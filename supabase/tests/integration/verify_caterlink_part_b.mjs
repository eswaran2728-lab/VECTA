// CaterLink Part B (In-flight Security Post) -- record_caterlink_part_b_secure() on native PostgreSQL (20261107000001).
// Authorization (server-derived actor, approved profile, station-operator assignment at the movement's station, scan capability, duty),
// workflow state, seal / whitelist verification, escalation, idempotency, immutability, audit, notification, direct-write denial.
import pg from 'pg';
import { assertDisposableLocalTarget } from './safeguards.mjs';

const { Client } = pg;
let failures = 0;
let passes = 0;
const assert = (c, m) => { if (!c) { failures += 1; console.log('FAIL:', m); } else { passes += 1; console.log('PASS:', m); } };

const pgConfig = { host: process.env.PGHOST || '127.0.0.1', port: parseInt(process.env.PGPORT || '55433', 10), user: process.env.PGUSER || 'postgres', password: process.env.PGPASSWORD || undefined };
const goldenDb = process.env.PGDATABASE || 'vecta_phase6_test';
const runDb = 'vecta_part_b_run';
assertDisposableLocalTarget(pgConfig, goldenDb, runDb);

const admin = new Client({ ...pgConfig, database: 'postgres' });
await admin.connect();
await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${runDb}' and pid <> pg_backend_pid();`);
await admin.query(`drop database if exists ${runDb};`);
await admin.query(`create database ${runDb} template ${goldenDb};`);
await admin.end();

const db = new Client({ ...pgConfig, database: runDb });
await db.connect();
await db.query('set check_function_bodies = off;');
await db.query(`
  create or replace function pg_temp.sim_user(p uuid) returns void language plpgsql as $$
  begin perform set_config('request.jwt.claims', json_build_object('sub', p::text, 'role', 'authenticated')::text, false); perform set_config('role', 'authenticated', false); end; $$;
  create or replace function pg_temp.sim_service() returns void language plpgsql as $$
  begin perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, false); perform set_config('role', 'service_role', false); end; $$;`);
const sup = () => db.query('select pg_temp.sim_service();');
const one = async (sql, p) => (await db.query(sql, p)).rows[0];
const rows = async (sql, p) => (await db.query(sql, p)).rows;
await db.query('begin;');
await sup();

const myAoc = (await one("select id from public.aocs where code = 'MY';")).id;
const maa = (await one("select id from public.operating_entities where aoc_id = $1 and code = 'MAA';", [myAoc])).id;
const dept = async (code) => (await one('select id from public.departments where aoc_id = $1 and code = $2;', [myAoc, code])).id;
const opsDept = await dept('operation'); const clDept = await dept('caterlink'); const enfDept = await dept('enforcement');
const profUnit = (await one("select u.id from public.units u join public.departments d on d.id = u.department_id where d.code = 'enforcement' and d.aoc_id = $1 and u.code = 'profiling';", [myAoc])).id;
const roles = new Map((await rows('select id, code from public.role_definitions;')).map((r) => [r.code, r.id]));
const station = async (code) => one('select id, hub_id, code from public.org_stations where code = $1;', [code]);
const pen = await station('PEN'); const jhb = await station('JHB'); const kul = await station('KUL - MAA'); const btu = await station('BTU');
const teamOf = async (st) => { await db.query("insert into public.org_teams (station_id, name) values ($1, 'ALPHA') on conflict (station_id, name) do nothing;", [st.id]); return (await one("select id from public.org_teams where station_id = $1 and name = 'ALPHA';", [st.id])).id; };
let seq = 0xa100;
const nextId = () => `00000000-0000-0000-0000-${(++seq).toString(16).padStart(12, '0')}`;

async function person(label, role, { st = null, status = 'approved' } = {}) {
  const id = nextId();
  await db.query('insert into auth.users (id, email) values ($1, $2);', [id, `pb-${label}@example.test`]);
  await db.query("insert into public.profiles (id, email, name, staff_no, role, status) values ($1,$2,$3,$4,'ASO',$5) on conflict (id) do update set status = excluded.status, name = excluded.name, staff_no = excluded.staff_no;", [id, `pb-${label}@example.test`, `PB ${label}`, `PB-${label}`.slice(0, 20), status]);
  const ins = (cols, vals) => db.query(`insert into public.user_role_assignments (profile_id, role_definition_id, starts_at${cols ? ', ' + cols : ''}) values ($1,$2,$3${vals.map((_, i) => `,$${i + 4}`).join('')});`, [id, roles.get(role), new Date(Date.now() - 86400000).toISOString(), ...vals]);
  const member = async () => (await one("insert into public.user_entity_memberships (profile_id, aoc_id, operating_entity_id, status, is_primary) values ($1,$2,$3,'active',true) returning id;", [id, myAoc, maa])).id;
  if (role === 'caterlink_management') await ins('aoc_id, department_id', [myAoc, clDept]);
  else if (role === 'operation_manager') await ins('aoc_id, department_id', [myAoc, opsDept]);
  else if (role === 'profiling_aso') await ins('aoc_id, department_id, unit_id, hub_id, station_id, team_id, entity_membership_id', [myAoc, enfDept, profUnit, st.hub_id, st.id, await teamOf(st), await member()]);
  else if (st) await ins('aoc_id, department_id, hub_id, station_id, team_id, entity_membership_id', [myAoc, opsDept, st.hub_id, st.id, await teamOf(st), await member()]);
  return id;
}
const asUser = async (u, sql, p = []) => { await db.query('select pg_temp.sim_user($1)', [u]); try { return await rows(sql, p); } finally { await sup(); } };
const failsWith = async (u, sql, p = []) => {
  await db.query('select pg_temp.sim_user($1)', [u]);
  await db.query('savepoint f');
  try { await db.query(sql, p); await db.query('rollback to savepoint f'); return null; }
  catch (e) { await db.query('rollback to savepoint f'); return e.message; }
  finally { await sup(); }
};

// ------------------------------------------------------------------ fixtures
const asoPen = await person('asopen', 'aso', { st: pen });
const asoPen2 = await person('asopen2', 'aso', { st: pen });
const asoPenNoDuty = await person('asopennoduty', 'aso', { st: pen });
const asoJhb = await person('asojhb', 'aso', { st: jhb });
const asoKul = await person('asokul', 'aso', { st: kul });
const asoBtu = await person('asobtu', 'aso', { st: btu });
const profAso = await person('profaso', 'profiling_aso', { st: pen });
const pending = await person('pending', 'aso', { st: pen, status: 'pending' });
const noAssign = await person('noassign', 'aso');
const clMgmt = await person('clmgmt', 'caterlink_management');
const opMgr = await person('opmgr', 'operation_manager');
const today = (await one("select (now() at time zone 'Asia/Kuala_Lumpur')::date::text d")).d;
for (const u of [asoPen, asoPen2, asoJhb, asoKul, asoBtu, profAso, pending]) {
  await db.query("insert into public.duty_records (profile_id, station, duty_date, shift_code, check_in_at, status) select $1, 'PEN', $2::date, 'PB', now(), 'present' where exists (select 1 from public.stations where code = 'PEN');", [u, today]);
}
const co = (await one("insert into public.catering_companies (name, code, aoc_id, status, is_active, effective_from) values ('PB Caterer', 'PBC', $1, 'active', true, current_date - 1) returning id;", [myAoc])).id;
await db.query("insert into public.vehicles (vehicle_number, catering_company_id, aoc_id, status, is_active, effective_from) values ('PB1234A', $1, $2, 'active', true, current_date - 1);", [co, myAoc]);
await db.query("insert into public.drivers (name, staff_id, catering_company_id, aoc_id, status, is_active, effective_from) values ('PB Driver', 'PBD001', $1, $2, 'active', true, current_date - 1);", [co, myAoc]);
const creator = nextId();
await db.query("insert into auth.users (id, email) values ($1,'pb-creator@example.test');", [creator]);
await db.query("insert into public.profiles (id, email, name, staff_no, role, status) values ($1,'pb-creator@example.test','PB Creator','PB-CR','ASO','approved') on conflict (id) do update set status = 'approved';", [creator]);

let txn = 0;
const SEAL = { number: 'PB-SEAL-1', color: 'BLUE' };
async function makeTx(st, { direction = 'OUTBOUND', status = 'CREATED' } = {}) {
  const id = nextId();
  txn += 1;
  await db.query('reset role;');
  await db.query('set session_replication_role = replica;');
  await db.query(`insert into public.transactions (id, transaction_number, aoc_id, direction, vehicle_number, driver_name, driver_id, seal_number, status, route, origin_station_id, flight_number, created_by)
    values ($1,$2,$3,$4,'PB1234A','PB Driver','PBD001','S',$5,'AIRCRAFT',$6,'AK703',$7);`, [id, `TX-PB-${txn}`, myAoc, direction, status, st.id, creator]);
  const sealId = (await one("insert into public.seals (transaction_id, seal_number, seal_type, seal_color) values ($1,$2,'TRUCK_SEAL',$3) returning id;", [id, SEAL.number, SEAL.color])).id;
  await db.query('set session_replication_role = origin;');
  await sup();
  return { id, sealId };
}
const SIG = 'part-b/sig-test.png';
const HASH = 'a'.repeat(64);
const call = async (user, tx, o = {}) => {
  const args = {
    veh: true, drv: true, entries: { [tx.sealId]: SEAL.number }, colors: { [tx.sealId]: SEAL.color }, vehicle: 'pb1234a', dname: 'PB Driver', did: 'pbd001',
    sig: SIG, hash: HASH, remarks: 'ok', result: 'PASS', reason: null, ...o,
  };
  return failsOrRows(user, args, tx);
};
async function failsOrRows(user, a, tx) {
  await db.query('select pg_temp.sim_user($1)', [user]);
  await db.query('savepoint c');
  try {
    const r = await rows('select * from public.record_caterlink_part_b_secure($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13);',
      [tx.id, a.veh, a.drv, JSON.stringify(a.entries), JSON.stringify(a.colors), a.vehicle, a.dname, a.did, a.sig, a.hash, a.remarks, a.result, a.reason]);
    await db.query('release savepoint c');
    return { ok: true, row: r[0] };
  } catch (e) { await db.query('rollback to savepoint c'); return { ok: false, err: e.message }; }
  finally { await sup(); }
}
const status = async (tx) => (await one('select status from public.transactions where id = $1', [tx.id])).status;
const pbCount = async (tx) => (await one('select count(*)::int n from public.part_b_c where transaction_id = $1', [tx.id])).n;

console.log('=== Part B: happy path ===');
const t1 = await makeTx(pen);
const r1 = await call(asoPen, t1);
assert(r1.ok && r1.row.outcome === 'APPROVED' && r1.row.transaction_status === 'INFLIGHT_POST_APPROVED' && r1.row.is_new === true, 'PEN officer records a valid Part B: APPROVED, transaction -> INFLIGHT_POST_APPROVED');
const rec = await one('select * from public.part_b_c where transaction_id = $1', [t1.id]);
assert(rec.checkpoint_stage === 'B' && rec.result === 'PASS' && rec.completed_by === asoPen && rec.avsec_name === 'PB asopen' && rec.avsec_staff_id === 'PB-asopen', 'the officer name and staff number come from the profile, the actor from auth.uid() (nothing client-supplied)');
assert(rec.observed_vehicle_number === 'PB1234A' && rec.observed_driver_id === 'pbd001' && rec.checkpoint_date !== null && rec.checkpoint_time !== null && rec.seal_verified === true, 'observed vehicle (normalised), driver and a server-side date/time are stored');
assert((await one("select count(*)::int n from public.seal_verifications where seal_id = $1 and checkpoint = 'INFLIGHT_POST' and matched", [t1.sealId])).n === 1, 'the seal verification trail is written (matched)');
assert((await one("select count(*)::int n from public.phase8_audit_log where action = 'caterlink_part_b_record' and entity_id = $1", [t1.id])).n === 1, 'the record is audited');
assert((await one("select count(*)::int n from public.caterlink_incidents where transaction_id = $1", [t1.id])).n === 0, 'a PASS raises no incident');

console.log('=== idempotency / repeat ===');
const r1b = await call(asoPen, t1);
assert(r1b.ok && r1b.row.outcome === 'ALREADY_RECORDED' && r1b.row.is_new === false && r1b.row.part_id === r1.row.part_id, 'the same officer repeating gets the existing record (no second one)');
assert(await pbCount(t1) === 1 && await status(t1) === 'INFLIGHT_POST_APPROVED', 'still exactly one record and one state advance');
const r1c = await call(asoPen2, t1);
assert(!r1c.ok && /already been recorded/.test(r1c.err), 'a different officer cannot record it again');

console.log('=== authorization (uniform refusal) ===');
const t2 = await makeTx(pen);
const denial = async (label, user, tx, re = /not available at your station/) => {
  const r = await call(user, tx);
  assert(!r.ok && re.test(r.err) && await pbCount(tx) === 0 && await status(tx) === 'CREATED', `${label}: refused, nothing written`);
};
await denial('an officer at ANOTHER station (JHB on a PEN movement)', asoJhb, t2);
await denial('KUL officer (station without the scan capability)', asoKul, await makeTx(kul));
await denial('BTU officer (no CaterLink capability)', asoBtu, await makeTx(btu));
await denial('Staff Profiling ASO at PEN', profAso, t2);
await denial('pending profile with an assignment', pending, t2, /Not available/);
await denial('approved profile without any assignment', noAssign, t2);
await denial('CaterLink Management', clMgmt, t2);
await denial('Operation Manager', opMgr, t2);
const noDuty = await call(asoPenNoDuty, t2);
assert(!noDuty.ok && /checked in for duty/.test(noDuty.err) && await pbCount(t2) === 0, 'an officer without an open duty check-in is refused');
const tJ = await makeTx(jhb);
await denial('a PEN officer on a JHB movement (cross-station)', asoPen, tJ);
const anon = await failsWith(asoPen, "select 1");
void anon;
await db.query('reset role;'); await db.query("select set_config('request.jwt.claims','{}', false);"); await db.query('set role anon;');
let anonErr = null; await db.query('savepoint an'); try { await db.query("select * from public.record_caterlink_part_b_secure(gen_random_uuid(), true, true, '{}'::jsonb, '{}'::jsonb, 'a','b','c','part-b/x', repeat('a',64), null, 'PASS', null);"); } catch (e) { anonErr = e.message; } await db.query('rollback to savepoint an'); await sup();
assert(anonErr !== null && /permission denied/i.test(anonErr), 'an anonymous caller cannot execute the function');

console.log('=== workflow state ===');
const tOrder = await makeTx(pen, { status: 'AIRPORT_POST_APPROVED' });
const ro = await call(asoPen, tOrder);
assert(!ro.ok && /Out of order/.test(ro.err), 'a transaction that is not waiting for Part B (outbound beyond B) is refused');
const tInb = await makeTx(pen, { direction: 'INBOUND', status: 'CREATED' });
const ri = await call(asoPen, tInb);
assert(!ri.ok && /Out of order/.test(ri.err), 'inbound Part B is only valid after Part C (status AIRPORT_POST_APPROVED)');
const tInb2 = await makeTx(pen, { direction: 'INBOUND', status: 'AIRPORT_POST_APPROVED' });
const ri2 = await call(asoPen, tInb2);
assert(ri2.ok && ri2.row.outcome === 'COMPLETED' && await status(tInb2) === 'COMPLETED' && (await one('select completed_at from public.transactions where id = $1', [tInb2.id])).completed_at !== null, 'inbound Part B is the FINAL checkpoint: COMPLETED with completed_at');

console.log('=== validation (nothing written on a refused call) ===');
const t3 = await makeTx(pen);
const bad = async (label, o, re) => { const r = await call(asoPen, t3, o); assert(!r.ok && re.test(r.err) && await pbCount(t3) === 0 && await status(t3) === 'CREATED', label); };
await bad('escalate without a reason', { result: 'ESCALATE', reason: '  ' }, /escalation reason/);
await bad('PASS with the vehicle check unticked', { veh: false }, /Vehicle and driver checks/);
await bad('PASS with the driver check unticked', { drv: false }, /Vehicle and driver checks/);
await bad('unknown result value', { result: 'MAYBE' }, /Pass or Escalate/);
await bad('a signature path outside part-b/', { sig: 'receipt/other.png' }, /valid signature/);
await bad('an invalid signature hash', { hash: 'xyz' }, /valid signature/);
await bad('missing observed driver id', { did: ' ' }, /observed vehicle and driver/);
await bad('a seal number left blank', { entries: { [t3.sealId]: '' } }, /mandatory for every seal/);
await bad('a seal colour left blank', { colors: {} }, /mandatory for every seal/);

console.log('=== seal mismatch / wrong colour / whitelist / officer escalation ===');
const t4 = await makeTx(pen);
const rm = await call(asoPen, t4, { entries: { [t4.sealId]: 'WRONG-NUMBER' } });
assert(rm.ok && rm.row.outcome === 'SEAL_MISMATCH' && rm.row.transaction_status === 'ESCALATED' && await status(t4) === 'ESCALATED' && await pbCount(t4) === 0, 'a wrong seal number escalates the transaction and records NO Part B');
assert((await one("select incident_type, status, severity from public.caterlink_incidents where transaction_id = $1", [t4.id])).incident_type === 'SEAL_MISMATCH', 'a SEAL_MISMATCH incident is open');
assert((await one("select count(*)::int n from public.seal_verifications where seal_id = $1 and not matched", [t4.sealId])).n === 1, 'the failed verification is recorded');
const nn = await rows("select recipient_profile_id from public.user_notifications where event_type = 'caterlink_checkpoint_escalated' and payload ->> 'transaction_id' = $1", [t4.id]);
assert(nn.length === 2 && nn.some((x) => x.recipient_profile_id === clMgmt) && nn.some((x) => x.recipient_profile_id === opMgr), 'CaterLink Management and Operation Manager are notified (and only they)');
assert(!nn.some((x) => [asoPen, asoJhb, asoKul].includes(x.recipient_profile_id)), 'no station officer receives the escalation notification');
const frozen = await call(asoPen, t4);
assert(!frozen.ok && /escalated/.test(frozen.err), 'an escalated transaction is frozen: no further Part B');
const t5 = await makeTx(pen);
const rc = await call(asoPen, t5, { colors: { [t5.sealId]: 'GREEN' } });
assert(rc.ok && rc.row.outcome === 'WRONG_SEAL_COLOR' && await status(t5) === 'ESCALATED', 'a right number with the wrong colour escalates (WRONG_SEAL_COLOR)');
const t6 = await makeTx(pen);
const rw = await call(asoPen, t6, { vehicle: 'NOT-LISTED' });
assert(rw.ok && rw.row.outcome === 'WHITELIST_VIOLATION' && await status(t6) === 'ESCALATED' && await pbCount(t6) === 0, 'an observed vehicle that is not whitelisted escalates (WHITELIST_VIOLATION), no PASS recorded');
const t7 = await makeTx(pen);
const re = await call(asoPen, t7, { result: 'ESCALATE', reason: 'seal looks tampered', veh: false });
assert(re.ok && re.row.outcome === 'ESCALATED' && await status(t7) === 'ESCALATED', 'an officer escalation freezes the transaction');
const eRec = await one('select result, escalation_reason, seal_verified from public.part_b_c where transaction_id = $1', [t7.id]);
assert(eRec.result === 'ESCALATE' && eRec.escalation_reason === 'seal looks tampered' && eRec.seal_verified === false, 'the escalated checkpoint is kept with its reason');
assert((await one("select count(*)::int n from public.caterlink_incidents where transaction_id = $1 and incident_type = 'OTHER'", [t7.id])).n === 1, 'an OTHER incident carries the officer reason');

console.log('=== immutability and direct-write denial ===');
let upd = null; await db.query('savepoint u'); try { await db.query("update public.part_b_c set remarks = 'edited' where transaction_id = $1", [t1.id]); } catch (e) { upd = e.message; } await db.query('rollback to savepoint u');
assert(upd !== null && /immutable/.test(upd), 'a recorded Part B cannot be edited, even with full database privileges');
const direct = await failsWith(asoPen, "insert into public.part_b_c (transaction_id, checkpoint_stage, avsec_name, avsec_staff_id, signature_url, completed_by) values ($1,'B','x','x','part-b/x',$2)", [t2.id, asoPen]);
assert(direct !== null && /permission denied/i.test(direct), 'an officer cannot insert a checkpoint directly');
const direct2 = await failsWith(asoPen, "update public.transactions set status = 'INFLIGHT_POST_APPROVED' where id = $1", [t2.id]);
assert(direct2 !== null, 'an officer cannot advance a transaction directly');
const grants = await one("select has_function_privilege('anon', p.oid, 'execute') a, has_function_privilege('authenticated', p.oid, 'execute') u, has_function_privilege('authenticated', 'public.caterlink_checkpoint_escalate_internal(uuid,uuid,text,text,text,uuid)'::regprocedure, 'execute') i from pg_proc p where p.oid = 'public.record_caterlink_part_b_secure(uuid,boolean,boolean,jsonb,jsonb,text,text,text,text,text,text,text,text)'::regprocedure");
assert(grants.a === false && grants.u === true && grants.i === false, 'grants: authenticated (not anon) may call the RPC; the internal escalation helper is not callable by clients');
const def = (await one("select pg_get_functiondef('public.record_caterlink_part_b_secure(uuid,boolean,boolean,jsonb,jsonb,text,text,text,text,text,text,text,text)'::regprocedure) d")).d;
assert(!/can_user_scan_caterlink/.test(def), 'the scan-decision invariant holds: no database function references can_user_scan_caterlink');
assert(/set search_path to 'public'/i.test(def) || /search_path/.test(def), 'fixed search_path');

await db.query('rollback;');
await db.end();
console.log(`\nTOTAL: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
