import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {gitGates,environmentGates,connectVerified,APPROVED_REF} from './lib/run-gates.mjs';
import {encryptBackupPayload,decryptBackupPayload} from './lib/backup-crypto.mjs';

// Guarded rollout of canonical report scope, team history and DSE/SO acknowledgment. Usage (dry run, then --live):
//   node --env-file=<staging env> scripts/staging/apply-report-scope-migration.mjs --expected-head=<sha> --backup=<outside-repo>.enc.json [--live --confirm="<LIVE_PHRASE>"]
export const MIGRATION={version:'20261205000001',name:'report_canonical_scope_and_team_history',sha256:'925b2ef29cbf1efb3191a2fe9e48cc469454eda365fe3a75e21d29a69f6685cd'};
export const PRE_COUNT=116,PRE_LAST='20261203000006',BRANCH='fix/roster-canonical-save';
export const LIVE_PHRASE='APPLY REPORT CANONICAL SCOPE TO STAGING ddlctzbnqewubltcavkh';
const ROOT=path.resolve(import.meta.dirname,'../..');
const normal=x=>x.replace(/\r\n?/g,'\n');
const hash=x=>crypto.createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex');
const TABLES=['report_sec013','report_sec014','report_sec016','report_sec018','report_sec029','report_sec033','report_makeup','report_breakup'];
const ALLOWED=/^(create or replace function public\.(report_canonical_scope|get_report_submitter|can_acknowledge_report|audit_report_acknowledgement|dse_scope_recipients|deliver_dse_report_notifications_v2|notify_dse_of_report|enforce_report_operational_scope|list_team_submissions_secure)|revoke |grant |drop trigger if exists trg_(audit_report_acknowledgement|zz_enforce_report_operational_scope) on public\.report_|create trigger trg_(audit_report_acknowledgement|zz_enforce_report_operational_scope) (after|before) insert on public\.report_)/i;
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
 counts:(await p.query("select (select count(*) from public.report_sec016)::int a,(select count(*) from public.report_sec014)::int b,(select count(*) from public.central_reports_index)::int c,(select count(*) from public.user_notifications)::int n,(select count(*) from public.report_acknowledgements)::int k,(select count(*) from public.report_notification_failures)::int f")).rows[0],
 other:(await p.query("select p.oid::regprocedure::text sig,md5(pg_get_functiondef(p.oid)) h from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind='f' and p.proname not in ('report_canonical_scope','get_report_submitter','can_acknowledge_report','audit_report_acknowledgement','dse_scope_recipients','deliver_dse_report_notifications_v2','notify_dse_of_report','enforce_report_operational_scope','list_team_submissions_secure') order by 1")).rows,
 ackPolicies:(await p.query("select policyname,cmd,qual,with_check from pg_policies where tablename='report_acknowledgements' order by 1")).rows,
};}
async function asUser(p,uid,cb){
 await p.query('savepoint sp');
 try{await p.query("select set_config('request.jwt.claims',$1,true),set_config('role','authenticated',true)",[JSON.stringify({sub:uid,role:'authenticated'})]);return {value:await cb()};}
 catch(e){return {error:{code:e.code,message:e.message}};}
 finally{await p.query('rollback to savepoint sp');await p.query('release savepoint sp');}
}
// Same impersonation, but the effects are KEPT inside the outer rolled-back transaction (later probes depend on them).
async function keep(p,uid,cb){
 await p.query('savepoint kp');
 try{await p.query("select set_config('request.jwt.claims',$1,true),set_config('role','authenticated',true)",[JSON.stringify({sub:uid,role:'authenticated'})]);const value=await cb();await p.query("select set_config('role','postgres',true)");await p.query('release savepoint kp');return {value};}
 catch(e){await p.query('rollback to savepoint kp');await p.query('release savepoint kp');await p.query("select set_config('role','postgres',true)");return {error:{code:e.code,message:e.message}};}
}
async function reportColumns(p,table,over){
 const cols=(await p.query("select column_name,data_type from information_schema.columns where table_schema='public' and table_name=$1 and is_nullable='NO' and column_default is null",[table])).rows;
 const row={};
 for(const c of cols){
  if(c.column_name in over)continue;
  row[c.column_name]=c.data_type==='uuid'?crypto.randomUUID():c.data_type==='boolean'?false:/int|numeric|double/.test(c.data_type)?0:c.data_type==='date'?'2026-11-04':/^time/.test(c.data_type)&&!/stamp/.test(c.data_type)?'08:00':/timestamp/.test(c.data_type)?new Date().toISOString():c.data_type==='ARRAY'?'{}':c.data_type==='USER-DEFINED'?undefined:'[ROLLED-BACK SCOPE PROBE]';
 }
 const all={...row,...over};for(const k of Object.keys(all))if(all[k]===undefined)delete all[k];
 return all;
}
const insertSql=(table,all)=>{const keys=Object.keys(all);return {text:`insert into public.${table}(${keys.map(k=>'"'+k+'"').join(',')}) values(${keys.map((_,i)=>'$'+(i+1)).join(',')}) returning id`,values:keys.map(k=>all[k])};};
async function probes(p){
 let n=0;const ok=(name,c)=>{assert.ok(c,name);n++;console.log('PROBE PASS: '+name);};
 const asg=async(role,team,ent)=>(await p.query(`select a.id aid,a.profile_id uid from public.user_role_assignments a join public.role_definitions rd on rd.id=a.role_definition_id and rd.code=$1 join public.org_stations st on st.id=a.station_id and st.code='KUL - MAA' join public.org_teams t on t.id=a.team_id and t.name=$2 join public.profiles pr on pr.id=a.profile_id where pr.status='approved' and a.revoked_at is null order by a.profile_id`,[role,team])).rows;
 const charlieAso=await asg('aso','CHARLIE'),alphaAso=await asg('aso','ALPHA');
 const dseC=(await asg('dse','CHARLIE'))[0],dseA=(await asg('dse','ALPHA'))[0];
 assert.ok(charlieAso.length>=2&&alphaAso.length>=1&&dseC&&dseA,'Charlie ASOs, an Alpha ASO and both DSEs are required');
 const A1=charlieAso[0],A2=charlieAso[1],A3=alphaAso[0];
 const role=async code=>(await p.query("select a.profile_id uid from public.user_role_assignments a join public.role_definitions r on r.id=a.role_definition_id where r.code=$1 and a.revoked_at is null limit 1",[code])).rows[0]?.uid;
 const maaBoss=await role('maa_boss'),aaxBoss=await role('aax_boss');
 const outsider=(await p.query("select a.profile_id uid from public.user_role_assignments a join public.org_stations st on st.id=a.station_id and st.code not like 'KUL%' join public.profiles pr on pr.id=a.profile_id and pr.status='approved' where a.revoked_at is null limit 1")).rows[0].uid;
 // SO fixtures (rolled back): a Charlie SO and an Alpha SO are made from existing officers of those teams by copying their assignment with the SO role
 const soId=(await p.query("select id from public.role_definitions where code='so'")).rows[0].id;
 const mkSo=async a=>{await p.query(`insert into public.user_role_assignments(profile_id,role_definition_id,aoc_id,operating_entity_id,entity_membership_id,department_id,unit_id,hub_id,station_id,team_id,starts_at,granted_by,grant_reason) select profile_id,$2,aoc_id,operating_entity_id,entity_membership_id,department_id,unit_id,hub_id,station_id,team_id,now(),granted_by,'[ROLLED-BACK SO PROBE]' from public.user_role_assignments where id=$1`,[a.aid,soId]);return a.uid;};
 const soC=await mkSo(A2),soA=await mkSo(A3);
 await p.query("insert into public.duty_records(profile_id,station,duty_date,shift_code,check_in_at) values($1,'KUL - MAA',(now() at time zone 'Asia/Kuala_Lumpur')::date,coalesce((select shift_code from public.duty_records limit 1),'D'),now()) on conflict (profile_id,duty_date,shift_code) do update set check_in_at=now(),check_out_at=null",[A1.uid]);

 const file=async(table,over)=>{
  const all=await reportColumns(p,table,{profile_id:A1.uid,status:'submitted',station:'KUL - MAA',team:'CHARLIE',...over});
  const q=insertSql(table,all);
  const r=await keep(p,A1.uid,async()=>{const id=(await p.query(q.text,q.values)).rows[0].id;await p.query('select public.mark_report_ready_for_indexing($1,$2,0)',[table,id]);return id;});
  return r;
 };
 const sec016={cargo_hold_checked:'YES',do_infmd:'NO',staff_frisked:'YES',flight_type:'departure',aircraft_type:'A 320',sta_std:'13:00',reg_no:'9M-ZSC1',duty_date:'2026-11-05'};
 const ak=await file('report_sec016',{...sec016,flight:'AK5001'});
 ok('A Charlie officer files an AK (MAA) departure',Boolean(ak.value)&&!ak.error);
 const d7=await file('report_sec016',{...sec016,flight:'D75002',reg_no:'9M-ZSC2'});
 ok('The same officer files a D7 (AAX) departure',Boolean(d7.value)&&!d7.error);
 const stored=(await p.query("select id,operating_entity_code ent,org_station_id is not null s,org_team_id is not null t from public.report_sec016 where id=any($1::uuid[]) order by flight",[[ak.value,d7.value]])).rows;
 ok('The report entity comes from the flight prefix (AK is MAA, D7 is AAX) and the canonical station and team are stored',stored.length===2&&stored.find(r=>r.id===ak.value).ent==='MAA'&&stored.find(r=>r.id===d7.value).ent==='AAX'&&stored.every(r=>r.s&&r.t));
 const sec014=await file('report_sec014',{date_time_in:new Date().toISOString(),remark:'[ROLLED-BACK SCOPE PROBE]',acknowledgement:true});
 ok('A SEC014 from the same officer is filed',Boolean(sec014.value)&&!sec014.error);

 // ---- inconsistent station/team is refused for new reports ----
 const wrongStation=await file('report_sec016',{...sec016,flight:'AK5003',station:'KUL - AAX'});
 ok('A KUL - MAA CHARLIE officer cannot file a report with station KUL - AAX',/assigned station/.test(wrongStation.error?.message||''));
 const wrongTeam=await file('report_sec016',{...sec016,flight:'AK5004',team:'ALPHA'});
 ok('A Charlie officer cannot file a report for team ALPHA',/assigned team/.test(wrongTeam.error?.message||''));
 const wrong14=await file('report_sec014',{date_time_in:new Date().toISOString(),remark:'x',acknowledgement:true,station:'KUL - AAX'});
 ok('The same rule covers SEC014',Boolean(wrong14.error));

 // ---- alerts: canonical DSE of the team only, both entities, once ----
 await p.query('select public.process_report_index_queue(100)');
 const keyCount=async(rid,uid)=>(await p.query("select count(*)::int n from public.user_notifications where dedup_key=$1",['dse_report:report_sec016:'+rid+':'+uid])).rows[0].n;
 ok('The Charlie DSE is alerted to the AK report and the D7 report',(await keyCount(ak.value,dseC.uid))===1&&(await keyCount(d7.value,dseC.uid))===1);
 ok('No other team DSE is alerted',(await keyCount(ak.value,dseA.uid))===0&&(await keyCount(d7.value,dseA.uid))===0);
 await p.query("select public.deliver_dse_report_notifications_v2('report_sec016',$1,'x','AK5001')",[ak.value]);
 ok('A retry does not duplicate the alert',(await keyCount(ak.value,dseC.uid))===1);
 ok('No delivery failure was recorded for these reports',(await p.query("select count(*)::int n from public.report_notification_failures where source_id=any($1::uuid[])",[[ak.value,d7.value,sec014.value]])).rows[0].n===0);

 // ---- DSE and SO of Charlie see both entities and can acknowledge; others cannot ----
 const team=(uid,args='')=>asUser(p,uid,async()=>(await p.query('select * from public.list_team_submissions_secure(100,0,'+(args||'null,null,null,null,null,null,null')+')')).rows);
 for(const [label,uid] of [['DSE',dseC.uid],['SO',soC]]){
  const r=await team(uid);const mine=(r.value||[]).filter(x=>[ak.value,d7.value,sec014.value].includes(x.id));
  ok('The Charlie '+label+' Team Submission History lists the AK/MAA, the D7/AAX and the SEC014 reports',mine.length===3&&mine.some(x=>x.entity==='MAA')&&mine.some(x=>x.entity==='AAX'));
  ok('The '+label+' history rows carry number, type, officer, staff ID, flight, entity, station, team, time, status and acknowledgment state',mine.every(x=>x.report_no&&x.report_type&&x.staff_name&&x.staff_id&&x.entity!==undefined&&x.station==='KUL - MAA'&&x.team==='CHARLIE'&&x.submitted_at&&x.status==='submitted'&&x.acknowledged_at===null));
  ok('Every row of the '+label+' history belongs to KUL - MAA CHARLIE',(r.value||[]).every(x=>x.station==='KUL - MAA'&&x.team==='CHARLIE'));
 }
 const flt=await team(dseC.uid,"'sec016',null,null,'AAX',null,null,null");
 ok('The entity and type filters work',(flt.value||[]).length>=1&&(flt.value||[]).every(x=>x.entity==='AAX'&&x.report_type==='sec016'));
 for(const [label,uid] of [['ALPHA DSE',dseA.uid],['ALPHA SO',soA]]){
  const r=await team(uid);
  ok('The '+label+' sees none of the Charlie reports in the team history',(r.value||[]).every(x=>![ak.value,d7.value,sec014.value].includes(x.id)&&x.team==='ALPHA'));
 }
 const outs=await team(outsider);ok('A staff member who is not a DSE or SO is refused the team history',/available to a DSE or SO/.test(outs.error?.message||''));
 const sub=(uid,rt,id)=>asUser(p,uid,async()=>(await p.query('select public.can_acknowledge_report($1,$2) a',[rt,id])).rows[0].a);
 ok('The Charlie DSE and SO can acknowledge the AK and the D7 report',(await sub(dseC.uid,'sec016',ak.value)).value===true&&(await sub(dseC.uid,'sec016',d7.value)).value===true&&(await sub(soC,'sec016',ak.value)).value===true&&(await sub(soC,'sec016',d7.value)).value===true);
 ok('The Alpha DSE and SO cannot acknowledge them, and the outsider cannot',(await sub(dseA.uid,'sec016',ak.value)).value===false&&(await sub(soA,'sec016',d7.value)).value===false&&(await sub(outsider,'sec016',ak.value)).value===false);
 const view=(uid,id)=>asUser(p,uid,async()=>(await p.query("select id from public.get_report_by_source_secure('report_sec016',$1)",[id])).rows.length);
 ok('The Charlie DSE and SO open both reports by detail link',(await view(dseC.uid,ak.value)).value===1&&(await view(dseC.uid,d7.value)).value===1&&(await view(soC,ak.value)).value===1&&(await view(soC,d7.value)).value===1);
 ok('The Alpha DSE, Alpha SO and the outsider are refused the detail by direct call',Boolean((await view(dseA.uid,ak.value)).error)&&Boolean((await view(soA,d7.value)).error)&&Boolean((await view(outsider,ak.value)).error));
 const direct=await asUser(p,dseC.uid,async()=>(await p.query('select count(*)::int n from public.report_sec016 where id=any($1::uuid[])',[[ak.value,d7.value]])).rows[0].n);
 ok('Direct table reads still return only a person\'s own rows (no side door around the secured functions)',direct.value===0);

 // ---- bosses keep entity segregation ----
 ok('The MAA Boss opens the AK report and not the D7 report',(await view(maaBoss,ak.value)).value===1&&Boolean((await view(maaBoss,d7.value)).error));
 ok('The AAX Boss opens the D7 report and not the AK report',(await view(aaxBoss,d7.value)).value===1&&Boolean((await view(aaxBoss,ak.value)).error));

 // ---- acknowledgment: one record and one audit per action ----
 const ack=(uid,rt,id)=>keep(p,uid,async()=>(await p.query('insert into public.report_acknowledgements(report_type,report_id,acknowledged_by) values($1,$2,$3) returning id',[rt,id,uid])).rows[0].id);
 const denied=await ack(dseA.uid,'sec016',ak.value);
 ok('An Alpha DSE acknowledgment of a Charlie report is refused by row-level security',Boolean(denied.error));
 const good=await ack(dseC.uid,'sec016',ak.value);
 ok('The Charlie DSE acknowledges the AK report',Boolean(good.value));
 const audits=async id=>(await p.query("select count(*)::int n from public.phase8_audit_log where action='report_acknowledged' and entity_id=$1",[id])).rows[0].n;
 ok('Exactly one audit record exists for that acknowledgment',(await audits(good.value))===1);
 const again=await ack(soC,'sec016',ak.value);
 ok('A second acknowledgment of the same report is refused and adds no audit record',Boolean(again.error)&&(await p.query("select count(*)::int n from public.phase8_audit_log where action='report_acknowledged' and (detail->>'report_id')=$1",[ak.value])).rows[0].n===1);
 const soAck=await ack(soC,'sec016',d7.value);
 ok('The Charlie SO acknowledges the D7 report',Boolean(soAck.value));
 const after=await team(dseC.uid,"null,null,null,null,null,null,'acknowledged'");
 ok('The acknowledged filter and the history show who acknowledged',(after.value||[]).filter(x=>[ak.value,d7.value].includes(x.id)).length===2&&(after.value||[]).every(x=>x.acknowledged_at&&x.acknowledged_by_name));
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
  assert.equal((await p.query("select pg_try_advisory_lock(hashtext('vecta-report-scope')) l")).rows[0].l,true);
  const h0=await history(p);assert.equal(h0.length,PRE_COUNT);assert.equal(h0.at(-1).version,PRE_LAST);
  const before=await surface(p);
  const snapshot={project:APPROVED_REF,createdAt:new Date().toISOString(),head:expectedHead,history:h0,surface:before,
   functionsBefore:(await p.query("select proname,pg_get_functiondef(oid) d from pg_proc where proname in ('get_report_submitter','can_acknowledge_report','notify_dse_of_report')")).rows,
   failuresOpen:(await p.query("select id,source_table,source_id,error,created_at from public.report_notification_failures where resolved_at is null order by created_at")).rows};
  fs.mkdirSync(path.dirname(path.resolve(backupFile)),{recursive:true});
  fs.writeFileSync(backupFile,JSON.stringify(encryptBackupPayload(snapshot,process.env.VECTA_BACKUP_PASSPHRASE)),{flag:'wx',mode:0o600});
  assert.deepEqual(decryptBackupPayload(fs.readFileSync(backupFile,'utf8'),process.env.VECTA_BACKUP_PASSPHRASE),JSON.parse(JSON.stringify(snapshot)));
  console.log('Scoped encrypted backup written and authenticated; no credentials printed.');
  async function pass(commit){
   await p.query('begin isolation level serializable');
   try{
    await p.query("set local lock_timeout='10s'; set local statement_timeout='180s'");
    assert.deepEqual(await history(p),h0);
    await p.query(sql);
    await p.query('savepoint all_probes');
    const count=await probes(p);
    await p.query('rollback to savepoint all_probes');await p.query('release savepoint all_probes');
    const a=await surface(p);
    assert.deepEqual(a.other,before.other,'Unrelated functions changed');
    assert.deepEqual(a.counts,before.counts,'Probe rows persisted');
    assert.deepEqual(a.ackPolicies,before.ackPolicies,'Acknowledgment policies changed');
    await p.query('insert into supabase_migrations.schema_migrations(version,name) values($1,$2)',[MIGRATION.version,MIGRATION.name]);
    await p.query(commit?'commit':'rollback');return count;
   }catch(e){await p.query('rollback');throw e;}
  }
  const dry=await pass(false);assert.deepEqual(await history(p),h0);assert.deepEqual(await surface(p),before);
  console.log('DRY RUN PASSED: '+dry+' probes; history, rows, policies and functions rollback verified.');
  if(live){const c=await pass(true);assert.equal((await history(p)).length,PRE_COUNT+1);console.log('LIVE PASSED: '+c+' probes; migration '+(PRE_COUNT+1)+' ending '+MIGRATION.version+'.');}
 }finally{await p.end();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error('REPORT SCOPE MIGRATION STOPPED:',e.message);process.exitCode=1;});
