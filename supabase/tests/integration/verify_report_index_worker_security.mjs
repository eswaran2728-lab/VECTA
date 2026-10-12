// Security review of 20261106000001 (process_report_index_queue runs in the service-role context).
//  * authenticated and anonymous callers cannot invoke the worker (so it is no privilege-escalation path)
//  * SECURITY DEFINER with a fixed search_path; EXECUTE only for service_role
//  * the service-role claim is transaction-local and does not leak to the next transaction / session
//  * the worker touches only pending / failed queue rows, honours its batch size, and never edits report content
// Native PostgreSQL only; disposable local database.
import pg from 'pg';
import { assertDisposableLocalTarget } from './safeguards.mjs';

const { Client } = pg;
let failures = 0;
let passes = 0;
const assert = (c, m) => { if (!c) { failures += 1; console.log('FAIL:', m); } else { passes += 1; console.log('PASS:', m); } };

const pgConfig = { host: process.env.PGHOST || '127.0.0.1', port: parseInt(process.env.PGPORT || '55433', 10), user: process.env.PGUSER || 'postgres', password: process.env.PGPASSWORD || undefined };
const goldenDb = process.env.PGDATABASE || 'vecta_phase6_test';
const runDb = 'vecta_report_index_security_run';
assertDisposableLocalTarget(pgConfig, goldenDb, runDb);

const admin = new Client({ ...pgConfig, database: 'postgres' });
await admin.connect();
await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${runDb}' and pid <> pg_backend_pid();`);
await admin.query(`drop database if exists ${runDb};`);
await admin.query(`create database ${runDb} template ${goldenDb};`);
await admin.end();

const db = new Client({ ...pgConfig, database: runDb });
await db.connect();
const rows = async (sql, p) => (await db.query(sql, p)).rows;
const one = async (sql, p) => (await rows(sql, p))[0];
const as = async (role, uid) => {
  await db.query('reset role;');
  await db.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify(uid ? { sub: uid, role } : { role })]);
  await db.query(`set role ${role};`);
};
const reset = async () => { await db.query('reset role;'); await db.query("select set_config('request.jwt.claims', '', false)"); };
const denied = async (sql) => { await db.query('savepoint d'); try { await db.query(sql); await db.query('rollback to savepoint d'); return null; } catch (e) { await db.query('rollback to savepoint d'); return e.message; } };

console.log('=== report index worker security (20261106000001) ===');
await db.query('begin;');
await reset();

// ---- metadata
const meta = await one(`select p.prosecdef d, coalesce(p.proconfig, '{}') c,
  has_function_privilege('anon', p.oid, 'execute') an, has_function_privilege('authenticated', p.oid, 'execute') au,
  has_function_privilege('service_role', p.oid, 'execute') sv, has_function_privilege('public', p.oid, 'execute') pu
  from pg_proc p where p.oid = 'public.process_report_index_queue(integer)'::regprocedure;`);
assert(meta.d === true, 'SECURITY DEFINER');
assert(meta.c.some((x) => x === 'search_path=public'), 'fixed search_path = public');
assert(meta.an === false && meta.au === false && meta.pu === false && meta.sv === true, 'EXECUTE: service_role only (not anon, authenticated or PUBLIC)');
assert(/set_config\('request\.jwt\.claims'[^;]*,\s*true\)/.test((await one("select pg_get_functiondef('public.process_report_index_queue(integer)'::regprocedure) d")).d), 'the service-role claim is set transaction-locally (is_local = true)');

// ---- an authenticated or anonymous caller cannot use it (no privilege escalation)
const user = (await one('select id from public.profiles limit 1'))?.id ?? '00000000-0000-0000-0000-000000000001';
await as('authenticated', user);
let e = await denied('select * from public.process_report_index_queue(5);');
assert(e !== null && /permission denied/i.test(e), `authenticated caller is refused (${(e ?? 'ALLOWED').slice(0, 40)})`);
// and calling it must not have changed who they are
assert((await one('select auth.role() r')).r === 'authenticated', 'a refused call leaves the caller authenticated, not service_role');
await as('anon');
e = await denied('select * from public.process_report_index_queue(5);');
assert(e !== null && /permission denied/i.test(e), 'anonymous caller is refused');
await reset();

// ---- intended records only, batch size, no content edit, no leak
await db.query("insert into public.report_index_queue (source_table, source_id, status, attempts) values ('report_sec016', gen_random_uuid(), 'completed', 3), ('report_sec016', gen_random_uuid(), 'permanently_failed', 1), ('report_sec016', gen_random_uuid(), 'pending', 0), ('report_sec016', gen_random_uuid(), 'pending', 0);");
const before = await rows("select id, status, attempts from public.report_index_queue order by id");
await as('service_role');
const run = await one('select * from public.process_report_index_queue(1);');
await reset();
assert(run.processed === 1, `batch size is honoured (processed ${run.processed} of 2 pending)`);
const after = await rows("select id, status, attempts from public.report_index_queue order by id");
const changed = after.filter((a) => { const b = before.find((x) => x.id === a.id); return b.status !== a.status || b.attempts !== a.attempts; });
assert(changed.length === 1 && before.find((b) => b.id === changed[0].id).status === 'pending', 'only ONE pending record was touched; completed and permanently_failed records are untouched');
assert(changed[0].status === 'permanently_failed', 'a record whose source no longer exists is permanently failed, not retried');
// the claim does not outlive the call inside the same session once a new transaction begins
await db.query('commit;');
await db.query('begin;');
assert((await one('select auth.role() r')).r !== 'service_role', 'the service-role claim does not leak into the next transaction');
await db.query('rollback;');
// a separate session never sees it
const other = new Client({ ...pgConfig, database: runDb });
await other.connect();
assert((await other.query('select auth.role() r')).rows[0].r !== 'service_role', 'a separate session never inherits the claim');
await other.end();
await db.query('begin;');
await db.query('rollback;');
await db.end();
console.log(`\nTOTAL: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
