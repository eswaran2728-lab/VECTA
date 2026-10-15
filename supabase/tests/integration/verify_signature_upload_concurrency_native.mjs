// Signature bucket upload authorization: real multi-connection concurrency on native PostgreSQL (20261113000001).
//  * many sessions inserting the SAME object name: exactly one object, every other attempt is refused
//  * a mixed burst of authorised and cross-user attempts: only the authorised ones create objects
//  * a workflow state change committed while uploads are in flight: uploads that start afterwards are refused
import pg from 'pg';
import { assertDisposableLocalTarget } from './safeguards.mjs';

const { Client } = pg;
let failures = 0;
let passes = 0;
const assert = (c, m) => { if (!c) { failures += 1; console.log('FAIL:', m); } else { passes += 1; console.log('PASS:', m); } };

const pgConfig = { host: process.env.PGHOST || '127.0.0.1', port: parseInt(process.env.PGPORT || '55433', 10), user: process.env.PGUSER || 'postgres', password: process.env.PGPASSWORD || undefined };
const goldenDb = process.env.PGDATABASE || 'vecta_phase6_test';
const runDb = 'vecta_sigup_concurrency_run';
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
const asSuper = async (fn) => { await db.query('reset role;'); try { return await fn(); } finally { await sup(); } };
const one = async (s, p) => (await db.query(s, p)).rows[0];
const mk = async () => { const c = new Client({ ...pgConfig, database: runDb, statement_timeout: 20000, query_timeout: 25000 }); await c.connect(); return c; };
async function session(user) {
  const c = await mk();
  await c.query('begin;');
  await c.query("select set_config('request.jwt.claims', json_build_object('sub', $1::text, 'role', 'authenticated')::text, true), set_config('role', 'authenticated', true);", [user]);
  return c;
}
let seq = 0x9900;
const nextId = () => `00000000-0000-0000-0000-${(++seq).toString(16).padStart(12, '0')}`;
const uuid = () => nextId().replace(/^0000/, 'aaaa');

await db.query("insert into storage.buckets (id, name, public) values ('signatures', 'signatures', false) on conflict (id) do nothing;");
await db.query('create unique index if not exists bucketid_objname on storage.objects (bucket_id, name);'); // Supabase Storage has this index
await db.query('grant select, insert, update, delete on storage.objects to authenticated, service_role;');
await sup();
async function external(label, role) {
  const id = nextId();
  await db.query('insert into auth.users (id, email) values ($1,$2);', [id, `sc-${label}@example.test`]);
  await db.query("insert into public.profiles (id, email, name, staff_no, role, status) values ($1,$2,$3,$4,'ASO','approved') on conflict (id) do update set status = 'approved';", [id, `sc-${label}@example.test`, `SC ${label}`, `SC-${label}`.slice(0, 20)]);
  await db.query('insert into public.users (id, name, staff_id, email, role, status) values ($1,$2,$3,$4,$5,$6);', [id, `SC ${label}`, `SC-${label}`.slice(0, 20), `sc-${label}@example.test`, role, 'active']);
  return id;
}
const insert = (c, name, owner) => c.query("insert into storage.objects (bucket_id, name, owner) values ('signatures', $1, $2);", [name, owner]);
const count = async (like) => (await one("select count(*)::int n from storage.objects where bucket_id = 'signatures' and name like $1", [like])).n;

console.log('=== twelve sessions insert the SAME name at once ===');
{
  const driver = await external('drv', 'warehouse_pic');
  const name = `part-a/${driver}/${uuid()}.png`;
  const cs = await Promise.all(Array.from({ length: 12 }, () => session(driver)));
  const res = await Promise.allSettled(cs.map(async (c) => { await insert(c, name, driver); await c.query('commit;'); }));
  await Promise.all(cs.map((c) => c.query('rollback;').catch(() => {}).then(() => c.end())));
  const won = res.filter((r) => r.status === 'fulfilled').length;
  assert(won === 1, `exactly one of twelve simultaneous inserts of one name succeeded (found ${won})`);
  assert((await count(name)) === 1, 'exactly one object exists for that name');
}

console.log('=== a mixed burst: own-uid attempts succeed, cross-user attempts are all refused ===');
{
  const drivers = [];
  for (let i = 0; i < 6; i += 1) drivers.push(await external(`d${i}`, 'warehouse_pic'));
  const vendor = await external('ven', 'vendor');
  const attempts = [];
  for (const d of drivers) {
    attempts.push({ who: d, name: `part-a/${d}/${uuid()}.png`, ok: true });                       // own id
    attempts.push({ who: d, name: `part-a/${vendor}/${uuid()}.png`, ok: false });                 // another account's id
    attempts.push({ who: vendor, name: `part-a/${d}/${uuid()}.png`, ok: false });                 // a Vendor on a Driver id
    attempts.push({ who: d, name: `arbitrary-test/${uuid()}.png`, ok: false });                   // unknown prefix
  }
  const cs = await Promise.all(attempts.map((a) => session(a.who)));
  const res = await Promise.allSettled(cs.map(async (c, i) => { await insert(c, attempts[i].name, attempts[i].who); await c.query('commit;'); }));
  await Promise.all(cs.map((c) => c.query('rollback;').catch(() => {}).then(() => c.end())));
  const okIdx = attempts.map((a, i) => (res[i].status === 'fulfilled' ? i : -1)).filter((i) => i >= 0);
  assert(okIdx.length === 6 && okIdx.every((i) => attempts[i].ok), `exactly the six authorised uploads succeeded (${okIdx.length} succeeded)`);
  const rlsDenied = res.filter((r, i) => !attempts[i].ok && r.status === 'rejected' && /row-level security|policy/i.test(String(r.reason?.message))).length;
  assert(rlsDenied === 18, `all eighteen unauthorised attempts were refused by Storage RLS (${rlsDenied})`);
  assert((await count('arbitrary-test/%')) === 0, 'no object exists under the unknown prefix');
}

console.log('=== a workflow state change committed mid-burst: later uploads are refused ===');
{
  const vendor = await external('ven2', 'vendor');
  const pen = await one("select id from public.org_stations where code = 'PEN';");
  const myAoc = (await one("select id from public.aocs where code = 'MY';")).id;
  const dId = nextId();
  await asSuper(async () => {
  await db.query('set session_replication_role = replica;');
  await db.query(`insert into public.caterlink_vendor_deliveries (id, delivery_number, aoc_id, station_id, vendor_user_id, status, driver_name, driver_nric, vehicle_registration_no, seal_number)
    values ($1,'CLV-SC-1',$2,$3,$4,'SECURITY_VERIFIED','D','900101-01-1234','VEN1234','S');`, [dId, myAoc, pen.id, vendor]);
  await db.query('set session_replication_role = origin;');
  });
  const before = await Promise.allSettled([1, 2, 3].map(async () => { const c = await session(vendor); try { await insert(c, `vendor-part-c/${dId}/${uuid()}.png`, vendor); await c.query('commit;'); } finally { await c.end(); } }));
  assert(before.every((r) => r.status === 'fulfilled'), 'while the delivery is security-verified every owner upload is accepted');
  await db.query("update public.caterlink_vendor_deliveries set status = 'COMPLETED' where id = $1", [dId]);
  const after = await Promise.allSettled(Array.from({ length: 8 }, async () => { const c = await session(vendor); try { await insert(c, `vendor-part-c/${dId}/${uuid()}.png`, vendor); await c.query('commit;'); } finally { await c.end(); } }));
  assert(after.every((r) => r.status === 'rejected' && /row-level security|policy/i.test(String(r.reason?.message))), 'once the delivery is COMPLETED, eight simultaneous uploads are all refused by Storage RLS');
  assert((await count(`vendor-part-c/${dId}/%`)) === 3, 'only the three uploads made before the state change exist');
}

await db.end();
console.log(`\nTOTAL: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
