// Guarded staging runner (scripts/staging/apply-p0-migrations.mjs): runs the runner's own execute() -- the exact code that will run on staging --
// against a disposable database reproducing the hosted staging pre-state of the nine touched tables (the three P0 migrations reverted). Proves FIRST that
// the application's payloads fail on that state, then: the pre-state gates refuse a wrong state, the dry run passes every probe and leaves the database
// unchanged, the live pass commits all three migrations atomically, existing rows are preserved, the migrations are idempotent, and a second run is
// refused. Dual-mode (PGlite / native PostgreSQL).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { assertDisposableLocalTarget } from './safeguards.mjs';

const { Client } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_DATA_DIR = path.join(__dirname, 'pgdata');
const RUN_DATA_DIR = path.join(__dirname, 'pgdata_p0_runner_run');
let failures = 0;
let passes = 0;
const assert = (c, m) => { if (!c) { failures += 1; console.log('FAIL:', m); } else { passes += 1; console.log('PASS:', m); } };

async function main() {
  const runner = await import(pathToFileURL(path.join(__dirname, '..', '..', '..', 'scripts', 'staging', 'apply-p0-migrations.mjs')).href);
  const isNative = process.argv.includes('--native') || process.env.PG_NATIVE === '1';
  const pgConfig = { host: process.env.PGHOST || '127.0.0.1', port: parseInt(process.env.PGPORT || '55433', 10), user: process.env.PGUSER || 'postgres', password: process.env.PGPASSWORD || undefined };
  const goldenDb = process.env.PGDATABASE || 'vecta_phase6_test';
  const runDb = 'vecta_p0_runner_run';
  let db;
  if (isNative) {
    assertDisposableLocalTarget(pgConfig, goldenDb, runDb);
    console.log('=== P0 guarded runner core against native PostgreSQL ===');
    const admin = new Client({ ...pgConfig, database: 'postgres' });
    await admin.connect();
    await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${runDb}' and pid <> pg_backend_pid();`);
    await admin.query(`drop database if exists ${runDb};`);
    await admin.query(`create database ${runDb} template ${goldenDb};`);
    const client = new Client({ ...pgConfig, database: runDb });
    await client.connect();
    db = { exec: (s) => client.query(s), query: (s, p) => client.query(s, p), close: async () => { await client.end(); await admin.query(`drop database if exists ${runDb};`); await admin.end(); } };
  } else {
    console.log('=== P0 guarded runner core against PGlite ===');
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

  // ---- personas under the manifest labels the runner uses
  await db.exec("select set_config('request.jwt.claims', '{}', false), set_config('role', 'service_role', false);");
  let seq = 0x9e00;
  const nextId = () => `00000000-0000-0000-0000-${(++seq).toString(16).padStart(12, '0')}`;
  const DAY = 86400000;
  const iso = (ms) => new Date(Date.now() + ms).toISOString();
  const myAoc = (await one("select id from public.aocs where code = 'MY';")).id;
  const opsDept = (await one("select id from public.departments where aoc_id = $1 and code = 'operation';", [myAoc])).id;
  const maa = (await one("select id from public.operating_entities where aoc_id = $1 and code = 'MAA';", [myAoc])).id;
  const aax = (await one("select id from public.operating_entities where aoc_id = $1 and code = 'AAX';", [myAoc])).id;
  const roleMap = new Map((await rows('select id, code from public.role_definitions;')).map((r) => [r.code, r.id]));
  const accounts = new Map();
  async function profile(label, station, team) {
    const id = nextId();
    await db.query('insert into auth.users (id, email) values ($1,$2);', [id, `p0-${label}@example.test`]);
    await db.query("insert into public.profiles (id, email, name, staff_no, role, status, station, team) values ($1,$2,$3,$4,'ASO','approved',$5,$6) on conflict (id) do update set status = 'approved';", [id, `p0-${label}@example.test`, `P0 ${label}`, `P0-${label}`.slice(0, 20), station, team]);
    accounts.set(label, id);
    return id;
  }
  async function stationOfficer(label, stationCode, entity, role = 'aso') {
    const st = await one('select id, hub_id from public.org_stations where code = $1;', [stationCode]);
    await db.query("insert into public.org_teams (station_id, name) values ($1, 'ALPHA') on conflict (station_id, name) do nothing;", [st.id]);
    const team = (await one("select id from public.org_teams where station_id = $1 and name = 'ALPHA';", [st.id])).id;
    const id = await profile(label, stationCode, 'ALPHA');
    const m = (await one("insert into public.user_entity_memberships (profile_id, aoc_id, operating_entity_id, status, is_primary) values ($1,$2,$3,'active',true) returning id;", [id, myAoc, entity])).id;
    const enf = (await one("select id from public.departments where aoc_id = $1 and code = 'enforcement';", [myAoc])).id;
    const unit = role === 'profiling_aso' ? (await one("select id from public.units where department_id = $1 and code = 'profiling';", [enf])).id : null;
    await db.query('insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, unit_id, hub_id, station_id, team_id, entity_membership_id, starts_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10);', [id, roleMap.get(role), myAoc, role === 'profiling_aso' ? enf : opsDept, unit, st.hub_id, st.id, team, m, iso(-DAY)]);
    return id;
  }
  const om = await profile('operation_manager', null, null);
  await db.query('insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, starts_at) values ($1,$2,$3,$4,$5);', [om, roleMap.get('operation_manager'), myAoc, opsDept, iso(-DAY)]);
  await stationOfficer('aso', 'KUL - MAA', maa);
  await stationOfficer('profiling_aso', 'KUL - MAA', maa, 'profiling_aso');
  const otherCode = (await one("select code from public.org_stations where code <> 'KUL - MAA' and is_active order by code limit 1;")).code;
  await stationOfficer('aso-jhb', otherCode, aax);
  const acct = (label) => accounts.get(label) ?? (() => { throw new Error(`no ${label}`); })();
  await db.exec('reset role;');
  // the station users' profiles carry their station and team (written by the approval workflow on hosted databases; the guard trigger is bypassed on the disposable copy only)
  await db.exec('alter table public.profiles disable trigger user;');
  for (const [label, st] of [['aso', 'KUL - MAA'], ['profiling_aso', 'KUL - MAA'], ['aso-jhb', otherCode]]) await db.query("update public.profiles set station = $1, team = 'ALPHA' where id = $2", [st, acct(label)]);
  await db.exec('alter table public.profiles enable trigger user;');
  await db.exec("select set_config('request.jwt.claims', '', false);");

  // ---- reproduce the historical staging state: the three P0 migrations reverted
  await db.exec(`
    alter table public.report_sec013 drop column if exists ops_group;
    alter table public.report_sec014 drop column if exists ops_group;
    alter table public.report_sec018 drop column if exists ops_group;
    alter table public.report_sec029 drop column if exists ops_group, drop column if exists flight_destination, drop column if exists aircraft_type_other;
    alter table public.report_sec033 drop column if exists ops_group;
    alter table public.duty_records drop column if exists ops_group;
    drop index if exists public.overtime_requests_duty_category_uniq;
    alter table public.overtime_requests drop column if exists ops_group, drop column if exists actual_check_in, drop column if exists actual_check_out, drop column if exists scheduled_start, drop column if exists scheduled_end, drop column if exists calculated_at;
    alter table public.report_sec014_patrols drop constraint if exists report_sec014_patrols_entry_no_check, drop constraint if exists report_sec014_patrols_location_check;
    alter table public.report_sec014_patrols add constraint report_sec014_patrols_entry_no_check check (entry_no >= 1 and entry_no <= 15);
    alter table public.report_sec014_patrols add constraint report_sec014_patrols_location_check check (location = any (array['Aircraft'::text, 'Terminal'::text, 'Premises'::text]));
    alter table public.overtime_requests drop constraint if exists overtime_requests_category_check;
    alter table public.overtime_requests add constraint overtime_requests_category_check check (category = any (array['flight_delay'::text, 'manpower_shortage'::text, 'event'::text, 'off_day_work'::text, 'adhoc'::text]));
    alter table public.profiles drop constraint if exists profiles_approved_by_fkey;
    alter table public.profiles drop column if exists approved_by, drop column if exists approved_at, drop column if exists rejection_reason;
  `);
  // ... and hosted's required-column sets (read-only observation 2026-10-21): the canonical chain has extra NOT NULL columns that hosted never had
  const HOSTED_REQUIRED = {
    report_sec013: ['profile_id', 'station', 'team', 'staff_name', 'staff_id', 'date_time_in', 'date_time_out'],
    report_sec014: ['profile_id', 'station', 'team', 'staff_name', 'staff_id', 'date_time_in', 'remark'],
    report_sec014_patrols: ['report_id', 'entry_no'],
    report_sec018: ['profile_id', 'station', 'team', 'staff_name', 'date_time'],
    report_sec029: ['profile_id', 'station', 'team', 'supervising_officer_name', 'supervising_officer_id', 'staff_name', 'staff_id', 'assisted_by_name', 'assisted_by_id', 'aircraft_type', 'flight_no', 'aircraft_registration', 'std'],
    report_sec033: ['profile_id', 'station', 'team', 'staff_name', 'staff_id', 'report_date', 'report_time'],
    duty_records: ['profile_id', 'station', 'duty_date', 'shift_code'],
    overtime_requests: ['profile_id', 'station', 'work_date', 'start_at', 'end_at', 'category', 'reason'],
  };
  for (const [t, req] of Object.entries(HOSTED_REQUIRED)) {
    const extra = (await rows("select column_name from information_schema.columns where table_schema='public' and table_name=$1 and is_nullable='NO' and column_default is null and is_generated='NEVER' and column_name <> all($2)", [t, req])).map((r) => r.column_name);
    if (extra.length) await db.exec('alter table public.' + t + ' ' + extra.map((c) => 'alter column ' + c + ' drop not null').join(', ') + ';');
  }
  // hosted lets authenticated insert report_sec014_patrols (policy: via parent write) and has no table-level SELECT on it
  await db.exec('grant insert on public.report_sec014_patrols to authenticated;');
  await db.exec("create schema if not exists supabase_migrations; create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text);");
  const hist = await one('select count(*)::int n, max(version) v from supabase_migrations.schema_migrations;');
  if (hist.n === 0) await db.exec("insert into supabase_migrations.schema_migrations (version, name, statements) values ('20261117000001', 'bay_board_sec016_reconciliation', '{}');");
  const preCount = (await one('select count(*)::int n from supabase_migrations.schema_migrations;')).n;
  const state = async () => JSON.stringify({
    cols: (await rows("select table_name, column_name, is_nullable from information_schema.columns where table_schema='public' and table_name in ('report_sec013','report_sec014','report_sec014_patrols','report_sec018','report_sec029','report_sec033','duty_records','overtime_requests','profiles') order by 1,2;")),
    cons: (await rows("select conrelid::regclass::text t, conname, pg_get_constraintdef(oid) d from pg_constraint where conrelid in ('public.report_sec014_patrols'::regclass,'public.overtime_requests'::regclass,'public.profiles'::regclass) order by 1,2;")),
    idx: (await rows("select indexname from pg_indexes where schemaname='public' and tablename='overtime_requests' order by 1;")),
    hist: (await one('select count(*)::int n from supabase_migrations.schema_migrations;')).n,
  });

  const readFile = (f) => fs.readFileSync(path.join(__dirname, '..', '..', 'migrations', f));
  const files = runner.verifyFrozenMigrations(readFile);
  assert(files.length === 3 && files.every((f) => runner.normalisedSha256(Buffer.from(f.sql)) === f.sha256), 'the frozen SHA-256 of all three migrations matches the files');
  const logs = [];
  const base = { files, acct, log: (m) => logs.push(m), preCount, lastPre: '20261117000001', hashes: null };
  const before = await state();

  // ================= FAILING FIRST: the application's payloads on the reproduced pre-state =================
  const tryRun = async (label, fn) => {
    await db.exec('BEGIN;');
    try {
      await db.exec("select set_config('request.jwt.claims', '" + JSON.stringify({ sub: acct(label), role: 'authenticated' }) + "', true), set_config('role', 'authenticated', true)");
      await db.exec('SAVEPOINT tr;');
      try { await fn(); return 'OK'; } catch (e) { return (e.code ?? '') + ':' + String(e.message).slice(0, 100); }
    } finally { await db.exec('RESET role;').catch(() => {}); await db.exec('ROLLBACK;').catch(() => {}); }
  };
  const me = await one('select id, station, team, name, staff_no from public.profiles where id = $1', [acct('aso')]);
  const sec013 = (extra) => db.query(`insert into public.report_sec013 (profile_id, station, team, staff_name, staff_id, date_time_in, date_time_out${extra ? ', ops_group' : ''}) values ($1,$2,$3,'n','s',now(),now()${extra ? ', null' : ''})`, [me.id, me.station, me.team]);
  const red1 = await tryRun('aso', () => sec013(true));
  assert(/^42703:/.test(red1), `BEFORE the migrations the application's SEC013 payload (ops_group) fails on the missing column (${red1})`);
  const redTxt = await tryRun('aso', () => db.query("update public.profiles set approved_at = now() where id = $1", [me.id]));
  assert(/^42703:/.test(redTxt), `BEFORE the migrations the registration approval audit update fails on the missing column (${redTxt})`);
  assert((await state()) === before, 'the failing-first experiments changed nothing');

  // ---- gates refuse a wrong state, and refusal changes nothing
  const refuse = async (label, ctx, rx) => {
    let msg = null;
    try { await runner.execute(db, ctx); } catch (e) { msg = e.message; }
    assert(msg !== null && rx.test(msg), `${label} (${msg})`);
    assert((await state()) === before, `${label}: database unchanged`);
  };
  await refuse('a wrong history count is refused', { ...base, preCount: base.preCount + 1 }, /history is not exactly/);
  await refuse('a wrong last migration is refused', { ...base, lastPre: '20261115000001' }, /history is not exactly/);
  await refuse('an observed-state hash mismatch is refused', { ...base, hashes: { ...runner.PRE_STATE, columnsMd5: '0'.repeat(32) } }, /differs from the observed pre-state/);
  await refuse('tampered SQL is refused', { ...base, files: [{ ...files[0], sql: files[0].sql + '\n-- x' }, files[1], files[2]] }, /does not match its frozen SHA-256/);
  await db.exec('BEGIN;');
  await db.exec("alter table public.duty_records add column ops_group text;");
  let partial = null; try { await runner.execute(db, base); } catch (e) { partial = e.message; }
  await db.exec('ROLLBACK;');
  assert(partial && /already exists: this migration set has been partly applied/.test(partial), `a partly applied state is refused (${partial})`);
  // duplicates make the unique index impossible: refused by the pre-state gate before anything is written
  await db.exec('BEGIN;');
  await db.exec("alter table public.overtime_requests disable trigger user; alter table public.duty_records disable trigger user;");
  const dutyId = nextId();
  await db.query("insert into public.duty_records (id, profile_id, station, duty_date, shift_code) values ($1,$2,$3,current_date,'M');", [dutyId, me.id, me.station]);
  const dupSql = "insert into public.overtime_requests (profile_id, station, work_date, start_at, end_at, category, reason, linked_duty_id) values ($1,$2,current_date,now(),now()+interval '1 hour','off_day_work','dup',$3);";
  let dupMsg = null;
  try { await db.query(dupSql, [me.id, me.station, dutyId]); await db.query(dupSql, [me.id, me.station, dutyId]); await runner.execute(db, base); } catch (e) { dupMsg = e.message; }
  await db.exec('ROLLBACK;');
  assert(dupMsg && /duplicate \(linked_duty_id, category\)|holds \d+ duplicate/.test(dupMsg), `duplicate (linked_duty_id, category) rows are refused before anything is written (${dupMsg})`);
  assert((await state()) === before, 'the refusal experiments left the database unchanged');

  // ---- existing rows survive (SEC014 + patrol, duty, overtime)
  const existing = nextId();
  await db.exec('BEGIN;');
  await db.exec('alter table public.report_sec014 disable trigger user; alter table public.report_sec014_patrols disable trigger user;');
  await db.query("insert into public.report_sec014 (id, profile_id, station, team, staff_name, staff_id, date_time_in, remark) values ($1,$2,$3,$4,'old','o1',now(),'old row')", [existing, me.id, me.station, me.team]);
  await db.query("insert into public.report_sec014_patrols (report_id, entry_no, location) values ($1, 5, 'Terminal')", [existing]);
  const rowBefore = (await one('select to_jsonb(r) j from public.report_sec014_patrols r where report_id = $1', [existing])).j;
  for (const f of files) await db.exec(f.sql);
  const rowAfter = (await one('select to_jsonb(r) j from public.report_sec014_patrols r where report_id = $1', [existing])).j;
  await db.exec('ROLLBACK;');
  assert(JSON.stringify(rowBefore) === JSON.stringify(rowAfter), 'EXISTING ROW PRESERVED: a pre-migration SEC014 patrol row is byte-identical after the migrations');
  assert((await state()) === before, 'the existing-row experiment changed nothing (rolled back)');

  // ---- dry run
  const dry = await runner.execute(db, { ...base, live: false });
  assert(dry.committed === false && dry.probes.length === runner.EXPECTED_PROBES, `dry run passes ${dry.probes.length} probes (required ${runner.EXPECTED_PROBES}) and commits nothing`);
  assert((await state()) === before, 'dry run leaves columns, constraints, indexes and history exactly as they were');
  assert(logs.some((m) => /staging is unchanged after the dry-run rollback/.test(m)), 'the dry-run unchanged-proof ran');
  for (const p of dry.probes) console.log('   probe:', p);
  assert((await runner.execute(db, { ...base, live: false, expectedProbes: runner.EXPECTED_PROBES })).probes.length === runner.EXPECTED_PROBES, 'the runner enforces the exact required probe count');
  let wrongCount = null; try { await runner.execute(db, { ...base, live: false, expectedProbes: runner.EXPECTED_PROBES + 1 }); } catch (e) { wrongCount = e.message; }
  assert(wrongCount && /incomplete probe execution/.test(wrongCount), `a probe-count mismatch is refused (${wrongCount})`);

  // ---- live pass (disposable copy only)
  const live = await runner.execute(db, { ...base, live: true });
  assert(live.committed === true, 'live pass commits');
  const after = JSON.parse(await state());
  assert(after.hist === preCount + 3, `exactly three history rows were added (${preCount} -> ${after.hist})`);
  const v = await runner.verifyApplied(async (s, p) => (await db.query(s, p)).rows, { postCount: preCount + 3, postLast: runner.POST_LAST });
  assert(v.last === runner.POST_LAST, 'verifyApplied (the read-only post-apply check) passes on the applied state');
  assert((await rows("select version from supabase_migrations.schema_migrations where version >= '20261118000001' order by 1")).map((r) => r.version).join() === runner.MIGRATIONS.map((m) => m.version).join(), 'all three versions are recorded in order');

  // ---- idempotency: the three migrations run again change nothing and raise nothing
  const stateAfterLive = await state();
  await db.exec('BEGIN;');
  let rerun = 'OK';
  try { for (const f of files) await db.exec(f.sql); } catch (e) { rerun = String(e.message).slice(0, 100); }
  const stateAfterRerun = await state();
  await db.exec('ROLLBACK;');
  assert(rerun === 'OK' && stateAfterRerun === stateAfterLive, 'the migrations are idempotent: re-applying them raises nothing and changes nothing');

  // ---- a second run is refused
  let again = null;
  try { await runner.execute(db, { ...base, preCount: after.hist, lastPre: runner.POST_LAST, live: true }); } catch (e) { again = e.message; }
  assert(again !== null && /already recorded|already exists/.test(again), `re-running after the apply is refused (${again})`);
  let againOriginal = null;
  try { await runner.execute(db, { ...base, live: true }); } catch (e) { againOriginal = e.message; }
  assert(againOriginal !== null && /history is not exactly/.test(againOriginal), `re-running with the original pre-state expectation is refused (${againOriginal})`);
  assert(JSON.stringify(await state()) === JSON.stringify(after) || (await state()) === stateAfterLive, 'the refused re-runs changed nothing');

  await db.close();
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
