// Vendor Part B signature authorization (20261111000001). Runs on PGlite (default) and on native PostgreSQL (--native).
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
const RUN_DATA_DIR = path.join(__dirname, 'pgdata_vendorsig_run');
let failures = 0;
let passes = 0;
const assert = (c, m) => { if (!c) { failures += 1; console.log('FAIL:', m); } else { passes += 1; console.log('PASS:', m); } };

async function main() {
  const isNative = process.argv.includes('--native') || process.env.PG_NATIVE === '1';
  const pgConfig = { host: process.env.PGHOST || '127.0.0.1', port: parseInt(process.env.PGPORT || '55433', 10), user: process.env.PGUSER || 'postgres', password: process.env.PGPASSWORD || undefined };
  const goldenDb = process.env.PGDATABASE || 'vecta_phase6_test';
  const runDb = 'vecta_vendorsig_run';
  let db;
  if (isNative) {
    assertDisposableLocalTarget(pgConfig, goldenDb, runDb);
    console.log('=== Vendor signature authorization against native PostgreSQL ===');
    const admin = new Client({ ...pgConfig, database: 'postgres' });
    await admin.connect();
    await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${runDb}' and pid <> pg_backend_pid();`);
    await admin.query(`drop database if exists ${runDb};`);
    await admin.query(`create database ${runDb} template ${goldenDb};`);
    const client = new Client({ ...pgConfig, database: runDb });
    await client.connect();
    db = { exec: (s) => client.query(s), query: (s, p) => client.query(s, p), close: async () => { await client.end(); await admin.query(`drop database if exists ${runDb};`); await admin.end(); } };
  } else {
    console.log('=== Vendor signature authorization against PGlite ===');
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

  let seq = 0x9300;
  const nextId = () => `00000000-0000-0000-0000-${(++seq).toString(16).padStart(12, '0')}`;
  const myAoc = (await one("select id from public.aocs where code = 'MY';")).id;
  const myEntity = (await one("select id from public.operating_entities where aoc_id = $1 and code = 'MAA';", [myAoc])).id;
  const opsDept = (await one("select id from public.departments where aoc_id = $1 and code = 'operation';", [myAoc])).id;
  const roleMap = new Map((await rows('select id, code from public.role_definitions;')).map((r) => [r.code, r.id]));
  const station = async (code) => one('select id, hub_id, code from public.org_stations where code = $1;', [code]);
  const kul = await station('KUL - MAA'); const pen = await station('PEN');
  const team = async (st, name) => { await db.query('insert into public.org_teams (station_id, name) values ($1,$2) on conflict (station_id, name) do nothing;', [st.id, name]); return (await one('select id from public.org_teams where station_id = $1 and name = $2;', [st.id, name])).id; };
  const kulAlpha = await team(kul, 'ALPHA'); const penAlpha = await team(pen, 'ALPHA');
  const today = (await one("select (now() at time zone 'Asia/Kuala_Lumpur')::date::text d")).d;

  async function person(label, { st = kul, tm = kulAlpha, stTxt = 'KUL - MAA', tmTxt = 'ALPHA', status = 'approved', timing = {} } = {}) {
    const id = nextId();
    await db.query('insert into auth.users (id, email) values ($1,$2) on conflict (id) do nothing;', [id, `lv-${label}@example.test`]);
    await db.query("insert into public.profiles (id, email, name, staff_no, role, status, station, team) values ($1,$2,$3,$4,'ASO',$5,$6,$7) on conflict (id) do update set status = excluded.status, name = excluded.name, staff_no = excluded.staff_no, station = excluded.station, team = excluded.team;", [id, `lv-${label}@example.test`, `LV ${label}`, `LV-${label}`.slice(0, 20), status, stTxt, tmTxt]);
    const mem = (await one("insert into public.user_entity_memberships (profile_id, aoc_id, operating_entity_id, status, is_primary) values ($1,$2,$3,'active',true) returning id;", [id, myAoc, myEntity])).id;
    await db.query(`insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, hub_id, station_id, team_id, entity_membership_id, starts_at, ends_at, revoked_at)
      values ($1,$2,$3,$4,$5,$6,$7,$8, coalesce($9::timestamptz, now() - interval '1 day'), $10, $11);`, [id, roleMap.get('aso'), myAoc, opsDept, st.hub_id, st.id, tm, mem, timing.starts ?? null, timing.ends ?? null, timing.revoked ?? null]);
    return id;
  }
  // ---- the legacy permissive policy that staging carries (any signed-in user may write any path in `signatures`); the new restrictive policy must bind it
  await db.exec('reset role;');
  await db.query("insert into storage.buckets (id, name, public) values ('signatures', 'signatures', false) on conflict (id) do nothing;");
  await db.exec(`drop policy if exists "signatures: authenticated upload" on storage.objects;
    create policy "signatures: authenticated upload" on storage.objects for insert to authenticated with check (bucket_id = 'signatures');`);
  await db.exec(`grant select, insert, update, delete on storage.objects to authenticated, service_role;`);
  await sup();

  const officerPen = await person('vpen', { st: pen, tm: penAlpha, stTxt: 'PEN', tmTxt: 'ALPHA' });
  const officerPen2 = await person('vpen2', { st: pen, tm: penAlpha, stTxt: 'PEN', tmTxt: 'ALPHA' });
  const officerKul = await person('vkul');
  const bad = {
    pending: await person('vpending', { st: pen, tm: penAlpha, stTxt: 'PEN', status: 'pending' }),
    rejected: await person('vrejected', { st: pen, tm: penAlpha, stTxt: 'PEN', status: 'rejected' }),
    revoked: await person('vrevoked', { st: pen, tm: penAlpha, stTxt: 'PEN', timing: { revoked: new Date(Date.now() - 3600_000).toISOString() } }),
    expired: await person('vexpired', { st: pen, tm: penAlpha, stTxt: 'PEN', timing: { starts: new Date(Date.now() - 5 * 86400_000).toISOString(), ends: new Date(Date.now() - 86400_000).toISOString() } }),
    future: await person('vfuture', { st: pen, tm: penAlpha, stTxt: 'PEN', timing: { starts: new Date(Date.now() + 86400_000).toISOString() } }),
  };
  try { await db.exec('savepoint dd;'); bad.deactivated = await person('vdeact', { st: pen, tm: penAlpha, stTxt: 'PEN', status: 'deactivated' }); await db.exec('release savepoint dd;'); } catch (e) { await db.exec('rollback to savepoint dd; release savepoint dd;'); console.log('NOTE: no deactivated persona in this schema (' + String(e.message).slice(0, 60) + '); pending/rejected/revoked/expired/future cover the inactive states'); }
  const vendorUser = nextId();
  await db.query('insert into auth.users (id, email) values ($1,$2);', [vendorUser, 'v-vendor@example.test']);
  await db.query("insert into public.profiles (id, email, name, staff_no, role, status) values ($1,'v-vendor@example.test','V Vendor','V-VEN','ASO','approved') on conflict (id) do update set status = 'approved';", [vendorUser]);
  await db.query("insert into public.users (id, name, staff_id, email, role, status) values ($1,'V Vendor','V-VEN','v-vendor@example.test','vendor','pending') on conflict (id) do nothing;", [vendorUser]);

  let dseq = 0;
  async function delivery(st, status = 'CREATED') {
    await db.exec('reset role; set session_replication_role = replica;');
    const id = nextId();
    await db.query(`insert into public.caterlink_vendor_deliveries (id, delivery_number, aoc_id, station_id, vendor_user_id, status, driver_name, driver_nric, vehicle_registration_no, seal_number)
      values ($1, $2, $3, $4, $5, $6, 'Driver', '900101-01-1234', 'VEN1234', 'SEAL-V');`, [id, `CLV-T-${++dseq}`, myAoc, st.id, vendorUser, status]);
    await db.exec('set session_replication_role = origin;');
    await sup();
    return id;
  }
  const uuid = () => nextId();
  const pathFor = (d) => `vendor-part-b/${d}/${uuid().replace(/^0000/, 'aaaa')}.png`;
  const upload = (u, path, owner = u) => attempt(asUser(u), () => db.query("insert into storage.objects (bucket_id, name, owner) values ('signatures', $1, $2);", [path, owner]));
  const finalize = (u, d, path, result = 'PASS', reason = null, hash = 'a'.repeat(64)) => attempt(asUser(u), () => db.query("select public.record_caterlink_vendor_security_check_secure($1,$2,$3,$4,null,$5,'{}'::jsonb);", [d, path, hash, result, reason]));
  const state = async (d) => ({
    status: (await one('select status from public.caterlink_vendor_deliveries where id = $1', [d])).status,
    cps: (await one("select count(*)::int n from public.caterlink_vendor_checkpoints where delivery_id = $1 and stage = 'B'", [d])).n,
    audit: (await one("select count(*)::int n from public.phase8_audit_log where entity_id = $1 and action = 'caterlink_vendor_security_check'", [d])).n,
  });
  const objects = async (d) => (await one("select count(*)::int n from storage.objects where bucket_id = 'signatures' and name like $1", [`vendor-part-b/${d}/%`])).n;

  console.log('--- the Storage policy binds uploads to the database authorization ---');
  const d1 = await delivery(pen);
  const p1 = pathFor(d1);
  const okUp = await upload(officerPen, p1);
  assert(okUp.ok, 'an authorized officer at the delivery station can upload under vendor-part-b/<delivery>/');
  for (const [label, u] of [['officer at another station', officerKul], ['the vendor itself', vendorUser], ...Object.entries(bad).map(([k, v]) => [`${k} profile/assignment`, v])]) {
    const r = await upload(u, pathFor(d1));
    assert(!r.ok && /row-level security|policy/i.test(r.err), `${label}: the upload is refused by Storage RLS`);
  }
  assert((await objects(d1)) === 1, 'refused uploads created no object (only the authorized one exists)');
  assert(!(await upload(officerPen, `vendor-part-b/${d1}/not-a-uuid.png`)).ok, 'a non-conforming file name is refused');
  assert(!(await upload(officerPen, `vendor-part-b/${d1}/../x.png`)).ok, 'a traversal name is refused');
  assert(!(await upload(officerPen, `vendor-part-b/${uuid()}/${uuid()}.png`)).ok, 'a path for a delivery that does not exist is refused');
  assert(!(await upload(officerPen, `vendor-part-b/${d1}/${uuid()}.exe`)).ok, 'a non-image extension is refused');
  const dKul = await delivery(kul);
  assert(!(await upload(officerPen, pathFor(dKul))).ok, 'a PEN officer cannot upload for a delivery at another station');
  const other = await upload(officerKul, 'part-b/unrelated.png');
  assert(other.ok, 'other signature prefixes are unaffected by the new policy');

  console.log('--- finalize binds path, owner and state ---');
  const stBefore = await state(d1);
  assert(!(await finalize(officerPen, d1, pathFor(d1))).ok, 'a path that was never uploaded is refused');
  const foreign = pathFor(d1);
  await upload(officerPen2, foreign, officerPen2);
  assert(!(await finalize(officerPen, d1, foreign)).ok, "an object owned by a different user cannot be registered by this caller");
  assert(!(await finalize(officerPen, d1, `vendor-part-b/${dKul}/${uuid()}.png`)).ok, 'a path bound to a different delivery is refused');
  assert(!(await finalize(officerPen, d1, 'part-b/unrelated.png')).ok, 'a path outside the vendor pattern is refused');
  assert(!(await finalize(officerPen, d1, p1, 'PASS', null, 'not-a-hash')).ok, 'a malformed hash is refused');
  assert(JSON.stringify(stBefore) === JSON.stringify(await state(d1)), 'every refusal above wrote nothing');
  const uniform = new Set();
  for (const [label, u] of [['officer at another station', officerKul], ...Object.entries(bad)]) {
    const r = await finalize(u, d1, p1);
    uniform.add(r.err);
    assert(!r.ok && JSON.stringify(stBefore) === JSON.stringify(await state(d1)), `${label}: finalize refused, nothing written`);
  }
  const ghost = await finalize(officerKul, uuid(), p1);
  assert(!ghost.ok && uniform.has(ghost.err), 'a nonexistent delivery gets the same refusal as an unauthorized caller (no existence leak)');

  console.log('--- success, idempotency, one authoritative checkpoint ---');
  const ok1 = await finalize(officerPen, d1, p1);
  const afterOk = await state(d1);
  assert(ok1.ok && afterOk.status === 'SECURITY_VERIFIED' && afterOk.cps === 1 && afterOk.audit === 1, 'the authorized, bound submission records one checkpoint and advances the delivery');
  const cp = await one("select signature_url, actor_id from public.caterlink_vendor_checkpoints where delivery_id = $1 and stage = 'B'", [d1]);
  assert(cp.signature_url === p1 && cp.actor_id === officerPen, 'the checkpoint stores the bound path and the authenticated actor');
  const again = await finalize(officerPen, d1, p1);
  assert(!again.ok && JSON.stringify(await state(d1)) === JSON.stringify(afterOk), 'a repeated submission is rejected and changes nothing');
  assert(!(await upload(officerPen, pathFor(d1))).ok, 'once the check is recorded the delivery accepts no further signature uploads');

  console.log('--- orphan reconciliation ---');
  const d2 = await delivery(pen);
  const lost = pathFor(d2); const kept = pathFor(d2);
  await upload(officerPen, lost); await upload(officerPen, kept);
  await finalize(officerPen, d2, kept);
  await db.exec('reset role;'); await db.query("update storage.objects set created_at = now() - interval '2 hours' where bucket_id = 'signatures' and name like 'vendor-part-b/%';"); await sup();
  const listed = (await db.query('select name from public.list_orphan_vendor_signatures_secure(30);')).rows.map((r) => r.name);
  assert(listed.includes(lost) && !listed.includes(kept) && !listed.includes(p1), 'the unreferenced old object is listed; referenced signatures are never listed');
  const young = pathFor(d2);
  await db.exec('reset role;'); await db.query("insert into storage.objects (bucket_id, name, owner) values ('signatures', $1, $2);", [young, officerPen]); await sup();
  assert(!(await db.query('select name from public.list_orphan_vendor_signatures_secure(30);')).rows.some((r) => r.name === young), 'a recent object (upload still in flight) is not listed');
  const denyList = await attempt(asUser(officerPen), () => db.query('select * from public.list_orphan_vendor_signatures_secure(30);'));
  assert(!denyList.ok && /permission denied/i.test(denyList.err), 'a signed-in user cannot list orphans');
  const denyAnon = await attempt(asAnon, () => db.query('select * from public.list_orphan_vendor_signatures_secure(30);'));
  assert(!denyAnon.ok && /permission denied/i.test(denyAnon.err), 'anonymous cannot list orphans');

  console.log('--- escalation path is bound the same way ---');
  const d3 = await delivery(pen);
  const p3 = pathFor(d3);
  await upload(officerPen, p3);
  assert(!(await finalize(officerPen, d3, p3, 'ESCALATE', null)).ok, 'ESCALATE still requires a reason');
  assert((await finalize(officerPen, d3, p3, 'ESCALATE', 'seal broken')).ok && (await state(d3)).status === 'ESCALATED', 'ESCALATE with a reason is recorded with the bound signature');

  console.log('--- an authenticated user can neither replace, move, copy nor delete a stored signature ---');
  const targetPath = pathFor(d3);
  await upload(officerPen2, targetPath);
  const mut = async (label, sql, params) => {
    const before = (await db.query("select count(*)::int n, min(name) nm from storage.objects where bucket_id = 'signatures' and name like 'vendor-part-b/%'")).rows[0];
    const r = await attempt(asUser(officerPen2), () => db.query(sql, params));
    const after = (await db.query("select count(*)::int n, min(name) nm from storage.objects where bucket_id = 'signatures' and name like 'vendor-part-b/%'")).rows[0];
    assert((!r.ok || (r.r.affectedRows ?? r.r.rowCount) === 0) && JSON.stringify(before) === JSON.stringify(after), label + ': refused or affects nothing');
  };
  await mut('UPDATE (overwrite metadata)', "update storage.objects set metadata = '{}'::jsonb where bucket_id = 'signatures' and name = $1", [targetPath]);
  await mut('UPDATE (move to another path)', "update storage.objects set name = $1 where bucket_id = 'signatures' and name = $2", [pathFor(d3), targetPath]);
  await mut('DELETE', "delete from storage.objects where bucket_id = 'signatures' and name = $1", [targetPath]);
  const dup = await upload(officerPen2, targetPath);
  assert(!dup.ok, 'a second insert at an existing path (upsert/overwrite) is refused');
  const copy = await upload(officerPen2, pathFor(d1), officerPen2);
  assert(!copy.ok, 'a copy into a delivery that already has its check recorded is refused');

  await db.exec('rollback;');
  await db.close();
  console.log(`
TOTAL: ${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
