// Guarded staging runner (scripts/staging/apply-caterlink-visibility-migration.mjs): runs the runner's own execute() -- the exact code that will run on staging --
// against a disposable database reproducing the hosted pre-state of the CaterLink least-privilege migration (the station-membership policy and no new
// function). Proves: a Staff Profiling officer and an unrelated station officer can read a movement under the old policy; the gates refuse a wrong state; the
// dry run passes every probe and leaves the database unchanged; the live pass commits atomically; the access matrix after the change is exactly the designed
// one; a second run is refused. Dual-mode (PGlite / native PostgreSQL).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { assertDisposableLocalTarget } from './safeguards.mjs';

const { Client } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_DATA_DIR = path.join(__dirname, 'pgdata');
const RUN_DATA_DIR = path.join(__dirname, 'pgdata_caterlink_visibility_run');
let failures = 0;
let passes = 0;
const assert = (c, m) => { if (!c) { failures += 1; console.log('FAIL:', m); } else { passes += 1; console.log('PASS:', m); } };

async function main() {
  const runner = await import(pathToFileURL(path.join(__dirname, '..', '..', '..', 'scripts', 'staging', 'apply-caterlink-visibility-migration.mjs')).href);
  const isNative = process.argv.includes('--native') || process.env.PG_NATIVE === '1';
  const pgConfig = { host: process.env.PGHOST || '127.0.0.1', port: parseInt(process.env.PGPORT || '55433', 10), user: process.env.PGUSER || 'postgres', password: process.env.PGPASSWORD || undefined };
  const goldenDb = process.env.PGDATABASE || 'vecta_phase6_test';
  const runDb = 'vecta_caterlink_visibility_run';
  let db;
  if (isNative) {
    assertDisposableLocalTarget(pgConfig, goldenDb, runDb);
    console.log('=== CaterLink visibility guarded runner core against native PostgreSQL ===');
    const admin = new Client({ ...pgConfig, database: 'postgres' });
    await admin.connect();
    await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${runDb}' and pid <> pg_backend_pid();`);
    await admin.query(`drop database if exists ${runDb};`);
    await admin.query(`create database ${runDb} template ${goldenDb};`);
    const client = new Client({ ...pgConfig, database: runDb });
    await client.connect();
    db = { exec: (s) => client.query(s), query: (s, p) => client.query(s, p), close: async () => { await client.end(); await admin.query(`drop database if exists ${runDb};`); await admin.end(); } };
  } else {
    console.log('=== CaterLink visibility guarded runner core against PGlite ===');
    if (!fs.existsSync(GOLDEN_DATA_DIR)) { console.error('ERROR: ./pgdata does not exist -- run `node migrate.mjs` first.'); process.exit(1); }
    fs.rmSync(RUN_DATA_DIR, { recursive: true, force: true });
    fs.cpSync(GOLDEN_DATA_DIR, RUN_DATA_DIR, { recursive: true });
    const pgliteDb = new PGlite(RUN_DATA_DIR);
    const batch = async (s) => { const r = await pgliteDb.exec(s); const last = r[r.length - 1] ?? { rows: [], fields: [] }; return { ...last, rowCount: last.rows.length || last.affectedRows || 0 }; };
    db = { exec: (s) => pgliteDb.exec(s), query: (s, p) => (p === undefined ? batch(s) : pgliteDb.query(s, p).then((r) => ({ ...r, rowCount: r.rows.length || r.affectedRows || 0 }))), close: () => pgliteDb.close().then(() => fs.rmSync(RUN_DATA_DIR, { recursive: true, force: true })) };
  }
  const one = async (s, p) => (await db.query(s, p)).rows[0];
  const rows = async (s, p) => (await db.query(s, p)).rows;

  await db.exec("select set_config('request.jwt.claims', '{}', false), set_config('role', 'service_role', false);");
  let seq = 0xa100;
  const nextId = () => `00000000-0000-0000-0000-${(++seq).toString(16).padStart(12, '0')}`;
  const DAY = 86400000;
  const iso = (ms) => new Date(Date.now() + ms).toISOString();
  const myAoc = (await one("select id from public.aocs where code = 'MY';")).id;
  const opsDept = (await one("select id from public.departments where aoc_id = $1 and code = 'operation';", [myAoc])).id;
  const maa = (await one("select id from public.operating_entities where aoc_id = $1 and code = 'MAA';", [myAoc])).id;
  const roleMap = new Map((await rows('select id, code from public.role_definitions;')).map((r) => [r.code, r.id]));
  const accounts = new Map();
  async function profile(label, status = 'approved') {
    const id = nextId();
    await db.query('insert into auth.users (id, email) values ($1,$2);', [id, `cv-${label}@example.test`]);
    await db.query("insert into public.profiles (id, email, name, staff_no, role, status, station, team) values ($1,$2,$3,$4,'ASO',$5,null,null) on conflict (id) do update set status = excluded.status;", [id, `cv-${label}@example.test`, `CV ${label}`, `CV-${label}`.slice(0, 20), status]);
    accounts.set(label, id);
    return id;
  }
  async function officer(label, stationCode, roleCode = 'aso', status = 'approved') {
    const st = await one('select id, hub_id from public.org_stations where code = $1;', [stationCode]);
    await db.query("insert into public.org_teams (station_id, name) values ($1, 'ALPHA') on conflict (station_id, name) do nothing;", [st.id]);
    const team = (await one("select id from public.org_teams where station_id = $1 and name = 'ALPHA';", [st.id])).id;
    const id = await profile(label, status);
    const m = (await one("insert into public.user_entity_memberships (profile_id, aoc_id, operating_entity_id, status, is_primary) values ($1,$2,$3,'active',true) returning id;", [id, myAoc, maa])).id;
    const u = roleCode.startsWith('profiling') ? (await one("select id, department_id from public.units where name ilike '%profil%' order by name limit 1;")) : null;
    await db.query('insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, unit_id, hub_id, station_id, team_id, entity_membership_id, starts_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10);', [id, roleMap.get(roleCode), myAoc, u?.department_id ?? opsDept, u?.id ?? null, st.hub_id, st.id, team, m, iso(-DAY)]);
    return id;
  }
  async function aocRole(label, roleCode) {
    const id = await profile(label);
    await db.query('insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, operating_entity_id, starts_at) values ($1,$2,$3,$4,$5,$6);', [id, roleMap.get(roleCode), myAoc, roleCode === 'caterlink_management' ? (await one("select id from public.departments where aoc_id = $1 and code = 'caterlink';", [myAoc])).id : opsDept, null, iso(-DAY)]);
    return id;
  }
  const noCapStation = (await one("select code from public.org_stations where code not in ('PEN','JHB','KUL - MAA','KCH','BKI') and is_active order by code limit 1;")).code;
  await officer('aso', 'PEN');
  await officer('profiling_aso', 'PEN', 'profiling_aso');
  await officer('aso-jhb', 'JHB');
  await officer('aso-kul', 'KUL - MAA');
  await officer('aso-kch-receipt', 'KCH');
  await officer('aso-bki-receipt', 'BKI');
  await officer('aso-no-caterlink', noCapStation);
  await officer('neg-pending-profile', 'PEN', 'aso', 'pending');
  await aocRole('caterlink_management', 'caterlink_management');
  await aocRole('operation_manager', 'operation_manager');
  await profile('caterlink-driver');
  await profile('caterlink-vendor');
  const acct = (label) => accounts.get(label) ?? (() => { throw new Error(`no ${label}`); })();
  await db.exec('reset role;');
  await db.exec("select set_config('request.jwt.claims', '', false);");

  // ---- hosted station capabilities (the designed inputs), deterministic
  const cap = { PEN: [true, false, true, true, true], JHB: [true, false, true, true, true], 'KUL - MAA': [true, true, false, true, true], KCH: [true, false, false, false, true], BKI: [true, false, false, false, true] };
  for (const code of [...Object.keys(cap), noCapStation]) {
    const st = (await one('select id from public.org_stations where code = $1;', [code])).id;
    await db.query('delete from public.caterlink_station_capabilities where aoc_id = $1 and station_id = $2;', [myAoc, st]);
    if (cap[code]) {
      const [v, cr, sc, cs, ch] = cap[code];
      await db.query('insert into public.caterlink_station_capabilities (aoc_id, station_id, is_active, can_view, can_create, can_scan, can_confirm_station_receipt, can_confirm_hub_receipt, can_view_history) values ($1,$2,true,$3,$4,$5,$6,$7,true);', [myAoc, st, v, cr, sc, cs, ch]);
    }
  }

  // ---- reproduce the hosted pre-state: the station-membership policy, no new function, history 98 ending 20261118000005
  await db.exec('drop policy if exists transactions_read_policy on public.transactions;');
  await db.exec(`create policy transactions_read_policy on public.transactions for select to authenticated using (
    (current_user = 'service_role'::name)
    or ((aoc_id is not null) and public.has_active_role_for_aoc('caterlink_management'::text, aoc_id))
    or ((aoc_id is not null) and (public.has_active_role_for_aoc('operation_manager'::text, aoc_id) or public.has_active_role_for_aoc('main_enforcement'::text, aoc_id)))
    or (created_by = auth.uid())
    or ((aoc_id is not null) and public.has_station_assignment_for_transaction(aoc_id, destination_station_id, origin_station_id)));`);
  await db.exec('drop function if exists public.caterlink_can_read_transaction_at_stations(uuid, uuid, uuid, text);');
  await db.exec("create schema if not exists supabase_migrations; create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text);");
  await db.exec("delete from supabase_migrations.schema_migrations where version >= '20261119000001';");
  if ((await one("select count(*)::int n from supabase_migrations.schema_migrations where version = '20261118000005';")).n === 0) await db.exec("insert into supabase_migrations.schema_migrations (version, name, statements) values ('20261118000005', 'profile_guard_hosted_compatible', '{}');");
  const preCount = (await one('select count(*)::int n from supabase_migrations.schema_migrations;')).n;
  const state = async () => JSON.stringify({
    policy: (await one("select md5(pg_get_expr(polqual, polrelid)) h from pg_policy where polrelid = 'public.transactions'::regclass and polname = 'transactions_read_policy'")).h,
    fn: (await one("select count(*)::int n from pg_proc where proname = 'caterlink_can_read_transaction_at_stations'")).n,
    hist: (await one('select count(*)::int n from supabase_migrations.schema_migrations;')).n,
  });

  const readFile = (f) => fs.readFileSync(path.join(__dirname, '..', '..', 'migrations', f));
  const files = runner.verifyFrozenMigrations(readFile);
  assert(files.length === 1 && runner.normalisedSha256(Buffer.from(files[0].sql)) === files[0].sha256, 'the frozen SHA-256 of the migration matches the file');
  const logs = [];
  const base = { files, acct, log: (m) => logs.push(m), preCount, lastPre: '20261118000005', hashes: null };
  const before = await state();
  assert(JSON.parse(before).fn === 0, 'the fixture reproduces the pre-state: no visibility function, the station-membership policy');

  // ---- the old policy lets station membership alone grant access (reproduced on the disposable pre-state)
  const readAs = async (label, id) => {
    await db.exec("select set_config('request.jwt.claims', '" + JSON.stringify({ sub: acct(label), role: 'authenticated' }) + "', false), set_config('role', 'authenticated', false);");
    try { return (await db.query('select count(*)::int n from public.transactions where id = $1', [id])).rows[0].n === 1; } finally { await db.exec("reset role; select set_config('request.jwt.claims', '', false);"); }
  };
  const pen = (await one("select id from public.org_stations where code = 'PEN'")).id;
  const kul = (await one("select id from public.org_stations where code = 'KUL - MAA'")).id;
  await db.exec('set session_replication_role = replica;');
  const T = (await one(`insert into public.transactions (transaction_number, aoc_id, direction, vehicle_number, driver_name, driver_id, seal_number, status, route, origin_station_id, destination_station_id, hub_destination, flight_number, created_by)
    values ('CV-PROBE-1', $1, 'OUTBOUND', 'CV-VEH', 'cv probe', 'CV-DRV', 'CV-SEAL', 'CREATED', 'AIRCRAFT', $2, $3, 'PEN', 'AK9001', $4) returning id`, [myAoc, kul, pen, acct('caterlink-driver')])).id;
  await db.exec('set session_replication_role = origin;');
  assert(await readAs('profiling_aso', T) === true && await readAs('aso', T) === true, 'BEFORE: profiling_aso and aso at PEN both read a PEN-destined movement (station membership alone)');
  await db.query('delete from public.transactions where id = $1', [T]);

  // ---- gates refuse a wrong state, and refusal changes nothing
  const refuse = async (label, ctx, rx) => {
    let msg = null;
    try { await runner.execute(db, ctx); } catch (e) { msg = e.message; }
    assert(msg !== null && rx.test(msg), `${label} (${msg})`);
    assert((await state()) === before, `${label}: database unchanged`);
  };
  await refuse('a wrong history count is refused', { ...base, preCount: base.preCount + 1 }, /history is not exactly/);
  await refuse('a wrong last migration is refused', { ...base, lastPre: '20261115000001' }, /history is not exactly/);
  await refuse('an observed-state hash mismatch is refused', { ...base, hashes: { ...runner.PRE_STATE, policyMd5: '0'.repeat(32) } }, /differs from the observed pre-state/);
  await refuse('tampered SQL is refused', { ...base, files: [{ ...files[0], sql: files[0].sql + '\n-- x' }] }, /does not match its frozen SHA-256/);
  await refuse('an extra statement outside the allow-list is refused', { ...base, files: [{ ...files[0], sql: files[0].sql + '\ngrant all on public.profiles to anon;', sha256: undefined }] }, /outside the reviewed allow-list/);

  // ---- dry run
  const dry = await runner.execute(db, { ...base, live: false });
  assert(dry.committed === false && dry.probes.length === runner.EXPECTED_PROBES, `dry run passes ${dry.probes.length} probes and commits nothing`);
  assert((await state()) === before, 'dry run leaves the policy, the function set and history exactly as they were');
  assert(logs.some((m) => /staging is unchanged after the dry-run rollback/.test(m)), 'the dry-run unchanged-proof ran');
  for (const p of dry.probes) console.log('   probe:', p);
  let wrongCount = null; try { await runner.execute(db, { ...base, live: false, expectedProbes: dry.probes.length + 1 }); } catch (e) { wrongCount = e.message; }
  assert(wrongCount && /incomplete probe execution/.test(wrongCount), `a probe-count mismatch is refused (${wrongCount})`);

  // ---- live pass (disposable copy only)
  const live = await runner.execute(db, { ...base, live: true });
  assert(live.committed === true, 'live pass commits');
  const after = JSON.parse(await state());
  assert(after.hist === preCount + 1 && after.fn === 1 && after.policy !== JSON.parse(before).policy, `one history row added (${preCount} -> ${after.hist}), the function exists and the policy changed`);
  const v = await runner.verifyApplied(async (s, p) => (await db.query(s, p)).rows, { postCount: preCount + 1, postLast: runner.POST_LAST });
  assert(v.last === runner.POST_LAST, 'verifyApplied (the read-only post-apply check) passes on the applied state');

  // ---- the applied behaviour, independently of the runner's probes
  await db.exec('set session_replication_role = replica;');
  const T2 = (await one(`insert into public.transactions (transaction_number, aoc_id, direction, vehicle_number, driver_name, driver_id, seal_number, status, route, origin_station_id, destination_station_id, hub_destination, flight_number, created_by)
    values ('CV-PROBE-2', $1, 'OUTBOUND', 'CV-VEH', 'cv probe', 'CV-DRV', 'CV-SEAL', 'CREATED', 'AIRCRAFT', $2, $3, 'PEN', 'AK9001', $4) returning id`, [myAoc, kul, pen, acct('caterlink-driver')])).id;
  await db.exec('set session_replication_role = origin;');
  assert(await readAs('profiling_aso', T2) === false, 'AFTER: profiling_aso at PEN cannot read a PEN-destined movement');
  assert(await readAs('aso', T2) === true, 'AFTER: aso at PEN (receipt capability) still reads it');
  assert(await readAs('aso-jhb', T2) === false && await readAs('aso-no-caterlink', T2) === false, 'AFTER: other-station officers cannot read it');
  assert(await readAs('caterlink_management', T2) === true && await readAs('operation_manager', T2) === true && await readAs('caterlink-driver', T2) === true, 'AFTER: management, operation manager and the creating driver still read it');
  assert(await readAs('caterlink-vendor', T2) === false, 'AFTER: a vendor cannot read another party\'s movement');

  // ---- a second run is refused
  let again = null;
  try { await runner.execute(db, { ...base, live: true }); } catch (e) { again = e.message; }
  assert(again !== null && /history is not exactly/.test(again), `re-running after the apply is refused (${again})`);
  let againPost = null;
  try { await runner.execute(db, { ...base, preCount: after.hist, lastPre: runner.POST_LAST, live: true }); } catch (e) { againPost = e.message; }
  assert(againPost !== null && /already recorded|already exists|has been applied already/.test(againPost), `re-running with the post-state expectation is refused (${againPost})`);

  await db.close();
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
