import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {gitGates,environmentGates,connectVerified,APPROVED_REF} from './lib/run-gates.mjs';
import {encryptBackupPayload,decryptBackupPayload} from './lib/backup-crypto.mjs';

export const MIGRATION={version:'20261130000007',name:'repair_canonical_roster_save',sha256:'8bd122db88caf5e85d700e1e9bda3a71d89e7e3734bc824cb98880c95ebebd39'};
export const PRE_COUNT=109,PRE_LAST='20261130000006',BRANCH='fix/roster-canonical-save';
export const LIVE_PHRASE='REPAIR CANONICAL ROSTER SAVE ON STAGING ddlctzbnqewubltcavkh';
const PRE_FUNCTION_HASH='a4b505989d467cfaa615daf2d35871e41dee8f3de97a2f3fd4715a7ee8650070';
const ROOT=path.resolve(import.meta.dirname,'../..');
const normal=x=>x.replace(/\r\n?/g,'\n');
const hash=x=>crypto.createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex');
export function validateSql(sql){
 assert.match(sql.trim(),/^--[\s\S]*create or replace function public\.upsert_roster_cell_secure\([\s\S]+as \$function\$[\s\S]+\$function\$;$/i);
 assert.equal((sql.match(/create or replace function/gi)||[]).length,1);
 assert.doesNotMatch(sql,/^\s*(?:alter|drop|grant|revoke|create policy|create table)\b/im);
 assert.equal(sql.trim().split('$function$').length,3);
 return true;
}
export function frozenSql(){const sql=normal(fs.readFileSync(path.join(ROOT,'supabase/migrations',MIGRATION.version+'_'+MIGRATION.name+'.sql'),'utf8'));assert.equal(hash(sql),MIGRATION.sha256);validateSql(sql);return sql;}
async function history(p){return (await p.query('select version,name from supabase_migrations.schema_migrations order by version')).rows;}
async function target(p){return (await p.query("select replace(pg_get_functiondef(p.oid),chr(13),'') definition,p.proacl::text acl,p.proowner,p.prosecdef,p.provolatile,p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='upsert_roster_cell_secure'")).rows;}
async function invariants(p){
 return {
  schema:(await p.query("select column_name,data_type,is_nullable,column_default from information_schema.columns where table_schema='public' and table_name='team_rosters' order by ordinal_position")).rows,
  roster:(await p.query('select * from public.team_rosters order by id')).rows,
  functions:(await p.query("select p.oid::regprocedure::text signature,replace(pg_get_functiondef(p.oid),chr(13),'') definition,p.proacl::text acl,p.proowner,p.prosecdef,p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind='f' and p.proname<>'upsert_roster_cell_secure' order by 1")).rows,
  policies:(await p.query("select * from pg_policies where schemaname='public' order by tablename,policyname")).rows,
  triggers:(await p.query("select c.relname,t.tgname,pg_get_triggerdef(t.oid) definition from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not t.tgisinternal order by 1,2")).rows,
 };
}
async function scopes(p){return (await p.query(`select a.profile_id uid,r.code role,t.name team,
 (select s.code from public.stations s cross join lateral public.resolve_legacy_station(s.code) rs where rs.station_id=a.station_id limit 1) station
 from public.user_role_assignments a join public.role_definitions r on r.id=a.role_definition_id
 join public.profiles pr on pr.id=a.profile_id left join public.org_teams t on t.id=a.team_id
 where r.code in ('operation_manager','hub_se','dse','sso') and pr.status='approved' and a.revoked_at is null
 and (a.starts_at is null or a.starts_at<=now()) and (a.ends_at is null or a.ends_at>now()) order by r.code,a.profile_id`)).rows;}
async function asUser(p,uid,callback){
 await p.query('savepoint roster_probe');
 try{await p.query("select set_config('request.jwt.claims',$1,true),set_config('role','authenticated',true)",[JSON.stringify(uid?{sub:uid,role:'authenticated'}:{role:'authenticated'})]);return {value:await callback()};}
 catch(error){return {error:{code:error.code,message:error.message}};}
 finally{await p.query('rollback to savepoint roster_probe');await p.query('release savepoint roster_probe');}
}
async function probes(p,actors){
 let n=0;const ok=(name,condition)=>{assert.ok(condition,name);n++;console.log('PROBE PASS: '+name);};
 const write=async(station,team,date='2099-12-30',notes='[ROLLED-BACK ROSTER REPAIR PROBE]')=>(await p.query("select row_id from public.upsert_roster_cell_secure($1,$2,$3::date,'OFF',null::time,null::time,$4)",[station,team,date,notes])).rows[0].row_id;
 const manager=actors.find(a=>a.role==='operation_manager');assert.ok(manager,'Operation Manager required');
 const ds=actors.filter(a=>a.role==='dse'&&a.station&&a.team);assert.ok(ds.length,'DSE scope required');
 const d=ds[0];
 const before=(await p.query('select count(*)::int n from public.team_rosters')).rows[0].n;
 const managerResult=await asUser(p,manager.uid,async()=>{
  const a=await write(d.station,d.team),b=await write(d.station,d.team,'2099-12-30','[ROLLED-BACK UPDATE]');
  assert.equal(a,b,'Same team/date updates one row');
  for(const date of ['2099-12-28','2099-12-29'])await write(d.station,d.team,date);
  return true;
 });ok('Operation Manager insert, update and team date range',managerResult.value===true);
 for(const actor of ds){
  const good=await asUser(p,actor.uid,()=>write(actor.station,actor.team));ok('DSE own station/team '+actor.team,Boolean(good.value));
  const wrongTeam=actor.team==='ALPHA'?'BRAVO':'ALPHA';
  const denied=await asUser(p,actor.uid,()=>write(actor.station,wrongTeam));ok('DSE other team denied '+actor.team,denied.error?.code==='P0001'&&/roster-write authority/.test(denied.error.message));
  const deniedStation=await asUser(p,actor.uid,()=>write(actor.station==='PEN'?'KUL - MAA':'PEN',actor.team));ok('DSE other station denied '+actor.team,deniedStation.error?.code==='P0001'&&/roster-write authority/.test(deniedStation.error.message));
 }
 const hub=actors.find(a=>a.role==='hub_se');assert.ok(hub,'Hub SE required');
 const stations=(await p.query('select code from public.stations order by code')).rows;
 const hubScopes=[];
 for(const {code}of stations){const r=await asUser(p,hub.uid,async()=>(await p.query('select public.can_manage_roster_secure($1,$2) allowed',[code,'ALPHA'])).rows[0].allowed);hubScopes.push({station:code,allowed:r.value});}
 const inside=hubScopes.find(s=>s.allowed),outside=hubScopes.find(s=>s.allowed===false);assert.ok(inside&&outside,'Hub must have inside/outside station scopes');
 ok('Hub SE assigned hub allowed',Boolean((await asUser(p,hub.uid,()=>write(inside.station,'ALPHA'))).value));
 const hubDenied=await asUser(p,hub.uid,()=>write(outside.station,'ALPHA'));ok('Hub SE other hub denied',hubDenied.error?.code==='P0001'&&/roster-write authority/.test(hubDenied.error.message));
 const sso=actors.find(a=>a.role==='sso');assert.ok(sso);
 const no=await asUser(p,sso.uid,()=>write(d.station,d.team));ok('Ordinary SSO cannot administer rosters',no.error?.code==='P0001'&&/roster-write authority/.test(no.error.message));
 const anon=await asUser(p,null,()=>write(d.station,d.team));ok('Missing authenticated identity denied',anon.error?.code==='P0001'&&/Must be signed in/.test(anon.error.message));
 const pending=(await p.query("select id from public.profiles where status='pending' limit 1")).rows[0];
 if(pending){const r=await asUser(p,pending.id,()=>write(d.station,d.team));ok('Pending profile denied',r.error?.code==='P0001'&&/approved account/.test(r.error.message));}
 ok('Probes leave no roster rows',before===(await p.query('select count(*)::int n from public.team_rosters')).rows[0].n);
 return n;
}
export async function main(){
 const option=k=>process.argv.find(a=>a.startsWith('--'+k+'='))?.slice(k.length+3);
 const expectedHead=option('expected-head'),backupFile=option('backup'),live=process.argv.includes('--live');
 assert.match(expectedHead||'',/^[0-9a-f]{40}$/);assert.ok(backupFile,'Private backup path required');
 assert.ok(path.relative(ROOT,path.resolve(backupFile)).startsWith('..'),'Backup must be outside repo');
 if(live)assert.equal(option('confirm'),LIVE_PHRASE);
 process.chdir(ROOT);const git=gitGates({expectedBase:expectedHead,expectedRepoPath:ROOT,expectedBranch:BRANCH});assert.equal(git.head,expectedHead,'Exact expected HEAD required');
 environmentGates();const sql=frozenSql();const {client:p}=await connectVerified();
 try{
  assert.equal((await p.query("select pg_try_advisory_lock(hashtext('vecta-roster-save-repair')) locked")).rows[0].locked,true);
  const originalHistory=await history(p);assert.equal(originalHistory.length,PRE_COUNT);assert.equal(originalHistory.at(-1).version,PRE_LAST);
  const before=await target(p);assert.equal(before.length,1);assert.equal(hash(before[0].definition),PRE_FUNCTION_HASH,'Reviewed old function differs');
  const unchanged=await invariants(p);assert.ok(unchanged.schema.every(c=>c.column_name!=='ops_group'));
  const actors=await scopes(p);
  const snapshot={project:APPROVED_REF,createdAt:new Date().toISOString(),head:expectedHead,history:originalHistory,target:before,invariants:unchanged};
  fs.mkdirSync(path.dirname(path.resolve(backupFile)),{recursive:true});
  const envelope=encryptBackupPayload(snapshot,process.env.VECTA_BACKUP_PASSPHRASE);
  fs.writeFileSync(backupFile,JSON.stringify(envelope),{flag:'wx',mode:0o600});
  assert.deepEqual(decryptBackupPayload(fs.readFileSync(backupFile,'utf8'),process.env.VECTA_BACKUP_PASSPHRASE),snapshot);
  console.log('Scoped encrypted backup written and authenticated; no credentials printed.');
  async function pass(commit){
   await p.query('begin isolation level serializable');
   try{
    await p.query("set local lock_timeout='10s'; set local statement_timeout='30s'");
    assert.deepEqual(await history(p),originalHistory);assert.deepEqual(await target(p),before);assert.deepEqual(await invariants(p),unchanged);
    await p.query(sql);const after=await target(p);
    for(const key of ['acl','proowner','prosecdef','provolatile','proconfig'])assert.deepEqual(after[0][key],before[0][key],key+' changed');
    const count=await probes(p,actors);
    assert.deepEqual(await invariants(p),unchanged,'Unrelated state changed');
    await p.query('insert into supabase_migrations.schema_migrations(version,name) values($1,$2)',[MIGRATION.version,MIGRATION.name]);
    const h=await history(p);assert.equal(h.length,110);assert.deepEqual(h.slice(0,-1),originalHistory);assert.equal(h.at(-1).version,MIGRATION.version);
    await p.query(commit?'commit':'rollback');return count;
   }catch(error){await p.query('rollback');throw error;}
  }
  const dry=await pass(false);assert.deepEqual(await history(p),originalHistory);assert.deepEqual(await target(p),before);assert.deepEqual(await invariants(p),unchanged);
  console.log('DRY RUN PASSED: '+dry+' probes; function, history and roster rollback verified.');
  if(live){const count=await pass(true);assert.equal((await history(p)).length,110);console.log('LIVE PASSED: '+count+' probes; migration 110 ending '+MIGRATION.version+'; no roster fixtures persisted.');}
 }finally{await p.end();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error('ROSTER REPAIR STOPPED:',e.message);process.exitCode=1;});
