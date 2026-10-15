// Vendor Part B signature: real multi-connection concurrency on native PostgreSQL (20261111000001).
import pg from 'pg';
import { assertDisposableLocalTarget } from './safeguards.mjs';

const { Client } = pg;
let failures = 0;
let passes = 0;
const assert = (c, m) => { if (!c) { failures += 1; console.log('FAIL:', m); } else { passes += 1; console.log('PASS:', m); } };

const pgConfig = { host: process.env.PGHOST || '127.0.0.1', port: parseInt(process.env.PGPORT || '55433', 10), user: process.env.PGUSER || 'postgres', password: process.env.PGPASSWORD || undefined };
const goldenDb = process.env.PGDATABASE || 'vecta_phase6_test';
const runDb = 'vecta_vendorsig_concurrency_run';
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
let seq = 0x9700;
const nextId = () => `00000000-0000-0000-0000-${(++seq).toString(16).padStart(12, '0')}`;
async function person(label) {
  const id = nextId();
  await db.query('insert into auth.users (id, email) values ($1,$2);', [id, `lc-${label}@example.test`]);
  await db.query("insert into public.profiles (id, email, name, staff_no, role, status, station, team) values ($1,$2,$3,$4,'ASO','approved','KUL - MAA','ALPHA') on conflict (id) do update set status = 'approved', station = 'KUL - MAA', team = 'ALPHA';", [id, `lc-${label}@example.test`, `LC ${label}`, `LC-${label}`.slice(0, 20)]);
  const mem = (await one("insert into public.user_entity_memberships (profile_id, aoc_id, operating_entity_id, status, is_primary) values ($1,$2,$3,'active',true) returning id;", [id, myAoc, myEntity])).id;
  await db.query("insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, hub_id, station_id, team_id, entity_membership_id, starts_at) values ($1,$2,$3,$4,$5,$6,$7,$8, now() - interval '1 day');", [id, aso, myAoc, opsDept, kul.hub_id, kul.id, alpha, mem]);
  return id;
}
const pen = await one("select id, hub_id from public.org_stations where code = 'PEN';");
await db.query("insert into public.org_teams (station_id, name) values ($1,'ALPHA') on conflict (station_id, name) do nothing;", [pen.id]);
const penAlpha = (await one("select id from public.org_teams where station_id = $1 and name = 'ALPHA';", [pen.id])).id;
async function officer(label) {
  const id = nextId();
  await db.query('insert into auth.users (id, email) values ($1,$2);', [id, `vc-${label}@example.test`]);
  await db.query("insert into public.profiles (id, email, name, staff_no, role, status, station, team) values ($1,$2,$3,$4,'ASO','approved','PEN','ALPHA') on conflict (id) do update set status = 'approved';", [id, `vc-${label}@example.test`, `VC ${label}`, `VC-${label}`.slice(0, 20)]);
  const mem = (await one("insert into public.user_entity_memberships (profile_id, aoc_id, operating_entity_id, status, is_primary) values ($1,$2,$3,'active',true) returning id;", [id, myAoc, myEntity])).id;
  await db.query("insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, hub_id, station_id, team_id, entity_membership_id, starts_at) values ($1,$2,$3,$4,$5,$6,$7,$8, now() - interval '1 day');", [id, aso, myAoc, opsDept, pen.hub_id, pen.id, penAlpha, mem]);
  return id;
}
await db.query('reset role;');
await db.query("insert into storage.buckets (id, name, public) values ('signatures', 'signatures', false) on conflict (id) do nothing;");
await db.query(`drop policy if exists "signatures: authenticated upload" on storage.objects; create policy "signatures: authenticated upload" on storage.objects for insert to authenticated with check (bucket_id = 'signatures');`);
await db.query('grant select, insert, update, delete on storage.objects to authenticated, service_role;');
await sup();
const vendorUser = nextId();
await db.query('insert into auth.users (id, email) values ($1,$2);', [vendorUser, 'vc-vendor@example.test']);
await db.query("insert into public.profiles (id, email, name, staff_no, role, status) values ($1,'vc-vendor@example.test','VC Vendor','VC-VEN','ASO','approved') on conflict (id) do update set status = 'approved';", [vendorUser]);
await db.query("insert into public.users (id, name, staff_id, email, role, status) values ($1,'VC Vendor','VC-VEN','vc-vendor@example.test','vendor','pending') on conflict (id) do nothing;", [vendorUser]);
async function delivery() {
  await db.query('reset role;');
  await db.query('set session_replication_role = replica;');
  const id = nextId();
  await db.query("insert into public.caterlink_vendor_deliveries (id, delivery_number, aoc_id, station_id, vendor_user_id, status, driver_name, driver_nric, vehicle_registration_no, seal_number) values ($1, $2, $3, $4, $5, 'CREATED', 'D', '900101-01-1234', 'V1', 'S');", [id, `CLV-C-${id.slice(-6)}`, myAoc, pen.id, vendorUser]);
  await db.query('set session_replication_role = origin;');
  await sup();
  return id;
}
const officers = [];
for (let i = 0; i < 6; i += 1) officers.push(await officer(`o${i}`));
const q = async (s, p) => (await db.query(s, p)).rows;
const pathOf = (d) => `vendor-part-b/${d}/${nextId().replace(/^0000/, 'aaaa')}.png`;
const FIN = "select public.record_caterlink_vendor_security_check_secure($1,$2,$3,'PASS',null,null,'{}'::jsonb);";
const HASH = 'a'.repeat(64);

console.log('=== six officers upload their own object, then finalize at the same moment ===');
{
  const d = await delivery();
  const sessions = await Promise.all(officers.map((u) => session(u)));
  const paths = officers.map(() => pathOf(d));
  const ups = await Promise.allSettled(sessions.map((c, i) => c.query("insert into storage.objects (bucket_id, name, owner) values ('signatures', $1, $2);", [paths[i], officers[i]])));
  assert(ups.every((r) => r.status === 'fulfilled'), 'every authorized officer may upload its own signature object while the delivery is CREATED');
  // uploads and the save are separate requests: commit each upload, then start a fresh transaction for the save
  await Promise.all(sessions.map((c) => c.query('commit;')));
  await Promise.all(sessions.map(async (c, i) => {
    await c.query('begin;');
    await c.query("select set_config('request.jwt.claims', json_build_object('sub', $1::text, 'role', 'authenticated')::text, true), set_config('role', 'authenticated', true);", [officers[i]]);
  }));
  const fins = await Promise.allSettled(sessions.map(async (c, i) => { const r = await c.query(FIN, [d, paths[i], HASH]); await c.query('commit;'); return r; }));
  await Promise.all(sessions.map((c) => c.query('rollback;').catch(() => {}).then(() => c.end())));
  const won = fins.map((r, i) => (r.status === 'fulfilled' ? i : -1)).filter((i) => i >= 0);
  assert(won.length === 1, `exactly one simultaneous submission became the checkpoint (found ${won.length})`);
  const cps = await q("select signature_url, actor_id from public.caterlink_vendor_checkpoints where delivery_id = $1 and stage = 'B'", [d]);
  const del = (await q('select status from public.caterlink_vendor_deliveries where id = $1', [d]))[0].status;
  const audit = (await q("select count(*)::int n from public.phase8_audit_log where entity_id = $1 and action = 'caterlink_vendor_security_check'", [d]))[0].n;
  assert(cps.length === 1 && cps[0].signature_url === paths[won[0]] && cps[0].actor_id === officers[won[0]], 'one checkpoint, bound to the winning path and identity');
  assert(del === 'SECURITY_VERIFIED' && audit === 1, 'one status change and one audit entry');
  await db.query("update storage.objects set created_at = now() - interval '2 hours' where bucket_id = 'signatures' and name like $1", [`vendor-part-b/${d}/%`]);
  const orphans = (await q('select name from public.list_orphan_vendor_signatures_secure(30)')).map((r) => r.name).filter((n) => n.startsWith(`vendor-part-b/${d}/`));
  assert(orphans.length === 5 && !orphans.includes(paths[won[0]]) && paths.filter((_, i) => i !== won[0]).every((p) => orphans.includes(p)), 'the five losing objects are listed for reconciliation; the winning signature is not');
}

console.log('=== a delivery that is no longer CREATED accepts no new upload even from an authorized officer ===');
{
  const d = await delivery();
  const c1 = await session(officers[0]);
  const p = pathOf(d);
  await c1.query("insert into storage.objects (bucket_id, name, owner) values ('signatures', $1, $2);", [p, officers[0]]);
  await c1.query(FIN, [d, p, HASH]);
  await c1.query('commit;');
  await c1.end();
  const c2 = await session(officers[1]);
  let err = null;
  try { await c2.query("insert into storage.objects (bucket_id, name, owner) values ('signatures', $1, $2);", [pathOf(d), officers[1]]); } catch (e) { err = e.message; }
  await c2.query('rollback;').catch(() => {});
  await c2.end();
  assert(err && /row-level security|policy/i.test(err), 'the upload after the check is recorded is refused by Storage RLS');
}

await db.end();
console.log(`\nTOTAL: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
