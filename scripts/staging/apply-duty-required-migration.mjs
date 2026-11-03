import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {gitGates,environmentGates,connectVerified,APPROVED_REF} from './lib/run-gates.mjs';
import {encryptBackupPayload,decryptBackupPayload} from './lib/backup-crypto.mjs';

// Guarded rollout of the database-level check-in rule for report submission and physical work. Usage (dry run, then --live):
//   node --env-file=<staging env> scripts/staging/apply-duty-required-migration.mjs --expected-head=<sha> --backup=<outside-repo>.enc.json [--live --confirm="<LIVE_PHRASE>"]
export const MIGRATION={version:'20261203000006',name:'duty_required_for_submission_and_physical_work',sha256:'111cf5a068f5c403d81f6534e02794151f6b063fbaab4b09bcd639ae8539e60a'};
export const PRE_COUNT=115,PRE_LAST='20261203000005',BRANCH='fix/roster-canonical-save';
export const LIVE_PHRASE='APPLY DUTY REQUIRED FOR SUBMISSION TO STAGING ddlctzbnqewubltcavkh';
const ROOT=path.resolve(import.meta.dirname,'../..');
const normal=x=>x.replace(/\r\n?/g,'\n');
const hash=x=>crypto.createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex');
const ALLOWED=/^(create or replace function public\.(report_submit_requires_open_duty|finish_aircraft_search_secure)|revoke |grant |drop trigger if exists trg_report_submit_requires_open_duty on public\.report_|create trigger trg_report_submit_requires_open_duty before insert or update of status on public\.report_)/i;
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
 counts:(await p.query("select (select count(*) from public.report_sec014)::int a,(select count(*) from public.aircraft_search_records)::int r,(select count(*) from public.user_notifications)::int n")).rows[0],
 other:(await p.query("select p.oid::regprocedure::text sig,md5(pg_get_functiondef(p.oid)) h from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind='f' and p.proname not in ('report_submit_requires_open_duty','finish_aircraft_search_secure') order by 1")).rows,
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
 const aso=at('aso')[0],dse=at('dse')[0],sup=at('sso')[0]||at('so')[0];
 assert.ok(aso,'An ASO at the DSE station is required');
 const openNow=async id=>(await p.query("select count(*)::int n from public.duty_records where profile_id=$1 and duty_date=(now() at time zone 'Asia/Kuala_Lumpur')::date and check_in_at is not null and check_out_at is null",[id])).rows[0].n;
 assert.equal(await openNow(aso.uid),0,'The probe ASO must be off duty');
 const submit=(uid,status)=>asUser(p,uid,()=>p.query("insert into public.report_sec014(profile_id,status,station,team,staff_name,staff_id,date_time_in,remark,acknowledgement) values($1,$2,$3,'ALPHA','[ROLLED-BACK PROBE]','PROBE',now(),'[ROLLED-BACK OFF-DUTY PROBE]',true) returning id",[uid,status||'submitted',St]));

 // ---- off duty: preparation is allowed, submission is not ----
 const off=await submit(aso.uid);
 ok('An off-duty ASO cannot submit a report even by a direct insert',/check in for duty/.test(off.error?.message||''));
 const draft=await submit(aso.uid,'draft');
 ok('An off-duty ASO can still hold a draft-status row (preparation and drafts are allowed off duty)',!draft.error);
 const prepared=await p.query("insert into public.report_sec014(profile_id,status,station,team,staff_name,staff_id,date_time_in,remark,acknowledgement) values($1,'draft',$2,'ALPHA','[ROLLED-BACK PROBE]','PROBE',now(),'[ROLLED-BACK DRAFT]',true) returning id",[aso.uid,St]);
 const flip=await asUser(p,aso.uid,()=>p.query("update public.report_sec014 set status='submitted' where id=$1",[prepared.rows[0].id]));
 ok('An off-duty ASO cannot turn a prepared draft into a submitted report by a direct update',/check in for duty/.test(flip.error?.message||''));
 for(const who of [sup,dse].filter(Boolean)){const r=await submit(who.uid);ok('An off-duty '+who.role.toUpperCase()+' cannot submit a report by a direct insert',Boolean(r.error));}
 const asOwner=await p.query("insert into public.report_sec014(profile_id,status,station,team,staff_name,staff_id,date_time_in,remark,acknowledgement) values($1,'submitted',$2,'ALPHA','[ROLLED-BACK PROBE]','PROBE',now(),'[ROLLED-BACK OWNER]',true) returning id",[aso.uid,St]);
 ok('A service-side write with no signed-in user is not blocked',Boolean(asOwner.rows[0].id));

 // ---- on duty: the same request succeeds ----
 await p.query("insert into public.duty_records(profile_id,station,duty_date,shift_code,check_in_at) values($1,$2,(now() at time zone 'Asia/Kuala_Lumpur')::date,coalesce((select shift_code from public.duty_records limit 1),'D'),now()) on conflict (profile_id,duty_date,shift_code) do update set check_in_at=now(),check_out_at=null",[aso.uid,St]);
 const on=await submit(aso.uid);
 ok('After check-in the same ASO submission succeeds',!on.error);

 // ---- physical work: finishing an aircraft search needs an open check-in ----
 const finisher=sup?sup.uid:aso.uid;
 const rec=(await p.query("insert into public.aircraft_search_records(kind,station,entity,flight,registration,aircraft_type,submitter_id,started_at,presence_status) values('search',$1,'MAA','D7600','9M-ZOFF','A320',$2,now()-interval '40 minutes','reported') returning id",[St,finisher])).rows[0].id;
 if(await openNow(finisher)===0){
  const f=await asUser(p,finisher,()=>p.query("select * from public.finish_aircraft_search_secure($1,3.1,101.7,10,null)",[rec]));
  ok('An off-duty officer cannot finish an aircraft search by a direct call',/checked in for duty/.test(f.error?.message||''));
 }else ok('Finish-search refusal skipped: the probe officer is on duty (start-search probes cover it)',true);
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
  assert.equal((await p.query("select pg_try_advisory_lock(hashtext('vecta-duty-required')) l")).rows[0].l,true);
  const h0=await history(p);assert.equal(h0.length,PRE_COUNT);assert.equal(h0.at(-1).version,PRE_LAST);
  const before=await surface(p);
  const snapshot={project:APPROVED_REF,createdAt:new Date().toISOString(),head:expectedHead,history:h0,surface:before,
   finishFunction:(await p.query("select pg_get_functiondef(oid) d from pg_proc where proname='finish_aircraft_search_secure'")).rows};
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
  console.log('DRY RUN PASSED: '+dry+' probes; history, rows and functions rollback verified.');
  if(live){const c=await pass(true);assert.equal((await history(p)).length,PRE_COUNT+1);console.log('LIVE PASSED: '+c+' probes; migration '+(PRE_COUNT+1)+' ending '+MIGRATION.version+'.');}
 }finally{await p.end();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error('DUTY REQUIRED MIGRATION STOPPED:',e.message);process.exitCode=1;});
