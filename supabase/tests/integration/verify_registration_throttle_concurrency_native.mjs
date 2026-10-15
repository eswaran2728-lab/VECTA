// Registration throttle: real concurrent connections hitting the same key (native PostgreSQL, 20261110000001).
import pg from 'pg';
import { assertDisposableLocalTarget } from './safeguards.mjs';

const { Client } = pg;
let failures = 0;
let passes = 0;
const assert = (c, m) => { if (!c) { failures += 1; console.log('FAIL:', m); } else { passes += 1; console.log('PASS:', m); } };
const pgConfig = { host: process.env.PGHOST || '127.0.0.1', port: parseInt(process.env.PGPORT || '55433', 10), user: process.env.PGUSER || 'postgres', password: process.env.PGPASSWORD || undefined };
const goldenDb = process.env.PGDATABASE || 'vecta_phase6_test';
const runDb = 'vecta_throttle_concurrency_run';
assertDisposableLocalTarget(pgConfig, goldenDb, runDb);
const admin = new Client({ ...pgConfig, database: 'postgres' });
await admin.connect();
await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${runDb}' and pid <> pg_backend_pid();`);
await admin.query(`drop database if exists ${runDb};`);
await admin.query(`create database ${runDb} template ${goldenDb};`);
await admin.end();

const mk = async () => {
  const c = new Client({ ...pgConfig, database: runDb, statement_timeout: 20000, query_timeout: 25000 });
  await c.connect();
  await c.query("select set_config('request.jwt.claims', '{}', false), set_config('role', 'service_role', false);");
  return c;
};
const KEY = 'a'.repeat(64);
const SQL = 'select public.registration_throttle_hit($1, $2, $3) as ok;';

console.log('=== forty simultaneous hits on one key, limit 7 ===');
const cs = await Promise.all(Array.from({ length: 40 }, mk));
const res = await Promise.allSettled(cs.map((c) => c.query(SQL, [KEY, 7, 3600])));
await Promise.all(cs.map((c) => c.end()));
const ok = res.filter((r) => r.status === 'fulfilled' && r.value.rows[0].ok === true).length;
const limited = res.filter((r) => r.status === 'fulfilled' && r.value.rows[0].ok === false).length;
assert(res.every((r) => r.status === 'fulfilled'), 'no simultaneous call failed (no lost update, no deadlock)');
assert(ok === 7 && limited === 33, `exactly seven were allowed and thirty-three refused (allowed ${ok}, refused ${limited})`);
const c = await mk();
const hits = (await c.query('select hits from public.registration_throttle where key_hash = $1', [KEY])).rows;
assert(hits.length === 1 && hits[0].hits === 40, 'one counter row recorded all forty hits');
await c.end();
console.log(`\nTOTAL: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
