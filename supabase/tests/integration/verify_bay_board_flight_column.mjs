// Bay Board / SEC016 reconciliation (20261117000001). The approved staging project never received 20260911000005, so public.bay_board has no
// flight / is_manual / arrival_report_id / departure_report_id, report_sec016 has no flight_type / aircraft_search_completed / search_overdue_flag /
// search_remark, and the legacy bay_board_cleared_by_report_id_fkey (-> report_sec029) is still present. Reproduces that state, proves every
// reachable read and write defect, applies the migration exactly as written, then proves the repair. Dual-mode (PGlite / native PostgreSQL).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { assertDisposableLocalTarget } from './safeguards.mjs';

const { Client } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_DATA_DIR = path.join(__dirname, 'pgdata');
const RUN_DATA_DIR = path.join(__dirname, 'pgdata_baybay_run');
const MIGRATION_FILE = '20261117000001_bay_board_sec016_reconciliation.sql';
let failures = 0;
let passes = 0;
const assert = (c, m) => { if (!c) { failures += 1; console.log('FAIL:', m); } else { passes += 1; console.log('PASS:', m); } };

async function main() {
  const isNative = process.argv.includes('--native') || process.env.PG_NATIVE === '1';
  const pgConfig = { host: process.env.PGHOST || '127.0.0.1', port: parseInt(process.env.PGPORT || '55433', 10), user: process.env.PGUSER || 'postgres', password: process.env.PGPASSWORD || undefined };
  const goldenDb = process.env.PGDATABASE || 'vecta_phase6_test';
  const runDb = 'vecta_baybay_run';
  let db;
  if (isNative) {
    assertDisposableLocalTarget(pgConfig, goldenDb, runDb);
    console.log('=== Bay Board / SEC016 reconciliation against native PostgreSQL ===');
    const admin = new Client({ ...pgConfig, database: 'postgres' });
    await admin.connect();
    await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${runDb}' and pid <> pg_backend_pid();`);
    await admin.query(`drop database if exists ${runDb};`);
    await admin.query(`create database ${runDb} template ${goldenDb};`);
    const client = new Client({ ...pgConfig, database: runDb });
    await client.connect();
    db = { exec: (s) => client.query(s), query: (s, p) => client.query(s, p), close: async () => { await client.end(); await admin.query(`drop database if exists ${runDb};`); await admin.end(); } };
  } else {
    console.log('=== Bay Board / SEC016 reconciliation against PGlite ===');
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
    catch (e) { await db.exec(`rollback to savepoint ${name}; release savepoint ${name};`); return { ok: false, err: e.message, code: e.code }; }
    finally { await sup(); }
  }
  const asUser = (u) => () => db.query('select pg_temp.sim_user($1)', [u]);
  const asAnon = () => db.exec('select pg_temp.sim_anon();');
  const asOwner = () => db.exec('reset role;');

  let seq = 0x9c00;
  const nextId = () => `00000000-0000-0000-0000-${(++seq).toString(16).padStart(12, '0')}`;
  const myAoc = (await one("select id from public.aocs where code = 'MY';")).id;
  const opsDept = (await one("select id from public.departments where aoc_id = $1 and code = 'operation';", [myAoc])).id;
  const enfDept = (await one("select id from public.departments where aoc_id = $1 and code = 'enforcement';", [myAoc])).id;
  const maa = (await one("select id from public.operating_entities where aoc_id = $1 and code = 'MAA';", [myAoc])).id;
  const aax = (await one("select id from public.operating_entities where aoc_id = $1 and code = 'AAX';", [myAoc])).id;
  const roleMap = new Map((await rows('select id, code from public.role_definitions;')).map((r) => [r.code, r.id]));
  const kul = await one("select id, hub_id from public.org_stations where code = 'KUL - MAA';");
  const hubCode = (await one('select code from public.hubs where id = $1;', [kul.hub_id])).code;
  await db.query("insert into public.org_teams (station_id, name) values ($1, 'ALPHA') on conflict (station_id, name) do nothing;", [kul.id]);
  const team = (await one("select id from public.org_teams where station_id = $1 and name = 'ALPHA';", [kul.id])).id;
  const DAY = 86400000;
  const iso = (ms) => new Date(Date.now() + ms).toISOString();

  async function profile(label, status = 'approved') {
    const id = nextId();
    await db.query('insert into auth.users (id, email) values ($1,$2);', [id, `bb-${label}@example.test`]);
    await db.query("insert into public.profiles (id, email, name, staff_no, role, status, station, team) values ($1,$2,$3,$4,'ASO',$5,'KUL - MAA','ALPHA') on conflict (id) do update set status = excluded.status;", [id, `bb-${label}@example.test`, `BB ${label}`, `BB-${label}`.slice(0, 20), status]);
    return id;
  }
  const assign = (id, role, { aocId = null, dept = null, entity = null, starts = iso(-DAY), ends = null, revoked = null } = {}) =>
    db.query('insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, operating_entity_id, starts_at, ends_at, revoked_at) values ($1,$2,$3,$4,$5,$6,$7,$8);', [id, roleMap.get(role), aocId, dept, entity, starts, ends, revoked]);
  async function leader(label, role, opts = {}) {
    const { status, ...rest } = opts;
    const id = await profile(label, status);
    const entityRole = ['maa_boss', 'maa_admin', 'aax_boss', 'aax_admin'].includes(role);
    await assign(id, role, { aocId: myAoc, dept: entityRole ? null : (role === 'main_enforcement' ? enfDept : opsDept), entity: entityRole ? (role.startsWith('maa') ? maa : aax) : null, ...rest });
    return id;
  }
  async function aso(label) {
    const id = await profile(label);
    const m = (await one("insert into public.user_entity_memberships (profile_id, aoc_id, operating_entity_id, status, is_primary) values ($1,$2,$3,'active',true) returning id;", [id, myAoc, maa])).id;
    await db.query('insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, hub_id, station_id, team_id, entity_membership_id, starts_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9);', [id, roleMap.get('aso'), myAoc, opsDept, kul.hub_id, kul.id, team, m, iso(-DAY)]);
    return id;
  }

  const authorized = [
    ['operation_manager', await leader('opm', 'operation_manager')],
    ['main_enforcement', await leader('enf', 'main_enforcement')],
    ['maa_boss', await leader('maaboss', 'maa_boss')],
    ['maa_admin', await leader('maaadmin', 'maa_admin')],
    ['aax_boss', await leader('aaxboss', 'aax_boss')],
    ['aax_admin', await leader('aaxadmin', 'aax_admin')],
  ];
  const opm = authorized[0][1];
  const stationAso = await aso('aso');
  const ghod = await profile('ghod'); await assign(ghod, 'ghod');
  const grc = await profile('grc'); await assign(grc, 'global_reporting_controller');
  const intl = await profile('intl'); await assign(intl, 'airasia_management');
  const noRole = await profile('norole'); // also the shape of a CaterLink-only external identity: no role assignment at all
  const pendingOpm = await leader('pendingopm', 'operation_manager', { status: 'pending' });
  const expiredOpm = await leader('expiredopm', 'operation_manager', { starts: iso(-5 * DAY), ends: iso(-DAY) });
  const revokedOpm = await leader('revokedopm', 'operation_manager', { revoked: iso(-1000) });
  const futureOpm = await leader('futureopm', 'operation_manager', { starts: iso(DAY) });

  // ---- a second AOC whose station must never be visible to the MY leaders
  const zzAoc = (await one("insert into public.aocs (code, name, is_active) values ('ZZ', 'Synthetic Test AOC', true) returning id;")).id;
  const zzHub = (await one("insert into public.hubs (aoc_id, code, name) values ($1, 'zzhub', 'ZZ Hub') returning id;", [zzAoc])).id;
  await db.query("insert into public.org_stations (hub_id, code, name) values ($1, 'ZZS', 'ZZ Station');", [zzHub]);
  await db.query("insert into public.stations (code, label) values ('ZZS', 'ZZS') on conflict do nothing;");

  // ---- reproduce the historical staging state
  await asOwner();
  await db.exec(`alter table public.bay_board drop column if exists flight, drop column if exists is_manual, drop column if exists arrival_report_id, drop column if exists departure_report_id;
    alter table public.report_sec016 drop column if exists flight_type, drop column if exists aircraft_search_completed, drop column if exists search_overdue_flag, drop column if exists search_remark;
    alter table public.bay_board drop constraint if exists bay_board_cleared_by_report_id_fkey;
    alter table public.bay_board add constraint bay_board_cleared_by_report_id_fkey foreign key (cleared_by_report_id) references public.report_sec029 (id);`);
  const preRow = nextId(); const preRow2 = nextId(); const zzRow = nextId();
  await db.query("insert into public.bay_board (id, station, reg_no, aircraft_type, bay, on_ground_since, created_by) values ($1,'KUL - MAA','9M-BBA','A320','B7', now() - interval '2 hours', $2), ($3,'KUL - MAA','9M-BBC','A321','B9', now() - interval '6 hours', $2), ($4,'ZZS','9M-ZZZ','A320','Z1', now() - interval '1 hour', $2);", [preRow, opm, preRow2, zzRow]);
  await db.query('update public.bay_board set cleared_at = now() where id = $1;', [preRow2]);
  await sup();
  const cols = async (t) => (await rows("select column_name from information_schema.columns where table_schema='public' and table_name=$1;", [t])).map((r) => r.column_name);
  assert(!(await cols('bay_board')).some((c) => ['flight', 'is_manual', 'arrival_report_id', 'departure_report_id'].includes(c)), 'fixture: bay_board has none of the four missing columns (staging state)');
  assert(!(await cols('report_sec016')).some((c) => ['flight_type', 'aircraft_search_completed', 'search_overdue_flag', 'search_remark'].includes(c)), 'fixture: report_sec016 has none of the four missing columns (staging state)');

  const sec016Insert = (id, who, type) => db.query(`insert into public.report_sec016 (id, profile_id, status, station, team, staff_name, staff_no, duty_date, duty_hour, flight, origin_arr_dep, assisted_by, aircraft_type, reg_no, sta_std, ata_atd, bay_no, do_infmd, shift_leader, cargo_hold_checked, staff_frisked, discrepancies, flight_type, aircraft_search_completed, search_overdue_flag, search_remark)
    values ($1,$2,'submitted','KUL - MAA','ALPHA','BB','S1',current_date,'10:00','AK703','ARR','x','A320','9M-BBN','10:00','10:05','B1','NO','sl','YES','YES','none',$3,false,false,null);`, [id, who, type]);
  const sec016InsertLegacy = (id, who) => db.query(`insert into public.report_sec016 (id, profile_id, status, station, team, staff_name, staff_no, duty_date, duty_hour, flight, origin_arr_dep, assisted_by, aircraft_type, reg_no, sta_std, ata_atd, bay_no, do_infmd, shift_leader, cargo_hold_checked, staff_frisked, discrepancies)
    values ($1,$2,'submitted','KUL - MAA','ALPHA','BB','S1',current_date,'10:00','AK703','ARR','x','A320','9M-BBN','10:00','10:05','B1','NO','sl','YES','YES','none');`, [id, who]);
  const bayArrival = (reportId, who) => db.query("insert into public.bay_board (station, reg_no, aircraft_type, bay, flight, arrival_report_id, on_ground_since, is_manual, created_by) values ('KUL - MAA','9M-BBN','A320','B1','AK703',$1, now(), false, $2);", [reportId, who]);

  // ---- reachable defects BEFORE the migration (each is a user-facing failure on staging today)
  const pre = {
    rpc: await attempt(asUser(opm), () => rows('select * from public.get_bay_board_secure(null, null);')),
    sec016: await attempt(asUser(stationAso), () => sec016Insert(nextId(), stationAso, 'arrival')),
    arrival: await attempt(asUser(stationAso), () => bayArrival(null, stationAso)),
  };
  assert(!pre.rpc.ok && pre.rpc.code === '42703', `before: leadership Bay Board RPC fails 42703 (${pre.rpc.err})`);
  assert(!pre.sec016.ok && pre.sec016.code === '42703', `before: SEC016 submit (flight_type et al.) fails 42703 (${pre.sec016.err})`);
  assert(!pre.arrival.ok && pre.arrival.code === '42703', `before: SEC016 arrival Bay Board insert (flight / arrival_report_id / is_manual) fails 42703 (${pre.arrival.err})`);
  const legacyReport = nextId();
  await asOwner(); await sec016InsertLegacy(legacyReport, stationAso); await sup();
  const fk = await attempt(asOwner, () => db.query('update public.bay_board set cleared_at = now(), cleared_by_report_id = $1 where id = $2;', [legacyReport, preRow]));
  assert(!fk.ok && fk.code === '23503', `before: clearing a bay row with a SEC016 id violates the legacy report_sec029 FK (${fk.err})`);

  // ---- apply the forward migration exactly as written
  const MIGRATION = fs.readFileSync(path.join(__dirname, '..', '..', 'migrations', MIGRATION_FILE), 'utf8');
  await asOwner();
  await db.exec(MIGRATION);
  await sup();

  // ---- preservation
  const kept = await rows('select id, reg_no, bay, cleared_at, flight, is_manual, arrival_report_id, departure_report_id from public.bay_board where id in ($1,$2,$3) order by reg_no;', [preRow, preRow2, zzRow]);
  assert(kept.length === 3 && kept.every((r) => r.flight === null && r.is_manual === false && r.arrival_report_id === null && r.departure_report_id === null), 'existing rows preserved; new columns null / false');
  assert(kept.find((r) => r.reg_no === '9M-BBC').cleared_at !== null && kept.find((r) => r.reg_no === '9M-BBA').cleared_at === null, 'existing cleared / open state preserved');
  const legacyRow = await one('select flight_type, aircraft_search_completed, search_overdue_flag, search_remark from public.report_sec016 where id = $1;', [legacyReport]);
  assert(legacyRow.flight_type === 'arrival' && legacyRow.aircraft_search_completed === false && legacyRow.search_overdue_flag === false && legacyRow.search_remark === null, 'existing report_sec016 rows take the canonical defaults');

  // ---- read path: every authorized persona, every filter
  for (const [lbl, u] of authorized) {
    const r = await attempt(asUser(u), () => rows('select * from public.get_bay_board_secure(null, null);'));
    assert(r.ok && r.r.length === 1 && r.r[0].reg_no === '9M-BBA' && r.r[0].flight === null && Object.keys(r.r[0]).join() === 'id,station,reg_no,aircraft_type,bay,flight,on_ground_since', `${lbl}: reads exactly its AOC's open row with the unchanged column list`);
  }
  const f1 = await attempt(asUser(opm), () => rows('select * from public.get_bay_board_secure($1, $2);', [hubCode, 'KUL - MAA']));
  assert(f1.ok && f1.r.length === 1, 'hub + station filter resolves the row');
  assert((await attempt(asUser(opm), () => rows("select * from public.get_bay_board_secure(null, 'PEN');"))).r.length === 0, 'another station: empty result');
  assert((await attempt(asUser(opm), () => rows("select * from public.get_bay_board_secure('nohub', null);"))).r.length === 0, 'unknown hub: empty result');
  assert((await attempt(asUser(opm), () => rows("select * from public.get_bay_board_secure(null, 'ZZS');"))).r.length === 0, 'a station in ANOTHER AOC is not visible even when named explicitly');
  const inj = await attempt(asUser(opm), () => rows('select * from public.get_bay_board_secure($1, $2);', ["x' or '1'='1", "KUL - MAA'; drop table public.bay_board; --"]));
  assert(inj.ok && inj.r.length === 0 && (await one("select to_regclass('public.bay_board') is not null t;")).t === true, 'SQL-injection-like filter text matches nothing and harms nothing');
  assert((await attempt(asUser(opm), () => rows('select * from public.list_bay_board_scopes_secure();'))).r.length > 0, 'list_bay_board_scopes_secure still works');

  // ---- reachable WRITE workflows, as the real station user under RLS
  const arrReport = nextId();
  assert((await attempt(asUser(stationAso), () => sec016Insert(arrReport, stationAso, 'arrival'))).ok, 'SEC016 arrival submit succeeds');
  assert((await attempt(asUser(stationAso), () => bayArrival(arrReport, stationAso))).ok, 'SEC016 arrival Bay Board insert (flight, arrival_report_id, is_manual) succeeds under RLS');
  const flightRead = await attempt(asUser(opm), () => rows("select flight, bay from public.get_bay_board_secure(null, 'KUL - MAA') where flight ilike '%ak70%';"));
  assert(flightRead.ok && flightRead.r.length === 1 && flightRead.r[0].flight === 'AK703', 'flight value round-trips and is searchable through the leadership RPC');
  const depReport = nextId();
  assert((await attempt(asUser(stationAso), () => sec016Insert(depReport, stationAso, 'departure'))).ok, 'SEC016 departure submit succeeds');
  const dep = await attempt(asUser(stationAso), () => db.query("update public.bay_board set cleared_at = now(), cleared_by_report_id = $1, departure_report_id = $1 where station = 'KUL - MAA' and reg_no = '9M-BBN' and cleared_at is null;", [depReport]));
  assert(dep.ok, 'SEC016 departure clears the open row (cleared_by_report_id = a SEC016 id, departure_report_id)');
  assert((await attempt(asUser(opm), () => rows("select * from public.get_bay_board_secure(null, 'KUL - MAA') where reg_no = '9M-BBN';"))).r.length === 0, 'the cleared aircraft leaves the Bay Board');
  const manual = await attempt(asUser(stationAso), () => db.query("insert into public.bay_board (station, reg_no, aircraft_type, bay, flight, on_ground_since, is_manual, created_by) values ('KUL - MAA','9M-BBM','A320','B2','AK1', now(), true, $1);", [stationAso]));
  assert(manual.ok, 'manual Bay Board entry (flight, is_manual) succeeds');
  assert((await attempt(asUser(stationAso), () => db.query("update public.bay_board set cleared_at = now() where reg_no = '9M-BBM' and cleared_at is null;"))).ok, 'manual clear (existing columns) succeeds');
  const rls = await attempt(asUser(stationAso), () => db.query("insert into public.bay_board (station, reg_no, bay, on_ground_since, created_by) values ('ZZS','9M-ZZX','Z2', now(), $1);", [stationAso]));
  assert(!rls.ok, 'RLS unchanged: a KUL station user cannot write a bay row for another AOC station');
  const anonWrite = await attempt(asAnon, () => db.query("insert into public.bay_board (station, reg_no, bay, on_ground_since, created_by) values ('KUL - MAA','9M-ANN','B1', now(), $1);", [stationAso]));
  assert(!anonWrite.ok, 'anon cannot write bay_board');

  // ---- denied personas
  for (const [lbl, u] of [['ASO', stationAso], ['GHOD', ghod], ['GRC', grc], ['international management', intl], ['no-role / CaterLink-only identity', noRole], ['pending operation manager', pendingOpm], ['expired operation manager', expiredOpm], ['revoked operation manager', revokedOpm], ['future-dated operation manager', futureOpm]]) {
    assert(!(await attempt(asUser(u), () => rows('select * from public.get_bay_board_secure(null, null);'))).ok, `${lbl}: Bay Board RPC refused`);
  }
  assert(!(await attempt(asAnon, () => rows('select * from public.get_bay_board_secure(null, null);'))).ok, 'anon: Bay Board RPC refused (execute revoked)');

  // ---- function hardening, ownership and ACL
  const fn = await one("select p.prosecdef, p.provolatile, p.proconfig, p.proowner = c.relowner same_owner, coalesce(p.proacl::text, '') acl from pg_proc p join pg_namespace n on n.oid = p.pronamespace, pg_class c where n.nspname = 'public' and p.proname = 'get_bay_board_secure' and c.oid = 'public.bay_board'::regclass;");
  assert(fn.prosecdef === true && fn.provolatile === 's' && (fn.proconfig || []).includes('search_path=public') && fn.same_owner === true, 'SECURITY DEFINER, STABLE, search_path fixed to public, owned by the table owner');
  const acl = await one("select has_function_privilege('anon','public.get_bay_board_secure(text,text)','execute') a, has_function_privilege('authenticated','public.get_bay_board_secure(text,text)','execute') u, has_function_privilege('service_role','public.get_bay_board_secure(text,text)','execute') s;");
  assert(acl.a === false && acl.u === true && acl.s === true && !/(^\{|,)=/.test(fn.acl), 'execute: anon and PUBLIC denied, authenticated + service_role granted');
  const pol = (await rows("select policyname, cmd from pg_policies where schemaname='public' and tablename='bay_board' order by policyname;")).map((r) => `${r.policyname}:${r.cmd}`).join();
  assert(pol === 'bay_board_scoped_insert:INSERT,bay_board_scoped_select:SELECT,bay_board_scoped_update:UPDATE', 'bay_board RLS policies unchanged (no new or widened policy)');
  assert((await rows("select 1 from information_schema.role_table_grants where table_schema='public' and table_name in ('bay_board','report_sec016') and grantee in ('anon','PUBLIC');")).length === 0, 'no anon / PUBLIC table grant on bay_board or report_sec016');

  // ---- schema shape equals the canonical chain
  const shape = await rows("select table_name, column_name, is_nullable, column_default from information_schema.columns where table_schema='public' and ((table_name='bay_board' and column_name in ('flight','is_manual','arrival_report_id','departure_report_id')) or (table_name='report_sec016' and column_name in ('flight_type','aircraft_search_completed','search_overdue_flag','search_remark'))) order by table_name, column_name;");
  const col = (n) => shape.find((c) => c.column_name === n);
  assert(shape.length === 8 && col('is_manual').is_nullable === 'NO' && /false/.test(col('is_manual').column_default) && col('flight_type').is_nullable === 'NO' && /arrival/.test(col('flight_type').column_default), 'new columns match the canonical definitions (types, NOT NULL, defaults)');
  assert((await one("select count(*)::int n from pg_constraint where conname = 'bay_board_cleared_by_report_id_fkey' and conrelid = 'public.bay_board'::regclass;")).n === 0, 'legacy report_sec029-only FK removed');
  assert((await one("select count(*)::int n from pg_constraint where conrelid='public.report_sec016'::regclass and contype='c' and pg_get_constraintdef(oid) ilike '%flight_type%';")).n === 1, 'flight_type CHECK present exactly once');
  assert((await one("select count(*)::int n from pg_indexes where schemaname='public' and indexname in ('idx_report_sec016_flight_type','idx_report_sec016_station_reg','idx_bay_board_match','idx_bay_board_arrival_report');")).n === 4, 'canonical indexes present');
  const bad = await attempt(asOwner, () => sec016Insert(nextId(), stationAso, 'sideways'));
  assert(!bad.ok && bad.code === '23514', 'flight_type CHECK rejects an invalid value');

  // ---- idempotent
  for (let i = 0; i < 2; i += 1) {
    const again = await attempt(asOwner, () => db.exec(MIGRATION));
    assert(again.ok, `re-applying the migration is a no-op (run ${i + 1})`);
  }
  assert((await attempt(asUser(opm), () => rows('select * from public.get_bay_board_secure(null, null);'))).ok, 'RPC still works after repeated application');

  await db.exec('rollback;');
  await db.close();
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
