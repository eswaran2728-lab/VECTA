import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {gitGates,environmentGates,connectVerified,APPROVED_REF} from './lib/run-gates.mjs';
import {encryptBackupPayload,decryptBackupPayload} from './lib/backup-crypto.mjs';

// Guarded rollout of the Bay Board manual-removal bypass closure and controlled correction. Usage (dry run, then --live):
//   node --env-file=<staging env> scripts/staging/apply-bay-board-correction-migration.mjs --expected-head=<sha> --backup=<outside-repo>.enc.json [--live --confirm="<LIVE_PHRASE>"]
export const MIGRATION={version:'20261203000005',name:'bay_board_controlled_correction',sha256:'f6378b5eb0584b2dd0e17a630a828a3618457847f00544b0ed1e9c5d55768e79'};
export const PRE_COUNT=114,PRE_LAST='20261203000004',BRANCH='fix/roster-canonical-save';
export const LIVE_PHRASE='APPLY BAY BOARD CONTROLLED CORRECTION TO STAGING ddlctzbnqewubltcavkh';
const ROOT=path.resolve(import.meta.dirname,'../..');
const normal=x=>x.replace(/\r\n?/g,'\n');
const hash=x=>crypto.createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex');
const ALLOWED=/^(alter table public\.bay_board|create table if not exists public\.bay_board_corrections|create index if not exists bay_board_corrections_|alter table public\.bay_board_corrections|revoke |grant |create policy "bay_board_corrections |create or replace function public\.correct_bay_board_entry_secure|drop policy if exists "bay_board_scoped_update")/i;
export function validateSql(sql){
 const stripped=sql.replace(/\$function\$[\s\S]*?\$function\$/g,'$function$$function$');
 for(const stmt of stripped.split(/;\s*(?:\n|$)/).map(s=>s.replace(/^(\s*--.*\n)+/g,'').trim()).filter(Boolean))assert.match(stmt,ALLOWED,'Statement outside allow-list: '+stmt.slice(0,80));
 assert.doesNotMatch(stripped,/\b(drop table|truncate|delete from)\b/i);
 assert.doesNotMatch(sql,/zsxneokqulktgnccxgkz/);
 return true;
}
export function frozenSql(){const sql=normal(fs.readFileSync(path.join(ROOT,'supabase/migrations',MIGRATION.version+'_'+MIGRATION.name+'.sql'),'utf8'));assert.equal(hash(sql),MIGRATION.sha256,'Migration changed since it was frozen');validateSql(sql);return sql;}
async function history(p){return (await p.query('select version,name from supabase_migrations.schema_migrations order by version')).rows;}
async function surface(p){return {
 counts:(await p.query("select (select count(*) from public.bay_board)::int b,(select count(*) from public.aircraft_search_records)::int r,(select count(*) from public.user_notifications)::int n")).rows[0],
 other:(await p.query("select p.oid::regprocedure::text sig,md5(pg_get_functiondef(p.oid)) h from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind='f' and p.proname<>'correct_bay_board_entry_secure' order by 1")).rows,
 grants:(await p.query("select privilege_type,count(*)::int n from information_schema.role_table_grants where table_schema='public' and table_name='bay_board' and grantee='authenticated' group by 1 order by 1")).rows,
};}
async function asUser(p,uid,cb){
 await p.query('savepoint sp');
 try{await p.query("select set_config('request.jwt.claims',$1,true),set_config('role','authenticated',true)",[JSON.stringify({sub:uid,role:'authenticated'})]);return {value:await cb()};}
 catch(e){return {error:{code:e.code,message:e.message}};}
 finally{await p.query('rollback to savepoint sp');await p.query('release savepoint sp');}
}
async function probes(p){
 let n=0;const ok=(name,c)=>{assert.ok(c,name);n++;console.log('PROBE PASS: '+name);};
 const people=(await p.query(`select a.profile_id uid,rd.code role,st.code station from public.user_role_assignments a join public.role_definitions rd on rd.id=a.role_definition_id and rd.code in ('dse','so','sso','aso')
  join public.org_stations st on st.id=a.station_id join public.profiles pr on pr.id=a.profile_id where pr.status='approved' and a.revoked_at is null and (a.ends_at is null or a.ends_at>now()) order by st.code,a.profile_id`)).rows;
 const St=people.find(r=>r.role==='dse')?.station;assert.ok(St,'A DSE station is required');
 const at=code=>people.filter(r=>r.station===St&&r.role===code);
 const dse=at('dse')[0],asos=at('aso'),sso=at('sso')[0]||at('so')[0];
 assert.ok(asos.length>=1,'An ASO at the DSE station is required');
 const om=(await p.query("select a.profile_id uid from public.user_role_assignments a join public.role_definitions r on r.id=a.role_definition_id where r.code='operation_manager' and a.revoked_at is null limit 1")).rows[0].uid;
 const ASO=asos[0].uid;
 const bay=async(reg,ground,creator,opts={})=>(await p.query("insert into public.bay_board(station,reg_no,aircraft_type,bay,flight,on_ground_since,is_manual,created_by,towed_from_hangar,search_state) values($1,$2,'A320','10','D7500',now()-($3||' minutes')::interval,true,$4,$5,$6) returning id",[St,reg,String(ground),creator,opts.towed||false,opts.state||'pending'])).rows[0].id;
 const row=async id=>(await p.query('select cleared_at is not null cleared,cleared_kind,cleared_by_report_id,search_state,correction_reason,corrected_by from public.bay_board where id=$1',[id])).rows[0];
 const correct=(uid,id,reason)=>asUser(p,uid,async()=>{const r=(await p.query('select * from public.correct_bay_board_entry_secure($1,$2)',[id,reason])).rows[0];await p.query("select set_config('role','postgres',true)");return {...r,after:await row(id)};});

 // ---- the bypass is closed ----
 const e1=await bay('9M-ZB1',30,ASO);
 const direct=await asUser(p,ASO,()=>p.query('update public.bay_board set cleared_at=now() where id=$1',[e1]));
 ok('A direct UPDATE of cleared_at by an officer is denied',Boolean(direct.error));
 const directSearch=await asUser(p,dse.uid,()=>p.query("update public.bay_board set search_state='confirmed' where id=$1",[e1]));
 ok('A direct UPDATE of the search state, even by a DSE, is denied',Boolean(directSearch.error));
 const insCleared=await asUser(p,ASO,()=>p.query("insert into public.bay_board(station,reg_no,bay,on_ground_since,created_by,cleared_at) values($1,'9M-ZB9','1',now(),$2,now())",[St,ASO]));
 ok('An entry cannot be inserted already cleared',Boolean(insCleared.error));
 const insOk=await asUser(p,ASO,()=>p.query("insert into public.bay_board(station,reg_no,bay,on_ground_since,created_by,is_manual) values($1,'9M-ZB8','1',now(),$2,true) returning id",[St,ASO]));
 ok('An ordinary manual entry can still be added',!insOk.error);

 // ---- authority and reason ----
 const asoTry=await correct(ASO,e1,'Entered against the wrong registration');
 if(process.env.BBC_DEBUG)console.log(JSON.stringify(asoTry));
 ok('An ASO cannot correct an entry',asoTry.value?.code==='NOT_AUTHORISED'&&asoTry.value.after.cleared===false);
 const short=await correct(dse.uid,e1,'wrong');
 ok('A correction without a real reason is refused',short.value?.code==='REASON_REQUIRED'&&short.value.after.cleared===false);

 // ---- authorised correction of a genuinely incorrect entry (no search required) ----
 const good=await correct(dse.uid,e1,'Duplicate entry for a registration that never arrived');
 ok('A DSE corrects an incorrect entry with a reason',good.value?.ok===true&&good.value.after.cleared===true&&good.value.after.cleared_kind==='correction'&&good.value.after.cleared_by_report_id===null&&good.value.after.corrected_by===dse.uid);
 const audit=await asUser(p,dse.uid,async()=>{await p.query('select * from public.correct_bay_board_entry_secure($1,$2)',[e1,'Duplicate entry for a registration that never arrived']);await p.query("select set_config('role','postgres',true)");return (await p.query('select count(*)::int n,bool_or(had_required_search) req from public.bay_board_corrections where bay_board_id=$1',[e1])).rows[0];});
 ok('The correction is recorded for audit and is not a required-search correction',audit.value?.n===1&&audit.value.req===false);
 if(sso){const e2=await bay('9M-ZB2',30,ASO);const s=await correct(sso.uid,e2,'Wrong bay entered for the wrong aircraft');ok('An SO/SSO can correct an ordinary incorrect entry',s.value?.ok===true);}
 const e1b=await bay('9M-ZB3',30,ASO);
 const twice=await asUser(p,dse.uid,async()=>{await p.query('select * from public.correct_bay_board_entry_secure($1,$2)',[e1b,'Entered against the wrong registration']);return (await p.query('select * from public.correct_bay_board_entry_secure($1,$2)',[e1b,'Entered against the wrong registration'])).rows[0];});
 ok('A second correction of the same entry is refused',twice.value?.code==='ALREADY_CLEARED');

 // ---- a required-search aircraft cannot vanish as normally cleared ----
 const req=await bay('9M-ZR1',360,ASO,{state:'submitted'});
 if(sso&&sso.role!=='dse'){const s=await correct(sso.uid,req,'Aircraft is not actually on the ground here');ok('An SO/SSO cannot correct an aircraft that still needs a search',s.value?.code==='NEEDS_DSE'&&s.value.after.cleared===false);}
 const asoReq=await correct(ASO,req,'Aircraft is not actually on the ground here');
 ok('An ASO cannot remove a required-search aircraft',asoReq.value?.code==='NOT_AUTHORISED'&&asoReq.value.after.cleared===false);
 const ownReq=await bay('9M-ZR2',360,dse.uid,{state:'submitted'});
 const own=await correct(dse.uid,ownReq,'Aircraft is not actually on the ground here');
 ok('The creator of a required-search entry cannot correct it themselves',own.value?.code==='OWN_ENTRY'&&own.value.after.cleared===false);
 const towed=await bay('9M-ZR3',20,ASO,{towed:true});
 const t=await correct(ASO,towed,'Aircraft is not actually on the ground here');
 ok('A towed aircraft is treated as still needing a search',t.value?.code==='NOT_AUTHORISED'&&t.value.after.cleared===false);
 const night=await bay('9M-ZR4',1500,ASO,{state:'pending'});
 const authorised=await asUser(p,dse.uid,async()=>{const r=(await p.query('select * from public.correct_bay_board_entry_secure($1,$2)',[night,'Entry created by mistake for an aircraft already departed on another system'])).rows[0];await p.query("select set_config('role','postgres',true)");return {r,after:await row(night),rec:(await p.query("select count(*)::int n from public.aircraft_search_records where registration='9M-ZR4' and kind='missing' and review_state='exception'")).rows[0].n,corr:(await p.query('select had_required_search from public.bay_board_corrections where bay_board_id=$1',[night])).rows[0]};});
 ok('A DSE can correct a required-search entry: marked a correction (never confirmed), with an exception left for review',authorised.value?.r.ok===true&&authorised.value.after.cleared_kind==='correction'&&authorised.value.after.search_state==='exception'&&authorised.value.rec===1&&authorised.value.corr.had_required_search===true);
 const omReq=await bay('9M-ZR5',400,ASO,{state:'submitted'});
 const omRes=await correct(om,omReq,'Entry created by mistake for an aircraft already departed on another system');
 ok('The Operation Manager can correct a required-search entry',omRes.value?.ok===true&&omRes.value.after.cleared_kind==='correction'&&omRes.value.after.search_state==='exception');
 return n;
}
export async function main(){
 const option=k=>process.argv.find(a=>a.startsWith('--'+k+'='))?.slice(k.length+3);
 const expectedHead=option('expected-head'),backupFile=option('backup'),live=process.argv.includes('--live');
 assert.match(expectedHead||'',/^[0-9a-f]{40}$/);assert.ok(backupFile,'Private backup path required');
 assert.ok(path.relative(ROOT,path.resolve(backupFile)).startsWith('..'),'Backup must be outside repo');
 if(live)assert.equal(option('confirm'),LIVE_PHRASE);
 process.chdir(ROOT);const git=gitGates({expectedBase:expectedHead,expectedRepoPath:ROOT,expectedBranch:BRANCH});assert.equal(git.head,expectedHead);
 environmentGates();const sql=frozenSql();const {client:p}=await connectVerified();
 try{
  assert.equal((await p.query("select pg_try_advisory_lock(hashtext('vecta-bay-board-correction')) l")).rows[0].l,true);
  const h0=await history(p);assert.equal(h0.length,PRE_COUNT);assert.equal(h0.at(-1).version,PRE_LAST);
  const before=await surface(p);
  const snapshot={project:APPROVED_REF,createdAt:new Date().toISOString(),head:expectedHead,history:h0,surface:before,
   bayPolicies:(await p.query("select policyname,cmd,qual,with_check from pg_policies where schemaname='public' and tablename='bay_board' order by 1")).rows};
  fs.mkdirSync(path.dirname(path.resolve(backupFile)),{recursive:true});
  fs.writeFileSync(backupFile,JSON.stringify(encryptBackupPayload(snapshot,process.env.VECTA_BACKUP_PASSPHRASE)),{flag:'wx',mode:0o600});
  assert.deepEqual(decryptBackupPayload(fs.readFileSync(backupFile,'utf8'),process.env.VECTA_BACKUP_PASSPHRASE),JSON.parse(JSON.stringify(snapshot)));
  console.log('Scoped encrypted backup written and authenticated; no credentials printed.');
  async function pass(commit){
   await p.query('begin isolation level serializable');
   try{
    await p.query("set local lock_timeout='10s'; set local statement_timeout='120s'");
    assert.deepEqual(await history(p),h0);
    await p.query(sql);
    await p.query('savepoint all_probes');
    const count=await probes(p);
    await p.query('rollback to savepoint all_probes');await p.query('release savepoint all_probes');
    const a=await surface(p);
    assert.deepEqual(a.other,before.other,'Unrelated functions changed');
    assert.deepEqual(a.counts,before.counts,'Probe rows persisted');
    await p.query('insert into supabase_migrations.schema_migrations(version,name) values($1,$2)',[MIGRATION.version,MIGRATION.name]);
    await p.query(commit?'commit':'rollback');return count;
   }catch(e){await p.query('rollback');throw e;}
  }
  const dry=await pass(false);assert.deepEqual(await history(p),h0);assert.deepEqual(await surface(p),before);
  console.log('DRY RUN PASSED: '+dry+' probes; history, rows, grants and functions rollback verified.');
  if(live){const c=await pass(true);assert.equal((await history(p)).length,PRE_COUNT+1);console.log('LIVE PASSED: '+c+' probes; migration '+(PRE_COUNT+1)+' ending '+MIGRATION.version+'.');}
 }finally{await p.end();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error('BAY BOARD CORRECTION MIGRATION STOPPED:',e.message);process.exitCode=1;});
