// Same-day leave: real multi-connection concurrency and COMMITTED atomicity on native PostgreSQL (20261109000001).
import pg from 'pg';
import { assertDisposableLocalTarget } from './safeguards.mjs';

const { Client } = pg;
let failures = 0;
let passes = 0;
const assert = (c, m) => { if (!c) { failures += 1; console.log('FAIL:', m); } else { passes += 1; console.log('PASS:', m); } };

const pgConfig = { host: process.env.PGHOST || '127.0.0.1', port: parseInt(process.env.PGPORT || '55433', 10), user: process.env.PGUSER || 'postgres', password: process.env.PGPASSWORD || undefined };
const goldenDb = process.env.PGDATABASE || 'vecta_phase6_test';
const runDb = 'vecta_leave_concurrency_run';
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
const sup = () => db.query("select set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, false), set_config('role', 'service_role', false);");
const ddl = async (q) => { await db.query('reset role;'); await db.query(q); await sup(); };
await sup();
const one = async (s, p) => (await db.query(s, p)).rows[0];
const rows = async (s, p) => (await db.query(s, p)).rows;
const mk = async () => { const c = new Client({ ...pgConfig, database: runDb, statement_timeout: 20000, query_timeout: 25000 }); await c.connect(); return c; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function session(user) {
  const c = await mk();
  await c.query('begin;');
  await c.query("select set_config('request.jwt.claims', json_build_object('sub', $1::text, 'role', 'authenticated')::text, true), set_config('role', 'authenticated', true);", [user]);
  return c;
}

const myAoc = (await one("select id from public.aocs where code = 'MY';")).id;
const myEntity = (await one("select id from public.operating_entities where aoc_id = $1 and code = 'MAA';", [myAoc])).id;
const opsDept = (await one("select id from public.departments where aoc_id = $1 and code = 'operation';", [myAoc])).id;
const aso = (await one("select id from public.role_definitions where code = 'aso';")).id;
const kul = await one("select id, hub_id from public.org_stations where code = 'KUL - MAA';");
await db.query("insert into public.org_teams (station_id, name) values ($1,'ALPHA') on conflict (station_id, name) do nothing;", [kul.id]);
const alpha = (await one("select id from public.org_teams where station_id = $1 and name = 'ALPHA';", [kul.id])).id;
const today = (await one("select (now() at time zone 'Asia/Kuala_Lumpur')::date::text d")).d;
let seq = 0x9900;
const nextId = () => `00000000-0000-0000-0000-${(++seq).toString(16).padStart(12, '0')}`;
async function person(label) {
  const id = nextId();
  await db.query('insert into auth.users (id, email) values ($1,$2);', [id, `lc-${label}@example.test`]);
  await db.query("insert into public.profiles (id, email, name, staff_no, role, status, station, team) values ($1,$2,$3,$4,'ASO','approved','KUL - MAA','ALPHA') on conflict (id) do update set status = 'approved', station = 'KUL - MAA', team = 'ALPHA';", [id, `lc-${label}@example.test`, `LC ${label}`, `LC-${label}`.slice(0, 20)]);
  const mem = (await one("insert into public.user_entity_memberships (profile_id, aoc_id, operating_entity_id, status, is_primary) values ($1,$2,$3,'active',true) returning id;", [id, myAoc, myEntity])).id;
  await db.query("insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, hub_id, station_id, team_id, entity_membership_id, starts_at) values ($1,$2,$3,$4,$5,$6,$7,$8, now() - interval '1 day');", [id, aso, myAoc, opsDept, kul.hub_id, kul.id, alpha, mem]);
  return id;
}
const creator = nextId();
await db.query('insert into auth.users (id, email) values ($1,$2);', [creator, 'lc-creator@example.test']);
await db.query("insert into public.profiles (id, email, name, staff_no, role, status) values ($1,'lc-creator@example.test','LC Creator','LC-CR','ASO','approved') on conflict (id) do update set status = 'approved';", [creator]);
await db.query("insert into public.team_rosters (station, team, roster_date, shift_code, start_time, end_time, set_by, ops_group) values ('KUL - MAA','ALPHA',$1::date,'M','23:59','23:58',$2,'operation_avsec') on conflict (station, team, roster_date, ops_group) do update set shift_code = 'M';", [today, creator]);
const SQL = "select * from public.submit_leave_application_secure('absent', null, null, $1);";
const counts = async (u) => ({
  notices: (await one('select count(*)::int n from public.absence_notices where user_id = $1', [u])).n,
  duty: (await one('select count(*)::int n from public.duty_records where profile_id = $1', [u])).n,
  audit: (await one("select count(*)::int n from public.phase8_audit_log where actor_id = $1 and action = 'absence_notice_submit'", [u])).n,
});

console.log('=== eight simultaneous submissions by one officer ===');
const u1 = await person('one');
{
  const cs = await Promise.all(Array.from({ length: 8 }, () => session(u1)));
  const res = await Promise.allSettled(cs.map(async (c, i) => { const r = await c.query(SQL, [`simultaneous ${i}`]); await c.query('commit;'); return r.rows[0]; }));
  await Promise.all(cs.map((c) => c.query('rollback;').catch(() => {}).then(() => c.end())));
  const won = res.filter((r) => r.status === 'fulfilled').length;
  const lost = res.filter((r) => r.status === 'rejected').map((r) => r.reason.message);
  const c = await counts(u1);
  assert(won === 1, `exactly one of eight simultaneous submissions won (found ${won})`);
  assert(lost.length === 7 && lost.every((m) => /already submitted/i.test(m)), 'the other seven were refused as duplicates');
  assert(c.notices === 1 && c.duty === 1 && c.audit === 1, 'committed state: one notice, one absent duty record, one audit entry');
}

console.log('=== two different officers submit at the same time ===');
const u2 = await person('two'); const u3 = await person('three');
{
  const cs = await Promise.all([session(u2), session(u3)]);
  const res = await Promise.allSettled(cs.map(async (c) => { const r = await c.query(SQL, ['both']); await c.query('commit;'); return r.rows[0]; }));
  await Promise.all(cs.map((c) => c.query('rollback;').catch(() => {}).then(() => c.end())));
  assert(res.every((r) => r.status === 'fulfilled'), 'unrelated officers do not block or break each other');
  assert((await counts(u2)).notices === 1 && (await counts(u3)).notices === 1 && (await counts(u2)).duty === 1 && (await counts(u3)).duty === 1, 'each has exactly one notice and one duty record');
}

console.log('=== committed atomicity: a failing duty write leaves nothing behind ===');
const u4 = await person('four');
await ddl("create or replace function public.lc_boom() returns trigger language plpgsql as $$ begin raise exception 'injected failure'; end; $$;");
{
  await ddl('create trigger lc_boom_duty before insert or update on public.duty_records for each row execute function public.lc_boom();');
  const c = await session(u4);
  let err = null;
  try { await c.query(SQL, ['duty fails']); await c.query('commit;'); } catch (e) { err = e.message; await c.query('rollback;').catch(() => {}); }
  await c.end();
  await ddl('drop trigger lc_boom_duty on public.duty_records;');
  assert(err !== null, 'the call fails (never a reported success)');
  const k = await counts(u4);
  assert(k.notices === 0 && k.duty === 0 && k.audit === 0, 'COMMITTED state after the failure: no notice, no duty record, no audit entry');
}
{
  await ddl('create trigger lc_boom_notice before insert on public.absence_notices for each row execute function public.lc_boom();');
  const c = await session(u4);
  let err = null;
  try { await c.query(SQL, ['notice fails']); await c.query('commit;'); } catch (e) { err = e.message; await c.query('rollback;').catch(() => {}); }
  await c.end();
  await ddl('drop trigger lc_boom_notice on public.absence_notices;');
  const k = await counts(u4);
  assert(err !== null && k.notices === 0 && k.duty === 0, 'a failing notice insert leaves no duty row behind (committed state)');
  const c2 = await session(u4);
  const ok = await c2.query(SQL, ['recovered']); await c2.query('commit;'); await c2.end();
  const k2 = await counts(u4);
  assert(ok.rows[0].result_same_day === true && k2.notices === 1 && k2.duty === 1 && k2.audit === 1, 'after the faults are removed the officer submits normally');
}

console.log('=== a check-in racing the leave: the leave rechecks after the row lock ===');
const u5 = await person('five');
await db.query("insert into public.duty_records (profile_id, station, team, duty_date, shift_code, status) values ($1,'KUL - MAA','ALPHA',$2::date,'M','pending');", [u5, today]);
{
  const checkin = await mk();
  await checkin.query('begin;');
  await checkin.query("update public.duty_records set check_in_at = now(), status = 'present' where profile_id = $1;", [u5]);
  const leave = await session(u5);
  let done = false; let err = null;
  const lp = leave.query(SQL, ['racing']).catch((e) => { err = e.message; }).finally(() => { done = true; });
  await sleep(500);
  assert(!done, 'the leave waits behind the uncommitted check-in on the attendance row');
  await checkin.query('commit;');
  await lp; await leave.query('rollback;').catch(() => {});
  await leave.end(); await checkin.end();
  const k = await counts(u5);
  const d = await one('select status, check_in_at from public.duty_records where profile_id = $1', [u5]);
  assert(err && /checking in|checked in/i.test(err) && k.notices === 0 && d.status === 'present' && d.check_in_at !== null, 'once the check-in commits the leave is refused: the attendance is untouched and no notice exists');
}

await db.end();
console.log(`\nTOTAL: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
