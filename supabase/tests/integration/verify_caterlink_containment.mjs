// CaterLink fail-closed containment (20261108000001) on native PostgreSQL.
//  1. skip_part_d and raise_caterlink_incident_secure: no role holds EXECUTE; every persona is denied; nothing changes.
//  2. The Part B automatic escalation (internal path) still escalates, audits and notifies management.
//  3. The destination receipt completes a movement only from the final-step state of the existing state machine; a denied receipt
//     writes nothing (no hub checkpoint, audit, notification or PDF job); a valid receipt is single-shot.
import pg from 'pg';
import { assertDisposableLocalTarget } from './safeguards.mjs';

const { Client } = pg;
let failures = 0;
let passes = 0;
const assert = (c, m) => { if (!c) { failures += 1; console.log('FAIL:', m); } else { passes += 1; console.log('PASS:', m); } };

const pgConfig = { host: process.env.PGHOST || '127.0.0.1', port: parseInt(process.env.PGPORT || '55433', 10), user: process.env.PGUSER || 'postgres', password: process.env.PGPASSWORD || undefined };
const goldenDb = process.env.PGDATABASE || 'vecta_phase6_test';
const runDb = 'vecta_containment_run';
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
  create or replace function pg_temp.sim_anon() returns void language plpgsql as $$
  begin perform set_config('request.jwt.claims', '{}', false); perform set_config('role', 'anon', false); end; $$;
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
const opsDept = await dept('operation'); const clDept = await dept('caterlink');
const roles = new Map((await rows('select id, code from public.role_definitions;')).map((r) => [r.code, r.id]));
const station = async (code) => one('select id, hub_id, code from public.org_stations where code = $1;', [code]);
const pen = await station('PEN'); const kch = await station('KCH'); const kul = await station('KUL - MAA');
const teamOf = async (st) => { await db.query("insert into public.org_teams (station_id, name) values ($1, 'ALPHA') on conflict (station_id, name) do nothing;", [st.id]); return (await one("select id from public.org_teams where station_id = $1 and name = 'ALPHA';", [st.id])).id; };
let seq = 0xc100;
const nextId = () => `00000000-0000-0000-0000-${(++seq).toString(16).padStart(12, '0')}`;

async function person(label, role, { st = null, status = 'approved' } = {}) {
  const id = nextId();
  await db.query('insert into auth.users (id, email) values ($1, $2);', [id, `ct-${label}@example.test`]);
  await db.query("insert into public.profiles (id, email, name, staff_no, role, status) values ($1,$2,$3,$4,'ASO',$5) on conflict (id) do update set status = excluded.status, name = excluded.name, staff_no = excluded.staff_no;", [id, `ct-${label}@example.test`, `CT ${label}`, `CT-${label}`.slice(0, 20), status]);
  const ins = (cols, vals) => db.query(`insert into public.user_role_assignments (profile_id, role_definition_id, starts_at${cols ? ', ' + cols : ''}) values ($1,$2,$3${vals.map((_, i) => `,$${i + 4}`).join('')});`, [id, roles.get(role), new Date(Date.now() - 86400000).toISOString(), ...vals]);
  const member = async () => (await one("insert into public.user_entity_memberships (profile_id, aoc_id, operating_entity_id, status, is_primary) values ($1,$2,$3,'active',true) returning id;", [id, myAoc, maa])).id;
  if (role === 'caterlink_management') await ins('aoc_id, department_id', [myAoc, clDept]);
  else if (role === 'operation_manager') await ins('aoc_id, department_id', [myAoc, opsDept]);
  else if (st) await ins('aoc_id, department_id, hub_id, station_id, team_id, entity_membership_id', [myAoc, opsDept, st.hub_id, st.id, await teamOf(st), await member()]);
  return id;
}
const failsWith = async (sess, sql, p = []) => {
  await sess();
  await db.query('savepoint f');
  try { await db.query(sql, p); await db.query('rollback to savepoint f'); return null; }
  catch (e) { await db.query('rollback to savepoint f'); return e.message; }
  finally { await sup(); }
};
const tryKeep = async (sess, sql, p = []) => {
  await sess();
  await db.query('savepoint k');
  try { await db.query(sql, p); await db.query('release savepoint k'); return null; }
  catch (e) { await db.query('rollback to savepoint k'); return e.message; }
  finally { await sup(); }
};
const asUser = (u) => () => db.query('select pg_temp.sim_user($1)', [u]);
const asAnon = () => db.query('select pg_temp.sim_anon()');
const asService = () => db.query('select pg_temp.sim_service()');
const callAs = async (u, sql, p = []) => { await db.query('select pg_temp.sim_user($1)', [u]); try { return await rows(sql, p); } finally { await sup(); } };

// ------------------------------------------------------------------ fixtures
const asoPen = await person('asopen', 'aso', { st: pen });
const asoKul = await person('asokul', 'aso', { st: kul });
const asoKch = await person('asokch', 'aso', { st: kch });
const clMgmt = await person('clmgmt', 'caterlink_management');
const opMgr = await person('opmgr', 'operation_manager');
const pending = await person('pending', 'aso', { st: pen, status: 'pending' });
const rejected = await person('rejected', 'aso', { st: pen, status: 'rejected' });
let deactivated = null;
try { await db.query('savepoint d'); deactivated = await person('deactivated', 'aso', { st: pen, status: 'deactivated' }); await db.query('release savepoint d'); } catch { await db.query('rollback to savepoint d'); deactivated = null; }
const external = nextId();
await db.query('insert into auth.users (id, email) values ($1, $2);', [external, 'ct-external@example.test']);
await db.query("insert into public.profiles (id, email, name, staff_no, role, status) values ($1,'ct-external@example.test','CT External','CT-EXT','ASO','approved') on conflict (id) do update set status = 'approved';", [external]);
const creator = nextId();
await db.query('insert into auth.users (id, email) values ($1,$2);', [creator, 'ct-creator@example.test']);
await db.query("insert into public.profiles (id, email, name, staff_no, role, status) values ($1,'ct-creator@example.test','CT Creator','CT-CR','ASO','approved') on conflict (id) do update set status = 'approved';", [creator]);
const today = (await one("select (now() at time zone 'Asia/Kuala_Lumpur')::date::text d")).d;
await db.query("insert into public.duty_records (profile_id, station, duty_date, shift_code, check_in_at, status) select $1, 'PEN', $2::date, 'CT', now(), 'present' where exists (select 1 from public.stations where code = 'PEN');", [asoPen, today]);
const co = (await one("insert into public.catering_companies (name, code, aoc_id, status, is_active, effective_from) values ('CT Caterer', 'CTC', $1, 'active', true, current_date - 1) returning id;", [myAoc])).id;
await db.query("insert into public.vehicles (vehicle_number, catering_company_id, aoc_id, status, is_active, effective_from) values ('CT1234A', $1, $2, 'active', true, current_date - 1);", [co, myAoc]);
await db.query("insert into public.drivers (name, staff_id, catering_company_id, aoc_id, status, is_active, effective_from) values ('CT Driver', 'CTD001', $1, $2, 'active', true, current_date - 1);", [co, myAoc]);

let txn = 0;
async function makeTx({ station: st = pen, direction = 'OUTBOUND', route = 'AIRCRAFT', status = 'CREATED', dest = null, hub = null } = {}) {
  const id = nextId();
  txn += 1;
  await db.query('reset role;');
  await db.query('set session_replication_role = replica;');
  await db.query(`insert into public.transactions (id, transaction_number, aoc_id, direction, vehicle_number, driver_name, driver_id, seal_number, status, route, origin_station_id, destination_station_id, hub_destination, flight_number, created_by)
    values ($1,$2,$3,$4,'CT1234A','CT Driver','CTD001','S',$5,$6,$7,$8,$9,'AK703',$10);`, [id, `TX-CT-${txn}`, myAoc, direction, status, route, st.id, dest?.id ?? null, hub, creator]);
  const sealId = (await one("insert into public.seals (transaction_id, seal_number, seal_type, seal_color) values ($1,'CT-SEAL-1','TRUCK_SEAL','BLUE') returning id;", [id])).id;
  await db.query('set session_replication_role = origin;');
  await sup();
  return { id, sealId };
}
const state = async (tx) => ({
  status: (await one('select status from public.transactions where id = $1', [tx.id])).status,
  hub: (await one('select count(*)::int n from public.caterlink_checkpoint_hub where transaction_id = $1', [tx.id])).n,
  audit: (await one("select count(*)::int n from public.phase8_audit_log where entity_id = $1 and action = 'caterlink_receipt_confirm'", [tx.id])).n,
  notif: (await one("select count(*)::int n from public.user_notifications where event_type = 'caterlink_movement_received' and payload ->> 'transaction_id' = $1", [tx.id])).n,
  jobs: (await one('select count(*)::int n from public.caterlink_pdf_jobs where transaction_id = $1', [tx.id])).n,
  incidents: (await one('select count(*)::int n from public.caterlink_incidents where transaction_id = $1', [tx.id])).n,
});
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ================================================================== 1. skip_part_d and raise_caterlink_incident_secure
console.log('=== skip_part_d / raise_caterlink_incident_secure: fail closed ===');
const SKIP = 'public.skip_part_d(uuid, text)';
const RAISE = 'public.raise_caterlink_incident_secure(uuid, text, text, text, text)';
for (const [name, sig] of [['skip_part_d', SKIP], ['raise_caterlink_incident_secure', RAISE]]) {
  const g = await one(`select has_function_privilege('anon', '${sig}', 'execute') an, has_function_privilege('authenticated', '${sig}', 'execute') au, has_function_privilege('service_role', '${sig}', 'execute') sv,
    exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x where p.oid = '${sig}'::regprocedure and x.grantee = 0 and x.privilege_type = 'EXECUTE') pub;`);
  assert(!g.an && !g.au && !g.sv && !g.pub, `${name}: PUBLIC, anon, authenticated and service_role all lack EXECUTE`);
  const body = (await one(`select pg_get_functiondef('${sig}'::regprocedure) d`)).d;
  assert(/raise exception 'Not available\.'/.test(body) && !/current_user_role|update public\.transactions|insert into/i.test(body), `${name}: the body only raises (no legacy role text, no NULL-sensitive comparison, no write)`);
}
const txA = await makeTx({ station: pen, status: 'AIRPORT_POST_APPROVED', dest: kul });
const txB = await makeTx({ station: pen, status: 'CREATED' });
const before = [await state(txA), await state(txB)];
const personas = [['anonymous', asAnon], ['service_role', asService], ['ordinary officer at the movement station', asUser(asoPen)], ['officer at another station', asUser(asoKul)],
  ['CaterLink Management', asUser(clMgmt)], ['Operation Manager', asUser(opMgr)], ['pending profile', asUser(pending)], ['rejected profile', asUser(rejected)],
  ['external CaterLink party (no VECTA role)', asUser(external)]];
if (deactivated) personas.push(['deactivated profile', asUser(deactivated)]);
for (const [label, sess] of personas) {
  const s1 = await failsWith(sess, 'select public.skip_part_d($1, $2);', [txA.id, 'attempt']);
  const s2 = await failsWith(sess, "select * from public.raise_caterlink_incident_secure($1, 'OTHER', 'attempt', 'low', null);", [txB.id]);
  assert(s1 && /permission denied/i.test(s1), `skip_part_d is denied to ${label}`);
  assert(s2 && /permission denied/i.test(s2), `raise_caterlink_incident_secure is denied to ${label}`);
}
assert(same(before[0], await state(txA)) && same(before[1], await state(txB)), 'no denied attempt changed any movement, incident, audit row, notification or job');

// ================================================================== 2. Part B automatic escalation still works
console.log('=== Part B automatic escalation (internal path) is unaffected ===');
const txP = await makeTx({ station: pen, status: 'CREATED' });
const mismatch = await callAs(asoPen, 'select * from public.record_caterlink_part_b_secure($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13);',
  [txP.id, true, true, JSON.stringify({ [txP.sealId]: 'WRONG-SEAL' }), JSON.stringify({ [txP.sealId]: 'BLUE' }), 'CT1234A', 'CT Driver', 'CTD001', 'part-b/ct.png', 'a'.repeat(64), '', 'PASS', null]);
assert(mismatch[0].outcome === 'SEAL_MISMATCH', 'a seal mismatch still returns SEAL_MISMATCH');
const sp = await state(txP);
assert(sp.status === 'ESCALATED' && sp.incidents === 1, 'the movement is frozen behind exactly one incident');
const inc = await one("select id, incident_type, reported_by from public.caterlink_incidents where transaction_id = $1", [txP.id]);
assert(inc.incident_type === 'SEAL_MISMATCH' && inc.reported_by === asoPen, 'the incident is SEAL_MISMATCH, reported by the authenticated officer');
assert((await one("select count(*)::int n from public.phase8_audit_log where entity_id = $1 and action = 'caterlink_checkpoint_escalate' and actor_id = $2", [inc.id, asoPen])).n === 1, 'the escalation is audited with the officer as actor');
const rcpt = (await rows("select recipient_profile_id from public.user_notifications where event_type = 'caterlink_checkpoint_escalated' and payload ->> 'transaction_id' = $1", [txP.id])).map((r) => r.recipient_profile_id).sort();
assert(JSON.stringify(rcpt) === JSON.stringify([clMgmt, opMgr].sort()), 'CaterLink Management and the Operation Manager are notified through the canonical notification table');

// ================================================================== 3. receipt state gate
console.log('=== destination receipt: only the final-step state of the existing state machine ===');
const receive = (u, tx, station = 'KCH') => tryKeep(asUser(u), 'select * from public.confirm_caterlink_destination_receipt_secure($1, $2, $3, $4);', [tx.id, station, 'receipt/ct.png', 'ok']);
const matrix = [
  // direction, route, status, accepted?
  ['OUTBOUND', 'AIRCRAFT', 'CREATED', false], ['OUTBOUND', 'AIRCRAFT', 'INFLIGHT_POST_APPROVED', false], ['OUTBOUND', 'AIRCRAFT', 'AIRPORT_POST_APPROVED', true], ['OUTBOUND', 'AIRCRAFT', 'POST6_APPROVED', true],
  ['OUTBOUND', 'AIRCRAFT', 'POST2_APPROVED', false], ['OUTBOUND', 'REDQ', 'INFLIGHT_POST_APPROVED', false], ['OUTBOUND', 'REDQ', 'REDQ_RESEALED', false], ['OUTBOUND', 'REDQ', 'AIRPORT_POST_APPROVED', true],
  ['OUTBOUND', 'HUB', 'CREATED', false], ['OUTBOUND', 'HUB', 'INFLIGHT_POST_APPROVED', true], ['OUTBOUND', 'HUB', 'AIRPORT_POST_APPROVED', false],
  ['OUTBOUND', 'MAINTENANCE', 'CREATED', false], ['OUTBOUND', 'MAINTENANCE', 'INFLIGHT_POST_APPROVED', true],
  ['INBOUND', 'AIRCRAFT', 'CREATED', false], ['INBOUND', 'AIRCRAFT', 'INFLIGHT_POST_APPROVED', false], ['INBOUND', 'AIRCRAFT', 'AIRPORT_POST_APPROVED', true],
];
for (const [direction, route, status, accepted] of matrix) {
  const tx = await makeTx({ station: pen, direction, route, status, dest: kch, hub: route === 'HUB' ? 'KCH' : null });
  const b = await state(tx);
  const err = await receive(asoKch, tx);
  const a = await state(tx);
  const label = `${direction} ${route} ${status}`;
  if (accepted) {
    assert(err === null && a.status === 'COMPLETED' && a.hub === 1 && a.audit === 1 && a.notif === 1 && a.jobs === 1, `${label}: receipt accepted (COMPLETED, one hub record, one audit entry, one notification, one PDF job)`);
    const again = await receive(asoKch, tx);
    assert(again && /already completed/i.test(again) && same(a, await state(tx)), `${label}: a repeated receipt is refused and writes nothing (idempotent)`);
  } else {
    assert(err !== null && same(a, b) && a.hub === 0 && a.audit === 0 && a.notif === 0 && a.jobs === 0, `${label}: receipt DENIED, no hub checkpoint, audit, notification or PDF job (${(err ?? '').slice(0, 60)})`);
  }
}
const ready = await makeTx({ station: pen, status: 'AIRPORT_POST_APPROVED', dest: kch });
const notReady = await makeTx({ station: pen, status: 'CREATED', dest: kch });
const list = (await callAs(asoKch, "select id from public.list_caterlink_pending_receipts_secure('KCH');")).map((r) => r.id);
assert(list.includes(ready.id) && !list.includes(notReady.id), `the pending-receipt list offers the receivable movement and not the one still awaiting checkpoints (${list.length} listed)`);
assert((await failsWith(asUser(asoPen), "select * from public.list_caterlink_pending_receipts_secure('KCH');")) !== null, 'the list stays closed to an officer without receipt authority at the station');
const stray = await makeTx({ station: pen, status: 'AIRPORT_POST_APPROVED', dest: kch });
assert((await receive(asoKul, stray)) !== null && (await state(stray)).status === 'AIRPORT_POST_APPROVED', 'an officer at another station still cannot receive (authorization unchanged)');
const g = await one("select has_function_privilege('anon', 'public.confirm_caterlink_destination_receipt_secure(uuid, text, text, text)', 'execute') a, has_function_privilege('authenticated', 'public.confirm_caterlink_destination_receipt_secure(uuid, text, text, text)', 'execute') b;");
assert(!g.a && g.b, 'receipt grants unchanged: authenticated yes, anon no');

await db.end();
console.log(`\nTOTAL: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
