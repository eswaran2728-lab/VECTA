// Registration throttle -- registration_throttle_hit() (20261110000001). Runs on PGlite (default) and on native PostgreSQL (--native).
// One RPC records the absence notice AND the same-day absent duty state in one transaction, deriving identity, station and team inside the
// database. Failure of either write leaves neither; the direct client write path to absence_notices is closed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { assertDisposableLocalTarget } from './safeguards.mjs';

const { Client } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_DATA_DIR = path.join(__dirname, 'pgdata');
const RUN_DATA_DIR = path.join(__dirname, 'pgdata_throttle_run');
let failures = 0;
let passes = 0;
const assert = (c, m) => { if (!c) { failures += 1; console.log('FAIL:', m); } else { passes += 1; console.log('PASS:', m); } };

async function main() {
  const isNative = process.argv.includes('--native') || process.env.PG_NATIVE === '1';
  const pgConfig = { host: process.env.PGHOST || '127.0.0.1', port: parseInt(process.env.PGPORT || '55433', 10), user: process.env.PGUSER || 'postgres', password: process.env.PGPASSWORD || undefined };
  const goldenDb = process.env.PGDATABASE || 'vecta_phase6_test';
  const runDb = 'vecta_throttle_run';
  let db;
  if (isNative) {
    assertDisposableLocalTarget(pgConfig, goldenDb, runDb);
    console.log('=== Registration throttle against native PostgreSQL ===');
    const admin = new Client({ ...pgConfig, database: 'postgres' });
    await admin.connect();
    await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${runDb}' and pid <> pg_backend_pid();`);
    await admin.query(`drop database if exists ${runDb};`);
    await admin.query(`create database ${runDb} template ${goldenDb};`);
    const client = new Client({ ...pgConfig, database: runDb });
    await client.connect();
    db = { exec: (s) => client.query(s), query: (s, p) => client.query(s, p), close: async () => { await client.end(); await admin.query(`drop database if exists ${runDb};`); await admin.end(); } };
  } else {
    console.log('=== Registration throttle against PGlite ===');
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
    create or replace function pg_temp.sim_anon() returns void language plpgsql as $$
    begin perform set_config('request.jwt.claims', '{}', true); perform set_config('role', 'anon', true); end; $$;
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
    catch (e) { await db.exec(`rollback to savepoint ${name}; release savepoint ${name};`); return { ok: false, err: e.message }; }
    finally { await sup(); }
  }
  const asUser = (u) => () => db.query('select pg_temp.sim_user($1)', [u]);
  const asAnon = () => db.exec('select pg_temp.sim_anon();');
  const asAuthed = () => db.exec("select set_config('request.jwt.claims', '{}', true), set_config('role', 'authenticated', true);");

  const hex64 = (c) => c.repeat(64);
  const hit = (k, limit = 3, win = 3600) => db.query('select public.registration_throttle_hit($1, $2, $3) as ok;', [k, limit, win]);

  console.log('--- grants ---');
  const g = await one("select has_function_privilege('anon','public.registration_throttle_hit(text,integer,integer)','execute') an, has_function_privilege('authenticated','public.registration_throttle_hit(text,integer,integer)','execute') au, has_function_privilege('service_role','public.registration_throttle_hit(text,integer,integer)','execute') sv, exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x where p.oid = 'public.registration_throttle_hit(text,integer,integer)'::regprocedure and x.grantee = 0 and x.privilege_type = 'EXECUTE') pub;");
  assert(!g.an && !g.au && g.sv && !g.pub, 'only the service role may call the limiter');
  const t = await one("select has_table_privilege('anon','public.registration_throttle','select,insert,update,delete') an, has_table_privilege('authenticated','public.registration_throttle','select,insert,update,delete') au, has_table_privilege('service_role','public.registration_throttle','select,insert,update,delete') sv;");
  assert(!t.an && !t.au && t.sv, 'clients cannot read or write the counter table');
  const denied = await attempt(asAuthed, () => hit(hex64('a')));
  assert(!denied.ok && /permission denied/i.test(denied.err), 'an authenticated client calling the limiter is denied');

  console.log('--- behaviour (as the service role) ---');
  await sup();
  const seq = [];
  for (let i = 0; i < 5; i += 1) seq.push((await hit(hex64('b'), 3)).rows[0].ok);
  assert(JSON.stringify(seq) === JSON.stringify([true, true, true, false, false]), 'a key is allowed exactly `limit` times per window, then refused');
  assert((await hit(hex64('c'), 3)).rows[0].ok === true, 'a different key has its own counter');
  const row = await one("select hits from public.registration_throttle where key_hash = $1;", [hex64('b')]);
  assert(row.hits === 5, 'hits are counted atomically');
  const bad = [['not-a-hash', 3, 3600], [hex64('d'), 0, 3600], [hex64('d'), 1001, 3600], [hex64('d'), 3, 5], [hex64('d'), 3, 100000], [null, 3, 3600], [hex64('D'), 3, 3600]];
  for (const args of bad) {
    const r = await attempt(sup, () => db.query('select public.registration_throttle_hit($1, $2, $3);', args));
    assert(!r.ok && /Invalid throttle request/.test(r.err), `invalid input is refused: ${JSON.stringify(args).slice(0, 50)}`);
  }
  await db.query("insert into public.registration_throttle (key_hash, window_start, hits) select md5(i::text) || md5((i + 1)::text), now() - interval '3 days', 1 from generate_series(1, 120) i;");
  const before = (await one('select count(*)::int n from public.registration_throttle')).n;
  await hit(hex64('e'), 3);
  const after = (await one('select count(*)::int n from public.registration_throttle')).n;
  assert(after < before + 1 && before - after >= 49, 'expired windows are purged in small bounded batches (at most 50 per call)');
  assert(before - after <= 50, 'housekeeping never deletes more than a bounded batch');

  await db.exec('rollback;');
  await db.close();
  console.log(`
TOTAL: ${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
