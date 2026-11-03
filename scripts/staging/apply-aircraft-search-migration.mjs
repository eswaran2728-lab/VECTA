import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {gitGates,environmentGates,connectVerified,APPROVED_REF} from './lib/run-gates.mjs';
import {encryptBackupPayload,decryptBackupPayload} from './lib/backup-crypto.mjs';

// Guarded rollout of Aircraft Search Verification. Usage (dry run, then --live):
//   node --env-file=<staging env> scripts/staging/apply-aircraft-search-migration.mjs --expected-head=<sha> --backup=<outside-repo>.enc.json [--live --confirm="<LIVE_PHRASE>"]
export const MIGRATION={version:'20261203000004',name:'aircraft_search_verification',sha256:'2a0e71d79403e00ff856b75bacf1e804944f587eea9a99ccd9e27d1bc172b478'};
export const PRE_COUNT=113,PRE_LAST='20261203000003',BRANCH='fix/roster-canonical-save';
export const LIVE_PHRASE='APPLY AIRCRAFT SEARCH VERIFICATION TO STAGING ddlctzbnqewubltcavkh';
const ROOT=path.resolve(import.meta.dirname,'../..');
const normal=x=>x.replace(/\r\n?/g,'\n');
const hash=x=>crypto.createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex');
const ALLOWED=/^(alter table public\.bay_board|create table if not exists public\.aircraft_search_records|create index if not exists aircraft_search_records_|alter table public\.aircraft_search_records|revoke |grant |create policy "aircraft_search_records |create or replace function public\.(aircraft_search_|start_aircraft_search_secure|finish_aircraft_search_secure|attach_search_to_sec029|review_aircraft_search_secure|preview_departure_search_secure|apply_departure_search_rules))/i;
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
 counts:(await p.query("select (select count(*) from public.bay_board)::int b,(select count(*) from public.report_sec029)::int s29,(select count(*) from public.report_sec016)::int s16,(select count(*) from public.user_notifications)::int n")).rows[0],
 bayColumns:(await p.query("select column_name from information_schema.columns where table_schema='public' and table_name='bay_board' order by 1")).rows,
 other:(await p.query("select p.oid::regprocedure::text sig,md5(pg_get_functiondef(p.oid)) h from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind='f' and p.proname !~ '^(aircraft_search_|start_aircraft_search|finish_aircraft_search|attach_search_to_sec029|review_aircraft_search|preview_departure_search|apply_departure_search)' order by 1")).rows,
};}
async function asUser(p,uid,cb){
 await p.query('savepoint sp');
 try{await p.query("select set_config('request.jwt.claims',$1,true),set_config('role','authenticated',true)",[JSON.stringify({sub:uid,role:'authenticated'})]);return {value:await cb()};}
 catch(e){return {error:{code:e.code,message:e.message}};}
 finally{await p.query('rollback to savepoint sp');await p.query('release savepoint sp');}
}
// Same impersonation but the effects are KEPT (inside the outer rolled-back transaction); used where a later probe depends on the earlier writes.
async function asUserKeep(p,uid,cb){
 await p.query("select set_config('request.jwt.claims',$1,true),set_config('role','authenticated',true)",[JSON.stringify({sub:uid,role:'authenticated'})]);
 let failed=null;try{return {value:await cb()};}catch(e){failed=e;console.error('probe step failed:',e.message);throw e;}finally{if(!failed)await p.query("select set_config('role','postgres',true)");}
}
// Inserts a row filling every NOT NULL column that has no default with a type-appropriate value, then applies overrides.
async function fixture(p,table,over){
 const cols=(await p.query("select column_name,data_type,udt_name from information_schema.columns where table_schema='public' and table_name=$1 and is_nullable='NO' and column_default is null",[table])).rows;
 const row={};
 for(const c of cols){
  if(c.column_name in over)continue;
  row[c.column_name]=c.data_type==='uuid'?crypto.randomUUID():c.data_type==='boolean'?false:/int|numeric|double/.test(c.data_type)?0:c.data_type==='date'?'2026-11-03':/^time/.test(c.data_type)&&!/stamp/.test(c.data_type)?'08:00':/timestamp/.test(c.data_type)?new Date().toISOString():c.data_type==='ARRAY'?'{}':c.data_type==='jsonb'?'{}':c.data_type==='USER-DEFINED'?undefined:'[ROLLED-BACK PROBE]';
 }
 const all={...row,...over};for(const k of Object.keys(all))if(all[k]===undefined)delete all[k];
 const keys=Object.keys(all);
 const r=await p.query(`insert into public.${table}(${keys.map(k=>'"'+k+'"').join(',')}) values(${keys.map((_,i)=>'$'+(i+1)).join(',')}) returning id`,keys.map(k=>all[k]));
 return r.rows[0].id;
}
async function probes(p){
 let n=0;const ok=(name,c)=>{assert.ok(c,name);n++;console.log('PROBE PASS: '+name);};
 const dse=(await p.query(`select a.profile_id uid,st.code station,m.operating_entity_id eid,oe.code ent from public.user_role_assignments a join public.role_definitions r on r.id=a.role_definition_id
  join public.org_stations st on st.id=a.station_id join public.user_entity_memberships m on m.id=a.entity_membership_id and m.status='active' and m.revoked_at is null
  join public.operating_entities oe on oe.id=m.operating_entity_id join public.profiles pr on pr.id=a.profile_id
  where r.code in ('dse','so','sso') and pr.status='approved' and a.revoked_at is null and (a.ends_at is null or a.ends_at>now()) order by a.profile_id`)).rows;
 assert.ok(dse.length>=1,'A reviewer-eligible officer is required');
 const R=dse[0];
 const people=(await p.query(`select pr.id,pr.staff_no from public.user_role_assignments a join public.role_definitions rd on rd.id=a.role_definition_id and rd.code='aso' join public.org_stations st on st.id=a.station_id and st.code=$1
  join public.user_entity_memberships m on m.id=a.entity_membership_id and m.status='active' and m.revoked_at is null join public.profiles pr on pr.id=a.profile_id
  where pr.status='approved' and a.revoked_at is null and m.operating_entity_id=$2 and pr.id<>$3 order by pr.id limit 2`,[R.station,R.eid,R.uid])).rows;
 assert.ok(people.length>=2,'Two ASOs at the reviewer station and entity are required');
 const [S,S2]=people;
 const St=R.station;
 const openDuty=async id=>p.query("insert into public.duty_records(profile_id,station,duty_date,shift_code,check_in_at) values($1,$2,(now() at time zone 'Asia/Kuala_Lumpur')::date,coalesce((select shift_code from public.duty_records limit 1),'D'),now()) on conflict (profile_id,duty_date,shift_code) do update set check_in_at=now(),check_out_at=null,station=excluded.station",[id,St]);
 await openDuty(S.id);await openDuty(R.uid);
 const bay=async(reg,ground,towed=false)=>(await p.query("insert into public.bay_board(station,reg_no,aircraft_type,bay,flight,on_ground_since,is_manual,created_by,towed_from_hangar) values($1,$2,'A320','10','D71',now()-($3||' minutes')::interval,true,$4,$5) returning id",[St,reg,String(ground),S.id,towed])).rows[0].id;
 const boardRow=async id=>(await p.query('select search_state,cleared_at is not null cleared,departed_without_confirmed_search dep from public.bay_board where id=$1',[id])).rows[0];
 const start=(uid,reg='9M-ZP1',flight='D7100',type='A320',fix=[3.1,101.7,10],reason=null)=>asUser(p,uid,async()=>(await p.query('select public.start_aircraft_search_secure($1,$2,$3,$4,$5,$6,$7,$8) id',[flight,reg,St,type,fix?.[0]??null,fix?.[1]??null,fix?.[2]??null,reason])).rows[0].id);

 // ---- recording ----
 const noDuty=await start(S2.id);ok('Search cannot start when not checked in',/checked in/.test(noDuty.error?.message||''));
 const noGps=await start(S.id,'9M-ZP1','D7100','A320',null,null);ok('No GPS and no reason is refused',/reason is required/.test(noGps.error?.message||''));
 const rec=await asUser(p,S.id,async()=>{
  const id=(await p.query("select public.start_aircraft_search_secure('D7100','9M-ZP1',$1,'A320',3.1,101.7,10,null) id",[St])).rows[0].id;
  const again=(await p.query("select public.start_aircraft_search_secure('D7100','9M-ZP1',$1,'A320',3.1,101.7,10,null) id",[St])).rows[0].id;
  await p.query("select set_config('role','postgres',true)");
  const row=(await p.query('select presence_status,started_at is not null st,station,entity from public.aircraft_search_records where id=$1',[id])).rows[0];
  return {id,again,row};
 });
 ok('Start records server time, reported GPS and the entity, and a repeat start reuses the open record',rec.value&&rec.value.id===rec.value.again&&rec.value.row.presence_status==='reported'&&rec.value.row.st&&rec.value.row.entity===R.ent);
 const gpsOff=await asUser(p,S.id,async()=>{const id=(await p.query("select public.start_aircraft_search_secure('D7101','9M-ZP2',$1,'A320',null,null,null,'Phone GPS switched off at the bay') id",[St])).rows[0].id;await p.query("select set_config('role','postgres',true)");return (await p.query('select presence_status from public.aircraft_search_records where id=$1',[id])).rows[0].presence_status;});
 ok('GPS unavailable with a reason is accepted and marked unverified',gpsOff.value==='unverified');
 const dur=async(type,seconds)=>asUser(p,S.id,async()=>{
  const id=(await p.query("select public.start_aircraft_search_secure('D7102','9M-ZP3',$1,$2,3.1,101.7,10,null) id",[St,type])).rows[0].id;
  await p.query("select set_config('role','postgres',true)");await p.query("update public.aircraft_search_records set started_at=clock_timestamp()-($2||' seconds')::interval where id=$1",[id,String(seconds)]);await p.query("select set_config('role','authenticated',true)");
  return (await p.query('select * from public.finish_aircraft_search_secure($1,3.1,101.7,10,null)',[id])).rows[0];});
 ok('A320 minimum 30 minutes: 30:30 passes, 29:00 is below minimum',(await dur('A320',1830)).value?.below_minimum===false&&(await dur('A320',1740)).value?.below_minimum===true);
 ok('A330 minimum 45 minutes: 45:30 passes, 44:00 is below minimum',(await dur('A330',2730)).value?.below_minimum===false&&(await dur('A330',2640)).value?.below_minimum===true);

 // ---- full turnaround: required, linked, both gaps, review ----
 const flow=async({reg,flight,ground,sta,std='13:00',towed=false,searchAfterMin=null,reasonBelow=null,skipSearch=false,dupSearch=false})=>{
  const board=await bay(reg,ground,towed);
  let recId=null,sec029=null;
  if(!skipSearch){
   recId=(await asUserKeep(p,S.id,async()=>(await p.query("select public.start_aircraft_search_secure($1,$2,$3,'A320',3.1,101.7,10,null) id",[flight,reg,St])).rows[0].id)).value;
   await p.query("update public.aircraft_search_records set started_at=clock_timestamp()-interval '31 minutes' where id=$1",[recId]);
   await asUserKeep(p,S.id,()=>p.query("select * from public.finish_aircraft_search_secure($1,3.1,101.7,10,null)",[recId]));
   await p.query("update public.aircraft_search_records set finished_at=clock_timestamp() where id=$1 and finished_at is null",[recId]);
   sec029=await fixture(p,'report_sec029',{profile_id:S.id,status:'submitted',station:St,team:'ALPHA',flight_no:flight,aircraft_registration:reg,aircraft_type:'A320',assisted_by_id:'NOPE',pic_informed:'YES',declaration:'I CERTIFY THAT THE ABOVE SEARCH HAS BEEN CARRIED OUT AND NO DISCREPANCY WAS FOUND.',acknowledgement:true,operating_entity_code:R.ent,submitted_at:new Date(Date.now()-(searchAfterMin??90)*60000).toISOString()});
   const att=await asUserKeep(p,S.id,async()=>(await p.query('select public.attach_search_to_sec029($1,$2,null,null) id',[sec029,recId])).rows[0].id);
   if(att.error)throw new Error('attach failed: '+att.error.message);
  }
  const dep=await fixture(p,'report_sec016',{profile_id:S2.id,status:'submitted',station:St,team:'ALPHA',flight,reg_no:reg,flight_type:'departure',cargo_hold_checked:'YES',do_infmd:'NO',staff_frisked:'YES',aircraft_type:'A 320',sta_std:sta??std,operating_entity_code:R.ent,submitted_at:new Date().toISOString()});
  const out=await asUserKeep(p,S2.id,async()=>{const r=(await p.query('select public.apply_departure_search_rules($1,$2,$3) a',[dep,towed,'delayed by ramp'])).rows[0].a;await p.query("select set_config('role','postgres',true)");return r;});
  if(out.error)throw new Error('apply failed: '+out.error.message);
  return {board,recId,sec029,dep,a:out.value};
 };
 const hhmm=(minOffset)=>(new Date(Date.now()+8*3600000+minOffset*60000)).toISOString().slice(11,16);

 const notReq=await flow({reg:'9M-ZN1',flight:'D7200',ground:120,skipSearch:true,sta:hhmm(60)});
 if(process.env.ACS_DEBUG)console.log(JSON.stringify(notReq.a),JSON.stringify(await boardRow(notReq.board)));
 ok('Under four hours, same day, not towed: no search required, board cleared',notReq.a.required===false&&(await boardRow(notReq.board)).cleared===true&&(await boardRow(notReq.board)).search_state==='not_required');
 const tow=await flow({reg:'9M-ZN2',flight:'D7201',ground:60,towed:true,skipSearch:true,sta:hhmm(60)});
 ok('Towed from a hangar requires a search; missing search is recorded as an exception and the board entry stays',tow.a.required===true&&tow.a.missing===true&&(await boardRow(tow.board)).cleared===false&&(await boardRow(tow.board)).dep===true);
 const four=await flow({reg:'9M-ZN3',flight:'D7202',ground:240,skipSearch:true,sta:hhmm(60)});
 ok('On ground 4 hours exactly requires a search',four.a.required===true&&four.a.reasons.includes('ground_4h'));
 const under=await flow({reg:'9M-ZN4',flight:'D7203',ground:239,skipSearch:true,sta:hhmm(60)});
 ok('Just under 4 hours does not require a search',under.a.required===false||!under.a.reasons.includes('ground_4h'));

 const good=await flow({reg:'9M-ZG1',flight:'D7300',ground:360,searchAfterMin:120,sta:hhmm(60)});
 ok('A SEC029 for the same flight and aircraft links to the departure, with both gaps computed from its submission',good.a.linked_record_id===good.recId&&good.a.std_gap_minutes>0&&good.a.departure_gap_minutes>0);
 ok('A linked, unconfirmed search keeps the board entry (SEC029 submission alone never clears it)',(await boardRow(good.board)).cleared===false&&(await boardRow(good.board)).search_state!=='confirmed');
 const late=await flow({reg:'9M-ZG2',flight:'D7301',ground:360,searchAfterMin:20,sta:hhmm(10)});
 ok('D7: a search 10 minutes before the entered STD is flagged late',late.a.std_flag===true&&late.a.flagged===true);
 const lateFiling=await flow({reg:'9M-ZG3',flight:'D7302',ground:700,searchAfterMin:600,sta:hhmm(-540)});
 ok('Delaying the SEC016 does not hide a search that missed the STD threshold',lateFiling.a.std_flag===true&&lateFiling.a.departure_flag===false);
 const okTimes=await flow({reg:'9M-ZG4',flight:'D7303',ground:360,searchAfterMin:120,sta:hhmm(60)});
 ok('A search well ahead of STD and of the SEC016 is not flagged',okTimes.a.flagged===false);
 const other=await flow({reg:'9M-ZG5',flight:'D7304',ground:360,sta:hhmm(60)});
 await p.query("update public.aircraft_search_records set registration='9M-OTHER' where id=$1",[other.recId]);
 const re=(await p.query('select public.aircraft_search_departure_assessment($1,$2,$3,$4,$5,$6,false,now(),null) a',[St,R.ent,'9M-ZG5','D7304','13:00','A320'])).rows[0].a;
 ok('A SEC029 for another aircraft is never evidence',re&&re.missing===true);
 const flightMismatch=(await p.query('select public.aircraft_search_departure_assessment($1,$2,$3,$4,$5,$6,false,now(),null) a',[St,R.ent,'9M-ZG1','D7999','13:00','A320'])).rows[0].a;
 ok('A SEC029 for another flight is never evidence',flightMismatch.linked_record_id===null);

 // ---- review ----
 const self=await asUser(p,S.id,async()=>(await p.query("select * from public.review_aircraft_search_secure($1,'confirm','looks fine')",[good.recId])).rows[0]);
 ok('Self-review is refused',self.value?.ok===false&&self.value.code!=='OK');
 const offDutyReviewer=dse.find(x=>x.station===St&&x.uid!==R.uid);assert.ok(offDutyReviewer,'A second reviewer-eligible officer (not checked in) is required');
 const noDutyRev=await asUser(p,offDutyReviewer.uid,async()=>(await p.query("select * from public.review_aircraft_search_secure($1,'confirm','looks fine')",[good.recId])).rows[0]);
 ok('An off-duty reviewer is refused',noDutyRev.value?.code==='OFF_DUTY');
 const aso=await asUser(p,S2.id,async()=>(await p.query("select * from public.review_aircraft_search_secure($1,'confirm','looks fine')",[good.recId])).rows[0]);
 ok('A non-supervisory officer is refused',aso.value?.code==='NOT_ELIGIBLE');
 const decide=await asUser(p,R.uid,async()=>{
  const first=(await p.query("select * from public.review_aircraft_search_secure($1,'confirm','Searched and confirmed on arrival of the team')",[good.recId])).rows[0];
  const second=(await p.query("select * from public.review_aircraft_search_secure($1,'confirm','again')",[good.recId])).rows[0];
  await p.query("select set_config('role','postgres',true)");
  const b=await boardRow(good.board);
  return {first,second,b};
 });
 ok('A different on-duty SO/SSO/DSE of the same station and entity confirms; the board then shows confirmed and clears',decide.value?.first.ok===true&&decide.value.b.search_state==='confirmed'&&decide.value.b.cleared===true);
 ok('A second decision on the same search is refused',decide.value?.second.code==='ALREADY_DECIDED');
 const flaggedNeedsNote=await asUser(p,R.uid,async()=>(await p.query("select * from public.review_aircraft_search_secure($1,'confirm',null)",[late.recId])).rows[0]);
 ok('A flagged search cannot be confirmed without a note',flaggedNeedsNote.value?.code==='NOTE_REQUIRED');
 const missingConfirm=await asUser(p,R.uid,async()=>(await p.query("select * from public.review_aircraft_search_secure($1,'confirm','x1234')",[(await p.query("select id from public.aircraft_search_records where departure_report_id=$1 and kind='missing'",[tow.dep])).rows[0].id])).rows[0]);
 ok('A missing search cannot be confirmed, only recorded as an exception',missingConfirm.value?.code==='NO_SEARCH');
 const missingExc=await asUser(p,R.uid,async()=>(await p.query("select * from public.review_aircraft_search_secure($1,'exception','No search was recorded for the tow')",[(await p.query("select id from public.aircraft_search_records where departure_report_id=$1 and kind='missing'",[tow.dep])).rows[0].id])).rows[0]);
 ok('An exception with a note is recorded',missingExc.value?.ok===true);
 ok('Historical default: records without live evidence default to historical_unverified',(await p.query("select column_default from information_schema.columns where table_name='aircraft_search_records' and column_name='presence_status'")).rows[0].column_default.includes('historical_unverified'));
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
  assert.equal((await p.query("select pg_try_advisory_lock(hashtext('vecta-aircraft-search')) l")).rows[0].l,true);
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
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error('AIRCRAFT SEARCH MIGRATION STOPPED:',e.message);process.exitCode=1;});
