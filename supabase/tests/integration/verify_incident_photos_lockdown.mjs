// Incident-photos bucket lockdown (20261114000001): the historical unrestricted upload/read policies are removed; clients cannot upload; reads follow the incident
// the photo belongs to (or the uploader). Dual-mode (PGlite / native PostgreSQL).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { assertDisposableLocalTarget } from './safeguards.mjs';

const { Client } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_DATA_DIR = path.join(__dirname, 'pgdata');
const RUN_DATA_DIR = path.join(__dirname, 'pgdata_incphoto_run');
let failures = 0;
let passes = 0;
const assert = (c, m) => { if (!c) { failures += 1; console.log('FAIL:', m); } else { passes += 1; console.log('PASS:', m); } };

async function main() {
  const isNative = process.argv.includes('--native') || process.env.PG_NATIVE === '1';
  const pgConfig = { host: process.env.PGHOST || '127.0.0.1', port: parseInt(process.env.PGPORT || '55433', 10), user: process.env.PGUSER || 'postgres', password: process.env.PGPASSWORD || undefined };
  const goldenDb = process.env.PGDATABASE || 'vecta_phase6_test';
  const runDb = 'vecta_incphoto_run';
  let db;
  if (isNative) {
    assertDisposableLocalTarget(pgConfig, goldenDb, runDb);
    console.log('=== Incident-photos lockdown against native PostgreSQL ===');
    const admin = new Client({ ...pgConfig, database: 'postgres' });
    await admin.connect();
    await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${runDb}' and pid <> pg_backend_pid();`);
    await admin.query(`drop database if exists ${runDb};`);
    await admin.query(`create database ${runDb} template ${goldenDb};`);
    const client = new Client({ ...pgConfig, database: runDb });
    await client.connect();
    db = { exec: (s) => client.query(s), query: (s, p) => client.query(s, p), close: async () => { await client.end(); await admin.query(`drop database if exists ${runDb};`); await admin.end(); } };
  } else {
    console.log('=== Incident-photos lockdown against PGlite ===');
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

  let seq = 0x9a00;
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
    await db.query('insert into auth.users (id, email) values ($1,$2) on conflict (id) do nothing;', [id, `ip-${label}@example.test`]);
    await db.query("insert into public.profiles (id, email, name, staff_no, role, status, station, team) values ($1,$2,$3,$4,'ASO',$5,$6,$7) on conflict (id) do update set status = excluded.status, name = excluded.name, staff_no = excluded.staff_no, station = excluded.station, team = excluded.team;", [id, `ip-${label}@example.test`, `IP ${label}`, `IP-${label}`.slice(0, 20), status, stTxt, tmTxt]);
    const mem = (await one("insert into public.user_entity_memberships (profile_id, aoc_id, operating_entity_id, status, is_primary) values ($1,$2,$3,'active',true) returning id;", [id, myAoc, myEntity])).id;
    await db.query(`insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, hub_id, station_id, team_id, entity_membership_id, starts_at, ends_at, revoked_at)
      values ($1,$2,$3,$4,$5,$6,$7,$8, coalesce($9::timestamptz, now() - interval '1 day'), $10, $11);`, [id, roleMap.get('aso'), myAoc, opsDept, st.hub_id, st.id, tm, mem, timing.starts ?? null, timing.ends ?? null, timing.revoked ?? null]);
    return id;
  }
  // ---- the historical policies staging carries (role public, auth.role() check), recreated so the migration under test must remove them
  await db.exec('reset role;');
  await db.query("insert into storage.buckets (id, name, public) values ('incident-photos', 'incident-photos', false) on conflict (id) do nothing;");
  await db.query("insert into storage.buckets (id, name, public) values ('signatures', 'signatures', false) on conflict (id) do nothing;");
  await db.exec(`drop policy if exists "incident photos: authenticated upload" on storage.objects;
    drop policy if exists "incident photos: authenticated read" on storage.objects;
    create policy "incident photos: authenticated upload" on storage.objects for insert to public with check (bucket_id = 'incident-photos' and auth.role() = 'authenticated');
    create policy "incident photos: authenticated read" on storage.objects for select to public using (bucket_id = 'incident-photos' and auth.role() = 'authenticated');`);
  await db.exec('grant select, insert, update, delete on storage.objects to authenticated, service_role;');
  await db.exec('create unique index if not exists bucketid_objname on storage.objects (bucket_id, name);');
  const MIGRATION = fs.readFileSync(path.join(__dirname, '..', '..', 'migrations', '20261114000001_incident_photos_lockdown.sql'), 'utf8');
  await db.exec(MIGRATION);
  await sup();

  // ---- personas
  const roleUser = async (label, roleCode, aocId, deptId) => {
    const id = nextId();
    await db.query('insert into auth.users (id, email) values ($1,$2);', [id, `ip-${label}@example.test`]);
    await db.query("insert into public.profiles (id, email, name, staff_no, role, status) values ($1,$2,$3,$4,'ASO','approved') on conflict (id) do update set status = 'approved';", [id, `ip-${label}@example.test`, `IP ${label}`, `IP-${label}`.slice(0, 20)]);
    await db.query("insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, starts_at) values ($1,$2,$3,$4, now() - interval '1 day');", [id, roleMap.get(roleCode), aocId, deptId]);
    return id;
  };
  const dept = async (aocId, code) => (await one('select id from public.departments where aoc_id = $1 and code = $2;', [aocId, code]))?.id;
  const caterlinkDept = await dept(myAoc, 'caterlink');
  const operationDept = await dept(myAoc, 'operation');
  const enforcementDept = await dept(myAoc, 'enforcement');
  const reporter = await person('ipreporter', { st: pen, tm: penAlpha, stTxt: 'PEN' });
  const assignee = await person('ipassignee', { st: pen, tm: penAlpha, stTxt: 'PEN' });
  const unrelated = await person('ipunrelated', { st: pen, tm: penAlpha, stTxt: 'PEN' });
  const otherStation = await person('ipkul');
  const pendingOfficer = await person('ippending', { st: pen, tm: penAlpha, stTxt: 'PEN', status: 'pending' });
  const mgmt = await roleUser('mgmt', 'caterlink_management', myAoc, caterlinkDept);
  const opMgr = await roleUser('opmgr', 'operation_manager', myAoc, operationDept);
  const enforcement = await roleUser('enf', 'main_enforcement', myAoc, enforcementDept);
  const zzAoc = nextId();
  await db.query("insert into public.aocs (id, code, name, is_active) values ($1, 'ZZ', 'Synthetica', true);", [zzAoc]);
  const zzDept = nextId();
  await db.query("insert into public.departments (id, aoc_id, code, name) values ($1, $2, 'caterlink', 'ZZ CaterLink');", [zzDept, zzAoc]);
  const zzMgmt = await roleUser('zzmgmt', 'caterlink_management', zzAoc, zzDept);
  const plain = nextId();
  await db.query('insert into auth.users (id, email) values ($1,$2);', [plain, 'ip-plain@example.test']);
  await db.query("insert into public.profiles (id, email, name, staff_no, role, status) values ($1,'ip-plain@example.test','IP Plain','IP-PLAIN','ASO','approved') on conflict (id) do update set status = 'approved';", [plain]);
  async function external(label, role) {
    const id = nextId();
    await db.query('insert into auth.users (id, email) values ($1,$2);', [id, `ip-${label}@example.test`]);
    await db.query("insert into public.profiles (id, email, name, staff_no, role, status) values ($1,$2,$3,$4,'ASO','approved') on conflict (id) do update set status = 'approved';", [id, `ip-${label}@example.test`, `IP ${label}`, `IP-${label}`.slice(0, 20)]);
    await db.query("insert into public.users (id, name, staff_id, email, role, status) values ($1,$2,$3,$4,$5,'active');", [id, `IP ${label}`, `IP-${label}`.slice(0, 20), `ip-${label}@example.test`, role]);
    return id;
  }
  const driver = await external('drv', 'warehouse_pic');
  const vendor = await external('ven', 'vendor');

  const uuid = () => nextId().replace(/^0000/, 'aaaa');
  const insertObj = (u, name, owner = u) => attempt(asUser(u), () => db.query("insert into storage.objects (bucket_id, name, owner) values ('incident-photos', $1, $2);", [name, owner]));
  const objectCount = async () => (await one("select count(*)::int n from storage.objects where bucket_id = 'incident-photos'")).n;
  const RLS = /row-level security|policy|permission denied/i;

  console.log('--- the historical unrestricted policies are gone and no client may upload ---');
  const pols = await rows("select policyname, cmd, permissive, roles::text from pg_policies where schemaname = 'storage' and tablename = 'objects' and (with_check ilike '%incident-photos%' or qual ilike '%incident-photos%') order by policyname");
  assert(!pols.some((p) => /authenticated (upload|read)$/.test(p.policyname)), 'both historical "incident photos: authenticated upload/read" policies are removed');
  assert(pols.filter((p) => p.cmd === 'INSERT').length === 0, 'NO INSERT policy exists for the bucket: clients cannot upload (service role only; no producer exists)');
  assert(pols.filter((p) => ['UPDATE', 'DELETE', 'ALL'].includes(p.cmd)).length === 0, 'no UPDATE/DELETE/ALL policy exists');
  assert(pols.length === 1 && pols[0].cmd === 'SELECT' && /authenticated/.test(pols[0].roles) && !/public/.test(pols[0].roles) && pols[0].policyname === 'incident photos: scoped read', 'exactly one policy remains: the scoped SELECT for authenticated');
  assert((await one("select public from storage.buckets where id = 'incident-photos'")).public === false, 'the bucket stays private');
  const fn = await one("select p.prosecdef sd, has_function_privilege('anon', p.oid, 'execute') an, has_function_privilege('authenticated', p.oid, 'execute') au, p.proconfig::text cfg from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'caterlink_incident_photo_visible'");
  assert(fn && !fn.sd && !fn.an && fn.au && /search_path/.test(fn.cfg), 'the read helper is SECURITY INVOKER (the incident RLS decides), pinned search_path, not callable by anon');

  const before = await objectCount();
  for (const [label, u] of [['an approved officer', unrelated], ['the incident reporter', reporter], ['a station officer elsewhere', otherStation], ['CaterLink Management', mgmt], ['Operation Manager', opMgr], ['Main Enforcement', enforcement], ['a foreign-AOC manager', zzMgmt], ['a Driver', driver], ['a Vendor', vendor], ['a plain approved account', plain], ['a pending officer', pendingOfficer]]) {
    for (const name of [`incident-photos/${uuid()}/${uuid()}.png`, `${uuid()}.png`, 'arbitrary-test/x.png', `part-a/${u}/${uuid()}.png`]) {
      const r = await insertObj(u, name);
      assert(!r.ok && RLS.test(r.err), `${label}: upload of a ${name.split('/')[0].replace(/[0-9a-f-]{36}.*/, '<uuid>')} name refused by Storage RLS`);
    }
  }
  const anon = await attempt(asAnon, () => db.query("insert into storage.objects (bucket_id, name, owner) values ('incident-photos', $1, null);", [`x/${uuid()}.png`]));
  assert(!anon.ok && RLS.test(anon.err), 'anonymous cannot upload');
  assert((await objectCount()) === before, 'no refused upload left an object row');

  console.log('--- trusted service-role writes keep working ---');
  const photo = `incident-photos/${uuid()}/${uuid()}.png`;
  const svc = await attempt(() => db.exec('select pg_temp.sim_service();'), () => db.query("insert into storage.objects (bucket_id, name, owner) values ('incident-photos', $1, $2);", [photo, reporter]));
  assert(svc.ok, 'service_role can still write an incident photo (trusted server workflow)');

  console.log('--- reads follow the incident the photo belongs to ---');
  const tx = nextId();
  await db.exec('reset role; set session_replication_role = replica;');
  await db.query(`insert into public.transactions (id, transaction_number, aoc_id, direction, vehicle_number, driver_name, driver_id, seal_number, status, route, origin_station_id, flight_number, created_by)
    values ($1,'TX-IP-1',$2,'OUTBOUND','IP1234A','IP Driver','IPD001','S','CREATED','AIRCRAFT',$3,'AK703',$4);`, [tx, myAoc, pen.id, driver]);
  await db.query(`insert into public.caterlink_incidents (transaction_id, aoc_id, station_id, incident_type, severity, description, reported_by, assigned_to, status, photo_url)
    values ($1,$2,$3,'OTHER','low','fixture',$4,$5,'OPEN',$6);`, [tx, myAoc, pen.id, reporter, assignee, photo]);
  await db.exec('set session_replication_role = origin;');
  await sup();
  const canRead = async (u) => { const r = await attempt(asUser(u), () => db.query("select count(*)::int n from storage.objects where bucket_id = 'incident-photos' and name = $1", [photo])); return r.ok ? r.r.rows[0].n === 1 : false; };
  for (const [label, u] of [['the reporter (owner and reporter)', reporter], ['the assignee', assignee], ['CaterLink Management of the AOC', mgmt], ['the Operation Manager of the AOC', opMgr], ['Main Enforcement of the AOC', enforcement]]) assert(await canRead(u), `${label} can read the photo`);
  for (const [label, u] of [['an unrelated officer at the same station', unrelated], ['an officer at another station', otherStation], ['a foreign-AOC CaterLink manager', zzMgmt], ['a Driver', driver], ['a Vendor', vendor], ['a plain approved account', plain], ['a pending officer', pendingOfficer]]) assert(!(await canRead(u)), `${label} cannot read it`);
  const anonRead = await attempt(asAnon, () => db.query("select count(*)::int n from storage.objects where bucket_id = 'incident-photos'"));
  assert(!anonRead.ok || anonRead.r.rows[0].n === 0, 'anonymous cannot read');
  // an unreferenced object is readable only by its uploader (owner)
  const lone = `incident-photos/${uuid()}/${uuid()}.png`;
  await db.exec('reset role;'); await db.query("insert into storage.objects (bucket_id, name, owner) values ('incident-photos', $1, $2);", [lone, unrelated]); await sup();
  const readLone = async (u) => { const r = await attempt(asUser(u), () => db.query("select count(*)::int n from storage.objects where bucket_id = 'incident-photos' and name = $1", [lone])); return r.ok ? r.r.rows[0].n === 1 : false; };
  assert(await readLone(unrelated), 'an unreferenced object stays readable by its uploader');
  assert(!(await readLone(reporter)) && !(await readLone(mgmt)) && !(await readLone(plain)), 'and by nobody else (not the reporter, not Management, not an unrelated account)');
  const dd = await attempt(asUser(unrelated), () => db.query("delete from storage.objects where bucket_id = 'incident-photos' and name = $1", [lone]));
  const uu = await attempt(asUser(unrelated), () => db.query("update storage.objects set name = $2 where bucket_id = 'incident-photos' and name = $1", [lone, `incident-photos/${uuid()}/${uuid()}.png`]));
  assert((!dd.ok || dd.r.affectedRows === 0 || dd.r.rowCount === 0) && (!uu.ok || uu.r.affectedRows === 0 || uu.r.rowCount === 0) && (await readLone(unrelated)), 'an uploader cannot delete or move an object through the API');
  const hGrants = await attempt(asAnon, () => db.query('select public.caterlink_incident_photo_visible($1)', [photo]));
  assert(!hGrants.ok && /permission denied/i.test(hGrants.err), 'anonymous cannot call the read helper');
  assert((await objectCount()) === before + 2, 'no client write changed the stored objects (only the two service-role fixtures exist)');

  await db.exec('rollback;');
  await db.close();
  console.log(`\nTOTAL: ${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
