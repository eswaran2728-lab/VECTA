// Guarded staging runner (scripts/staging/apply-bay-board-migration.mjs): runs the runner's own execute() -- the exact code that will run on staging --
// against a disposable database reproducing the EXACT hosted staging pre-state (Bay Board and SEC016 columns missing, the three rev03 columns and ops_group
// missing, the sixteen legacy SEC016 columns still NOT NULL). Proves FIRST that the unrevised migration fails on that state exactly as the hosted dry run did,
// then: the pre-state gates refuse a wrong state, the dry run passes every probe and leaves the database unchanged, the live pass commits, the migration is
// idempotent, existing rows are preserved, and a second run is refused. Dual-mode (PGlite / native PostgreSQL).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { assertDisposableLocalTarget } from './safeguards.mjs';
import * as F from '../../../scripts/staging/lib/sec016-fixtures.mjs';

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
  {
    // a station officer at a DIFFERENT station: must not see, insert or clear another station's Bay Board rows
    const other = await one("select id, hub_id, code from public.org_stations where code <> 'KUL - MAA' and is_active order by code limit 1;");
    await db.query("insert into public.org_teams (station_id, name) values ($1, 'ALPHA') on conflict (station_id, name) do nothing;", [other.id]);
    const otherTeam = (await one("select id from public.org_teams where station_id = $1 and name = 'ALPHA';", [other.id])).id;
    const id = await profile('aso-other');
    const m = (await one("insert into public.user_entity_memberships (profile_id, aoc_id, operating_entity_id, status, is_primary) values ($1,$2,$3,'active',true) returning id;", [id, myAoc, aax])).id;
    await db.query('insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, hub_id, station_id, team_id, entity_membership_id, starts_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9);', [id, roleMap.get('aso'), myAoc, opsDept, other.hub_id, other.id, otherTeam, m, iso(-DAY)]);
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
  // ... and the rest of the exact hosted drift (read-only observation 2026-10-21): the three rev03 columns and the historical ops_group are missing and the
  // sixteen legacy columns that rev03 relaxed are still NOT NULL (the table is empty on hosted, so the constraints can be re-imposed here)
  assert((await one('select count(*)::int n from public.report_sec016;')).n === 0 && (await one('select count(*)::int n from public.bay_board;')).n === 0, 'the staging-shaped fixture starts with zero report_sec016 and bay_board rows, like hosted');
  await db.exec('alter table public.report_sec016 drop column if exists ramp_agents_baggage, drop column if exists ramp_agents_cargo, drop column if exists cabin_check, drop column if exists ops_group;');
  // hosted never received the multi-tenant scaffolding either: no org_id on either table (the migration must not add it)
  await db.exec('alter table public.report_sec016 drop column if exists org_id; alter table public.bay_board drop column if exists org_id;');
  await db.exec('alter table public.report_sec016 ' + F.SEC016_LEGACY_NULLABLE.map((c) => 'alter column ' + c + ' set not null').join(', ') + ';');
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
  // roster labels the disposable database has no persona for are skipped by the runner (hosted has them all); the required probe count follows
  const missingDenied = runner.DENIED_LABELS.filter((l) => { try { acct(l); return false; } catch { return true; } }).length;
  const base = { files: [{ ...runner.MIGRATION, file, sql }], acct, log: (m) => logs.push(m), preCount: hist.n, lastPre: hist.v ?? '00000000000000', hashes: null, other: 'aso-other', expectedProbes: runner.EXPECTED_PROBES - missingDenied };
  if (hist.n === 0) {
    // the disposable database has no recorded history; seed a minimal, deterministic one so the runner's history gates have something to verify
    await db.exec("insert into supabase_migrations.schema_migrations (version, name, statements) values ('20261116000001', 'completed_forms_lockdown', '{}');");
    base.preCount = 1; base.lastPre = '20261116000001';
  }

  const before = await state();

  // ================= FAILING FIRST: the hosted drift reproduced, and the UNREVISED migration shown to fail on it =================
  const asUserTx = async (label, fn) => {
    await db.exec('BEGIN;');
    try {
      await db.exec("select set_config('request.jwt.claims', '" + JSON.stringify({ sub: acct(label), role: 'authenticated' }) + "', true), set_config('role', 'authenticated', true)");
      return await fn();
    } finally { await db.exec('ROLLBACK;').catch(() => {}); }
  };
  // expected failures run inside a savepoint (a failed statement otherwise aborts the surrounding transaction)
  const tryRun = async (sqlObj) => { await db.exec('SAVEPOINT tr;'); try { await db.query(sqlObj.text, sqlObj.values); await db.exec('RELEASE SAVEPOINT tr;'); return 'OK'; } catch (e) { await db.exec('ROLLBACK TO SAVEPOINT tr;'); return (e.code ?? '') + ':' + String(e.message).slice(0, 110); } };
  const writerRow = await one('select id, station, team, name, staff_no from public.profiles where id = $1', [acct('aso')]);
  const wctx = { profileId: writerRow.id, station: writerRow.station, team: writerRow.team, name: writerRow.name ?? 'fixture', staffNo: writerRow.staff_no ?? 'F1', reg: '9M-RED', flight: 'AK703', flightType: 'arrival' };
  const appInsert = () => F.insertSql('report_sec016', F.sec016AppPayload(wctx));
  const preCols = new Set((await rows("select column_name from information_schema.columns where table_schema='public' and table_name='report_sec016';")).map((r) => r.column_name));
  // the columns the UNREVISED runner's SEC016 probe inserted (it never named the legacy baggage / cargo / ramp_staff / offload columns, so hosted rejected it with 23502 inbound_baggage)
  const OLD_PROBE_COLUMNS = ['profile_id', 'status', 'station', 'team', 'staff_name', 'staff_no', 'duty_date', 'duty_hour', 'flight', 'origin_arr_dep', 'assisted_by', 'aircraft_type', 'reg_no', 'sta_std', 'ata_atd', 'bay_no', 'do_infmd', 'shift_leader', 'cargo_hold_checked', 'staff_frisked', 'discrepancies', 'flight_type', 'aircraft_search_completed', 'search_overdue_flag', 'search_remark'];
  const oldStyle = (existing = preCols) => { const full = F.sec016AppPayload(wctx); const o = {}; for (const k of OLD_PROBE_COLUMNS) if (existing.has(k)) o[k] = full[k]; return F.insertSql('report_sec016', o); };
  const drift = {
    missing: Object.keys(F.SEC016_NEW_COLUMNS).filter((c) => !preCols.has(c)),
    notNull: (await rows("select column_name from information_schema.columns where table_schema='public' and table_name='report_sec016' and is_nullable='NO' and column_name = any($1) order by 1;", [F.SEC016_LEGACY_NULLABLE])).map((r) => r.column_name),
  };
  assert(drift.missing.length === 8 && drift.notNull.length === 16, 'the fixture reproduces the exact hosted drift: eight report_sec016 columns missing and sixteen legacy columns NOT NULL (' + drift.missing.length + ' / ' + drift.notNull.length + ')');
  const red1 = await asUserTx('aso', () => tryRun(appInsert()));
  assert(/^42703:.*ops_group|^42703:/.test(red1), 'BEFORE ANY MIGRATION the application\'s SEC016 submit fails on the missing columns (' + red1 + ')');
  const red2 = await asUserTx('aso', () => tryRun(oldStyle()));
  assert(/^23502:.*inbound_baggage/.test(red2), 'BEFORE ANY MIGRATION a submit using only the columns hosted has fails exactly as the hosted dry run did: 23502 inbound_baggage (' + red2 + ')');
  const bayRed = await asUserTx('aso', () => tryRun(F.insertSql('bay_board', { station: wctx.station, reg_no: 'X', aircraft_type: 'A320', bay: 'B1', flight: 'AK703', arrival_report_id: null, on_ground_since: new Date().toISOString(), is_manual: false, created_by: wctx.profileId })));
  assert(/^42703:/.test(bayRed), 'BEFORE ANY MIGRATION the Bay Board arrival insert fails on the missing columns (' + bayRed + ')');
  // the UNREVISED migration (the fixture of what failed on hosted) does not repair SEC016 submission
  const oldSql = fs.readFileSync(path.join(__dirname, '..', 'fixtures', '20261117000001_bay_board_sec016_reconciliation.pre-revision.sql'), 'utf8');
  await db.exec('BEGIN;');
  await db.exec(oldSql);
  const oldAfter1 = await asUserTx2(() => tryRun(appInsert()));
  const oldAfter2 = await asUserTx2(() => tryRun(oldStyle2()));
  await db.exec('ROLLBACK;');
  function asUserTx2(fn) { return (async () => { await db.exec('SAVEPOINT x;'); try { await db.exec("select set_config('request.jwt.claims', '" + JSON.stringify({ sub: acct('aso'), role: 'authenticated' }) + "', true), set_config('role', 'authenticated', true)"); return await fn(); } finally { await db.exec('RESET role;').catch(() => {}); await db.exec('ROLLBACK TO SAVEPOINT x;').catch(() => {}); } })(); }
  function oldStyle2() { return oldStyle(new Set([...preCols, 'flight_type', 'aircraft_search_completed', 'search_overdue_flag', 'search_remark'])); }
  assert(/^42703:/.test(oldAfter1), 'WITH THE UNREVISED MIGRATION the application\'s SEC016 submit still fails (' + oldAfter1 + ')');
  assert(/^23502:.*inbound_baggage/.test(oldAfter2), 'WITH THE UNREVISED MIGRATION the best-effort submit still fails with 23502 inbound_baggage -- the hosted dry-run failure (' + oldAfter2 + ')');
  assert(JSON.stringify(await state()) === JSON.stringify(before), 'the failing-first experiments changed nothing (rolled back)');

  // ================= existing-row preservation (a pre-migration row must survive untouched) =================
  {
    await db.exec('BEGIN;');
    const legacy = { id: nextId(), profile_id: wctx.profileId, status: 'submitted', station: wctx.station, team: wctx.team, staff_name: 'legacy', staff_no: 'L1', duty_date: '2026-01-01', duty_hour: '10:00', flight: 'AK100', origin_arr_dep: 'ARR', assisted_by: 'x', aircraft_type: 'A320', reg_no: '9M-LEG', sta_std: '10:00', ata_atd: '10:05', bay_no: 'B9', do_infmd: 'NO', inbound_baggage: 'IB', outbound_baggage: 'OB', inbound_cargo: 'IC', outbound_cargo: 'OC', inbound_co_mail: 'IM', outbound_co_mail: 'OM', shift_leader: 'sl', ramp_staff_1: 'r1', ramp_staff_2: 'r2', ramp_staff_3: 'r3', ramp_staff_4: 'r4', ramp_staff_5: 'r5', cargo_hold_checked: 'YES', staff_frisked: 'YES', discrepancies: 'none', offload_flight_no: 'AK1', offload_destination: 'KUL', offload_total_baggage: '2', offload_baggage_tag_no: 'T', offload_remark: 'none' };
    // the immutability / form-assignment triggers are bypassed ONLY for this disposable fixture insert (the table is empty on hosted)
    await db.exec('alter table public.report_sec016 disable trigger user;');
    const li = F.insertSql('report_sec016', legacy);
    await db.query(li.text, li.values);
    await db.exec('alter table public.report_sec016 enable trigger user;');
    const beforeRow = await one("select to_jsonb(r) j from public.report_sec016 r where id = $1", [legacy.id]);
    await db.exec(sqlOfMigration());
    const afterRow = await one("select to_jsonb(r) j from public.report_sec016 r where id = $1", [legacy.id]);
    const preserved = Object.keys(beforeRow.j).every((k) => JSON.stringify(afterRow.j[k]) === JSON.stringify(beforeRow.j[k]));
    assert(preserved, 'EXISTING ROW PRESERVED: every pre-migration column value of an existing SEC016 row is unchanged by the migration');
    assert(afterRow.j.flight_type === 'arrival' && afterRow.j.aircraft_search_completed === false && afterRow.j.search_overdue_flag === false && afterRow.j.ramp_agents_baggage === null && afterRow.j.cabin_check === null && afterRow.j.ops_group === null, 'the existing row takes only the column defaults (flight_type arrival, flags false, new text columns null)');
    await db.exec('ROLLBACK;');
  }
  function sqlOfMigration() { return fs.readFileSync(path.join(__dirname, '..', '..', 'migrations', runner.MIGRATION.version + '_' + runner.MIGRATION.name + '.sql'), 'utf8'); }
  assert(JSON.stringify(await state()) === JSON.stringify(before), 'the existing-row experiment changed nothing (rolled back)');

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

  // ---- after the live pass (disposable copy): the application's statements all succeed, and nothing else moved
  {
    const cols016 = await rows("select column_name, data_type, is_nullable, coalesce(column_default,'') d from information_schema.columns where table_schema='public' and table_name='report_sec016';");
    const by = Object.fromEntries(cols016.map((c) => [c.column_name, c]));
    assert(Object.entries(F.SEC016_NEW_COLUMNS).every(([c, d]) => by[c] && by[c].data_type === d.data_type && by[c].is_nullable === d.nullable && (d.default ? d.default.test(by[c].d) : by[c].d === '')), 'all eight new report_sec016 columns match their canonical definitions (type, nullability, default)');
    assert(F.SEC016_LEGACY_NULLABLE.every((c) => by[c].is_nullable === 'YES'), 'all sixteen legacy report_sec016 columns are nullable after the migration');
    assert(cols016.filter((c) => c.is_nullable === 'NO' && !F.SEC016_LEGACY_NULLABLE.includes(c.column_name)).length > 10 && by.flight.is_nullable === 'NO' && by.station.is_nullable === 'NO' && by.profile_id.is_nullable === 'NO', 'the columns that must stay required (station, flight, profile_id ...) are still NOT NULL');
    assert(!('org_id' in by), 'no org_id was added to report_sec016');
  }
  const asW = async (label, fn) => {
    await db.exec('BEGIN;');
    try { await db.exec("select set_config('request.jwt.claims', '" + JSON.stringify({ sub: acct(label), role: 'authenticated' }) + "', true), set_config('role', 'authenticated', true)"); return await fn(); } finally { await db.exec('RESET role;').catch(() => {}); await db.exec('ROLLBACK;').catch(() => {}); }
  };
  const writerPayload = (flightType, over = {}) => F.sec016AppPayload({ ...wctx, reg: over.reg ?? '9M-GRN', flightType, withLegacyValues: !!over.withLegacyValues });
  for (const flightType of ['arrival', 'departure']) {
    const out = await asW('aso', async () => {
      const pl = writerPayload(flightType);
      const ins = F.insertSql('report_sec016', pl);
      const id = (await db.query(ins.text + ' returning id, submitted_at, report_no', ins.values)).rows[0].id; // only the columns the application returns are SELECT-granted
      await db.exec('reset role;');
      return (await db.query('select ramp_agents_baggage, ramp_agents_cargo, cabin_check, ops_group, flight_type, inbound_baggage, outbound_baggage, ramp_staff_1, ramp_staff_5, offload_flight_no, offload_destination, offload_total_baggage from public.report_sec016 where id = $1', [id])).rows[0];
    });
    assert(out.ramp_agents_baggage === 'RAMP-B1' && out.ramp_agents_cargo === 'RAMP-C1' && out.cabin_check === 'YES' && out.ops_group === null && out.flight_type === flightType, 'the canonical rev03 ' + flightType + ' submission succeeds and stores the three rev03 direction fields');
    assert(out.ramp_staff_1 === null && out.ramp_staff_5 === null && out.offload_flight_no === null && out.offload_destination === null && out.offload_total_baggage === null && (flightType === 'arrival' ? out.outbound_baggage === null && out.inbound_baggage === 'TRL-1' : out.inbound_baggage === null && out.outbound_baggage === 'TRL-2'), 'omitted legacy fields stay null and only the filed direction\'s fields are populated (' + flightType + ')');
  }
  const withLegacy = await asW('aso', async () => { const ins = F.insertSql('report_sec016', writerPayload('arrival', { withLegacyValues: true, reg: '9M-LEG2' })); const id = (await db.query(ins.text + ' returning id', ins.values)).rows[0].id; await db.exec('reset role;'); return (await db.query('select ramp_staff_1, offload_flight_no, offload_total_baggage from public.report_sec016 where id = $1', [id])).rows[0]; });
  assert(withLegacy.ramp_staff_1 === 'RS1' && withLegacy.offload_flight_no === 'AK1' && withLegacy.offload_total_baggage === '3', 'explicit values in the relaxed legacy columns are still accepted and stored');
  // RLS / station isolation of the new write path
  const isolation = await asW('aso', async () => {
    const pl = writerPayload('arrival', { reg: '9M-ISO' });
    const ins = F.insertSql('report_sec016', pl); const id = (await db.query(ins.text + ' returning id', ins.values)).rows[0].id;
    const b = F.insertSql('bay_board', { station: wctx.station, reg_no: '9M-ISO', aircraft_type: 'A320', bay: 'B1', flight: 'AK703', arrival_report_id: id, on_ground_since: new Date().toISOString(), is_manual: false, created_by: wctx.profileId });
    await db.query(b.text, b.values);
    await db.exec('SAVEPOINT s1;');
    // another station's officer, same transaction (claims switched), must not see, insert for, or clear this station's row
    await db.exec("select set_config('request.jwt.claims', '" + JSON.stringify({ sub: acct('aso-other'), role: 'authenticated' }) + "', true)");
    const seen = (await db.query("select count(*)::int n from public.bay_board where reg_no = '9M-ISO'")).rows[0].n;
    const clear = (await db.query("update public.bay_board set cleared_at = now() where reg_no = '9M-ISO'")).rowCount ?? 0;
    const insOther = await tryRun(F.insertSql('bay_board', { station: wctx.station, reg_no: '9M-ISO2', aircraft_type: 'A320', bay: 'B1', flight: 'X', on_ground_since: new Date().toISOString(), is_manual: true, created_by: acct('aso-other') }));
    const secSeen = (await db.query('select count(*)::int n from public.report_sec016 where id = $1', [id])).rows[0].n;
    return seen + '|' + clear + '|' + (/^42501:/.test(insOther) ? 'denied' : insOther) + '|' + secSeen;
  });
  assert(isolation === '0|0|denied|0', 'station / entity isolation holds on the new write path: another station\'s officer sees 0 Bay Board rows, clears 0, cannot insert for this station, and cannot read the SEC016 row (' + isolation + ')');
  // idempotency: running the migration again changes nothing and raises nothing
  const stateBeforeRerun = JSON.stringify((await rows("select table_name, column_name, is_nullable from information_schema.columns where table_schema='public' and table_name in ('report_sec016','bay_board') order by 1,2;")));
  await db.exec('BEGIN;');
  let rerun = 'OK';
  try { await db.exec(sqlOfMigration()); } catch (e) { rerun = String(e.message).slice(0, 100); }
  const stateAfterRerun = JSON.stringify((await rows("select table_name, column_name, is_nullable from information_schema.columns where table_schema='public' and table_name in ('report_sec016','bay_board') order by 1,2;")));
  await db.exec('ROLLBACK;');
  assert(rerun === 'OK' && stateAfterRerun === stateBeforeRerun, 'the revised migration is idempotent: re-applying it raises nothing and changes nothing');

  // ---- a second run is refused (columns already exist / already recorded)
  let again = null;
  try { await runner.execute(db, { ...base, preCount: after.hist, lastPre: runner.MIGRATION.version, live: false }); } catch (e) { again = e.message; }
  assert(again !== null && /already (has|recorded)/.test(again), `re-running after the apply is refused (${again})`);

  await db.close();
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
