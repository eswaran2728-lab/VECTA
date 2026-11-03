import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {gitGates,environmentGates,connectVerified,APPROVED_REF} from './lib/run-gates.mjs';
import {encryptBackupPayload,decryptBackupPayload} from './lib/backup-crypto.mjs';

// Guarded rollout of DSE in-app report notifications. Usage (dry run, then --live):
//   node --env-file=<staging env> scripts/staging/apply-dse-report-notifications-migration.mjs --expected-head=<sha> --backup=<outside-repo>.enc.json [--live --confirm="<LIVE_PHRASE>"]
export const MIGRATION={version:'20261203000003',name:'dse_report_notifications',sha256:'29833b4fd33a5e0f091d5e0d28e9a572a57d1b7995453c6028f6c1d652d53350'};
export const PRE_COUNT=112,PRE_LAST='20261203000002',BRANCH='fix/roster-canonical-save';
export const LIVE_PHRASE='APPLY DSE REPORT NOTIFICATIONS TO STAGING ddlctzbnqewubltcavkh';
const ROOT=path.resolve(import.meta.dirname,'../..');
const normal=x=>x.replace(/\r\n?/g,'\n');
const hash=x=>crypto.createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex');
const ALLOWED=/^(do \$do\$|create table if not exists public\.report_notification_failures|create index if not exists report_notification_failures_|alter table public\.report_notification_failures|revoke |grant |create policy "report_notification_failures |create or replace view public\.v_report_notification_health|create or replace function public\.(dse_report_recipients|deliver_dse_report_notifications|notify_dse_of_report)|drop trigger if exists trg_notify_dse_of_report on public\.report_|create trigger trg_notify_dse_of_report after insert on public\.report_)/i;
export function validateSql(sql){
 const stripped=sql.replace(/\$function\$[\s\S]*?\$function\$/g,'$function$$function$').replace(/\$do\$[\s\S]*?\$do\$/g,'$do$$do$');
 for(const stmt of stripped.split(/;\s*(?:\n|$)/).map(s=>s.replace(/^(\s*--.*\n)+/g,'').trim()).filter(Boolean))assert.match(stmt,ALLOWED,'Statement outside allow-list: '+stmt.slice(0,80));
 assert.doesNotMatch(stripped,/\b(drop table|truncate|delete from)\b/i);
 assert.doesNotMatch(sql,/zsxneokqulktgnccxgkz/);
 return true;
}
export function frozenSql(){const sql=normal(fs.readFileSync(path.join(ROOT,'supabase/migrations',MIGRATION.version+'_'+MIGRATION.name+'.sql'),'utf8'));assert.equal(hash(sql),MIGRATION.sha256,'Migration changed since it was frozen');validateSql(sql);return sql;}
async function history(p){return (await p.query('select version,name from supabase_migrations.schema_migrations order by version')).rows;}
async function surface(p){return {
 reports:(await p.query("select (select count(*) from public.report_sec014)::int a,(select count(*) from public.report_sec033)::int b,(select count(*) from public.user_notifications)::int n")).rows[0],
 other:(await p.query("select p.oid::regprocedure::text sig,md5(pg_get_functiondef(p.oid)) h from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind='f' and p.proname not in ('dse_report_recipients','deliver_dse_report_notifications','notify_dse_of_report') order by 1")).rows,
 triggers:(await p.query("select c.relname,t.tgname from pg_trigger t join pg_class c on c.oid=t.tgrelid where t.tgname='trg_notify_dse_of_report'")).rows,
};}
async function asUser(p,uid,cb){
 await p.query('savepoint lp');
 try{await p.query("select set_config('request.jwt.claims',$1,true),set_config('role','authenticated',true)",[JSON.stringify({sub:uid,role:'authenticated'})]);return {value:await cb()};}
 catch(e){return {error:{code:e.code,message:e.message}};}
 finally{await p.query('rollback to savepoint lp');await p.query('release savepoint lp');}
}
const TABLES=['report_sec013','report_sec014','report_sec016','report_sec018','report_sec029','report_sec033','report_makeup','report_breakup'];
async function probes(p){
 let n=0;const ok=(name,c)=>{assert.ok(c,name);n++;console.log('PROBE PASS: '+name);};
 const om=(await p.query("select a.profile_id uid from public.user_role_assignments a join public.role_definitions r on r.id=a.role_definition_id where r.code='operation_manager' and a.revoked_at is null limit 1")).rows[0].uid;
 const dse=(await p.query(`select a.profile_id uid,s.code station,t.name team,m.operating_entity_id eid from public.user_role_assignments a join public.role_definitions r on r.id=a.role_definition_id
  join public.user_entity_memberships m on m.id=a.entity_membership_id and m.status='active' and m.revoked_at is null
  join public.profiles pr on pr.id=a.profile_id join public.org_teams t on t.id=a.team_id join public.stations s on s.code is not null
  cross join lateral public.resolve_legacy_station(s.code) rs where rs.station_id=a.station_id and r.code='dse' and pr.status='approved' and a.revoked_at is null and (a.ends_at is null or a.ends_at>now()) order by a.profile_id`)).rows;
 assert.ok(dse.length>=1,'A DSE scope is required');
 const D=dse[0];
 const sub=(await p.query(`select pr.id,pr.name,pr.staff_no from public.profiles pr join public.user_entity_memberships m on m.profile_id=pr.id and m.status='active' and m.revoked_at is null
  where pr.status='approved' and m.operating_entity_id=$1 and pr.id<>$2 and (select count(*) from public.user_entity_memberships x where x.profile_id=pr.id and x.status='active' and x.revoked_at is null)=1 order by pr.id limit 1`,[D.eid,D.uid])).rows[0];
 assert.ok(sub,'A submitter in the DSE entity is required');
 const noEntity=(await p.query("select pr.id from public.profiles pr where pr.status='approved' and not exists (select 1 from public.user_entity_memberships m where m.profile_id=pr.id and m.status='active' and m.revoked_at is null) limit 1")).rows[0];
 const rec=async(st,tm,sb)=>(await p.query('select profile_id from public.dse_report_recipients($1,$2,$3)',[st,tm,sb])).rows.map(r=>r.profile_id);
 ok('Same entity, station and team DSE is a recipient',(await rec(D.station,D.team,sub.id)).includes(D.uid));
 ok('The submitter is never a recipient',!(await rec(D.station,D.team,D.uid)).includes(D.uid));
 const otherTeam=(await p.query("select t.name from public.org_teams t join public.stations s on s.code is not null cross join lateral public.resolve_legacy_station(s.code) rs where rs.station_id=t.station_id and s.code=$1 and t.name<>$2 limit 1",[D.station,D.team])).rows[0]?.name;
 if(otherTeam)ok('A DSE of another team is not a recipient',!(await rec(D.station,otherTeam,sub.id)).includes(D.uid));
 const otherStation=(await p.query("select code from public.stations where code<>$1 limit 1",[D.station])).rows[0]?.code;
 if(otherStation){let res=[];try{res=await rec(otherStation,D.team,sub.id);}catch{res=[];}ok('A DSE of another station is not a recipient',!res.includes(D.uid));}
 const deliver=async(id)=>(await p.query("select public.deliver_dse_report_notifications('report_sec014',$1,$2,$3,$4,'PROBE-1','') n",[id,D.station,D.team,sub.id])).rows[0].n;
 const sid=(await p.query('select gen_random_uuid() id')).rows[0].id;
 const first=await deliver(sid);const second=await deliver(sid);
 const count=(await p.query("select count(*)::int n from public.user_notifications where recipient_profile_id=$1 and event_type='dse_report_submitted' and dedup_key=$2",[D.uid,'dse_report:report_sec014:'+sid+':'+D.uid])).rows[0].n;
 ok('Delivery is idempotent: one alert per report per DSE',first>=1&&second>=1&&count===1);
 if(noEntity){
  const bad=(await p.query("select public.deliver_dse_report_notifications('report_sec014',gen_random_uuid(),$1,$2,$3,'PROBE-2','') n",[D.station,D.team,noEntity.id])).rows[0].n;
  ok('A delivery fault does not raise and is recorded for monitoring',bad===0&&(await p.query("select count(*)::int n from public.report_notification_failures where error like '%no single active operating entity%'")).rows[0].n>=1);
 }
 // A real submitted report fires the trigger; a submitter with no entity still submits and the fault is recorded.
 const ins=async(who,note)=>(await p.query(`insert into public.report_sec014(profile_id,status,station,team,staff_name,staff_id,date_time_in,remark,acknowledgement) values($1,'submitted',$2,$3,'[ROLLED-BACK PROBE]','PROBE',now(),$4,true) returning id`,[who,D.station,D.team,note])).rows[0].id;
 await p.query('savepoint real');
 const rid=await ins(sub.id,'[ROLLED-BACK DSE NOTIFICATION PROBE]');
 ok('A real submitted SEC014 alerts the scoped DSE',(await p.query("select count(*)::int n from public.user_notifications where recipient_profile_id=$1 and dedup_key=$2",[D.uid,'dse_report:report_sec014:'+rid+':'+D.uid])).rows[0].n===1);
 const seen=await asUser(p,D.uid,async()=>(await p.query('select id from public.report_sec014 where id=$1',[rid])).rows.length);
 ok('The DSE can open the report the alert links to (row-level security)',seen.value===1);
 await p.query('rollback to savepoint real');await p.query('release savepoint real');
 if(noEntity){
  await p.query('savepoint real2');
  const rid2=await ins(noEntity.id,'[ROLLED-BACK FAULT PROBE]');
  ok('A fault in delivery leaves the submission in place and visible to monitoring',Boolean(rid2)&&(await p.query("select count(*)::int n from public.report_notification_failures where source_id=$1",[rid2])).rows[0].n===1);
  await p.query('rollback to savepoint real2');await p.query('release savepoint real2');
 }
 const tr=(await p.query("select count(distinct c.relname)::int n from pg_trigger t join pg_class c on c.oid=t.tgrelid where t.tgname='trg_notify_dse_of_report'")).rows[0].n;
 ok('Triggers exist on all eight submitted-report tables',tr===8);
 const monitor=await asUser(p,om,async()=>(await p.query('select open_failures from public.v_report_notification_health')).rows.length);
 ok('Operation Manager can read the monitoring view',monitor.value===1);
 const denied=await asUser(p,D.uid,async()=>(await p.query('select count(*)::int n from public.report_notification_failures')).rows[0].n);
 ok('A DSE cannot read delivery failures',denied.value===0);
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
  assert.equal((await p.query("select pg_try_advisory_lock(hashtext('vecta-dse-report-notifications')) l")).rows[0].l,true);
  const h0=await history(p);assert.equal(h0.length,PRE_COUNT);assert.equal(h0.at(-1).version,PRE_LAST);
  const before=await surface(p);
  const snapshot={project:APPROVED_REF,createdAt:new Date().toISOString(),head:expectedHead,history:h0,surface:before,
   tablesBefore:(await p.query("select count(*)::int n from pg_class where relname='report_notification_failures'")).rows};
  fs.mkdirSync(path.dirname(path.resolve(backupFile)),{recursive:true});
  fs.writeFileSync(backupFile,JSON.stringify(encryptBackupPayload(snapshot,process.env.VECTA_BACKUP_PASSPHRASE)),{flag:'wx',mode:0o600});
  assert.deepEqual(decryptBackupPayload(fs.readFileSync(backupFile,'utf8'),process.env.VECTA_BACKUP_PASSPHRASE),JSON.parse(JSON.stringify(snapshot)));
  console.log('Scoped encrypted backup written and authenticated; no credentials printed.');
  async function pass(commit){
   await p.query('begin isolation level serializable');
   try{
    await p.query("set local lock_timeout='10s'; set local statement_timeout='60s'");
    assert.deepEqual(await history(p),h0);
    await p.query(sql);
    await p.query('savepoint all_probes');
    const count=await probes(p);
    await p.query('rollback to savepoint all_probes');await p.query('release savepoint all_probes');
    const a=await surface(p);
    assert.deepEqual(a.other,before.other,'Unrelated functions changed');
    assert.deepEqual(a.reports,before.reports,'Probe reports or alerts persisted');
    await p.query('insert into supabase_migrations.schema_migrations(version,name) values($1,$2)',[MIGRATION.version,MIGRATION.name]);
    await p.query(commit?'commit':'rollback');return count;
   }catch(e){await p.query('rollback');throw e;}
  }
  const dry=await pass(false);assert.deepEqual(await history(p),h0);
  assert.deepEqual(await surface(p),before);
  console.log('DRY RUN PASSED: '+dry+' probes; history, leave rows and functions rollback verified.');
  if(live){const c=await pass(true);assert.equal((await history(p)).length,PRE_COUNT+1);console.log('LIVE PASSED: '+c+' probes; migration '+(PRE_COUNT+1)+' ending '+MIGRATION.version+'.');}
 }finally{await p.end();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error('DSE REPORT MIGRATION STOPPED:',e.message);process.exitCode=1;});
