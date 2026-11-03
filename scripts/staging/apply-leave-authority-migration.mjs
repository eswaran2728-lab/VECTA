import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {gitGates,environmentGates,connectVerified,APPROVED_REF} from './lib/run-gates.mjs';
import {encryptBackupPayload,decryptBackupPayload} from './lib/backup-crypto.mjs';

// Guarded rollout of unpaid-leave routing and direct annual-leave cancellation. Usage (dry run, then --live):
//   node --env-file=<staging env> scripts/staging/apply-leave-authority-migration.mjs --expected-head=<sha> --backup=<outside-repo>.enc.json [--live --confirm="<LIVE_PHRASE>"]
export const MIGRATION={version:'20261203000002',name:'leave_unpaid_routing_and_cancellation',sha256:'61dcbb99c65ce3aac01e9d2e88c6ab4f88f2f812d7a8a0f66a7c3a6423067626'};
export const PRE_COUNT=111,PRE_LAST='20261203000001',BRANCH='fix/roster-canonical-save';
export const LIVE_PHRASE='APPLY LEAVE AUTHORITY AND CANCELLATION TO STAGING ddlctzbnqewubltcavkh';
const ROOT=path.resolve(import.meta.dirname,'../..');
const normal=x=>x.replace(/\r\n?/g,'\n');
const hash=x=>crypto.createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex');
const ALLOWED=/^(alter table public\.absence_notices|create or replace function public\.(leave_submitter_entity|leave_peak_overlap|review_leave_request_secure|cancel_approved_leave_secure)|revoke |grant )/i;
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
 notices:(await p.query('select * from public.absence_notices order by id')).rows,
 policies:(await p.query("select tablename,policyname,cmd,qual,with_check from pg_policies where schemaname='public' and tablename='absence_notices' order by policyname")).rows,
 other:(await p.query("select p.oid::regprocedure::text sig,md5(pg_get_functiondef(p.oid)) h from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind='f' and p.proname not in ('review_leave_request_secure','cancel_approved_leave_secure','leave_submitter_entity','leave_peak_overlap') order by 1")).rows,
 reviewAcl:(await p.query("select proacl::text a from pg_proc where proname='review_leave_request_secure'")).rows,
};}
async function asUser(p,uid,cb){
 await p.query('savepoint lp');
 try{await p.query("select set_config('request.jwt.claims',$1,true),set_config('role','authenticated',true)",[JSON.stringify({sub:uid,role:'authenticated'})]);return {value:await cb()};}
 catch(e){return {error:{code:e.code,message:e.message}};}
 finally{await p.query('rollback to savepoint lp');await p.query('release savepoint lp');}
}
async function probes(p){
 let n=0;const ok=(name,c)=>{assert.ok(c,name);n++;console.log('PROBE PASS: '+name);};
 const role=async(code,extra='')=>(await p.query(`select a.profile_id uid from public.user_role_assignments a join public.role_definitions r on r.id=a.role_definition_id join public.profiles pr on pr.id=a.profile_id where r.code=$1 and pr.status='approved' and a.revoked_at is null and (a.ends_at is null or a.ends_at>now()) ${extra} order by a.profile_id limit 1`,[code])).rows[0]?.uid;
 const om=await role('operation_manager'),maaBoss=await role('maa_boss'),aaxBoss=await role('aax_boss');
 assert.ok(om&&maaBoss&&aaxBoss,'Operation Manager and both Bosses required');
 const dses=(await p.query(`select a.profile_id uid,s.code station,t.name team from public.user_role_assignments a join public.role_definitions r on r.id=a.role_definition_id
  join public.profiles pr on pr.id=a.profile_id join public.org_teams t on t.id=a.team_id join public.stations s on s.code is not null
  cross join lateral public.resolve_legacy_station(s.code) rs where rs.station_id=a.station_id and r.code='dse' and pr.status='approved' and a.revoked_at is null and (a.ends_at is null or a.ends_at>now()) order by a.profile_id`)).rows;
 assert.ok(dses.length>=1,'A DSE scope is required');
 const D=dses[0];
 const others=(await p.query(`select pr.id,(select oe.code from public.user_entity_memberships m join public.operating_entities oe on oe.id=m.operating_entity_id where m.profile_id=pr.id and m.status='active' and m.revoked_at is null limit 1) ent
  from public.profiles pr where pr.status='approved' and pr.id<>$1 and (select count(*) from public.user_entity_memberships m where m.profile_id=pr.id and m.status='active' and m.revoked_at is null)=1
  and coalesce(public.submitter_department_code(pr.id),'')<>'enforcement' order by pr.id`,[D.uid])).rows;
 assert.ok(others.length>=5,'At least five applicant profiles are required');
 const maaUser=others.find(o=>o.ent==='MAA'),aaxUser=others.find(o=>o.ent==='AAX');assert.ok(maaUser&&aaxUser,'Applicants of both entities required');
 const today=(await p.query("select (now() at time zone 'Asia/Kuala_Lumpur')::date::text d")).rows[0].d;
 const plus4=(await p.query("select ((now() at time zone 'Asia/Kuala_Lumpur')::date+4)::text x")).rows[0].x;
 const add=async(user,type,off0,off1,status='pending',team=D.team,extra=false)=>(await p.query(`insert into public.absence_notices(user_id,staff_name,role,station,team,duty_date,shift_start_time,remarks,leave_type,start_date,end_date,approval_status,status,overlap_exception)
  values($1,'[ROLLED-BACK LEAVE PROBE]','ASO',$2,$3,current_date,now(),'[ROLLED-BACK LEAVE PROBE]',$4,(now() at time zone 'Asia/Kuala_Lumpur')::date+$5::int,(now() at time zone 'Asia/Kuala_Lumpur')::date+$6::int,$7,'green',$8) returning id`,[user,D.station,team,type,off0,off1,status,extra])).rows[0].id;
 const scenario=async fn=>{await p.query('savepoint sc');try{return await fn();}finally{await p.query('rollback to savepoint sc');await p.query('release savepoint sc');}};
 const review=(uid,id,action='approve')=>asUser(p,uid,async()=>(await p.query('select * from public.review_leave_request_secure($1,$2,$3)',[id,action,'probe'])).rows[0]);
 const cancel=(uid,id,reason='Operational reassignment')=>asUser(p,uid,async()=>(await p.query('select * from public.cancel_approved_leave_secure($1,$2)',[id,reason])).rows[0]);
 const status=async id=>(await p.query('select approval_status,end_date::text e,overlap_exception,cancellation_kind,original_end_date::text o from public.absence_notices where id=$1',[id])).rows[0];

 // ---- unpaid routing ----
 await scenario(async()=>{
  const two=await add(maaUser.id,'unpaid',20,21);
  ok('Unpaid 2 days: DSE cannot finalise',/Operation Manager/.test((await review(D.uid,two)).error?.message||''));
  ok('Unpaid 2 days: Boss cannot finalise',/Operation Manager/.test((await review(maaBoss,two)).error?.message||''));
  ok('Unpaid 2 days: Operation Manager approves',(await review(om,two)).value?.result_status==='approved');
  const one=await add(maaUser.id,'unpaid',25,25);ok('Unpaid 1 day: Operation Manager rejects',(await review(om,one,'reject')).value?.result_status==='rejected');
 });
 await scenario(async()=>{
  const three=await add(maaUser.id,'unpaid',20,22);
  ok('Unpaid 3 days: Operation Manager cannot finalise',/MAA Boss/.test((await review(om,three)).error?.message||''));
  ok('Unpaid 3 days: DSE cannot finalise',Boolean((await review(D.uid,three)).error));
  ok('Unpaid 3 days: other entity Boss cannot finalise',/MAA Boss/.test((await review(aaxBoss,three)).error?.message||''));
  ok('Unpaid 3 days: own-entity Boss approves',(await review(maaBoss,three)).value?.result_status==='approved');
  const aax=await add(aaxUser.id,'unpaid',30,33);ok('Unpaid AAX 4 days routes to the AAX Boss',(await review(aaxBoss,aax)).value?.result_status==='approved'&&Boolean((await review(maaBoss,await add(aaxUser.id,'unpaid',40,43))).error));
 });
 // ---- same-day overlap exception ----
 await scenario(async()=>{
  for(const u of others.slice(0,3))await add(u.id,'annual',50,52,'approved');
  const fourth=await add(others[3].id,'annual',51,51);
  ok('Fourth same-day officer: DSE refused',/capacity reached/.test((await review(D.uid,fourth)).error?.message||''));
  ok('Fourth same-day officer: Operation Manager approves and the exception is recorded',(await review(om,fourth)).value?.result_status==='approved'&&(await status(fourth)).overlap_exception===true);
 });
 await scenario(async()=>{
  await add(others[0].id,'annual',60,61,'approved');await add(others[1].id,'annual',62,63,'approved');await add(others[2].id,'annual',64,65,'approved');
  const chain=await add(others[3].id,'annual',60,65);
  ok('Ranges that never overlap on one day do not trigger the exception',(await review(D.uid,chain)).value?.result_status==='approved'&&(await status(chain)).overlap_exception===false);
 });
 // ---- direct cancellation ----
 await scenario(async()=>{
  const fut=await add(others[0].id,'annual',70,72,'approved');
  ok('Reason is required',/reason/.test((await cancel(D.uid,fut,'no')).error?.message||''));
  ok('Another team DSE scope: refused',Boolean((await cancel(maaBoss,fut)).error));
  ok('DSE cancels future approved annual leave in full',(await cancel(D.uid,fut)).value?.result_kind==='full'&&(await status(fut)).approval_status==='cancelled');
  ok('Repeated cancellation refused',/already been cancelled/.test((await cancel(D.uid,fut)).error?.message||''));
 });
 await scenario(async()=>{
  const under=await add(others[0].id,'annual',-3,4,'approved');
  const r=await cancel(D.uid,under);const s=await status(under);
  ok('Underway: today and earlier stay taken, tomorrow onward released',r.value?.result_kind==='partial'&&s.approval_status==='approved'&&s.e===today&&s.o===plus4);
  ok('Underway leave cannot be cancelled twice',Boolean((await cancel(D.uid,under)).error));
  const done=await add(others[1].id,'annual',-5,-1,'approved');ok('Completed leave cannot be cancelled',/Completed/.test((await cancel(D.uid,done)).error?.message||''));
  const lastDay=await add(others[2].id,'annual',-2,0,'approved');ok('Leave ending today has nothing to release',/No days remain/.test((await cancel(D.uid,lastDay)).error?.message||''));
  const self=await add(D.uid,'annual',80,81,'approved');ok('Self-cancellation through this route refused',/your own/.test((await cancel(D.uid,self)).error?.message||''));
  const mc=await add(others[3].id,'mc',80,81,'approved');ok('Non-annual leave refused',/annual/.test((await cancel(D.uid,mc)).error?.message||''));
 });
 await scenario(async()=>{
  const plain=await add(others[0].id,'annual',90,91,'approved');
  ok('Operation Manager cannot directly cancel an ordinary approval',/exception/.test((await cancel(om,plain)).error?.message||''));
  const exc=await add(others[1].id,'annual',90,91,'approved','',true);
  await p.query('update public.absence_notices set team=$2,overlap_exception=true where id=$1',[exc,D.team]);
  ok('Operation Manager cancels a recorded exception with a reason',(await cancel(om,exc)).value?.result_kind==='full');
 });
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
  assert.equal((await p.query("select pg_try_advisory_lock(hashtext('vecta-leave-authority')) l")).rows[0].l,true);
  const h0=await history(p);assert.equal(h0.length,PRE_COUNT);assert.equal(h0.at(-1).version,PRE_LAST);
  const before=await surface(p);
  const snapshot={project:APPROVED_REF,createdAt:new Date().toISOString(),head:expectedHead,history:h0,surface:before,
   functionsBefore:(await p.query("select pg_get_functiondef(p.oid) d from pg_proc p where proname in ('review_leave_request_secure')")).rows};
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
    assert.deepEqual(a.reviewAcl,before.reviewAcl,'review_leave_request_secure ACL changed');
    assert.equal(a.notices.length,before.notices.length,'Probe leave rows persisted');
    await p.query('insert into supabase_migrations.schema_migrations(version,name) values($1,$2)',[MIGRATION.version,MIGRATION.name]);
    await p.query(commit?'commit':'rollback');return count;
   }catch(e){await p.query('rollback');throw e;}
  }
  const dry=await pass(false);assert.deepEqual(await history(p),h0);
  const after=await surface(p);assert.deepEqual(after.other,before.other);assert.equal(after.notices.length,before.notices.length);
  console.log('DRY RUN PASSED: '+dry+' probes; history, leave rows and functions rollback verified.');
  if(live){const c=await pass(true);assert.equal((await history(p)).length,PRE_COUNT+1);console.log('LIVE PASSED: '+c+' probes; migration '+(PRE_COUNT+1)+' ending '+MIGRATION.version+'.');}
 }finally{await p.end();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error('LEAVE MIGRATION STOPPED:',e.message);process.exitCode=1;});
