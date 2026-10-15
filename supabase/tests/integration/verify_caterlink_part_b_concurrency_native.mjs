// CaterLink Part B (In-flight Security Post) -- record_caterlink_part_b_secure() on native PostgreSQL (20261107000001).
// Authorization (server-derived actor, approved profile, station-operator assignment at the movement's station, scan capability, duty),
// workflow state, seal / whitelist verification, escalation, idempotency, immutability, audit, notification, direct-write denial.
import pg from 'pg';
import { assertDisposableLocalTarget } from './safeguards.mjs';
import { sigPaths } from './sigfixtures.mjs';

const { Client } = pg;
let failures = 0;
let passes = 0;
const assert = (c, m) => { if (!c) { failures += 1; console.log('FAIL:', m); } else { passes += 1; console.log('PASS:', m); } };

const pgConfig = { host: process.env.PGHOST || '127.0.0.1', port: parseInt(process.env.PGPORT || '55433', 10), user: process.env.PGUSER || 'postgres', password: process.env.PGPASSWORD || undefined };
const goldenDb = process.env.PGDATABASE || 'vecta_phase6_test';
const runDb = 'vecta_part_b_concurrency_run';
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
// every session's signature is its own bound, existing, fresh object (migration 20261113000001); the committed objects are visible to all sessions
const putSig = async (p, owner) => { await db.query('reset role;'); await db.query("insert into storage.buckets (id, name, public) values ('signatures','signatures', false) on conflict (id) do nothing"); await db.query("insert into storage.objects (bucket_id, name, owner) values ('signatures', $1, $2)", [p, owner]); await sup(); return p; };
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


// ------------------------------------------------------------------ two REAL concurrent sessions
const mk = async () => { const c = new Client({ ...pgConfig, database: runDb, statement_timeout: 20000, query_timeout: 25000 }); await c.connect(); return c; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sql = 'select * from public.record_caterlink_part_b_secure($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13);';
const argsFor = (tx, o = {}, sig = SIG) => [tx.id, true, true, JSON.stringify({ [tx.sealId]: SEAL.number }), JSON.stringify({ [tx.sealId]: SEAL.color }), 'PB1234A', 'PB Driver', 'PBD001', sig, HASH, 'ok', o.result ?? 'PASS', o.reason ?? null];
async function session(user) {
  const c = await mk();
  await c.query('begin;');
  await c.query("select set_config('request.jwt.claims', json_build_object('sub', $1::text, 'role', 'authenticated')::text, false), set_config('role', 'authenticated', false);", [user]);
  return c;
}
async function race(label, userA, userB, tx, oA = {}, oB = {}) {
  const sigA = await putSig(sigPaths.partB(tx.id), userA); const sigB = await putSig(sigPaths.partB(tx.id), userB);
  const a = await session(userA); const b = await session(userB);
  const ra = await a.query(sql, argsFor(tx, oA, sigA));
  let bDone = false; let bRes = null; let bErr = null;
  const bp = b.query(sql, argsFor(tx, oB, sigB)).then((r) => { bRes = r.rows[0]; }).catch((e) => { bErr = e.message; }).finally(() => { bDone = true; });
  await sleep(500);
  assert(!bDone, `${label}: the second session is BLOCKED on the transaction row while the first holds its uncommitted Part B`);
  await a.query('commit;');
  await bp;
  await b.query('rollback;').catch(() => {});
  await a.end(); await b.end();
  return { a: ra.rows[0], bRes, bErr };
}
const q = async (s, p) => (await db.query(s, p)).rows;
const cnt = async (tx) => (await q('select count(*)::int n from public.part_b_c where transaction_id = $1', [tx.id]))[0].n;
const st = async (tx) => (await q('select status from public.transactions where id = $1', [tx.id]))[0].status;
const audits = async (tx) => (await q("select count(*)::int n from public.phase8_audit_log where action = 'caterlink_part_b_record' and entity_id = $1", [tx.id]))[0].n;

console.log('=== same officer, two sessions, same movement ===');
const t1 = await makeTx(pen);
const r1 = await race('same officer', asoPen, asoPen, t1);
assert(r1.a.is_new === true && r1.a.outcome === 'APPROVED', 'session A records the Part B and advances the transaction');
assert(r1.bRes && r1.bRes.outcome === 'ALREADY_RECORDED' && r1.bRes.is_new === false && r1.bRes.part_id === r1.a.part_id, 'session B, once unblocked, receives the SAME record (idempotent), not a second one');
assert(await cnt(t1) === 1 && await st(t1) === 'INFLIGHT_POST_APPROVED' && await audits(t1) === 1, 'exactly one record, one state advance, one audit entry');

console.log('=== two different officers racing for the same movement ===');
const t2 = await makeTx(pen);
const r2 = await race('different officers', asoPen, asoPen2, t2);
assert(r2.a.is_new === true && r2.bErr && /already been recorded/.test(r2.bErr), 'the loser is refused: the transition cannot be double-advanced by a second officer');
assert(await cnt(t2) === 1 && await st(t2) === 'INFLIGHT_POST_APPROVED', 'still one record and a single state transition');

console.log('=== PASS racing an officer ESCALATE on the same movement ===');
const t3 = await makeTx(pen);
const r3 = await race('pass vs escalate', asoPen, asoPen2, t3, {}, { result: 'ESCALATE', reason: 'racing escalation' });
assert(r3.a.outcome === 'APPROVED' && r3.bErr && /already been recorded/.test(r3.bErr), 'the escalation that lost the race is refused');
assert(await cnt(t3) === 1 && await st(t3) === 'INFLIGHT_POST_APPROVED' && (await q('select count(*)::int n from public.caterlink_incidents where transaction_id = $1', [t3.id]))[0].n === 0, 'no incident, no freeze: the approved state stands');

console.log('=== ten concurrent attempts on one movement ===');
const t4 = await makeTx(pen);
const sigs4 = [];
for (let i = 0; i < 10; i += 1) sigs4.push(await putSig(sigPaths.partB(t4.id), i % 2 ? asoPen : asoPen2));
const cs = await Promise.all(Array.from({ length: 10 }, (_, i) => session(i % 2 ? asoPen : asoPen2)));
const results = await Promise.allSettled(cs.map(async (c, i) => { const r = await c.query(sql, argsFor(t4, {}, sigs4[i])); await c.query('commit;'); return r.rows[0]; }));
await Promise.all(cs.map((c) => c.query('rollback;').catch(() => {}).then(() => c.end())));
const created = results.filter((r) => r.status === 'fulfilled' && r.value.is_new === true).length;
assert(created === 1, `exactly one of ten concurrent submissions created the record (found ${created})`);
assert(await cnt(t4) === 1 && await st(t4) === 'INFLIGHT_POST_APPROVED' && await audits(t4) === 1, 'one record, one transition, one audit entry after ten racing sessions');

await db.end();
console.log(`
TOTAL: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
