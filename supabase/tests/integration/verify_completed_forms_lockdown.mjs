// Completed-forms bucket lockdown (20261116000001): both historical broad authenticated policies are removed and nothing replaces them for clients (no active
// producer or consumer exists). Dual-mode (PGlite / native PostgreSQL).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { assertDisposableLocalTarget } from './safeguards.mjs';

const { Client } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_DATA_DIR = path.join(__dirname, 'pgdata');
const RUN_DATA_DIR = path.join(__dirname, 'pgdata_cform_run');
let failures = 0;
let passes = 0;
const assert = (c, m) => { if (!c) { failures += 1; console.log('FAIL:', m); } else { passes += 1; console.log('PASS:', m); } };

async function main() {
  const isNative = process.argv.includes('--native') || process.env.PG_NATIVE === '1';
  const pgConfig = { host: process.env.PGHOST || '127.0.0.1', port: parseInt(process.env.PGPORT || '55433', 10), user: process.env.PGUSER || 'postgres', password: process.env.PGPASSWORD || undefined };
  const goldenDb = process.env.PGDATABASE || 'vecta_phase6_test';
  const runDb = 'vecta_cform_run';
  let db;
  if (isNative) {
    assertDisposableLocalTarget(pgConfig, goldenDb, runDb);
    console.log('=== Completed-forms lockdown against native PostgreSQL ===');
    const admin = new Client({ ...pgConfig, database: 'postgres' });
    await admin.connect();
    await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${runDb}' and pid <> pg_backend_pid();`);
    await admin.query(`drop database if exists ${runDb};`);
    await admin.query(`create database ${runDb} template ${goldenDb};`);
    const client = new Client({ ...pgConfig, database: runDb });
    await client.connect();
    db = { exec: (s) => client.query(s), query: (s, p) => client.query(s, p), close: async () => { await client.end(); await admin.query(`drop database if exists ${runDb};`); await admin.end(); } };
  } else {
    console.log('=== Completed-forms lockdown against PGlite ===');
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

  let seq = 0x9b00;
  const nextId = () => `00000000-0000-0000-0000-${(++seq).toString(16).padStart(12, '0')}`;
  const myAoc = (await one("select id from public.aocs where code = 'MY';")).id;
  const myEntity = (await one("select id from public.operating_entities where aoc_id = $1 and code = 'MAA';", [myAoc])).id;
  const opsDept = (await one("select id from public.departments where aoc_id = $1 and code = 'operation';", [myAoc])).id;
  const roleMap = new Map((await rows('select id, code from public.role_definitions;')).map((r) => [r.code, r.id]));
  const station = async (code) => one('select id, hub_id, code from public.org_stations where code = $1;', [code]);
  const kul = await station('KUL - MAA'); const pen = await station('PEN');
  const team = async (st, name) => { await db.query('insert into public.org_teams (station_id, name) values ($1,$2) on conflict (station_id, name) do nothing;', [st.id, name]); return (await one('select id from public.org_teams where station_id = $1 and name = $2;', [st.id, name])).id; };
  const kulAlpha = await team(kul, 'ALPHA'); const penAlpha = await team(pen, 'ALPHA');
  
  async function person(label, { st = kul, tm = kulAlpha, stTxt = 'KUL - MAA', tmTxt = 'ALPHA', status = 'approved', timing = {} } = {}) {
    const id = nextId();
    await db.query('insert into auth.users (id, email) values ($1,$2) on conflict (id) do nothing;', [id, `cf-${label}@example.test`]);
    await db.query("insert into public.profiles (id, email, name, staff_no, role, status, station, team) values ($1,$2,$3,$4,'ASO',$5,$6,$7) on conflict (id) do update set status = excluded.status, name = excluded.name, staff_no = excluded.staff_no, station = excluded.station, team = excluded.team;", [id, `cf-${label}@example.test`, `CF ${label}`, `CF-${label}`.slice(0, 20), status, stTxt, tmTxt]);
    const mem = (await one("insert into public.user_entity_memberships (profile_id, aoc_id, operating_entity_id, status, is_primary) values ($1,$2,$3,'active',true) returning id;", [id, myAoc, myEntity])).id;
    await db.query(`insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, hub_id, station_id, team_id, entity_membership_id, starts_at, ends_at, revoked_at)
      values ($1,$2,$3,$4,$5,$6,$7,$8, coalesce($9::timestamptz, now() - interval '1 day'), $10, $11);`, [id, roleMap.get('aso'), myAoc, opsDept, st.hub_id, st.id, tm, mem, timing.starts ?? null, timing.ends ?? null, timing.revoked ?? null]);
    return id;
  }
  // ---- the historical state staging carries: both broad policies exist, and an object may already be stored
  await db.exec('reset role;');
  await db.query("insert into storage.buckets (id, name, public) values ('completed-forms', 'completed-forms', false) on conflict (id) do nothing;");
  await db.exec(`drop policy if exists "completed forms: authenticated upload" on storage.objects;
    drop policy if exists "completed forms: authenticated read" on storage.objects;
    create policy "completed forms: authenticated upload" on storage.objects for insert to public with check (bucket_id = 'completed-forms' and auth.role() = 'authenticated');
    create policy "completed forms: authenticated read" on storage.objects for select to public using (bucket_id = 'completed-forms' and auth.role() = 'authenticated');`);
  await db.exec('grant select, insert, update, delete on storage.objects to authenticated, service_role;');
  await db.exec('create unique index if not exists bucketid_objname on storage.objects (bucket_id, name);');
  const existing = `ICMS-2026-000001/${nextId()}.pdf`;
  await db.query("insert into storage.objects (bucket_id, name, owner) values ('completed-forms', $1, null);", [existing]);
  const before = (await one("select count(*)::int n from storage.objects where bucket_id = 'completed-forms'")).n;
  const MIGRATION = fs.readFileSync(path.join(__dirname, '..', '..', 'migrations', '20261116000001_completed_forms_lockdown.sql'), 'utf8');
  await db.exec(MIGRATION);
  await sup();

  // ---- personas
  const roleUser = async (label, roleCode, aocId, deptId) => {
    const id = nextId();
    await db.query('insert into auth.users (id, email) values ($1,$2);', [id, `cf-${label}@example.test`]);
    await db.query("insert into public.profiles (id, email, name, staff_no, role, status) values ($1,$2,$3,$4,'ASO','approved') on conflict (id) do update set status = 'approved';", [id, `cf-${label}@example.test`, `CF ${label}`, `CF-${label}`.slice(0, 20)]);
    await db.query("insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, starts_at) values ($1,$2,$3,$4, now() - interval '1 day');", [id, roleMap.get(roleCode), aocId, deptId]);
    return id;
  };
  const dept = async (aocId, code) => (await one('select id from public.departments where aoc_id = $1 and code = $2;', [aocId, code]))?.id;
  const caterlinkDept = await dept(myAoc, 'caterlink');
  const operationDept = await dept(myAoc, 'operation');
  const enforcementDept = await dept(myAoc, 'enforcement');
  const officer = await person('cfofficer', { st: pen, tm: penAlpha, stTxt: 'PEN' });
  const otherStation = await person('cfkul');
  const bad = {
    pending: await person('cfpending', { st: pen, tm: penAlpha, stTxt: 'PEN', status: 'pending' }),
    rejected: await person('cfrejected', { st: pen, tm: penAlpha, stTxt: 'PEN', status: 'rejected' }),
    revoked: await person('cfrevoked', { st: pen, tm: penAlpha, stTxt: 'PEN', timing: { revoked: new Date(Date.now() - 3600_000).toISOString() } }),
    expired: await person('cfexpired', { st: pen, tm: penAlpha, stTxt: 'PEN', timing: { starts: new Date(Date.now() - 5 * 86400_000).toISOString(), ends: new Date(Date.now() - 86400_000).toISOString() } }),
    future: await person('cffuture', { st: pen, tm: penAlpha, stTxt: 'PEN', timing: { starts: new Date(Date.now() + 86400_000).toISOString() } }),
  };
  try { await db.exec('savepoint dd;'); bad.deactivated = await person('cfdeact', { st: pen, tm: penAlpha, stTxt: 'PEN', status: 'deactivated' }); await db.exec('release savepoint dd;'); } catch (e) { await db.exec('rollback to savepoint dd; release savepoint dd;'); console.log('NOTE: no deactivated profile status in this local schema (' + String(e.message).slice(0, 50) + '); the staging dry run exercises a real deactivated persona'); }
  const mgmt = await roleUser('mgmt', 'caterlink_management', myAoc, caterlinkDept);
  const opMgr = await roleUser('opmgr', 'operation_manager', myAoc, operationDept);
  const enforcement = await roleUser('enf', 'main_enforcement', myAoc, enforcementDept);
  const zzAoc = nextId();
  await db.query("insert into public.aocs (id, code, name, is_active) values ($1, 'ZZ', 'Synthetica', true);", [zzAoc]);
  const zzDept = nextId();
  await db.query("insert into public.departments (id, aoc_id, code, name) values ($1, $2, 'caterlink', 'ZZ CaterLink');", [zzDept, zzAoc]);
  const zzMgmt = await roleUser('zzmgmt', 'caterlink_management', zzAoc, zzDept);
  const plain = nextId();
  await db.query('insert into auth.users (id, email) values ($1,$2);', [plain, 'cf-plain@example.test']);
  await db.query("insert into public.profiles (id, email, name, staff_no, role, status) values ($1,'cf-plain@example.test','CF Plain','CF-PLAIN','ASO','approved') on conflict (id) do update set status = 'approved';", [plain]);
  async function external(label, role) {
    const id = nextId();
    await db.query('insert into auth.users (id, email) values ($1,$2);', [id, `cf-${label}@example.test`]);
    await db.query("insert into public.profiles (id, email, name, staff_no, role, status) values ($1,$2,$3,$4,'ASO','approved') on conflict (id) do update set status = 'approved';", [id, `cf-${label}@example.test`, `CF ${label}`, `CF-${label}`.slice(0, 20)]);
    await db.query("insert into public.users (id, name, staff_id, email, role, status) values ($1,$2,$3,$4,$5,'active');", [id, `CF ${label}`, `CF-${label}`.slice(0, 20), `cf-${label}@example.test`, role]);
    return id;
  }
  const driver = await external('drv', 'warehouse_pic');
  const vendor = await external('ven', 'vendor');

  const uuid = () => nextId().replace(/^0000/, 'aaaa');
  const insertObj = (u, name, owner = u) => attempt(asUser(u), () => db.query("insert into storage.objects (bucket_id, name, owner) values ('completed-forms', $1, $2);", [name, owner]));
  const RLS = /row-level security|policy|permission denied/i;
  const everyone = [
    ['an approved officer', officer], ['a station officer elsewhere', otherStation], ['CaterLink Management', mgmt], ['Operation Manager', opMgr], ['Main Enforcement', enforcement],
    ['a foreign-AOC CaterLink manager', zzMgmt], ['a Driver', driver], ['a Vendor', vendor], ['a plain approved account', plain],
    ...Object.entries(bad).map(([k, v]) => [`a ${k} profile/assignment`, v]),
  ];

  console.log('--- both historical policies are gone and nothing replaces them for clients ---');
  const pols = await rows("select policyname, cmd, permissive, roles::text from pg_policies where schemaname = 'storage' and tablename = 'objects' and (with_check ilike '%completed-forms%' or qual ilike '%completed-forms%') order by policyname");
  assert(pols.length === 0, 'NO policy on storage.objects mentions the completed-forms bucket any more (client upload, read, update and delete are all denied)');
  const anyUnscoped = await rows("select policyname from pg_policies where schemaname = 'storage' and tablename = 'objects' and permissive = 'PERMISSIVE' and cmd in ('INSERT','SELECT','UPDATE','DELETE','ALL') and (coalesce(qual,'') !~ 'bucket_id' and coalesce(with_check,'') !~ 'bucket_id')");
  assert(anyUnscoped.length === 0, 'and no unscoped permissive policy exists that could reach the bucket anyway');
  assert((await one("select public from storage.buckets where id = 'completed-forms'")).public === false, 'the bucket stays private');
  assert(!(await one("select 1 x from pg_proc where proname ilike '%completed_form%' and pronamespace = 'public'::regnamespace")), 'no helper function was added (nothing to grant)');

  console.log('--- upload is denied to everyone, whatever the path ---');
  for (const [label, u] of everyone) {
    for (const name of [`ICMS-2026-000002/${uuid()}.pdf`, `${uuid()}.pdf`, 'arbitrary-test/x.pdf', `signatures/part-a/${u}/${uuid()}.png`]) {
      const r = await insertObj(u, name);
      assert(!r.ok && RLS.test(r.err), `${label}: upload of "${name.split('/')[0].replace(/[0-9a-f-]{36}.*/, '<uuid>')}" is refused by Storage RLS`);
    }
  }
  const anonUp = await attempt(asAnon, () => db.query("insert into storage.objects (bucket_id, name, owner) values ('completed-forms', $1, null);", [`ICMS-2026-000003/${uuid()}.pdf`]));
  assert(!anonUp.ok && RLS.test(anonUp.err), 'anonymous: upload refused');
  assert((await one("select count(*)::int n from storage.objects where bucket_id = 'completed-forms'")).n === before, 'no refused upload left an object row');

  console.log('--- read, list, move and delete are denied to every client ---');
  for (const [label, u] of everyone) {
    const seen = await attempt(asUser(u), () => db.query("select count(*)::int n from storage.objects where bucket_id = 'completed-forms'"));
    assert(seen.ok && seen.r.rows[0].n === 0, `${label}: cannot see or list any completed-forms object`);
  }
  const anonSeen = await attempt(asAnon, () => db.query("select count(*)::int n from storage.objects where bucket_id = 'completed-forms'"));
  assert(!anonSeen.ok || anonSeen.r.rows[0].n === 0, 'anonymous: cannot see or list any object');
  const rowsOf = (r) => (r.ok ? (r.r.affectedRows ?? r.r.rowCount ?? 0) : 0);
  const delR = await attempt(asUser(officer), () => db.query("delete from storage.objects where bucket_id = 'completed-forms'"));
  const updR = await attempt(asUser(officer), () => db.query("update storage.objects set name = name || 'x' where bucket_id = 'completed-forms'"));
  assert(rowsOf(delR) === 0 && rowsOf(updR) === 0, 'an officer cannot delete or move an object through the API');

  console.log('--- the trusted service role keeps working; nothing existing is deleted ---');
  const svcName = `ICMS-2026-000004/${uuid()}.pdf`;
  const svc = await attempt(() => db.exec('select pg_temp.sim_service();'), () => db.query("insert into storage.objects (bucket_id, name, owner) values ('completed-forms', $1, null);", [svcName]));
  assert(svc.ok, 'service_role can still write a completed form (trusted server workflow)');
  const svcRead = await attempt(() => db.exec('select pg_temp.sim_service();'), () => db.query("select count(*)::int n from storage.objects where bucket_id = 'completed-forms'"));
  assert(svcRead.ok && svcRead.r.rows[0].n === before + 1, 'and read/list them');
  assert((await one("select count(*)::int n from storage.objects where bucket_id = 'completed-forms' and name = $1", [existing])).n === 1, 'the object that existed before the migration is still stored (nothing deleted)');

  await db.exec('rollback;');
  await db.close();
  console.log(`\nTOTAL: ${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
