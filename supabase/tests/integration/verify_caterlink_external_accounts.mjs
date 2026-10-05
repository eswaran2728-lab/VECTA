// CaterLink external account table (20261023000001): created only where missing; own-row read; no client writes.
//    node verify_caterlink_external_accounts.mjs [--native]
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { assertDisposableLocalTarget } from './safeguards.mjs';

const { Client } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_DATA_DIR = path.join(__dirname, 'pgdata');
const RUN_DATA_DIR = path.join(__dirname, 'pgdata_cl_external_run');

function copyDir(src, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true });
}

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    failures += 1;
    console.log('FAIL:', msg);
    return;
  }
  console.log('PASS:', msg);
}

async function main() {
  const isNative = process.argv.includes('--native') || process.env.PG_NATIVE === '1';
  const pgConfig = {
    host: process.env.PGHOST || '127.0.0.1',
    port: parseInt(process.env.PGPORT || '55433', 10),
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || undefined,
  };
  const goldenDb = process.env.PGDATABASE || 'vecta_phase6_test';
  const runDb = 'vecta_cl_external_run';

  let db;
  if (isNative) {
    assertDisposableLocalTarget(pgConfig, goldenDb, runDb);
    console.log(`=== CaterLink external-account verification against Native PostgreSQL (${pgConfig.host}:${pgConfig.port}) ===`);
    const admin = new Client({ ...pgConfig, database: 'postgres' });
    await admin.connect();
    await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${runDb}' and pid <> pg_backend_pid();`);
    await admin.query(`drop database if exists ${runDb};`);
    await admin.query(`create database ${runDb} template ${goldenDb};`);
    const client = new Client({ ...pgConfig, database: runDb });
    await client.connect();
    db = {
      exec: (sql) => client.query(sql),
      query: (sql, params) => client.query(sql, params),
      close: async () => {
        await client.end();
        await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${runDb}' and pid <> pg_backend_pid();`);
        await admin.query(`drop database if exists ${runDb};`);
        await admin.end();
      },
    };
  } else {
    console.log('=== CaterLink external-account verification against PGlite embedded engine ===');
    if (!fs.existsSync(GOLDEN_DATA_DIR)) {
      console.error('ERROR: ./pgdata does not exist -- run `node migrate.mjs` first.');
      process.exit(1);
    }
    copyDir(GOLDEN_DATA_DIR, RUN_DATA_DIR);
    const pgliteDb = new PGlite(RUN_DATA_DIR);
    db = {
      exec: (sql) => pgliteDb.exec(sql),
      query: (sql, params) => pgliteDb.query(sql, params),
      close: () => pgliteDb.close(),
    };
  }

  await db.exec('set check_function_bodies = off;');
  await db.exec('begin;');
  await db.exec(`
    create or replace function pg_temp.simulate_user(p_profile_id uuid)
    returns void language plpgsql as $$
    begin
      perform set_config('request.jwt.claims', json_build_object('sub', p_profile_id::text, 'role', 'authenticated')::text, true);
      perform set_config('role', 'authenticated', true);
    end;
    $$;
    create or replace function pg_temp.simulate_service_role()
    returns void language plpgsql as $$
    begin
      perform set_config('request.jwt.claims', '{}', true);
      perform set_config('role', 'service_role', true);
    end;
    $$;
  `);
  const simulateUser = (id) => db.query('select pg_temp.simulate_user($1);', [id]);
  const simulateService = () => db.exec('select pg_temp.simulate_service_role();');
  async function expectFail(fn) {
    await db.exec('savepoint sp_x;');
    try { await fn(); await db.exec('release savepoint sp_x;'); return { failed: false }; }
    catch (e) { await db.exec('rollback to savepoint sp_x; release savepoint sp_x;'); return { failed: true, error: e }; }
  }
  await simulateService();
  const one = async (sql, params) => (await db.query(sql, params)).rows[0];
  const migrationSql = fs.readFileSync(path.join(__dirname, '..', '..', 'migrations', '20261023000001_caterlink_external_account_table.sql'), 'utf8');

  let seq = 0xd00;
  const nextId = () => `00000000-0000-0000-0000-${(++seq).toString(16).padStart(12, '0')}`;
  async function authUser(label) {
    const id = nextId();
    await db.query('insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing;', [id, `ext-${label}@example.test`]);
    return id;
  }

  console.log('\n--- SECTION 1: where public.users already exists the migration changes nothing ---');
  {
    const before = (await db.query("select count(*)::int n from pg_policies where tablename = 'users';")).rows[0].n;
    const colsBefore = (await db.query("select string_agg(column_name, ',' order by ordinal_position) c from information_schema.columns where table_schema='public' and table_name='users';")).rows[0].c;
    await db.exec('reset role;');
    await db.exec(migrationSql);
    await simulateService();
    const after = (await db.query("select count(*)::int n from pg_policies where tablename = 'users';")).rows[0].n;
    const colsAfter = (await db.query("select string_agg(column_name, ',' order by ordinal_position) c from information_schema.columns where table_schema='public' and table_name='users';")).rows[0].c;
    assert(before === after && colsBefore === colsAfter, 'an existing public.users table keeps its columns and policies exactly');
  }

  console.log('\n--- SECTION 2: created where missing (staging shape) ---');
  await db.exec('reset role;');
  await db.exec('drop table public.users cascade;');
  await db.exec(migrationSql);
  await simulateService();
  {
    assert((await one("select relrowsecurity as r from pg_class where oid = 'public.users'::regclass;")).r === true, 'RLS is enabled');
    const pol = (await db.query("select policyname, cmd, roles::text roles, qual from pg_policies where tablename = 'users';")).rows;
    assert(pol.length === 1 && pol[0].cmd === 'SELECT' && /auth\.uid\(\)/.test(pol[0].qual) && !/true/.test(pol[0].qual.replace(/auth\.uid\(\)/g, '')), 'exactly one policy: own-row select');
    const priv = await one("select has_table_privilege('anon','public.users','select') a, has_table_privilege('authenticated','public.users','select') s, has_table_privilege('authenticated','public.users','insert') i, has_table_privilege('authenticated','public.users','update') u, has_table_privilege('authenticated','public.users','delete') d, has_table_privilege('service_role','public.users','insert') sr;");
    assert(priv.a === false && priv.s === true && priv.i === false && priv.u === false && priv.d === false && priv.sr === true, 'grants: anon none; authenticated select only; service_role full');
    const cols = (await db.query("select column_name from information_schema.columns where table_schema='public' and table_name='users';")).rows.map((r) => r.column_name);
    assert(!cols.some((c) => /pass|secret|token/i.test(c)), 'no password, secret or token column');

    const driver = await authUser('driver');
    const vendor = await authUser('vendor');
    const other = await authUser('other');
    await db.query("insert into public.users (id, name, staff_id, email, role, status) values ($1,'Drv','D-1','d@example.test','warehouse_pic','active'), ($2,'Vnd','V-1','v@example.test','vendor','active'), ($3,'Oth','O-1','o@example.test','vendor','pending');", [driver, vendor, other]);
    const badId = await authUser('bad');
    const bad = await expectFail(() => db.query("insert into public.users (id, name, staff_id, email, role, status) values ($1,'X','X-1','x@example.test','supervisor','active');", [badId]));
    assert(bad.failed, "a VECTA staff role such as 'supervisor' cannot be stored: the table cannot carry staff authority");
    const dupId = await authUser('dup');
    const dupe = await expectFail(() => db.query("insert into public.users (id, name, staff_id, email, role) values ($1,'Dup','D-1','dup@example.test','vendor');", [dupId]));
    assert(dupe.failed, 'duplicate staff id rejected');

    await simulateUser(driver);
    const seen = (await db.query('select id, role from public.users;')).rows;
    const write = await expectFail(() => db.query("update public.users set role = 'vendor' where id = $1;", [driver]));
    const ins = await expectFail(() => db.query("insert into public.users (id, name, staff_id, email, role) values ($1,'S','S-9','s@example.test','vendor');", [driver]));
    const del = await expectFail(() => db.query('delete from public.users where id = $1;', [driver]));
    await simulateService();
    assert(seen.length === 1 && seen[0].id === driver && seen[0].role === 'warehouse_pic', 'a driver reads only its own account row (not the vendor or another account)');
    assert(write.failed && ins.failed && del.failed, 'a client cannot update, insert or delete account rows (no self-promotion, no fabricated identity)');
    await db.exec('set role anon;');
    const anon = await expectFail(() => db.query('select count(*) from public.users;'));
    await simulateService();
    assert(anon.failed, 'anon cannot read the account table');

    // a CaterLink-only identity gains no VECTA data through this table or RLS
    await simulateUser(driver);
    const leaks = {};
    for (const t of ['profiles', 'report_sec014', 'team_rosters', 'duty_records', 'overtime_requests', 'absence_notices', 'bay_board']) {
      const r = await expectFail(async () => { leaks[t] = (await one(`select count(*)::int n from public.${t};`)).n; });
      if (r.failed) leaks[t] = 0; // a permission error is also a denial
    }
    await simulateService();
    assert(Object.entries(leaks).every(([t, n]) => (t === 'profiles' ? n <= 1 : n === 0)), `an external driver with no canonical assignment reads no VECTA rows (only its own profile row at most) (${JSON.stringify(leaks)})`);
  }

  console.log('\n--- SECTION 3: idempotent ---');
  {
    const before = (await db.query("select count(*)::int n from pg_policies where tablename = 'users';")).rows[0].n;
    await db.exec('reset role;');
    await db.exec(migrationSql);
    await simulateService();
    const after = (await db.query("select count(*)::int n from pg_policies where tablename = 'users';")).rows[0].n;
    assert(before === after && after === 1, 'a second application is a no-op');
  }


  console.log(`\nCaterLink external-account verification completed. Total failures: ${failures}`);

  await db.exec('rollback;');
  await db.close();
  if (!isNative) fs.rmSync(RUN_DATA_DIR, { recursive: true, force: true });
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
