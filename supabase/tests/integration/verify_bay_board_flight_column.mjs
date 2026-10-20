// Bay Board RPC on a database whose bay_board predates the `flight` column (20261117000001). The approved staging project never received the
// 20260911* migrations, so public.bay_board has no flight / is_manual / arrival_report_id / departure_report_id / org_id and
// get_bay_board_secure() failed with 42703 "column b.flight does not exist". Dual-mode (PGlite / native PostgreSQL).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { assertDisposableLocalTarget } from './safeguards.mjs';

const { Client } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_DATA_DIR = path.join(__dirname, 'pgdata');
const RUN_DATA_DIR = path.join(__dirname, 'pgdata_baybay_run');
let failures = 0;
let passes = 0;
const assert = (c, m) => { if (!c) { failures += 1; console.log('FAIL:', m); } else { passes += 1; console.log('PASS:', m); } };

async function main() {
  const isNative = process.argv.includes('--native') || process.env.PG_NATIVE === '1';
  const pgConfig = { host: process.env.PGHOST || '127.0.0.1', port: parseInt(process.env.PGPORT || '55433', 10), user: process.env.PGUSER || 'postgres', password: process.env.PGPASSWORD || undefined };
  const goldenDb = process.env.PGDATABASE || 'vecta_phase6_test';
  const runDb = 'vecta_baybay_run';
  let db;
  if (isNative) {
    assertDisposableLocalTarget(pgConfig, goldenDb, runDb);
    console.log('=== Bay Board flight column against native PostgreSQL ===');
    const admin = new Client({ ...pgConfig, database: 'postgres' });
    await admin.connect();
    await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${runDb}' and pid <> pg_backend_pid();`);
    await admin.query(`drop database if exists ${runDb};`);
    await admin.query(`create database ${runDb} template ${goldenDb};`);
    const client = new Client({ ...pgConfig, database: runDb });
    await client.connect();
    db = { exec: (s) => client.query(s), query: (s, p) => client.query(s, p), close: async () => { await client.end(); await admin.query(`drop database if exists ${runDb};`); await admin.end(); } };
  } else {
    console.log('=== Bay Board flight column against PGlite ===');
    if (!fs.existsSync(GOLDEN_DATA_DIR)) { console.error('ERROR: ./pgdata does not exist -- run `node migrate.mjs` first.'); process.exit(1); }
    fs.rmSync(RUN_DATA_DIR, { recursive: true, force: true });
    fs.cpSync(GOLDEN_DATA_DIR, RUN_DATA_DIR, { recursive: true });
    const pgliteDb = new PGlite(RUN_DATA_DIR);
    db = { exec: (s) => pgliteDb.exec(s), query: (s, p) => pgliteDb.query(s, p), close: () => pgliteDb.close() };
  }
  await db.exec('set check_function_bodies = off;');
  await db.exec('begin;');
  await db.exec(`
    create or replace function pg_temp.sim_user(p uuid) returns void language plpgsql as $$
    begin perform set_config('request.jwt.claims', json_build_object('sub', p::text, 'role', 'authenticated')::text, true); perform set_config('role', 'authenticated', true); end; $$;
    create or replace function pg_temp.sim_service() returns void language plpgsql as $$
    begin perform set_config('request.jwt.claims', '{}', true); perform set_config('role', 'service_role', true); end; $$;`);
  const sup = () => db.exec('select pg_temp.sim_service();');
  const one = async (s, p) => (await db.query(s, p)).rows[0];
  const rows = async (s, p) => (await db.query(s, p)).rows;
  await sup();
  let sp = 0;
  async function attempt(sess, fn) {
    const name = `s${++sp}`;
    await sess();
    await db.exec(`savepoint ${name};`);
    try { const r = await fn(); await db.exec(`release savepoint ${name};`); return { ok: true, r }; }
    catch (e) { await db.exec(`rollback to savepoint ${name}; release savepoint ${name};`); return { ok: false, err: e.message, code: e.code }; }
    finally { await sup(); }
  }
  const asUser = (u) => () => db.query('select pg_temp.sim_user($1)', [u]);

  let seq = 0x9c00;
  const nextId = () => `00000000-0000-0000-0000-${(++seq).toString(16).padStart(12, '0')}`;
  const myAoc = (await one("select id from public.aocs where code = 'MY';")).id;
  const opsDept = (await one("select id from public.departments where aoc_id = $1 and code = 'operation';", [myAoc])).id;
  const roleMap = new Map((await rows('select id, code from public.role_definitions;')).map((r) => [r.code, r.id]));
  const kul = await one("select id, hub_id from public.org_stations where code = 'KUL - MAA';");
  const hubCode = (await one('select code from public.hubs where id = $1;', [kul.hub_id])).code;

  const roleUser = async (label, roleCode) => {
    const id = nextId();
    await db.query('insert into auth.users (id, email) values ($1,$2);', [id, `bb-${label}@example.test`]);
    await db.query("insert into public.profiles (id, email, name, staff_no, role, status) values ($1,$2,$3,$4,'ASO','approved') on conflict (id) do update set status = 'approved';", [id, `bb-${label}@example.test`, `BB ${label}`, `BB-${label}`.slice(0, 20)]);
    if (roleCode) await db.query("insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, starts_at) values ($1,$2,$3,$4, now() - interval '1 day');", [id, roleMap.get(roleCode), myAoc, opsDept]);
    return id;
  };
  const opm = await roleUser('opm', 'operation_manager');
  const outsider = await roleUser('outsider', null);

  // ---- reproduce the historical staging state: bay_board without the SEC016 / multi-tenant columns
  await db.exec('reset role;');
  await db.exec('alter table public.bay_board drop column if exists flight, drop column if exists is_manual, drop column if exists arrival_report_id, drop column if exists departure_report_id;');
  await db.query("insert into public.bay_board (id, station, reg_no, aircraft_type, bay, on_ground_since, created_by) values ($1,'KUL - MAA','9M-BBA','A320','B7', now() - interval '2 hours', $2);", [nextId(), opm]);
  await sup();
  assert((await rows("select 1 from information_schema.columns where table_schema='public' and table_name='bay_board' and column_name='flight';")).length === 0, 'fixture: bay_board has no flight column (staging state)');

  const before = await attempt(asUser(opm), () => rows('select * from public.get_bay_board_secure(null, null);'));
  assert(!before.ok && before.code === '42703', `before the migration the RPC fails with 42703 (got: ${before.ok ? 'success' : before.err})`);

  // ---- apply the forward migration exactly as written
  const MIGRATION = fs.readFileSync(path.join(__dirname, '..', '..', 'migrations', '20261117000001_bay_board_flight_column.sql'), 'utf8');
  await db.exec('reset role;');
  await db.exec(MIGRATION);
  await sup();

  const after = await attempt(asUser(opm), () => rows('select * from public.get_bay_board_secure(null, null);'));
  assert(after.ok && after.r.length === 1 && after.r[0].reg_no === '9M-BBA' && after.r[0].bay === 'B7' && 'flight' in after.r[0] && after.r[0].flight === null, 'after the migration the Operation Manager reads the open bay row (flight column present, null for existing rows)');
  const scoped = await attempt(asUser(opm), () => rows('select * from public.get_bay_board_secure($1, $2);', [hubCode, 'KUL - MAA']));
  assert(scoped.ok && scoped.r.length === 1, 'hub + station filters still resolve the row');
  const wrongStation = await attempt(asUser(opm), () => rows("select * from public.get_bay_board_secure(null, 'PEN');"));
  assert(wrongStation.ok && wrongStation.r.length === 0, 'a different station filter excludes the row');
  const scopes = await attempt(asUser(opm), () => rows('select * from public.list_bay_board_scopes_secure();'));
  assert(scopes.ok && scopes.r.length > 0, 'list_bay_board_scopes_secure still works');

  // a flight value written after the repair is returned
  await db.exec('reset role;');
  await db.exec("update public.bay_board set flight = 'AK703' where reg_no = '9M-BBA';");
  await sup();
  const withFlight = await attempt(asUser(opm), () => rows('select flight from public.get_bay_board_secure(null, null);'));
  assert(withFlight.ok && withFlight.r[0]?.flight === 'AK703', 'a stored flight value is returned by the RPC');

  // ---- authorization and function hardening unchanged
  const denied = await attempt(asUser(outsider), () => rows('select * from public.get_bay_board_secure(null, null);'));
  assert(!denied.ok, 'a non-oversight role is still refused');
  const anon = await attempt(() => db.exec("select set_config('request.jwt.claims','{}',true); select set_config('role','anon',true);"), () => rows('select * from public.get_bay_board_secure(null, null);'));
  assert(!anon.ok, 'anon is still refused (execute revoked)');
  const fn = await one("select p.prosecdef, p.provolatile, p.proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'get_bay_board_secure';");
  assert(fn.prosecdef === true && fn.provolatile === 's' && (fn.proconfig || []).includes('search_path=public'), 'still SECURITY DEFINER, STABLE, search_path fixed to public');
  const acl = await one("select has_function_privilege('anon','public.get_bay_board_secure(text,text)','execute') a, has_function_privilege('authenticated','public.get_bay_board_secure(text,text)','execute') u, has_function_privilege('service_role','public.get_bay_board_secure(text,text)','execute') s;");
  assert(acl.a === false && acl.u === true && acl.s === true, 'execute: anon denied, authenticated + service_role granted');

  // ---- idempotent on a database that already has the column
  const again = await attempt(() => db.exec('reset role;'), () => db.exec(MIGRATION));
  assert(again.ok, 're-applying the migration is a no-op');

  await db.exec('rollback;');
  await db.close();
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
