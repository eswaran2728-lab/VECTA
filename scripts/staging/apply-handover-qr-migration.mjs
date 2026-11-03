import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {gitGates,environmentGates,connectVerified,APPROVED_REF} from './lib/run-gates.mjs';
import {encryptBackupPayload,decryptBackupPayload} from './lib/backup-crypto.mjs';

// Guarded rollout of the recipient-bound, QR-verified handover migration. Usage (dry run, then --live):
//   node --env-file=<staging env> scripts/staging/apply-handover-qr-migration.mjs --expected-head=<sha> --backup=<outside-repo>.enc.json [--live --confirm="<LIVE_PHRASE>"]
export const MIGRATION={version:'20261203000001',name:'handover_recipient_qr_verification',sha256:'fc29928324eaf7355bc98980022fbb69b2e05bce9a83a408348dc4554af12d2a'};
export const PRE_COUNT=110,PRE_LAST='20261130000007',BRANCH='fix/roster-canonical-save';
export const LIVE_PHRASE='APPLY HANDOVER QR VERIFICATION TO STAGING ddlctzbnqewubltcavkh';
const ROOT=path.resolve(import.meta.dirname,'../..');
const normal=x=>x.replace(/\r\n?/g,'\n');
const hash=x=>crypto.createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex');
const ALLOWED=/^(alter table public\.(shift_handovers|user_notifications)|create index if not exists shift_handovers_|create or replace function public\.(handover_|resolve_handover_recipient_secure|file_handover_secure|issue_handover_challenge_secure|submit_handover_sender_location_secure|complete_handover_secure)|create or replace view public\.shift_handovers_with_status|revoke |grant |drop policy "shift_handovers |create policy "shift_handovers |do \$do\$)/i;
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
 handovers:(await p.query('select * from public.shift_handovers order by id')).rows,
 columns:(await p.query("select column_name,data_type from information_schema.columns where table_schema='public' and table_name='shift_handovers' order by ordinal_position")).rows,
 policies:(await p.query("select tablename,policyname,cmd,qual,with_check from pg_policies where schemaname='public' and tablename='shift_handovers' order by policyname")).rows,
 other:(await p.query("select p.oid::regprocedure::text sig,md5(pg_get_functiondef(p.oid)) h from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind='f' and p.proname not like '%handover%' order by 1")).rows,
 notificationRows:(await p.query('select count(*)::int n from public.user_notifications')).rows[0].n,
};}
async function asUser(p,uid,cb){
 await p.query('savepoint hp');
 try{await p.query("select set_config('request.jwt.claims',$1,true),set_config('role','authenticated',true)",[JSON.stringify(uid?{sub:uid,role:'authenticated'}:{role:'authenticated'})]);return {value:await cb()};}
 catch(e){return {error:{code:e.code,message:e.message}};}
 finally{await p.query('rollback to savepoint hp');await p.query('release savepoint hp');}
}
// All fixtures live inside the rolled-back transaction: real approved officers, temporary duty rows and a temporary zone.
async function probes(p){
 let n=0;const ok=(name,c)=>{assert.ok(c,name);n++;console.log('PROBE PASS: '+name);};
 const officers=(await p.query(`select pr.id,pr.name,upper(btrim(pr.staff_no)) staff_no,sc.station_code station
  from public.profiles pr cross join lateral public.handover_profile_scopes(pr.id) sc
  where pr.status='approved' and coalesce(btrim(pr.staff_no),'')<>'' and (select count(*) from public.handover_profile_scopes(pr.id))=1
   and (select count(*) from public.profiles x where x.status='approved' and upper(btrim(x.staff_no))=upper(btrim(pr.staff_no)))=1
  order by sc.station_code,pr.id`)).rows;
 const byStation={};for(const o of officers)(byStation[o.station]??=[]).push(o);
 const st=Object.keys(byStation).find(k=>byStation[k].length>=2);assert.ok(st,'Need two uniquely identified shift officers at one station');
 const [A,B]=byStation[st];
 const other=officers.find(o=>o.station!==st);
 const ZONE={type:'Polygon',coordinates:[[[101.699,3.099],[101.701,3.099],[101.701,3.101],[101.699,3.101],[101.699,3.099]]]};
 await p.query("insert into public.duty_zones(station,code,name,polygon,center_lat,center_lng,active) values($1,'ZZ-PROBE','Probe zone',$2::jsonb,3.1,101.7,true)",[st,JSON.stringify(ZONE)]);
 const duty=async(id,station)=>p.query("insert into public.duty_records(profile_id,station,duty_date,shift_code,check_in_at) values($1,$2,(now() at time zone 'Asia/Kuala_Lumpur')::date,coalesce((select shift_code from public.duty_records limit 1),'D'),now()) returning id",[id,station]);
 await duty(A.id,st);await duty(B.id,st);
 const file=async(uid,staff)=>asUser(p,uid,async()=>(await p.query("select public.file_handover_secure($1,'Bay','Bay 12','','probe notes','[]'::jsonb) id",[staff])).rows[0].id);
 const self=await file(A.id,A.staff_no);ok('Self handover rejected',/yourself/.test(self.error?.message||''));
 const nobody=await file(A.id,'NO-SUCH-STAFF-ID');ok('Unknown staff ID rejected',/No unique active officer/.test(nobody.error?.message||''));
 if(other){const cross=await file(A.id,other.staff_no);ok('Cross-station recipient rejected',/No unique active officer/.test(cross.error?.message||''));}
 const dup=(await p.query("select upper(btrim(staff_no)) s from public.profiles where status='approved' group by 1 having count(*)>1 limit 1")).rows[0];
 if(dup){const amb=await file(A.id,dup.s);ok('Duplicate staff ID rejected as ambiguous',/No unique active officer/.test(amb.error?.message||''));}
 // The filing function must persist, so file inside the outer transaction (not a rolled-back savepoint) while impersonating A.
 await p.query('savepoint filing');
 await p.query("select set_config('request.jwt.claims',$1,true),set_config('role','authenticated',true)",[JSON.stringify({sub:A.id,role:'authenticated'})]);
 const hid=(await p.query("select public.file_handover_secure($1,'Bay','Bay 12','','probe notes','[]'::jsonb) id",[B.staff_no])).rows[0].id;
 await p.query("select set_config('role','postgres',true)");
 await p.query('release savepoint filing');
 ok('Same-station recipient accepted',Boolean(hid));
 const row=(await p.query('select outgoing_profile_id,recipient_profile_id,handover_status,staff_name from public.shift_handovers where id=$1',[hid])).rows[0];
 ok('Sender derived from session and status pending',row.outgoing_profile_id===A.id&&row.recipient_profile_id===B.id&&row.handover_status==='pending'&&row.staff_name===A.name);
 ok('Recipient got an in-app alert',(await p.query("select count(*)::int n from public.user_notifications where recipient_profile_id=$1 and event_type='handover_received' and dedup_key=$2",[B.id,'handover_'+hid])).rows[0].n===1);
 const direct=await asUser(p,A.id,()=>p.query("insert into public.shift_handovers(outgoing_profile_id,station,staff_name,staff_id,place_category,place_detail,handover_notes) values($1,$2,'x','x','Bay','x','x')",[A.id,st]));
 ok('Direct client insert denied',Boolean(direct.error));
 const issueAsRecipient=await asUser(p,B.id,()=>p.query('select * from public.issue_handover_challenge_secure($1)',[hid]));
 ok('Recipient cannot issue a QR',Boolean(issueAsRecipient.error));
 // Each scenario runs inside one rolled-back savepoint so the handover returns to pending afterwards.
 const full=async(recip,o={})=>{const {senderLoc=[3.1,101.7,10],lat=3.1,lng=101.7,acc=10,ageS=2,delaySql=null,reuse=false}=o;
  return asUser(p,A.id,async()=>{
   const t=(await p.query('select * from public.issue_handover_challenge_secure($1)',[hid])).rows[0].token;
   await p.query('select public.submit_handover_sender_location_secure($1,$2,$3,$4)',[hid,...senderLoc]);
   if(delaySql){await p.query("select set_config('role','postgres',true)");await p.query(delaySql,[hid]);await p.query("select set_config('role','authenticated',true)");}
   await p.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:recip,role:'authenticated'})]);
   const q=()=>p.query("select * from public.complete_handover_secure($1,$2,$3,$4,$5,now()-($6||' seconds')::interval)",[hid,t,lat,lng,acc,String(ageS)]);
   const first=(await q()).rows[0];const second=reuse?(await q()).rows[0]:null;
   await p.query("select set_config('role','postgres',true)");
   const after=(await p.query('select handover_status,acknowledged_by,completed_at is not null done from public.shift_handovers where id=$1',[hid])).rows[0];
   return {first,second,after};
  });};
 const good=await full(B.id,{reuse:true});ok('Valid scan completes once with recipient evidence',good.value?.first.ok===true&&good.value.after.handover_status==='completed'&&good.value.after.acknowledged_by===B.id&&good.value.after.done);
 ok('Replay of a consumed QR is refused',good.value?.second.ok===false&&good.value.second.code==='NOT_PENDING');
 const thirdId=(await p.query("select id from public.profiles where status='approved' and id not in ($1,$2) limit 1",[A.id,B.id])).rows[0].id;
 const third=await full(thirdId);ok('Third person cannot complete',third.value?.first.code==='NOT_AVAILABLE');
 const stale=await full(B.id,{ageS:31});ok('Stale recipient location refused and stays pending',stale.value?.first.code==='RECIPIENT_LOCATION_STALE'&&stale.value.after.handover_status==='pending');
 const acc=await full(B.id,{acc:50.1});ok('Inaccurate location refused',acc.value?.first.code==='ACCURACY');
 const outside=await full(B.id,{lat:3.2,lng:101.8});ok('Recipient outside zone refused',outside.value?.first.code==='RECIPIENT_OUTSIDE_ZONE');
 const sOut=await full(B.id,{senderLoc:[3.2,101.8,10]});ok('Sender outside zone refused',sOut.value?.first.code==='SENDER_OUTSIDE_ZONE');
 const far=await full(B.id,{lat:3.10046});ok('Phones over 50 m apart refused',far.value?.first.code==='TOO_FAR_APART');
 const sStale=await full(B.id,{delaySql:"update public.shift_handovers set sender_location_at=now()-interval '31 seconds' where id=$1"});ok('Stale sender location refused',sStale.value?.first.code==='SENDER_LOCATION_STALE');
 const exp=await full(B.id,{delaySql:"update public.shift_handovers set challenge_expires_at=now()-interval '1 second' where id=$1"});ok('Expired QR refused',exp.value?.first.code==='CHALLENGE_EXPIRED');
 await p.query("update public.duty_records set check_out_at=now() where profile_id=$1",[A.id]);
 ok('Sender checkout makes it Uncompleted',(await p.query('select public.handover_effective_status($1) s',[hid])).rows[0].s==='uncompleted');
 const late=await asUser(p,A.id,()=>p.query('select * from public.issue_handover_challenge_secure($1)',[hid]));ok('No new QR after checkout',Boolean(late.error));
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
  assert.equal((await p.query("select pg_try_advisory_lock(hashtext('vecta-handover-qr')) l")).rows[0].l,true);
  const h0=await history(p);assert.equal(h0.length,PRE_COUNT);assert.equal(h0.at(-1).version,PRE_LAST);
  const before=await surface(p);
  const snapshot={project:APPROVED_REF,createdAt:new Date().toISOString(),head:expectedHead,history:h0,surface:before};
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
    assert.equal((await p.query("select count(*)::int n from public.shift_handovers where handover_status<>'historical'")).rows[0].n,0,'Existing rows must all be historical');
    // Every probe fixture (zone, duty rows, handover, alert, audit) is discarded even on the live pass: only the migration itself commits.
    await p.query('savepoint all_probes');
    const count=await probes(p);
    await p.query('rollback to savepoint all_probes');await p.query('release savepoint all_probes');
    assert.deepEqual((await surface(p)).other,before.other,'Unrelated functions changed');
    assert.deepEqual((await p.query('select count(*)::int n from public.shift_handovers')).rows[0].n,before.handovers.length,'Probe handover persisted');
    await p.query('insert into supabase_migrations.schema_migrations(version,name) values($1,$2)',[MIGRATION.version,MIGRATION.name]);
    await p.query(commit?'commit':'rollback');return count;
   }catch(e){await p.query('rollback');throw e;}
  }
  const dry=await pass(false);assert.deepEqual(await history(p),h0);assert.deepEqual(await surface(p),before);
  console.log('DRY RUN PASSED: '+dry+' probes; history, handovers, policies and functions rollback verified.');
  if(live){const c=await pass(true);assert.equal((await history(p)).length,PRE_COUNT+1);console.log('LIVE PASSED: '+c+' probes; migration '+(PRE_COUNT+1)+' ending '+MIGRATION.version+'.');}
 }finally{await p.end();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error('HANDOVER MIGRATION STOPPED:',e.message);process.exitCode=1;});
