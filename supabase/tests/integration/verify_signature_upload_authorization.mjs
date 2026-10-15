// Signature bucket upload authorization (20261113000001): the unrestricted upload policy is gone; only documented, bound path formats are accepted
// (caller, parent record, role and scope, workflow state), finalisation binds the stored reference, and orphans are reconcilable. Dual-mode (PGlite / native).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { assertDisposableLocalTarget } from './safeguards.mjs';

const { Client } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_DATA_DIR = path.join(__dirname, 'pgdata');
const RUN_DATA_DIR = path.join(__dirname, 'pgdata_sigup_run');
let failures = 0;
let passes = 0;
const assert = (c, m) => { if (!c) { failures += 1; console.log('FAIL:', m); } else { passes += 1; console.log('PASS:', m); } };

async function main() {
  const isNative = process.argv.includes('--native') || process.env.PG_NATIVE === '1';
  const pgConfig = { host: process.env.PGHOST || '127.0.0.1', port: parseInt(process.env.PGPORT || '55433', 10), user: process.env.PGUSER || 'postgres', password: process.env.PGPASSWORD || undefined };
  const goldenDb = process.env.PGDATABASE || 'vecta_phase6_test';
  const runDb = 'vecta_sigup_run';
  let db;
  if (isNative) {
    assertDisposableLocalTarget(pgConfig, goldenDb, runDb);
    console.log('=== Signature upload authorization against native PostgreSQL ===');
    const admin = new Client({ ...pgConfig, database: 'postgres' });
    await admin.connect();
    await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${runDb}' and pid <> pg_backend_pid();`);
    await admin.query(`drop database if exists ${runDb};`);
    await admin.query(`create database ${runDb} template ${goldenDb};`);
    const client = new Client({ ...pgConfig, database: runDb });
    await client.connect();
    db = { exec: (s) => client.query(s), query: (s, p) => client.query(s, p), close: async () => { await client.end(); await admin.query(`drop database if exists ${runDb};`); await admin.end(); } };
  } else {
    console.log('=== Signature upload authorization against PGlite ===');
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

  let seq = 0x9800;
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
    await db.query('insert into auth.users (id, email) values ($1,$2) on conflict (id) do nothing;', [id, `sg-${label}@example.test`]);
    await db.query("insert into public.profiles (id, email, name, staff_no, role, status, station, team) values ($1,$2,$3,$4,'ASO',$5,$6,$7) on conflict (id) do update set status = excluded.status, name = excluded.name, staff_no = excluded.staff_no, station = excluded.station, team = excluded.team;", [id, `sg-${label}@example.test`, `SG ${label}`, `SG-${label}`.slice(0, 20), status, stTxt, tmTxt]);
    const mem = (await one("insert into public.user_entity_memberships (profile_id, aoc_id, operating_entity_id, status, is_primary) values ($1,$2,$3,'active',true) returning id;", [id, myAoc, myEntity])).id;
    await db.query(`insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, hub_id, station_id, team_id, entity_membership_id, starts_at, ends_at, revoked_at)
      values ($1,$2,$3,$4,$5,$6,$7,$8, coalesce($9::timestamptz, now() - interval '1 day'), $10, $11);`, [id, roleMap.get('aso'), myAoc, opsDept, st.hub_id, st.id, tm, mem, timing.starts ?? null, timing.ends ?? null, timing.revoked ?? null]);
    return id;
  }
  // ---- the legacy policy staging carries, recreated so the migration under test must remove it
  await db.exec('reset role;');
  await db.query("insert into storage.buckets (id, name, public) values ('signatures', 'signatures', false) on conflict (id) do nothing;");
  await db.exec(`drop policy if exists "signatures: authenticated upload" on storage.objects;
    create policy "signatures: authenticated upload" on storage.objects for insert to public with check (bucket_id = 'signatures' and auth.role() = 'authenticated');`);
  await db.exec(`grant select, insert, update, delete on storage.objects to authenticated, service_role;`);
  await db.exec('create unique index if not exists bucketid_objname on storage.objects (bucket_id, name);'); // Supabase Storage has this index; the platform stub does not
  // re-run the migration under test (idempotent) on top of the legacy policy, exactly as staging will see it
  const MIGRATION = fs.readFileSync(path.join(__dirname, '..', '..', 'migrations', '20261113000001_signature_upload_authorization.sql'), 'utf8');
  await db.exec(MIGRATION);
  await sup();

  // ---- personas
  const duty = async (u) => db.query("insert into public.duty_records (profile_id, station, duty_date, shift_code, check_in_at, status) select $1, 'PEN', $2::date, 'SG', now(), 'present' where exists (select 1 from public.stations where code = 'PEN');", [u, today]);
  const officer = async (label, opts = {}) => { const id = await person(label, opts); if (opts.duty !== false) await duty(id); return id; };
  const aoPen = await officer('sgpen', { st: pen, tm: penAlpha, stTxt: 'PEN' });
  const aoPen2 = await officer('sgpen2', { st: pen, tm: penAlpha, stTxt: 'PEN' });
  const aoKul = await officer('sgkul');
  const aoNoDuty = await officer('sgnoduty', { st: pen, tm: penAlpha, stTxt: 'PEN', duty: false });
  const plain = nextId(); // approved profile with no assignment at all: an ordinary authenticated account
  await db.query('insert into auth.users (id, email) values ($1,$2);', [plain, 'sg-plain@example.test']);
  await db.query("insert into public.profiles (id, email, name, staff_no, role, status) values ($1,'sg-plain@example.test','SG Plain','SG-PLAIN','ASO','approved') on conflict (id) do update set status = 'approved';", [plain]);
  const badOfficer = {
    pending: await officer('sgpending', { st: pen, tm: penAlpha, stTxt: 'PEN', status: 'pending' }),
    rejected: await officer('sgrejected', { st: pen, tm: penAlpha, stTxt: 'PEN', status: 'rejected' }),
    revoked: await officer('sgrevoked', { st: pen, tm: penAlpha, stTxt: 'PEN', timing: { revoked: new Date(Date.now() - 3600_000).toISOString() } }),
    expired: await officer('sgexpired', { st: pen, tm: penAlpha, stTxt: 'PEN', timing: { starts: new Date(Date.now() - 5 * 86400_000).toISOString(), ends: new Date(Date.now() - 86400_000).toISOString() } }),
    future: await officer('sgfuture', { st: pen, tm: penAlpha, stTxt: 'PEN', timing: { starts: new Date(Date.now() + 86400_000).toISOString() } }),
  };
  try { await db.exec('savepoint dd;'); badOfficer.deactivated = await officer('sgdeact', { st: pen, tm: penAlpha, stTxt: 'PEN', status: 'deactivated' }); await db.exec('release savepoint dd;'); } catch (e) { await db.exec('rollback to savepoint dd; release savepoint dd;'); console.log('NOTE: no deactivated profile status in this schema (' + String(e.message).slice(0, 50) + ')'); }
  async function external(label, role, status = 'active') {
    const id = nextId();
    await db.query('insert into auth.users (id, email) values ($1,$2);', [id, `sg-${label}@example.test`]);
    await db.query("insert into public.profiles (id, email, name, staff_no, role, status) values ($1,$2,$3,$4,'ASO','approved') on conflict (id) do update set status = 'approved';", [id, `sg-${label}@example.test`, `SG ${label}`, `SG-${label}`.slice(0, 20)]);
    await db.query('insert into public.users (id, name, staff_id, email, role, status) values ($1,$2,$3,$4,$5,$6);', [id, `SG ${label}`, `SG-${label}`.slice(0, 20), `sg-${label}@example.test`, role, status]);
    return id;
  }
  const driverA = await external('drva', 'warehouse_pic');
  const driverB = await external('drvb', 'warehouse_pic');
  const driverPending = await external('drvpend', 'warehouse_pic', 'pending');
  const vendorA = await external('vena', 'vendor');
  const vendorB = await external('venb', 'vendor');
  const vendorPending = await external('venpend', 'vendor', 'pending');

  // ---- parents
  const uuid = () => nextId().replace(/^0000/, 'aaaa');
  const ext = (id) => `${id}`;
  let txn = 0;
  async function makeTx(st, { direction = 'OUTBOUND', status = 'CREATED', route = 'AIRCRAFT', hub = null, createdBy = driverA } = {}) {
    const id = nextId(); txn += 1;
    await db.exec('reset role; set session_replication_role = replica;');
    await db.query(`insert into public.transactions (id, transaction_number, aoc_id, direction, vehicle_number, driver_name, driver_id, seal_number, status, route, hub_destination, origin_station_id, flight_number, created_by)
      values ($1,$2,$3,$4,'SG1234A','SG Driver','SGD001','S',$5,$6,$7,$8,'AK703',$9);`, [id, `TX-SG-${txn}`, myAoc, direction, status, route, hub, st.id, createdBy]);
    await db.exec('set session_replication_role = origin;');
    await sup();
    return id;
  }
  let dseq = 0;
  async function delivery(owner, status = 'CREATED', st = pen) {
    await db.exec('reset role; set session_replication_role = replica;');
    const id = nextId();
    await db.query(`insert into public.caterlink_vendor_deliveries (id, delivery_number, aoc_id, station_id, vendor_user_id, status, driver_name, driver_nric, vehicle_registration_no, seal_number)
      values ($1, $2, $3, $4, $5, $6, 'Driver', '900101-01-1234', 'VEN1234', 'SEAL-V');`, [id, `CLV-SG-${++dseq}`, myAoc, st.id, owner, status]);
    await db.exec('set session_replication_role = origin;');
    await sup();
    return id;
  }

  const png = (...parts) => parts.join('') + '.png';
  const upload = (u, name, owner = u) => attempt(asUser(u), () => db.query("insert into storage.objects (bucket_id, name, owner) values ('signatures', $1, $2);", [name, owner]));
  const objectCount = async (like) => (await one("select count(*)::int n from storage.objects where bucket_id = 'signatures' and name like $1", [like])).n;
  const RLS = /row-level security|policy|violates/i;
  const denied = async (label, u, name, owner = u) => {
    const before = await objectCount('%');
    const r = await upload(u, name, owner);
    assert(!r.ok && RLS.test(r.err) && (await objectCount('%')) === before, `${label}: refused by Storage RLS, no object row`);
  };
  const allowed = async (label, u, name, owner = u) => {
    const r = await upload(u, name, owner);
    assert(r.ok, `${label}: accepted${r.ok ? '' : ' [' + String(r.err).slice(0, 90) + ']'}`);
    return r;
  };

  console.log('--- the legacy broad policy is gone and nothing is a generic "authenticated may upload" ---');
  const pols = await rows("select policyname, cmd, permissive, roles::text from pg_policies where schemaname = 'storage' and tablename = 'objects' and (with_check ilike '%signatures%' or qual ilike '%signatures%') order by policyname");
  assert(!pols.some((p) => p.policyname === 'signatures: authenticated upload'), 'the unrestricted "signatures: authenticated upload" policy is removed');
  const insertPolicies = pols.filter((p) => p.cmd === 'INSERT' && p.permissive === 'PERMISSIVE');
  assert(insertPolicies.length === 1 && /authenticated/.test(insertPolicies[0].roles) && !/public/.test(insertPolicies[0].roles), 'exactly one permissive INSERT policy remains, granted to authenticated only');
  assert(pols.filter((p) => ['UPDATE', 'DELETE', 'ALL'].includes(p.cmd)).length === 0, 'no UPDATE/DELETE/ALL policy exists for the bucket (no overwrite, move or delete by clients)');
  const bucket = await one("select public from storage.buckets where id = 'signatures'");
  assert(bucket.public === false, 'the bucket stays private');
  const fnGrants = await rows("select p.proname, has_function_privilege('anon', p.oid, 'execute') an, has_function_privilege('authenticated', p.oid, 'execute') au, has_function_privilege('service_role', p.oid, 'execute') sr, p.prosecdef sd, p.proconfig::text cfg from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('caterlink_signature_upload_allowed','caterlink_part_b_upload_allowed','caterlink_receipt_upload_allowed','caterlink_vendor_complete_upload_allowed','list_orphan_signatures_secure') order by 1");
  assert(fnGrants.length === 5, 'all five new helpers exist');
  assert(fnGrants.every((f) => !f.an && f.sr && f.sd && /search_path/.test(f.cfg)), 'every helper: not executable by anon, SECURITY DEFINER with a fixed search_path');
  assert(fnGrants.filter((f) => f.proname !== 'list_orphan_signatures_secure').every((f) => f.au) && !fnGrants.find((f) => f.proname === 'list_orphan_signatures_secure').au, 'upload helpers are callable by authenticated (the Storage policy runs as them); the orphan listing is service-role only');

  console.log('--- regression: an approved, unrelated user cannot upload an arbitrary or unrecognised path ---');
  for (const p of [`arbitrary-test/${uuid()}.png`, `e2e-probe/driver-1.png`, `x-${uuid()}.png`, `part-a/${Date.now()}-abcd1234.png`, `vendor-signatures/${Date.now()}-abcd1234.png`, `signatures/arbitrary-test/${uuid()}.png`, `other/${uuid()}/${uuid()}.png`]) {
    await denied(`approved unrelated officer, "${p.replace(/[0-9a-f-]{36}/g, '<uuid>')}"`, aoPen, p);
    await denied(`plain approved account, same path`, plain, p);
  }
  const anonUp = await attempt(asAnon, () => db.query("insert into storage.objects (bucket_id, name, owner) values ('signatures', $1, null);", [`part-a/${driverA}/${uuid()}.png`]));
  assert(!anonUp.ok && /row-level security|policy|permission denied/i.test(anonUp.err), 'anonymous cannot upload even a well-formed path');

  console.log('--- Part A: part-a/<caller uid>/<uuid>.png (a Driver, before the movement exists) ---');
  await allowed('active Driver, own uid', driverA, png('part-a/', driverA, '/', uuid()));
  await denied('Driver B using Driver A uid in the path', driverB, png('part-a/', driverA, '/', uuid()));
  await denied('Driver A with an owner column that is not the caller', driverA, png('part-a/', driverA, '/', uuid()), driverB);
  await denied('pending Driver account', driverPending, png('part-a/', driverPending, '/', uuid()));
  await denied('Vendor account', vendorA, png('part-a/', vendorA, '/', uuid()));
  await denied('station officer', aoPen, png('part-a/', aoPen, '/', uuid()));
  await denied('Driver, legacy flat name', driverA, `part-a/${Date.now()}-abcd1234.png`);

  console.log('--- Part B: part-b/<transaction uuid>-<uuid>.png (the parent exists, workflow state and officer scope apply) ---');
  const t1 = await makeTx(pen);
  const pb = (tx) => png('part-b/', tx, '-', uuid());
  await allowed('PEN officer on a PEN movement waiting for Part B', aoPen, pb(t1));
  await denied('officer at ANOTHER station (KUL, no scan capability)', aoKul, pb(t1));
  await denied('approved account with no assignment', plain, pb(t1));
  await denied('officer without an open duty check-in', aoNoDuty, pb(t1));
  for (const [k, u] of Object.entries(badOfficer)) await denied(`${k} officer`, u, pb(t1));
  await denied('Driver', driverA, pb(t1));
  await denied('Vendor', vendorA, pb(t1));
  await denied('missing parent (random transaction)', aoPen, pb(uuid()));
  for (const st of ['INFLIGHT_POST_APPROVED', 'ESCALATED', 'COMPLETED', 'AIRPORT_POST_APPROVED']) await denied(`wrong workflow state ${st} (outbound)`, aoPen, pb(await makeTx(pen, { status: st })));
  await allowed('inbound movement waiting at AIRPORT_POST_APPROVED', aoPen, pb(await makeTx(pen, { direction: 'INBOUND', status: 'AIRPORT_POST_APPROVED' })));
  await denied('inbound movement still CREATED', aoPen, pb(await makeTx(pen, { direction: 'INBOUND', status: 'CREATED' })));
  const tDone = await makeTx(pen);
  await db.exec('reset role; set session_replication_role = replica;');
  await db.query(`insert into public.part_b_c (transaction_id, checkpoint_stage, avsec_name, avsec_staff_id, signature_url, completed_by, result) values ($1,'B','x','y','part-b/legacy.png',$2,'PASS');`, [tDone, aoPen]);
  await db.exec('set session_replication_role = origin;'); await sup();
  await denied('Part B already recorded for this movement', aoPen, pb(tDone));
  const tJhb = await makeTx(await station('JHB'));
  await denied('PEN officer on a JHB-only movement (cross-station)', aoPen, pb(tJhb));

  console.log('--- receipt: receipt/<transaction uuid>/<uuid>.png (destination officer, ready state) ---');
  const rc = (tx) => png('receipt/', tx, '/', uuid());
  const tHub = await makeTx(kul, { route: 'HUB', hub: 'PEN', status: 'INFLIGHT_POST_APPROVED' });
  await allowed('PEN officer receiving a movement destined to PEN', aoPen, rc(tHub));
  await denied('officer at another station (KUL)', aoKul, rc(tHub));
  await denied('officer without assignment', plain, rc(tHub));
  for (const [k, u] of Object.entries(badOfficer)) await denied(`${k} officer`, u, rc(tHub));
  await denied('Driver', driverA, rc(tHub));
  await denied('Vendor', vendorA, rc(tHub));
  await denied('missing parent', aoPen, rc(uuid()));
  await denied('wrong workflow state (CREATED)', aoPen, rc(await makeTx(kul, { route: 'HUB', hub: 'PEN', status: 'CREATED' })));
  await denied('already COMPLETED', aoPen, rc(await makeTx(kul, { route: 'HUB', hub: 'PEN', status: 'COMPLETED' })));
  await denied('movement destined to a different hub (JHB)', aoPen, rc(await makeTx(kul, { route: 'HUB', hub: 'JHB', status: 'INFLIGHT_POST_APPROVED' })));
  await denied('movement with no trusted destination', aoPen, rc(await makeTx(kul, { route: 'AIRCRAFT', hub: null, status: 'AIRPORT_POST_APPROVED' })));

  console.log('--- Vendor delivery creation: vendor-signatures/<caller uid>/<uuid>.png ---');
  await allowed('active Vendor, own uid', vendorA, png('vendor-signatures/', vendorA, '/', uuid()));
  await denied('Vendor B using Vendor A uid', vendorB, png('vendor-signatures/', vendorA, '/', uuid()));
  await denied('pending Vendor account', vendorPending, png('vendor-signatures/', vendorPending, '/', uuid()));
  await denied('Driver account', driverA, png('vendor-signatures/', driverA, '/', uuid()));
  await denied('station officer', aoPen, png('vendor-signatures/', aoPen, '/', uuid()));
  await denied('Vendor, legacy flat name', vendorA, `vendor-signatures/${Date.now()}-abcd1234.png`);

  console.log('--- Vendor Part C: vendor-part-c/<delivery uuid>/<uuid>.png (owning vendor, SECURITY_VERIFIED) ---');
  const vc = (d) => png('vendor-part-c/', d, '/', uuid());
  const dOk = await delivery(vendorA, 'SECURITY_VERIFIED');
  await allowed('owning Vendor on a security-verified delivery', vendorA, vc(dOk));
  await denied('another Vendor', vendorB, vc(dOk));
  await denied('station officer', aoPen, vc(dOk));
  await denied('Driver', driverA, vc(dOk));
  await denied('missing parent', vendorA, vc(uuid()));
  for (const st of ['CREATED', 'ESCALATED', 'COMPLETED']) await denied(`wrong workflow state ${st}`, vendorA, vc(await delivery(vendorA, st)));
  await db.query("update public.users set status = 'pending' where id = $1", [vendorA]);
  await denied('owning Vendor whose account became pending', vendorA, vc(dOk));
  await db.query("update public.users set status = 'active' where id = $1", [vendorA]);

  console.log('--- Vendor Part B (unchanged design): vendor-part-b/<delivery uuid>/<uuid>.png ---');
  const dB = await delivery(vendorA, 'CREATED', pen);
  const vb = (d) => png('vendor-part-b/', d, '/', uuid());
  await allowed('authorised PEN officer on a CREATED delivery', aoPen, vb(dB));
  await denied('officer at another station', aoKul, vb(dB));
  await denied('Vendor owner', vendorA, vb(dB));
  await denied('unrelated approved account', plain, vb(dB));

  console.log('--- malformed and hostile names are refused even for an otherwise authorised caller ---');
  const good = png('part-a/', driverA, '/', uuid());
  const hostile = [
    ['malformed uuid', `part-a/${driverA}/not-a-uuid.png`],
    ['malformed parent uuid', `part-a/${driverA.slice(0, 35)}/${uuid()}.png`],
    ['path traversal', `part-a/${driverA}/../${uuid()}.png`],
    ['dot segments', `part-a/./${driverA}/${uuid()}.png`],
    ['double separator', `part-a/${driverA}//${uuid()}.png`],
    ['leading slash', `/part-a/${driverA}/${uuid()}.png`],
    ['trailing slash', `part-a/${driverA}/${uuid()}.png/`],
    ['upper-case extension', `part-a/${driverA}/${uuid()}.PNG`],
    ['mixed-case extension', `part-a/${driverA}/${uuid()}.Png`],
    ['unsupported extension gif', `part-a/${driverA}/${uuid()}.gif`],
    ['unsupported extension exe', `part-a/${driverA}/${uuid()}.exe`],
    ['double extension', `part-a/${driverA}/${uuid()}.png.exe`],
    ['no extension', `part-a/${driverA}/${uuid()}`],
    ['arbitrary filename', `part-a/${driverA}/signature-final.png`],
    ['oversized filename', `part-a/${driverA}/${'a'.repeat(200)}.png`],
    ['trailing whitespace', `part-a/${driverA}/${uuid()}.png `],
    ['newline', `part-a/${driverA}/${uuid()}.png\n`],
    ['unicode look-alike', `part-a/${driverA}/${uuid()}.pnɡ`],
    ['extra depth', `part-a/${driverA}/x/${uuid()}.png`],
    ['wrong prefix case', `Part-A/${driverA}/${uuid()}.png`],
  ];
  for (const [label, name] of hostile) await denied(label, driverA, name);
  const hostileB = [
    ['Part B traversal', `part-b/${t1}-${uuid()}/../x.png`],
    ['Part B slash instead of dash', `part-b/${t1}/${uuid()}.png`],
    ['Part B upper-case extension', `part-b/${t1}-${uuid()}.PNG`],
    ['Part B arbitrary filename', `part-b/${t1}-final.png`],
  ];
  for (const [label, name] of hostileB) await denied(label, aoPen, name);

  console.log('--- no overwrite, move, copy or delete by an authenticated client ---');
  const fixed = png('part-a/', driverB, '/', uuid());
  await allowed('first upload of a fixed name', driverB, fixed);
  const dup = await upload(driverB, fixed);
  assert(!dup.ok, 'a second insert at the same name is refused');
  const upsert = await attempt(asUser(driverB), () => db.query("insert into storage.objects (bucket_id, name, owner) values ('signatures', $1, $2) on conflict (bucket_id, name) do update set owner = excluded.owner;", [fixed, driverB]));
  assert(!upsert.ok, 'an upsert (insert ... on conflict do update) is refused: it needs an UPDATE policy that does not exist');
  const before = await one("select count(*)::int n, min(name) nm from storage.objects where bucket_id = 'signatures'");
  const upd = await attempt(asUser(driverB), () => db.query("update storage.objects set name = $1 where bucket_id = 'signatures' and name = $2", [png('part-a/', driverB, '/', uuid()), fixed]));
  const del = await attempt(asUser(driverB), () => db.query("delete from storage.objects where bucket_id = 'signatures' and name = $1", [fixed]));
  const after = await one("select count(*)::int n, min(name) nm from storage.objects where bucket_id = 'signatures'");
  assert((!upd.ok || upd.r.affectedRows === 0 || upd.r.rowCount === 0) && (!del.ok || del.r.affectedRows === 0 || del.r.rowCount === 0) && JSON.stringify(before) === JSON.stringify(after), 'UPDATE (move) and DELETE affect nothing');

  console.log('--- trusted service_role access is unchanged ---');
  await db.exec('select pg_temp.sim_service();');
  const svc = await attempt(() => db.exec('select pg_temp.sim_service();'), () => db.query("insert into storage.objects (bucket_id, name, owner) values ('signatures', $1, null);", [`service-only/${uuid()}.png`]));
  assert(svc.ok, 'service_role may still write any path (trusted server workflows, cleanup)');

  console.log('--- finalisation binds the stored reference to the parent and the actor ---');
  const sigObj = async (name, owner) => { await db.exec('reset role;'); await db.query("insert into storage.objects (bucket_id, name, owner) values ('signatures', $1, $2)", [name, owner]); await sup(); return name; };
  const insertRow = async (sql, params) => { await db.exec('reset role;'); await db.exec('savepoint ir;'); try { await db.query(sql, params); await db.exec('release savepoint ir;'); return { ok: true }; } catch (e) { await db.exec('rollback to savepoint ir; release savepoint ir;'); return { ok: false, err: e.message }; } finally { await sup(); } };
  const tf = await makeTx(pen);
  const tf2 = await makeTx(pen);
  const PA = 'insert into public.caterlink_checkpoint_part_a (transaction_id, pic_name, pic_staff_id, signature_url, completed_by) values ($1,$2,$3,$4,$5)';
  assert(!(await insertRow(PA, [tf, 'n', 's', png('part-a/', driverB, '/', uuid()), driverA])).ok, 'Part A: a reference to another account\'s path is refused');
  assert(!(await insertRow(PA, [tf, 'n', 's', 'part-a/anything.png', driverA])).ok, 'Part A: an unbound legacy-style path is refused for new rows');
  const paOk = await sigObj(png('part-a/', driverA, '/', uuid()), driverA);
  assert((await insertRow(PA, [tf, 'n', 's', paOk, driverA])).ok, 'Part A: the caller\'s own bound, existing object is accepted');
  assert(!(await insertRow(PA, [tf2, 'n', 's', png('part-a/', driverA, '/', uuid()), driverA])).ok, 'Part A: a bound path with no stored object is refused');
  const PB = "insert into public.part_b_c (transaction_id, checkpoint_stage, avsec_name, avsec_staff_id, signature_url, completed_by, result) values ($1,$2,'n','s',$3,$4,'PASS')";
  const pbOwn = await sigObj(png('part-b/', tf, '-', uuid()), aoPen);
  assert(!(await insertRow(PB, [tf2, 'B', pbOwn, aoPen])).ok, 'Part B: an object bound to a DIFFERENT transaction is refused');
  assert(!(await insertRow(PB, [tf, 'C', pbOwn, aoPen])).ok, 'Part C: no writer exists, any signature is refused');
  assert(!(await insertRow(PB, [tf, 'B', pbOwn, aoPen2])).ok, 'Part B: an object uploaded by a different officer is refused');
  assert((await insertRow(PB, [tf, 'B', pbOwn, aoPen])).ok, 'Part B: the bound, existing, own object is accepted');
  const HUB = "insert into public.caterlink_checkpoint_hub (transaction_id, confirmed_destination, hub_avsec_name, hub_avsec_staff_id, signature_url, completed_by) values ($1,'PEN','n','s',$2,$3)";
  const hubObj = await sigObj(png('receipt/', tf, '/', uuid()), aoPen);
  assert(!(await insertRow(HUB, [tf2, hubObj, aoPen])).ok, 'Receipt: an object bound to a different transaction is refused');
  assert((await insertRow(HUB, [tf, hubObj, aoPen])).ok, 'Receipt: the bound, existing, own object is accepted');
  const PD = "insert into public.caterlink_checkpoint_part_d (transaction_id, signature_url, completed_by) values ($1,$2,$3)";
  const pdr = await insertRow(PD, [tf, 'part-d/x.png', aoPen]);
  assert(!pdr.ok && !/column|does not exist/i.test(pdr.err || ''), 'Part D (blocked workflow): a signature reference is refused');
  const VC = "insert into public.caterlink_vendor_checkpoints (delivery_id, stage, actor_id, actor_name, actor_staff_id, signature_url) values ($1,$2,$3,'n','s',$4)";
  const dv = await delivery(vendorA, 'CREATED'); const dv2 = await delivery(vendorA, 'CREATED');
  const vaObj = await sigObj(png('vendor-signatures/', vendorA, '/', uuid()), vendorA);
  assert(!(await insertRow(VC, [dv, 'A', vendorB, vaObj])).ok, 'Vendor stage A: a path bound to another account is refused');
  assert((await insertRow(VC, [dv, 'A', vendorA, vaObj])).ok, 'Vendor stage A: the bound, existing, own object is accepted');
  const vcObj = await sigObj(png('vendor-part-c/', dv, '/', uuid()), vendorA);
  assert(!(await insertRow(VC, [dv2, 'C', vendorA, vcObj])).ok, 'Vendor stage C: an object bound to a different delivery is refused');
  assert((await insertRow(VC, [dv, 'C', vendorA, vcObj])).ok, 'Vendor stage C: the bound, existing, own object is accepted');

  console.log('--- reads: scoped read is unchanged; historical references stay readable ---');
  const histName = 'part-a/1700000000000-abcd1234.png';
  const histTx = await makeTx(pen, { createdBy: driverB });
  await db.exec('reset role; set session_replication_role = replica;');
  await db.query("insert into storage.objects (bucket_id, name, owner) values ('signatures', $1, $2)", [histName, driverB]);
  await db.query("insert into public.caterlink_checkpoint_part_a (transaction_id, pic_name, pic_staff_id, signature_url, completed_by) values ($1,'n','s',$2,$3)", [histTx, histName, driverB]);
  await db.exec('set session_replication_role = origin;'); await sup();
  const readable = async (u, name) => { const r = await attempt(asUser(u), () => db.query("select count(*)::int n from storage.objects where bucket_id = 'signatures' and name = $1", [name])); return r.ok ? r.r.rows[0].n : -1; };
  assert((await readable(driverB, histName)) === 1, 'a historical object (legacy name) stays readable by its owner');
  assert((await readable(plain, histName)) === 0, 'an unrelated approved account cannot see it');
  assert((await readable(driverB, fixed)) === 1 && (await readable(plain, fixed)) === 0, 'a fresh object is readable by its uploader only until a checkpoint references it');

  console.log('--- orphan reconciliation lists every new prefix and never a referenced object ---');
  await db.exec('reset role;');
  await db.query("update storage.objects set created_at = now() - interval '2 hours' where bucket_id = 'signatures'"); await sup();
  const listed = (await rows('select name from public.list_orphan_signatures_secure(30)')).map((r) => r.name);
  assert(listed.includes(fixed), 'an old unreferenced object under a new prefix is listed');
  assert(!listed.includes(histName) && !listed.includes(paOk) && !listed.includes(pbOwn) && !listed.includes(hubObj) && !listed.includes(vaObj) && !listed.includes(vcObj), 'referenced objects are never listed');
  assert(!listed.some((n) => n.startsWith('service-only/')), 'objects outside the approved prefixes are not touched');
  const denyList = await attempt(asUser(aoPen), () => db.query('select * from public.list_orphan_signatures_secure(30);'));
  assert(!denyList.ok && /permission denied/i.test(denyList.err), 'a signed-in user cannot list orphans');
  const denyAnon = await attempt(asAnon, () => db.query('select * from public.list_orphan_signatures_secure(30);'));
  assert(!denyAnon.ok && /permission denied/i.test(denyAnon.err), 'anonymous cannot list orphans');

  await db.exec('rollback;');
  await db.close();
  console.log(`\nTOTAL: ${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
