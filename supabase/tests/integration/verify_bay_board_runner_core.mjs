// Guarded staging runner (scripts/staging/apply-bay-board-migration.mjs): runs the runner's own execute() -- the exact code that will run on staging --
// against a disposable database reproducing the historical staging state. Proves: the pre-state gates refuse a wrong state, the dry run passes every
// probe and leaves the database unchanged, the live pass commits, and a second run is refused. Dual-mode (PGlite / native PostgreSQL).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { assertDisposableLocalTarget } from './safeguards.mjs';

const { Client } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_DATA_DIR = path.join(__dirname, 'pgdata');
const RUN_DATA_DIR = path.join(__dirname, 'pgdata_baybay_runner_run');
let failures = 0;
let passes = 0;
const assert = (c, m) => { if (!c) { failures += 1; console.log('FAIL:', m); } else { passes += 1; console.log('PASS:', m); } };

async function main() {
  const runner = await import(pathToFileURL(path.join(__dirname, '..', '..', '..', 'scripts', 'staging', 'apply-bay-board-migration.mjs')).href);
  const isNative = process.argv.includes('--native') || process.env.PG_NATIVE === '1';
  const pgConfig = { host: process.env.PGHOST || '127.0.0.1', port: parseInt(process.env.PGPORT || '55433', 10), user: process.env.PGUSER || 'postgres', password: process.env.PGPASSWORD || undefined };
  const goldenDb = process.env.PGDATABASE || 'vecta_phase6_test';
  const runDb = 'vecta_baybay_runner_run';
  let db;
  if (isNative) {
    assertDisposableLocalTarget(pgConfig, goldenDb, runDb);
    console.log('=== Bay Board guarded runner core against native PostgreSQL ===');
    const admin = new Client({ ...pgConfig, database: 'postgres' });
    await admin.connect();
    await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${runDb}' and pid <> pg_backend_pid();`);
    await admin.query(`drop database if exists ${runDb};`);
    await admin.query(`create database ${runDb} template ${goldenDb};`);
    const client = new Client({ ...pgConfig, database: runDb });
    await client.connect();
    db = { exec: (s) => client.query(s), query: (s, p) => client.query(s, p), close: async () => { await client.end(); await admin.query(`drop database if exists ${runDb};`); await admin.end(); } };
  } else {
    console.log('=== Bay Board guarded runner core against PGlite ===');
    if (!fs.existsSync(GOLDEN_DATA_DIR)) { console.error('ERROR: ./pgdata does not exist -- run `node migrate.mjs` first.'); process.exit(1); }
    fs.rmSync(RUN_DATA_DIR, { recursive: true, force: true });
    fs.cpSync(GOLDEN_DATA_DIR, RUN_DATA_DIR, { recursive: true });
    const pgliteDb = new PGlite(RUN_DATA_DIR);
    // hosted `pg` runs a parameterless query as one simple-protocol batch (multi-statement migration files); PGlite's query() is single-statement
    const batch = async (s) => { const r = await pgliteDb.exec(s); const last = r[r.length - 1] ?? { rows: [], fields: [] }; return { ...last, rowCount: last.rows.length || last.affectedRows || 0 }; };
    db = { exec: (s) => pgliteDb.exec(s), query: (s, p) => (p === undefined ? batch(s) : pgliteDb.query(s, p).then((r) => ({ ...r, rowCount: r.rows.length || r.affectedRows || 0 }))), close: () => pgliteDb.close() };
  }
  const one = async (s, p) => (await db.query(s, p)).rows[0];
  const rows = async (s, p) => (await db.query(s, p)).rows;

  // ---- personas under the manifest labels the runner uses (set up as service_role, like the other verifiers; the runner itself runs as the owner)
  await db.exec("select set_config('request.jwt.claims', '{}', false), set_config('role', 'service_role', false);");
  let seq = 0x9d00;
  const nextId = () => `00000000-0000-0000-0000-${(++seq).toString(16).padStart(12, '0')}`;
  const DAY = 86400000;
  const iso = (ms) => new Date(Date.now() + ms).toISOString();
  const myAoc = (await one("select id from public.aocs where code = 'MY';")).id;
  const opsDept = (await one("select id from public.departments where aoc_id = $1 and code = 'operation';", [myAoc])).id;
  const enfDept = (await one("select id from public.departments where aoc_id = $1 and code = 'enforcement';", [myAoc])).id;
  const maa = (await one("select id from public.operating_entities where aoc_id = $1 and code = 'MAA';", [myAoc])).id;
  const aax = (await one("select id from public.operating_entities where aoc_id = $1 and code = 'AAX';", [myAoc])).id;
  const roleMap = new Map((await rows('select id, code from public.role_definitions;')).map((r) => [r.code, r.id]));
  const kul = await one("select id, hub_id from public.org_stations where code = 'KUL - MAA';");
  await db.query("insert into public.org_teams (station_id, name) values ($1, 'ALPHA') on conflict (station_id, name) do nothing;", [kul.id]);
  const team = (await one("select id from public.org_teams where station_id = $1 and name = 'ALPHA';", [kul.id])).id;
  const accounts = new Map();
  async function profile(label, status = 'approved') {
    const id = nextId();
    await db.query('insert into auth.users (id, email) values ($1,$2);', [id, `rc-${label}@example.test`]);
    await db.query("insert into public.profiles (id, email, name, staff_no, role, status, station, team) values ($1,$2,$3,$4,'ASO',$5,'KUL - MAA','ALPHA') on conflict (id) do update set status = excluded.status;", [id, `rc-${label}@example.test`, `RC ${label}`, `RC-${label}`.slice(0, 20), status]);
    accounts.set(label, id);
    return id;
  }
  const assign = (id, role, { aocId = myAoc, dept = null, entity = null, starts = iso(-DAY), ends = null, revoked = null } = {}) =>
    db.query('insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, operating_entity_id, starts_at, ends_at, revoked_at) values ($1,$2,$3,$4,$5,$6,$7,$8);', [id, roleMap.get(role), aocId, dept, entity, starts, ends, revoked]);
  for (const role of ['operation_manager', 'main_enforcement']) await assign(await profile(role), role, { dept: role === 'main_enforcement' ? enfDept : opsDept });
  for (const role of ['maa_boss', 'maa_admin', 'aax_boss', 'aax_admin']) await assign(await profile(role), role, { entity: role.startsWith('maa') ? maa : aax });
  {
    const id = await profile('aso');
    const m = (await one("insert into public.user_entity_memberships (profile_id, aoc_id, operating_entity_id, status, is_primary) values ($1,$2,$3,'active',true) returning id;", [id, myAoc, maa])).id;
    await db.query('insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, hub_id, station_id, team_id, entity_membership_id, starts_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9);', [id, roleMap.get('aso'), myAoc, opsDept, kul.hub_id, kul.id, team, m, iso(-DAY)]);
  }
  for (const [label, role] of [['ghod', 'ghod'], ['global_reporting_controller', 'global_reporting_controller'], ['airasia_management', 'airasia_management']]) await assign(await profile(label), role, { aocId: null });
  await profile('neg-pending-profile', 'pending');
  const pendingOpm = accounts.get('neg-pending-profile');
  await db.query('insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, starts_at) values ($1,$2,$3,$4,$5);', [pendingOpm, roleMap.get('operation_manager'), myAoc, opsDept, iso(-DAY)]);
  await profile('neg-revoked-assignment'); await assign(accounts.get('neg-revoked-assignment'), 'operation_manager', { dept: opsDept, revoked: iso(-1000) });
  await profile('neg-expired-assignment'); await assign(accounts.get('neg-expired-assignment'), 'operation_manager', { dept: opsDept, starts: iso(-5 * DAY), ends: iso(-DAY) });
  await profile('neg-future-assignment'); await assign(accounts.get('neg-future-assignment'), 'operation_manager', { dept: opsDept, starts: iso(DAY) });
  await profile('caterlink-vendor'); // external identity: no role assignment
  const acct = (label) => accounts.get(label) ?? (() => { throw new Error(`no ${label}`); })();

  await db.exec('reset role;');
  await db.exec("select set_config('request.jwt.claims', '', false);");
  // the station user's profile carries its station and team (written by the approval workflow on hosted databases; the guard trigger is bypassed on the disposable copy only)
  await db.exec("alter table public.profiles disable trigger user; update public.profiles set station = 'KUL - MAA', team = 'ALPHA' where id = '" + acct('aso') + "'; alter table public.profiles enable trigger user;");
  // ---- reproduce the historical staging state
  await db.exec(`alter table public.bay_board drop column if exists flight, drop column if exists is_manual, drop column if exists arrival_report_id, drop column if exists departure_report_id;
    alter table public.report_sec016 drop column if exists flight_type, drop column if exists aircraft_search_completed, drop column if exists search_overdue_flag, drop column if exists search_remark;
    alter table public.bay_board drop constraint if exists bay_board_cleared_by_report_id_fkey;
    alter table public.bay_board add constraint bay_board_cleared_by_report_id_fkey foreign key (cleared_by_report_id) references public.report_sec029 (id);`);
  await db.exec("create schema if not exists supabase_migrations; create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text);");
  const hist = await one('select count(*)::int n, max(version) v from supabase_migrations.schema_migrations;');
  const state = async () => ({
    bay: (await rows("select column_name from information_schema.columns where table_schema='public' and table_name='bay_board' order by 1;")).map((r) => r.column_name).join(),
    hist: (await one('select count(*)::int n from supabase_migrations.schema_migrations;')).n,
  });

  const file = `${runner.MIGRATION.version}_${runner.MIGRATION.name}.sql`;
  const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'migrations', file), 'utf8');
  assert(runner.normalisedSha256(Buffer.from(sql)) === runner.MIGRATION.sha256, 'the frozen SHA-256 in the runner matches the migration file');
  assert(runner.statementAudit(sql) === null, 'every statement in the migration is on the runner allow-list');
  assert(runner.statementAudit(`${sql}\ngrant select on public.bay_board to anon;`) !== null, 'an added grant to anon is refused by the allow-list');
  assert(runner.statementAudit(`${sql}\ncreate policy p on public.bay_board for select using (true);`) !== null, 'an added policy is refused by the allow-list');
  assert(runner.statementAudit(`${sql}\ndelete from public.bay_board;`) !== null, 'an added delete is refused by the allow-list');
  const logs = [];
  const base = { files: [{ ...runner.MIGRATION, file, sql }], acct, log: (m) => logs.push(m), preCount: hist.n, lastPre: hist.v ?? '00000000000000', hashes: null };
  if (hist.n === 0) {
    // the disposable database has no recorded history; seed a minimal, deterministic one so the runner's history gates have something to verify
    await db.exec("insert into supabase_migrations.schema_migrations (version, name, statements) values ('20261116000001', 'completed_forms_lockdown', '{}');");
    base.preCount = 1; base.lastPre = '20261116000001';
  }

  const before = await state();

  // ---- gates refuse a wrong state, and refusal changes nothing
  const refuse = async (label, ctx, rx) => {
    let msg = null;
    try { await runner.execute(db, ctx); } catch (e) { msg = e.message; }
    assert(msg !== null && rx.test(msg), `${label} (${msg})`);
    assert(JSON.stringify(await state()) === JSON.stringify(before), `${label}: database unchanged`);
  };
  await refuse('a wrong history count is refused', { ...base, preCount: base.preCount + 1 }, /history is not exactly/);
  await refuse('a wrong last migration is refused', { ...base, lastPre: '20261115000001' }, /history is not exactly/);
  await refuse('an observed-state hash mismatch is refused', { ...base, hashes: { ...runner.PRE_STATE, functionMd5: '0'.repeat(32) } }, /differs from the observed pre-state/);

  // ---- dry run
  const dry = await runner.execute(db, { ...base, live: false });
  assert(dry.committed === false && dry.probes.length >= 20, `dry run passes ${dry.probes.length} probes and commits nothing`);
  assert(JSON.stringify(await state()) === JSON.stringify(before), 'dry run leaves columns and history exactly as they were');
  assert(logs.some((m) => /staging is unchanged after the dry-run rollback/.test(m)), 'the dry-run unchanged-proof ran');
  for (const p of dry.probes) console.log('   probe:', p);

  // ---- live pass (on the disposable copy only)
  const live = await runner.execute(db, { ...base, live: true });
  assert(live.committed === true, 'live pass commits');
  const after = await state();
  assert(after.hist === before.hist + 1 && /flight/.test(after.bay) && /is_manual/.test(after.bay) && /arrival_report_id/.test(after.bay) && /departure_report_id/.test(after.bay), 'after the live pass the columns exist and exactly one history row was added');
  await db.exec("select set_config('request.jwt.claims', json_build_object('sub', '" + acct('operation_manager') + "', 'role', 'authenticated')::text, false), set_config('role', 'authenticated', false)");
  const rpc = await db.query('select * from public.get_bay_board_secure(null, null)').then(() => 'ok').catch((e) => e.message);
  await db.exec("select set_config('role', 'postgres', false)").catch(() => db.exec('reset role;'));
  assert(rpc === 'ok', 'the Bay Board RPC works after the live pass');

  // ---- a second run is refused (columns already exist / already recorded)
  let again = null;
  try { await runner.execute(db, { ...base, preCount: after.hist, lastPre: runner.MIGRATION.version, live: false }); } catch (e) { again = e.message; }
  assert(again !== null && /already (has|recorded)/.test(again), `re-running after the apply is refused (${again})`);

  await db.close();
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
