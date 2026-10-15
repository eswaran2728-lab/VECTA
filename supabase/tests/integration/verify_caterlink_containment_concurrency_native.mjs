// CaterLink destination receipt (20261108000001): real multi-connection concurrency on native PostgreSQL.
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
const runDb = 'vecta_containment_concurrency_run';
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

// ------------------------------------------------------------------ fixtures (committed)
const asoKch = await person('asokch', 'aso', { st: kch });
const asoKch2 = await person('asokch2', 'aso', { st: kch });
const creator = nextId();
await db.query('insert into auth.users (id, email) values ($1,$2);', [creator, 'ct-creator@example.test']);
await db.query("insert into public.profiles (id, email, name, staff_no, role, status) values ($1,'ct-creator@example.test','CT Creator','CT-CR','ASO','approved') on conflict (id) do update set status = 'approved';", [creator]);
let txn = 0;
async function makeTx(status) {
  const id = nextId();
  txn += 1;
  await db.query('reset role;');
  await db.query('set session_replication_role = replica;');
  await db.query(`insert into public.transactions (id, transaction_number, aoc_id, direction, vehicle_number, driver_name, driver_id, seal_number, status, route, origin_station_id, destination_station_id, flight_number, created_by)
    values ($1,$2,$3,'OUTBOUND','CT1234A','CT Driver','CTD001','S',$4,'AIRCRAFT',$5,$6,'AK703',$7);`, [id, `TX-CTC-${txn}`, myAoc, status, pen.id, kch.id, creator]);
  await db.query('set session_replication_role = origin;');
  await sup();
  return { id };
}
const mk = async () => { const c = new Client({ ...pgConfig, database: runDb, statement_timeout: 20000, query_timeout: 25000 }); await c.connect(); return c; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function session(user) {
  const c = await mk();
  await c.query('begin;');
  await c.query("select set_config('request.jwt.claims', json_build_object('sub', $1::text, 'role', 'authenticated')::text, false), set_config('role', 'authenticated', false);", [user]);
  return c;
}
const RSQL = "select * from public.confirm_caterlink_destination_receipt_secure($1, 'KCH', 'receipt/ct.png', 'ok');";
const q = async (s, p) => (await db.query(s, p)).rows;
const counts = async (tx) => ({
  status: (await q('select status from public.transactions where id = $1', [tx.id]))[0].status,
  hub: (await q('select count(*)::int n from public.caterlink_checkpoint_hub where transaction_id = $1', [tx.id]))[0].n,
  audit: (await q("select count(*)::int n from public.phase8_audit_log where entity_id = $1 and action = 'caterlink_receipt_confirm'", [tx.id]))[0].n,
  notif: (await q("select count(*)::int n from public.user_notifications where event_type = 'caterlink_movement_received' and payload ->> 'transaction_id' = $1", [tx.id]))[0].n,
  jobs: (await q('select count(*)::int n from public.caterlink_pdf_jobs where transaction_id = $1', [tx.id]))[0].n,
});

console.log('=== same officer, two sessions: the second is blocked, then refused ===');
const t1 = await makeTx('AIRPORT_POST_APPROVED');
{
  const a = await session(asoKch); const b = await session(asoKch);
  const ra = await a.query(RSQL, [t1.id]);
  let done = false; let err = null;
  const bp = b.query(RSQL, [t1.id]).catch((e) => { err = e.message; }).finally(() => { done = true; });
  await sleep(500);
  assert(!done, 'the second session is BLOCKED on the transaction row while the first holds its uncommitted receipt');
  await a.query('commit;'); await bp; await b.query('rollback;').catch(() => {});
  await a.end(); await b.end();
  const c = await counts(t1);
  assert(ra.rows[0].status === 'COMPLETED' && err && /already completed/i.test(err), 'the first session completes; the second, once unblocked, is refused');
  assert(c.status === 'COMPLETED' && c.hub === 1 && c.audit === 1 && c.notif === 1 && c.jobs === 1, 'exactly one hub record, audit entry, notification and PDF job');
}

console.log('=== ten simultaneous receipts by two officers ===');
const t2 = await makeTx('AIRPORT_POST_APPROVED');
{
  const cs = await Promise.all(Array.from({ length: 10 }, (_, i) => session(i % 2 ? asoKch : asoKch2)));
  const res = await Promise.allSettled(cs.map(async (c) => { const r = await c.query(RSQL, [t2.id]); await c.query('commit;'); return r.rows[0]; }));
  await Promise.all(cs.map((c) => c.query('rollback;').catch(() => {}).then(() => c.end())));
  const won = res.filter((r) => r.status === 'fulfilled').length;
  const c = await counts(t2);
  assert(won === 1, `exactly one of ten simultaneous receipts won (found ${won})`);
  assert(c.status === 'COMPLETED' && c.hub === 1 && c.audit === 1 && c.notif === 1 && c.jobs === 1, 'one completion, one hub record, one audit entry, one notification, one PDF job');
}

console.log('=== a premature receipt storm writes nothing ===');
const t3 = await makeTx('CREATED');
{
  const cs = await Promise.all(Array.from({ length: 6 }, () => session(asoKch)));
  const res = await Promise.allSettled(cs.map(async (c) => { const r = await c.query(RSQL, [t3.id]); await c.query('commit;'); return r.rows[0]; }));
  await Promise.all(cs.map((c) => c.query('rollback;').catch(() => {}).then(() => c.end())));
  const c = await counts(t3);
  assert(res.every((r) => r.status === 'rejected'), 'every receipt on a CREATED movement is denied');
  assert(c.status === 'CREATED' && c.hub === 0 && c.audit === 0 && c.notif === 0 && c.jobs === 0, 'nothing was written: no hub record, audit entry, notification or PDF job');
}

console.log('=== the state is checked AFTER the row lock ===');
const t4 = await makeTx('INFLIGHT_POST_APPROVED');
{
  // the state machine advances the movement (row locked, uncommitted) while a receipt waits: the receipt must see the NEW state
  const mover = await mk(); await mover.query('begin;'); await mover.query("update public.transactions set status = 'AIRPORT_POST_APPROVED' where id = $1;", [t4.id]);
  const r = await session(asoKch);
  let done = false; let out = null;
  const rp = r.query(RSQL, [t4.id]).then((x) => { out = x.rows[0]; }).catch(() => {}).finally(() => { done = true; });
  await sleep(500);
  assert(!done, 'the receipt waits for the row lock instead of judging a stale state');
  await mover.query('commit;'); await rp; await r.query('commit;').catch(() => {}); await r.end(); await mover.end();
  assert(out && out.status === 'COMPLETED' && (await counts(t4)).hub === 1, 'once the movement reaches the final-step state, the waiting receipt succeeds exactly once');
}
const t5 = await makeTx('AIRPORT_POST_APPROVED');
{
  const mover = await mk(); await mover.query('begin;'); await mover.query("update public.transactions set status = 'ESCALATED' where id = $1;", [t5.id]);
  const r = await session(asoKch);
  let done = false; let err = null;
  const rp = r.query(RSQL, [t5.id]).catch((e) => { err = e.message; }).finally(() => { done = true; });
  await sleep(500);
  assert(!done, 'the receipt waits while the movement is being escalated');
  await mover.query('commit;'); await rp; await r.query('rollback;').catch(() => {}); await r.end(); await mover.end();
  const c = await counts(t5);
  assert(err && /escalated/i.test(err) && c.status === 'ESCALATED' && c.hub === 0 && c.audit === 0 && c.jobs === 0, 'a movement escalated while the receipt waited is refused and nothing is written');
}

console.log('=== a wrong-station officer racing the correct one ===');
const bki = await station('BKI');
const asoBki = await person('asobki', 'aso', { st: bki });
const t6 = await makeTx('AIRPORT_POST_APPROVED');
{
  const destBefore = (await q('select destination_station_id d from public.transactions where id = $1', [t6.id]))[0].d;
  const RB = "select * from public.confirm_caterlink_destination_receipt_secure($1, 'BKI', 'receipt/ct.png', 'ok');";
  const cs = await Promise.all(Array.from({ length: 8 }, (_, i) => session(i % 2 ? asoKch : asoBki)));
  const res = await Promise.allSettled(cs.map(async (c, i) => { const r = await c.query(i % 2 ? RSQL : RB, [t6.id]); await c.query('commit;'); return r.rows[0]; }));
  await Promise.all(cs.map((c) => c.query('rollback;').catch(() => {}).then(() => c.end())));
  const winners = res.map((r, i) => (r.status === 'fulfilled' ? i : -1)).filter((i) => i >= 0);
  const c = await counts(t6);
  const destAfter = (await q('select destination_station_id d from public.transactions where id = $1', [t6.id]))[0].d;
  assert(winners.length === 1 && winners[0] % 2 === 1, `exactly one receipt won, and it was the KCH officer's (winners: ${winners.join(',')})`);
  assert(c.status === 'COMPLETED' && c.hub === 1 && c.audit === 1 && c.notif === 1 && c.jobs === 1 && destAfter === destBefore, 'one completion; the destination was never rewritten by a BKI call');
}
console.log('=== only wrong-station officers: nothing is written ===');
const t7 = await makeTx('AIRPORT_POST_APPROVED');
{
  const RB = "select * from public.confirm_caterlink_destination_receipt_secure($1, 'BKI', 'receipt/ct.png', 'ok');";
  const cs = await Promise.all(Array.from({ length: 6 }, () => session(asoBki)));
  const res = await Promise.allSettled(cs.map(async (c) => { const r = await c.query(RB, [t7.id]); await c.query('commit;'); return r.rows[0]; }));
  await Promise.all(cs.map((c) => c.query('rollback;').catch(() => {}).then(() => c.end())));
  const c = await counts(t7);
  const dest = (await q('select destination_station_id d from public.transactions where id = $1', [t7.id]))[0].d;
  assert(res.every((r) => r.status === 'rejected') && c.status === 'AIRPORT_POST_APPROVED' && c.hub === 0 && c.audit === 0 && c.notif === 0 && c.jobs === 0 && dest === kch.id, 'six simultaneous wrong-station receipts are all refused and write nothing');
}

await db.end();
console.log(`\nTOTAL: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
