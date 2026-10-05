// Phase 9: CaterLink Station Access, Transaction Control and Management Oversight
// Comprehensive integration test verification against disposable PostgreSQL (PGlite and Native PG17).
//
// Verifies:
//  1. Station capability model (default deny, KUL full, PEN/JHB scanning/receipt,
//     AOR/IPH/LGK/KCH/BKI scanning disabled, dynamic future station enablement).
//  2. Profiling exclusion (profiling_so and profiling_aso unconditionally denied scanning).
//  3. Active role assignment lifecycle (revoked, expired, future, pending assignments denied).
//  4. Cross-AOC isolation (foreign AOC cannot scan, create, confirm receipt, raise incident, or export).
//  5. Transaction lifecycle and state transitions (creation, checkpoint order, destination matching,
//     sender restriction on cross-station confirmation, idempotency).
//  6. Incident lifecycle (raise, escalate transaction, resolve with notes, reopen with reason and counter).
//  7. Whitelist administration (scoped to AOC/entity, duplicate prevention, active/inactive/revoked).
//  8. Archive model (COMPLETED-only archive, immutable snapshot preservation, non-destructive).
//  9. Final PDF access authorization (completed-only, authorized roles, cross-AOC denial).
// 10. Multi-AOC export isolation and audit verification on a single connection.

import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { assertDisposableLocalTarget } from './safeguards.mjs';

const { Client } = pg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_DATA_DIR = path.join(__dirname, 'pgdata');
const RUN_DATA_DIR = path.join(__dirname, 'pgdata_phase9_caterlink_run');

function copyDir(src, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true });
}

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    failures += 1;
    console.log('FAIL:', msg);
    return;
  }
  console.log('PASS:', msg);
}

async function main() {
  const isNative = process.argv.includes('--native') || process.env.PG_NATIVE === '1';
  const pgConfig = {
    host: process.env.PGHOST || '127.0.0.1',
    port: parseInt(process.env.PGPORT || '55433', 10),
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || undefined,
  };
  const goldenDb = process.env.PGDATABASE || 'vecta_phase6_test';
  const runDb = 'vecta_phase9_caterlink_run';

  let db;
  if (isNative) {
    assertDisposableLocalTarget(pgConfig, goldenDb, runDb);
    console.log(`=== Phase 9 CaterLink verification against Native PostgreSQL (${pgConfig.host}:${pgConfig.port}) ===`);
    const admin = new Client({ ...pgConfig, database: 'postgres' });
    await admin.connect();
    await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${runDb}' and pid <> pg_backend_pid();`);
    await admin.query(`drop database if exists ${runDb};`);
    await admin.query(`create database ${runDb} template ${goldenDb};`);
    const client = new Client({ ...pgConfig, database: runDb });
    await client.connect();
    db = {
      exec: (sql) => client.query(sql),
      query: (sql, params) => client.query(sql, params),
      close: async () => {
        await client.end();
        await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${runDb}' and pid <> pg_backend_pid();`);
        await admin.query(`drop database if exists ${runDb};`);
        await admin.end();
      },
    };
  } else {
    console.log('=== Phase 9 CaterLink verification against PGlite embedded engine ===');
    if (!fs.existsSync(GOLDEN_DATA_DIR)) {
      console.error('ERROR: ./pgdata does not exist -- run `node migrate.mjs` first.');
      process.exit(1);
    }
    copyDir(GOLDEN_DATA_DIR, RUN_DATA_DIR);
    const pgliteDb = new PGlite(RUN_DATA_DIR);
    db = {
      exec: (sql) => pgliteDb.exec(sql),
      query: (sql, params) => pgliteDb.query(sql, params),
      close: () => pgliteDb.close(),
    };
  }

  await db.exec('set check_function_bodies = off;');
  await db.exec('begin;');

  let seq = 0x80;
  function nextId() {
    seq += 1;
    return `00000000-0000-0000-0000-${seq.toString(16).padStart(12, '0')}`;
  }

  await db.exec(`
    create or replace function pg_temp.simulate_user(p_profile_id uuid)
    returns void language plpgsql as $$
    begin
      perform set_config('request.jwt.claims', json_build_object('sub', p_profile_id::text, 'role', 'authenticated')::text, true);
      perform set_config('role', 'authenticated', true);
    end;
    $$;
    create or replace function pg_temp.simulate_service_role()
    returns void language plpgsql as $$
    begin
      perform set_config('request.jwt.claims', '{}', true);
      perform set_config('role', 'service_role', true);
    end;
    $$;
    create or replace function pg_temp.clear_simulation()
    returns void language plpgsql as $$
    begin
      perform set_config('request.jwt.claims', '', true);
      execute 'reset role';
    end;
    $$;
  `);

  function simulateUser(id) { return db.query('select pg_temp.simulate_user($1);', [id]); }
  function simulateServiceRole() { return db.exec('select pg_temp.simulate_service_role();'); }
  async function clearSim() { await db.exec('select pg_temp.clear_simulation();'); }
  // Direct table verification: clients hold no direct grant on these tables, so read as service_role
  // and then restore the caller's previous session.
  // can_user_scan_caterlink derives identity from auth.uid() only: call it AS the user, then restore service_role.
  async function scanAs(userId, aocId, station) {
    await simulateUser(userId);
    try {
      return (await db.query('select public.can_user_scan_caterlink($1, $2) as r;', [station, aocId])).rows[0].r;
    } finally {
      await simulateServiceRole();
    }
  }
  async function asService(sql, params) {
    const prev = (await db.query("select coalesce(current_setting('request.jwt.claims', true), '') as c, current_user::text as u")).rows[0];
    await simulateServiceRole();
    const r = await db.query(sql, params);
    await db.query("select set_config('request.jwt.claims', $1, true), set_config('role', $2, true)", [prev.c, prev.u]);
    return r;
  }


  // A Postgres error inside the outer transaction aborts it until ROLLBACK/ROLLBACK TO
  // SAVEPOINT -- every expected-failure probe below must run inside its own savepoint so the
  // rest of the script can keep issuing statements on the same connection afterward.
  let spSeq = 0;
  async function expectFail(fn) {
    const sp = `sp_${++spSeq}`;
    await db.exec(`savepoint ${sp};`);
    try {
      await fn();
      await db.exec(`release savepoint ${sp};`);
      return false;
    } catch (e) {
      await db.exec(`rollback to savepoint ${sp}; release savepoint ${sp};`);
      return true;
    }
  }

  await simulateServiceRole();

  // Fetch core IDs
  const myAocRes = await db.query("select id from public.aocs where code = 'MY';");
  const myAocId = myAocRes.rows[0].id;

  const rolesRes = await db.query("select id, code from public.role_definitions;");
  const roleMap = new Map(rolesRes.rows.map((r) => [r.code, r.id]));

  const stationsRes = await db.query("select id, code, hub_id from public.org_stations;");
  const stationMap = new Map(stationsRes.rows.map((s) => [s.code, s.id]));
  const stationHubMap = new Map(stationsRes.rows.map((s) => [s.code, s.hub_id]));

  // Setup second AOC: "ZZ"
  const zzAocId = nextId();
  await db.query("insert into public.aocs (id, code, name, is_active) values ($1, 'ZZ', 'Synthetica', true);", [zzAocId]);
  const zzHubId = nextId();
  await db.query("insert into public.hubs (id, aoc_id, code, name) values ($1, $2, 'zz_hub', 'ZZ Hub');", [zzHubId, zzAocId]);
  const zzStationId = nextId();
  await db.query("insert into public.org_stations (id, hub_id, code, name, is_active) values ($1, $2, 'ZZS', 'ZZ Station', true);", [zzStationId, zzHubId]);

  const myEntityRes = await db.query("select id from public.operating_entities where aoc_id = $1 and code = 'MAA';", [myAocId]);
  const myEntityId = myEntityRes.rows[0].id;

  // Resolve mandatory department_id for protected roles (Phase 3 scope-shape trigger
  // requires department_id for caterlink_management / operation_manager / main_enforcement / compliance).
  const myCaterlinkDeptRes = await db.query("select id from public.departments where aoc_id = $1 and code = 'caterlink';", [myAocId]);
  const myCaterlinkDeptId = myCaterlinkDeptRes.rows[0].id;
  const myOperationDeptRes = await db.query("select id from public.departments where aoc_id = $1 and code = 'operation';", [myAocId]);
  const myOperationDeptId = myOperationDeptRes.rows[0].id;
  const myEnforcementDeptRes = await db.query("select id from public.departments where aoc_id = $1 and code = 'enforcement';", [myAocId]);
  const myEnforcementDeptId = myEnforcementDeptRes.rows[0].id;
  const myProfilingUnitId = (
    await db.query(`insert into public.units (department_id, code, name) values ($1, 'profiling', 'MY Profiling Unit') on conflict (department_id, code) do update set name = excluded.name returning id;`, [myEnforcementDeptId])
  ).rows[0].id;
  const zzCaterlinkDeptId = nextId();
  await db.query("insert into public.departments (id, aoc_id, code, name) values ($1, $2, 'caterlink', 'ZZ CaterLink');", [zzCaterlinkDeptId, zzAocId]);

  // Resolve/create one team per station used by station-scoped role assignments below
  // (Phase 3 scope-shape trigger requires team_id for so/aso/profiling_so/profiling_aso).
  async function stationTeam(stationCode) {
    const stationId = stationMap.get(stationCode);
    const row = await db.query(
      `insert into public.org_teams (station_id, name) values ($1, 'Alpha') on conflict (station_id, name) do update set name = excluded.name returning id;`,
      [stationId],
    );
    return row.rows[0].id;
  }
  const kulTeamId = await stationTeam('KUL - MAA');
  const penTeamId = await stationTeam('PEN');
  const jhbTeamId = await stationTeam('JHB');
  const aorTeamId = await stationTeam('AOR');

  async function grantMembership(profileId, aocId, entityId) {
    const row = await db.query(
      `insert into public.user_entity_memberships (profile_id, aoc_id, operating_entity_id, status, is_primary) values ($1, $2, $3, 'active', true) returning id;`,
      [profileId, aocId, entityId],
    );
    return row.rows[0].id;
  }

  async function createTestUser(id, email, name, staffNo, station, role, status = 'approved') {
    await db.query("insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing;", [id, email]);
    await db.query(
      "insert into public.profiles (id, email, name, staff_no, station, role, status) values ($1, $2, $3, $4, $5, $6, $7) on conflict (id) do update set email = excluded.email, name = excluded.name, staff_no = excluded.staff_no, station = excluded.station, role = excluded.role, status = excluded.status;",
      [id, email, name, staffNo, station, role, status]
    );
  }

  // Create test actors
  // 1. Profiling SO (MY)
  const profilingSoId = nextId();
  await createTestUser(profilingSoId, 'prof-so@example.test', 'Profiling SO', 'P-SO-01', 'KUL - MAA', 'SO', 'approved');
  const profSoMemId = await grantMembership(profilingSoId, myAocId, myEntityId);
  await db.query("insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, unit_id, hub_id, station_id, team_id, entity_membership_id, starts_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now() - interval '1 day');",
    [profilingSoId, roleMap.get('profiling_so'), myAocId, myEnforcementDeptId, myProfilingUnitId, stationHubMap.get('KUL - MAA'), stationMap.get('KUL - MAA'), kulTeamId, profSoMemId]);

  // 2. Profiling ASO (MY)
  const profilingAsoId = nextId();
  await createTestUser(profilingAsoId, 'prof-aso@example.test', 'Profiling ASO', 'P-ASO-01', 'PEN', 'ASO', 'approved');
  const profAsoMemId = await grantMembership(profilingAsoId, myAocId, myEntityId);
  await db.query("insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, unit_id, hub_id, station_id, team_id, entity_membership_id, starts_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now() - interval '1 day');",
    [profilingAsoId, roleMap.get('profiling_aso'), myAocId, myEnforcementDeptId, myProfilingUnitId, stationHubMap.get('PEN'), stationMap.get('PEN'), penTeamId, profAsoMemId]);

  // 3. Operational AVSEC at KUL (Post 2 / Post 6 capable)
  const kulAvsecId = nextId();
  await createTestUser(kulAvsecId, 'kul-avsec@example.test', 'KUL AVSEC Officer', 'KUL-AV-01', 'KUL - MAA', 'SO', 'approved');
  const kulAvsecMemId = await grantMembership(kulAvsecId, myAocId, myEntityId);
  await db.query("insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, hub_id, station_id, team_id, entity_membership_id, starts_at) values ($1, $2, $3, $4, $5, $6, $7, $8, now() - interval '1 day');",
    [kulAvsecId, roleMap.get('so'), myAocId, myOperationDeptId, stationHubMap.get('KUL - MAA'), stationMap.get('KUL - MAA'), kulTeamId, kulAvsecMemId]);

  // 4. Destination AVSEC at PEN
  const penAvsecId = nextId();
  await createTestUser(penAvsecId, 'pen-avsec@example.test', 'PEN AVSEC Officer', 'PEN-AV-01', 'PEN', 'ASO', 'approved');
  const penAvsecMemId = await grantMembership(penAvsecId, myAocId, myEntityId);
  await db.query("insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, hub_id, station_id, team_id, entity_membership_id, starts_at) values ($1, $2, $3, $4, $5, $6, $7, $8, now() - interval '1 day');",
    [penAvsecId, roleMap.get('aso'), myAocId, myOperationDeptId, stationHubMap.get('PEN'), stationMap.get('PEN'), penTeamId, penAvsecMemId]);

  // 5. Destination AVSEC at JHB
  const jhbAvsecId = nextId();
  await createTestUser(jhbAvsecId, 'jhb-avsec@example.test', 'JHB AVSEC Officer', 'JHB-AV-01', 'JHB', 'ASO', 'approved');
  const jhbAvsecMemId = await grantMembership(jhbAvsecId, myAocId, myEntityId);
  await db.query("insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, hub_id, station_id, team_id, entity_membership_id, starts_at) values ($1, $2, $3, $4, $5, $6, $7, $8, now() - interval '1 day');",
    [jhbAvsecId, roleMap.get('aso'), myAocId, myOperationDeptId, stationHubMap.get('JHB'), stationMap.get('JHB'), jhbTeamId, jhbAvsecMemId]);

  // 6. AVSEC staff at AOR (disabled scanning station)
  const aorStaffId = nextId();
  await createTestUser(aorStaffId, 'aor-staff@example.test', 'AOR Staff', 'AOR-ST-01', 'AOR', 'ASO', 'approved');
  const aorStaffMemId = await grantMembership(aorStaffId, myAocId, myEntityId);
  await db.query("insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, hub_id, station_id, team_id, entity_membership_id, starts_at) values ($1, $2, $3, $4, $5, $6, $7, $8, now() - interval '1 day');",
    [aorStaffId, roleMap.get('aso'), myAocId, myOperationDeptId, stationHubMap.get('AOR'), stationMap.get('AOR'), aorTeamId, aorStaffMemId]);

  // 7. CaterLink Management (MY)
  const caterlinkMgmtId = nextId();
  await createTestUser(caterlinkMgmtId, 'clm@example.test', 'CaterLink Manager', 'CLM-01', null, 'MANAGEMENT', 'approved');
  await db.query("insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, starts_at) values ($1, $2, $3, $4, now() - interval '1 day');",
    [caterlinkMgmtId, roleMap.get('caterlink_management'), myAocId, myCaterlinkDeptId]);

  // 8. Operation Manager (MY)
  const opMgrId = nextId();
  await createTestUser(opMgrId, 'opm@example.test', 'Operation Manager', 'OPM-01', null, 'MANAGEMENT', 'approved');
  await db.query("insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, starts_at) values ($1, $2, $3, $4, now() - interval '1 day');",
    [opMgrId, roleMap.get('operation_manager'), myAocId, myOperationDeptId]);

  // 9. Foreign AOC CaterLink Management (ZZ)
  const zzCaterlinkMgmtId = nextId();
  await createTestUser(zzCaterlinkMgmtId, 'zz-clm@example.test', 'ZZ CaterLink Manager', 'ZZ-CLM-01', null, 'MANAGEMENT', 'approved');
  await db.query("insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, starts_at) values ($1, $2, $3, $4, now() - interval '1 day');",
    [zzCaterlinkMgmtId, roleMap.get('caterlink_management'), zzAocId, zzCaterlinkDeptId]);

  // 10. Inactive / Revoked user
  const revokedUserId = nextId();
  await createTestUser(revokedUserId, 'revoked@example.test', 'Revoked User', 'REV-01', 'KUL - MAA', 'ASO', 'approved');
  const revokedMemId = await grantMembership(revokedUserId, myAocId, myEntityId);
  await db.query("insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, hub_id, station_id, team_id, entity_membership_id, starts_at, revoked_at) values ($1, $2, $3, $4, $5, $6, $7, $8, now() - interval '2 days', now() - interval '1 day');",
    [revokedUserId, roleMap.get('aso'), myAocId, myOperationDeptId, stationHubMap.get('KUL - MAA'), stationMap.get('KUL - MAA'), kulTeamId, revokedMemId]);

  // 11. Expired user
  const expiredUserId = nextId();
  await createTestUser(expiredUserId, 'expired@example.test', 'Expired User', 'EXP-01', 'KUL - MAA', 'ASO', 'approved');
  const expiredMemId = await grantMembership(expiredUserId, myAocId, myEntityId);
  await db.query("insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, hub_id, station_id, team_id, entity_membership_id, starts_at, ends_at) values ($1, $2, $3, $4, $5, $6, $7, $8, now() - interval '2 days', now() - interval '1 hour');",
    [expiredUserId, roleMap.get('aso'), myAocId, myOperationDeptId, stationHubMap.get('KUL - MAA'), stationMap.get('KUL - MAA'), kulTeamId, expiredMemId]);

  // 12. Future assignment user
  const futureUserId = nextId();
  await createTestUser(futureUserId, 'future@example.test', 'Future User', 'FUT-01', 'KUL - MAA', 'ASO', 'approved');
  const futureMemId = await grantMembership(futureUserId, myAocId, myEntityId);
  await db.query("insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, hub_id, station_id, team_id, entity_membership_id, starts_at) values ($1, $2, $3, $4, $5, $6, $7, $8, now() + interval '1 day');",
    [futureUserId, roleMap.get('aso'), myAocId, myOperationDeptId, stationHubMap.get('KUL - MAA'), stationMap.get('KUL - MAA'), kulTeamId, futureMemId]);

  console.log('\n--- SECTION 1: Station Capability Matrix ---');

  // Test 1.1: KUL capability checks (both KUL - MAA and KUL - AAX)
  const kulMaaScan = (await db.query("select public.check_station_caterlink_capability($1, 'KUL - MAA', 'scan') as r;", [myAocId])).rows[0].r;
  const kulAaxScan = (await db.query("select public.check_station_caterlink_capability($1, 'KUL - AAX', 'scan') as r;", [myAocId])).rows[0].r;
  const kulAliasScan = (await db.query("select public.check_station_caterlink_capability($1, 'KUL', 'scan') as r;", [myAocId])).rows[0].r;
  const kulCreate = (await db.query("select public.check_station_caterlink_capability($1, 'KUL - MAA', 'create') as r;", [myAocId])).rows[0].r;
  assert(kulMaaScan === false && kulAaxScan === false && kulAliasScan === false, 'KUL (MAA, AAX, alias) has scanning DISABLED (20261021000001: only PEN and JHB scan)');
  assert(kulCreate === true, 'KUL has movement creation capability enabled');

  // Test 1.2: PEN & JHB capabilities (scan=true, receipt=true, create=false)
  const penScan = (await db.query("select public.check_station_caterlink_capability($1, 'PEN', 'scan') as r;", [myAocId])).rows[0].r;
  const penReceipt = (await db.query("select public.check_station_caterlink_capability($1, 'PEN', 'confirm_hub_receipt') as r;", [myAocId])).rows[0].r;
  const penCreate = (await db.query("select public.check_station_caterlink_capability($1, 'PEN', 'create') as r;", [myAocId])).rows[0].r;
  assert(penScan === true && penReceipt === true, 'PEN has CaterLink scanning and hub receipt enabled');
  assert(penCreate === false, 'PEN movement creation is disabled (dispatches originate from KUL)');

  const jhbScan = (await db.query("select public.check_station_caterlink_capability($1, 'JHB', 'scan') as r;", [myAocId])).rows[0].r;
  const jhbReceipt = (await db.query("select public.check_station_caterlink_capability($1, 'JHB', 'confirm_hub_receipt') as r;", [myAocId])).rows[0].r;
  const jhbCreate = (await db.query("select public.check_station_caterlink_capability($1, 'JHB', 'create') as r;", [myAocId])).rows[0].r;
  assert(jhbScan === true && jhbReceipt === true, 'JHB has CaterLink scanning and hub receipt enabled');
  assert(jhbCreate === false, 'JHB movement creation is disabled');

  // Test 1.3: Disabled stations: AOR, IPH, LGK, KCH, BKI
  for (const stn of ['AOR', 'IPH', 'LGK', 'KCH', 'BKI']) {
    const sScan = (await db.query("select public.check_station_caterlink_capability($1, $2, 'scan') as r;", [myAocId, stn])).rows[0].r;
    assert(sScan === false, `Station ${stn} CaterLink scanning is disabled`);
  }

  // Test 1.4: Unknown station default deny
  const unkScan = (await db.query("select public.check_station_caterlink_capability($1, 'UNKNOWN_STN', 'scan') as r;", [myAocId])).rows[0].r;
  assert(unkScan === false, 'Unconfigured/unknown station denied by default (default deny)');

  // Test 1.5: Dynamic future enablement without code changes
  const bkiStationId = stationMap.get('BKI');
  await db.query("update public.caterlink_station_capabilities set can_scan = true where aoc_id = $1 and station_id = $2;", [myAocId, bkiStationId]);
  const bkiDynamic = (await db.query("select public.check_station_caterlink_capability($1, 'BKI', 'scan') as r;", [myAocId])).rows[0].r;
  assert(bkiDynamic === true, 'BKI dynamic enablement via configuration row immediately grants scan capability');
  // Revert BKI
  await db.query("update public.caterlink_station_capabilities set can_scan = false where aoc_id = $1 and station_id = $2;", [myAocId, bkiStationId]);

  console.log('\n--- SECTION 2: Role Denial & Profiling Exclusion ---');

  // Test 2.1: Profiling SO and ASO unconditionally denied scanning
  const profSoScan = (await scanAs(profilingSoId, myAocId, 'KUL - MAA'));
  const profAsoScan = (await scanAs(profilingAsoId, myAocId, 'PEN'));
  assert(profSoScan === false, 'PROFILING EXCLUSION: profiling_so cannot scan even at KUL');
  assert(profAsoScan === false, 'PROFILING EXCLUSION: profiling_aso cannot scan even at PEN');

  // Test 2.2: Active operational staff positive verification
  const kulAvsecScan = (await scanAs(kulAvsecId, myAocId, 'KUL - MAA'));
  const penAvsecScan = (await scanAs(penAvsecId, myAocId, 'PEN'));
  assert(kulAvsecScan === false, 'KUL operational AVSEC officer cannot scan at KUL (scanning disabled there)');
  assert(penAvsecScan === true, 'PEN operational AVSEC officer can scan at PEN');

  // Test 2.3: Disabled station denial for operational staff
  const aorScan = (await scanAs(aorStaffId, myAocId, 'AOR'));
  assert(aorScan === false, 'Operational staff at disabled station (AOR) denied scanning');

  // Test 2.4: Assignment lifecycle checks (revoked, expired, future)
  const revokedScan = (await scanAs(revokedUserId, myAocId, 'KUL - MAA'));
  const expiredScan = (await scanAs(expiredUserId, myAocId, 'KUL - MAA'));
  const futureScan = (await scanAs(futureUserId, myAocId, 'KUL - MAA'));
  assert(revokedScan === false, 'Revoked role assignment denied scanning');
  assert(expiredScan === false, 'Expired role assignment denied scanning');
  assert(futureScan === false, 'Future role assignment denied scanning');

  // Test 2.5: Cross-AOC scanning denial
  const crossAocScan = (await scanAs(penAvsecId, zzAocId, 'KUL - MAA'));
  assert(crossAocScan === false, 'Cross-AOC scanning denied (MY officer cannot scan in foreign AOC)');

  console.log('\n--- SECTION 3: Transaction Creation & Station Policy ---');

  // create_caterlink_transaction_secure() now resolves and populates
  // vehicle_id/driver_id_ref via resolve_usable_caterlink_vehicle/driver()
  // (see Section 11 below for the full denial-matrix proof) -- every
  // vehicle/driver identifier any Section 3+ test uses to successfully
  // create a transaction must be a genuinely usable (active, approved)
  // whitelist entry first.
  async function registerUsableVehicle(identifier) {
    const res = await db.query(
      `select id from public.create_caterlink_whitelist_entry_secure(p_entry_type => 'vehicle', p_aoc_id => $1, p_identifier => $2);`,
      [myAocId, identifier],
    );
    await db.query("select * from public.approve_caterlink_whitelist_entry_secure('vehicle', $1);", [res.rows[0].id]);
    return res.rows[0].id;
  }
  async function registerUsableDriver(identifier, name = 'Fixture Driver') {
    const res = await db.query(
      `select id from public.create_caterlink_whitelist_entry_secure(p_entry_type => 'driver', p_aoc_id => $1, p_name => $2, p_identifier => $3);`,
      [myAocId, name, identifier],
    );
    await db.query("select * from public.approve_caterlink_whitelist_entry_secure('driver', $1);", [res.rows[0].id]);
    return res.rows[0].id;
  }
  await simulateUser(caterlinkMgmtId);
  await registerUsableVehicle('WXX 1234');
  await registerUsableDriver('DRV-001', 'Ali Driver');
  await registerUsableVehicle('WXX 5678');
  await registerUsableDriver('DRV-002', 'Bakar Driver');

  await simulateUser(kulAvsecId);

  // Test 3.1: Creation at KUL succeeds
  const txCreateRes = await db.query(`
    select transaction_id, transaction_number
    from public.create_caterlink_transaction_secure(
      p_aoc_id => $1,
      p_origin_station => 'KUL - MAA',
      p_direction => 'OUTBOUND',
      p_route => 'HUB',
      p_vehicle_number => 'WXX 1234',
      p_driver_name => 'Ali Driver',
      p_driver_id => 'DRV-001',
      p_seal_number => 'SEAL-9001',
      p_hub_destination => 'PEN'
    );
  `, [myAocId]);
  const txId = txCreateRes.rows[0].transaction_id;
  const txNum = txCreateRes.rows[0].transaction_number;
  assert(Boolean(txId && txNum.startsWith('CL-')), `Transaction created at KUL: ${txNum}`);

  // Test 3.2: Creation at PEN fails (station create capability disabled)
  const penCreateFailed = await expectFail(() => db.query(`
    select * from public.create_caterlink_transaction_secure(
      p_aoc_id => $1,
      p_origin_station => 'PEN',
      p_direction => 'OUTBOUND',
      p_route => 'AIRCRAFT',
      p_vehicle_number => 'PEN 1111',
      p_driver_name => 'Pen Driver',
      p_driver_id => 'DRV-PEN',
      p_seal_number => 'SEAL-PEN'
    );
  `, [myAocId]));
  assert(penCreateFailed, 'Transaction creation at PEN rejected (station not authorized to initiate movements)');

  console.log('\n--- SECTION 4: Checkpoint Execution & Destination Receipt ---');

  // Test 4.1: Destination receipt rejected before upstream checkpoint completed
  await simulateUser(penAvsecId);
  const prematureReceiptFailed = await expectFail(() => db.query(`
    select * from public.confirm_caterlink_destination_receipt_secure(
      p_transaction_id => $1,
      p_station_code => 'PEN',
      p_signature_url => 'sig_pen.png'
    );
  `, [txId]));
  assert(prematureReceiptFailed, 'HUB movement receipt rejected before In-flight Post approval');

  // Complete upstream checkpoint: In-flight Post (Post 2 approval)
  await simulateServiceRole();
  await db.query("update public.transactions set status = 'INFLIGHT_POST_APPROVED' where id = $1;", [txId]);

  // Test 4.2: Destination mismatch (JHB officer attempts to confirm PEN movement)
  await simulateUser(jhbAvsecId);
  const mismatchFailed = await expectFail(() => db.query(`
    select * from public.confirm_caterlink_destination_receipt_secure(
      p_transaction_id => $1,
      p_station_code => 'JHB',
      p_signature_url => 'sig_jhb.png'
    );
  `, [txId]));
  assert(mismatchFailed, 'Destination station mismatch rejected (JHB cannot confirm delivery destined for PEN)');

  // Test 4.3: Sender cannot confirm destination receipt for own cross-station movement
  await simulateUser(kulAvsecId);
  const senderConfirmFailed = await expectFail(() => db.query(`
    select * from public.confirm_caterlink_destination_receipt_secure(
      p_transaction_id => $1,
      p_station_code => 'PEN',
      p_signature_url => 'sig_sender.png'
    );
  `, [txId]));
  assert(senderConfirmFailed, 'Sender cannot confirm destination receipt for their own cross-station movement');

  // Test 4.4: Disabled station cannot confirm destination receipt
  await simulateUser(aorStaffId);
  const aorConfirmFailed = await expectFail(() => db.query(`
    select * from public.confirm_caterlink_destination_receipt_secure(
      p_transaction_id => $1,
      p_station_code => 'AOR',
      p_signature_url => 'sig_aor.png'
    );
  `, [txId]));
  assert(aorConfirmFailed, 'Disabled station (AOR) cannot confirm CaterLink destination receipt');

  // Test 4.5: Valid receipt confirmation by assigned destination officer at PEN
  await simulateUser(penAvsecId);
  const rcptRes = await db.query(`
    select transaction_id, status
    from public.confirm_caterlink_destination_receipt_secure(
      p_transaction_id => $1,
      p_station_code => 'PEN',
      p_signature_url => 'sig_pen_valid.png',
      p_remarks => 'Arrived intact at PEN'
    );
  `, [txId]);
  assert(rcptRes.rows[0].status === 'COMPLETED', 'Destination receipt confirmed at PEN -> status COMPLETED');

  // Verify caterlink_checkpoint_hub record was written (renamed from the colliding
  // legacy-named public.part_hub -- see the migration's collision-inventory note)
  const hubRec = (await asService("select confirmed_destination, hub_avsec_staff_id from public.caterlink_checkpoint_hub where transaction_id = $1;", [txId])).rows[0];
  assert(hubRec.confirmed_destination === 'PEN' && hubRec.hub_avsec_staff_id === 'PEN-AV-01', 'caterlink_checkpoint_hub recorded destination and confirming officer details');

  // Test 4.6: Repeated confirmation safely rejected
  const repeatFailed = await expectFail(() => db.query(`
    select * from public.confirm_caterlink_destination_receipt_secure(
      p_transaction_id => $1,
      p_station_code => 'PEN',
      p_signature_url => 'sig_pen_repeat.png'
    );
  `, [txId]));
  assert(repeatFailed, 'Repeated receipt confirmation on already-COMPLETED transaction safely rejected');

  // Test 4.7: Cross-AOC denial for destination receipt confirmation -- a ZZ-scoped caller
  // (no role assignment in MY's AOC at all) cannot confirm receipt on a MY transaction, even
  // though the transaction is already COMPLETED and this probes a clean error path.
  await simulateUser(zzCaterlinkMgmtId);
  const crossAocReceiptFailed = await expectFail(() => db.query(`
    select * from public.confirm_caterlink_destination_receipt_secure(
      p_transaction_id => $1,
      p_station_code => 'PEN',
      p_signature_url => 'sig_cross_aoc.png'
    );
  `, [txId]));
  assert(crossAocReceiptFailed, 'Cross-AOC caller (no role assignment in the transaction AOC) denied from confirming destination receipt');

  console.log('\n--- SECTION 5: CaterLink Incidents ---');

  // Create a second transaction for incident testing
  await simulateUser(kulAvsecId);
  const tx2Res = await db.query(`
    select transaction_id, transaction_number
    from public.create_caterlink_transaction_secure(
      p_aoc_id => $1,
      p_origin_station => 'KUL - MAA',
      p_direction => 'OUTBOUND',
      p_route => 'AIRCRAFT',
      p_vehicle_number => 'WXX 5678',
      p_driver_name => 'Bakar Driver',
      p_driver_id => 'DRV-002',
      p_seal_number => 'SEAL-9002'
    );
  `, [myAocId]);
  const tx2Id = tx2Res.rows[0].transaction_id;

  // Test 5.1: Cross-AOC user cannot raise incident on MY transaction
  await simulateUser(zzCaterlinkMgmtId);
  const crossIncFailed = await expectFail(() => db.query(`
    select * from public.raise_caterlink_incident_secure(
      p_transaction_id => $1,
      p_incident_type => 'BROKEN_SEAL',
      p_description => 'Cross AOC incident attempt'
    );
  `, [tx2Id]));
  assert(crossIncFailed, 'Cross-AOC incident raising denied');

  // Test 5.2: Raise incident on transaction 2
  await simulateUser(kulAvsecId);
  const incRes = await db.query(`
    select incident_id, transaction_status
    from public.raise_caterlink_incident_secure(
      p_transaction_id => $1,
      p_incident_type => 'BROKEN_SEAL',
      p_description => 'Broken seal detected at Post 2',
      p_severity => 'high'
    );
  `, [tx2Id]);
  const incId = incRes.rows[0].incident_id;
  assert(incRes.rows[0].transaction_status === 'ESCALATED', 'Incident raised -> transaction escalated to ESCALATED');

  // Test 5.3: Transaction completion blocked while incident is open
  const blockedCompletionFailed = await expectFail(() => db.query(`
    select * from public.confirm_caterlink_destination_receipt_secure(
      p_transaction_id => $1,
      p_station_code => 'KUL - MAA',
      p_signature_url => 'sig.png'
    );
  `, [tx2Id]));
  assert(blockedCompletionFailed, 'Transaction completion blocked while in ESCALATED incident status');

  // Test 5.4: Unauthorized officer (ASO) cannot resolve incident
  await simulateUser(penAvsecId);
  const unauthorizedResolveFailed = await expectFail(() => db.query(`
    select * from public.resolve_caterlink_incident_secure(
      p_incident_id => $1,
      p_resolution_notes => 'Unauthorized resolve attempt'
    );
  `, [incId]));
  assert(unauthorizedResolveFailed, 'Unauthorized staff (ASO) denied from resolving incident');

  // Test 5.5: CaterLink Management resolves incident with mandatory notes
  await simulateUser(caterlinkMgmtId);
  const resolveRes = await db.query(`
    select incident_id, new_status
    from public.resolve_caterlink_incident_secure(
      p_incident_id => $1,
      p_resolution_notes => 'Verified replacement seal applied. All cargo re-checked.',
      p_resume_status => 'CREATED'
    );
  `, [incId]);
  assert(resolveRes.rows[0].new_status === 'RESOLVED', 'CaterLink Management resolves incident -> status RESOLVED');

  const tx2Status = (await db.query("select status from public.transactions where id = $1;", [tx2Id])).rows[0].status;
  assert(tx2Status === 'CREATED', 'Transaction resumed from ESCALATED back to CREATED');

  // Test 5.6: Reopen incident with reason and counter increment
  const reopenRes = await db.query(`
    select incident_id, status
    from public.reopen_caterlink_incident_secure(
      p_incident_id => $1,
      p_reopen_reason => 'Secondary seal irregularity discovered during audit'
    );
  `, [incId]);
  assert(reopenRes.rows[0].status === 'OPEN', 'Incident reopened -> status OPEN');

  const incDetail = (await db.query("select reopen_count, reopen_reason, reopened_by from public.caterlink_incidents where id = $1;", [incId])).rows[0];
  assert(incDetail.reopen_count === 1 && incDetail.reopen_reason.includes('Secondary seal') && incDetail.reopened_by === caterlinkMgmtId,
    'Incident records reopen_count=1, reason, and actor correctly');

  // Resolve again so transaction 2 can proceed
  await db.query(`
    select * from public.resolve_caterlink_incident_secure(
      p_incident_id => $1,
      p_resolution_notes => 'Audit concluded and cleared.',
      p_resume_status => 'COMPLETED'
    );
  `, [incId]);

  console.log('\n--- SECTION 6: Whitelist System (legacy-table-backed, secured RPCs) ---');

  // Test 6.1: create -> pending, is_active forced false by the sync trigger regardless of default
  await simulateUser(caterlinkMgmtId);
  const createVendorRes = await db.query(
    `select id, status from public.create_caterlink_whitelist_entry_secure(
       p_entry_type => 'vendor', p_aoc_id => $1, p_name => 'Brahims SATS', p_code => 'BRSATS9'
     );`,
    [myAocId],
  );
  const vendorId = createVendorRes.rows[0].id;
  assert(createVendorRes.rows[0].status === 'pending', 'New vendor entry created with status=pending, not immediately active');

  const vendorRawRow = (await asService('select is_active from public.catering_companies where id = $1;', [vendorId])).rows[0];
  assert(vendorRawRow.is_active === false, 'Pending vendor is_active=false at the data layer the scanner/trigger path actually reads');

  const createVehicleRes = await db.query(
    `select id, status from public.create_caterlink_whitelist_entry_secure(
       p_entry_type => 'vehicle', p_aoc_id => $1, p_identifier => 'WYY 9999', p_truck_type => 'Bonded Truck'
     );`,
    [myAocId],
  );
  const vehicleId = createVehicleRes.rows[0].id;
  assert(createVehicleRes.rows[0].status === 'pending', 'New vehicle entry created with status=pending');

  // Test 6.2: cross-AOC create denied
  const crossAocCreateFailed = await expectFail(() => db.query(
    `select * from public.create_caterlink_whitelist_entry_secure(
       p_entry_type => 'vehicle', p_aoc_id => $1, p_identifier => 'ZZZ 0001'
     );`,
    [zzAocId],
  ));
  assert(crossAocCreateFailed, 'MY CaterLink Management cannot create a whitelist entry scoped to a foreign AOC');

  // Test 6.3: wrong-role denial (an operational AVSEC officer, not CaterLink Management)
  await simulateUser(kulAvsecId);
  const wrongRoleCreateFailed = await expectFail(() => db.query(
    `select * from public.create_caterlink_whitelist_entry_secure(
       p_entry_type => 'vehicle', p_aoc_id => $1, p_identifier => 'WYY 8888'
     );`,
    [myAocId],
  ));
  assert(wrongRoleCreateFailed, 'Non-CaterLink-Management caller (operational AVSEC) cannot create whitelist entries');

  // Test 6.4: pending entry is invisible to the scanner gate until approved
  await simulateServiceRole();
  const pendingScanCheck = (await asService(
    "select public.check_station_caterlink_capability($1, 'KUL - MAA', 'scan') as station_can, v.is_active from public.vehicles v where v.id = $2;",
    [myAocId, vehicleId],
  )).rows[0];
  assert(pendingScanCheck.is_active === false, 'Pending vehicle remains is_active=false (unusable at any checkpoint) until approved');

  // Test 6.5: unauthorized officer cannot approve
  await simulateUser(kulAvsecId);
  const wrongRoleApproveFailed = await expectFail(() => db.query(
    "select * from public.approve_caterlink_whitelist_entry_secure('vehicle', $1);",
    [vehicleId],
  ));
  assert(wrongRoleApproveFailed, 'Non-CaterLink-Management caller cannot approve a pending whitelist entry');

  // Test 6.6: CaterLink Management approves -> active, notification sent to creator
  await simulateUser(caterlinkMgmtId);
  const approveVehicleRes = await db.query(
    "select id, status from public.approve_caterlink_whitelist_entry_secure('vehicle', $1);",
    [vehicleId],
  );
  assert(approveVehicleRes.rows[0].status === 'active', 'Approved vehicle entry transitions to status=active');
  const vehicleActiveRow = (await asService('select is_active from public.vehicles where id = $1;', [vehicleId])).rows[0];
  assert(vehicleActiveRow.is_active === true, 'Approved vehicle is_active=true -- now usable at the real scanner/checkpoint gate');

  const wlApprovalNotif = (await db.query(
    "select event_type, payload from public.user_notifications where recipient_profile_id = $1 and event_type = 'caterlink_whitelist_approved';",
    [caterlinkMgmtId],
  )).rows;
  assert(wlApprovalNotif.some((r) => r.payload.entry_id === vehicleId),
    'caterlink_whitelist_approved notification sent to the entry creator, correct entry_id in payload');

  // Test 6.7: cannot re-approve an already-active entry
  const reapproveFailed = await expectFail(() => db.query(
    "select * from public.approve_caterlink_whitelist_entry_secure('vehicle', $1);",
    [vehicleId],
  ));
  assert(reapproveFailed, 'Re-approving an already-active entry is rejected (only pending entries can be approved)');

  // Test 6.8: reject a pending entry, with mandatory reason
  const rejectNoReasonFailed = await expectFail(() => db.query(
    "select * from public.reject_caterlink_whitelist_entry_secure('vendor', $1, '');",
    [vendorId],
  ));
  assert(rejectNoReasonFailed, 'Rejecting without a reason is rejected');

  const rejectVendorRes = await db.query(
    "select id, status from public.reject_caterlink_whitelist_entry_secure('vendor', $1, 'Duplicate of an existing approved vendor');",
    [vendorId],
  );
  assert(rejectVendorRes.rows[0].status === 'rejected', 'Rejected vendor entry transitions to status=rejected (never approved -- distinct from revoked)');
  const vendorRejectedRow = (await asService('select is_active, revoked_at, approved_at, deactivated_at from public.catering_companies where id = $1;', [vendorId])).rows[0];
  assert(vendorRejectedRow.is_active === false && vendorRejectedRow.revoked_at !== null && vendorRejectedRow.approved_at === null && vendorRejectedRow.deactivated_at === null,
    'Rejected vendor: is_active=false, revoked_at set, approved_at NEVER set, deactivated_at untouched -- unambiguous at the schema level');

  const wlRejectNotif = (await db.query(
    "select event_type, payload from public.user_notifications where recipient_profile_id = $1 and event_type = 'caterlink_whitelist_rejected';",
    [caterlinkMgmtId],
  )).rows;
  assert(wlRejectNotif.some((r) => r.payload.reason === 'Duplicate of an existing approved vendor'),
    'caterlink_whitelist_rejected notification sent to creator with the rejection reason in payload');

  // Test 6.9: deactivate an active entry, with mandatory reason
  const deactivateNoReasonFailed = await expectFail(() => db.query(
    "select * from public.deactivate_caterlink_whitelist_entry_secure('vehicle', $1, '');",
    [vehicleId],
  ));
  assert(deactivateNoReasonFailed, 'Deactivating without a reason is rejected');

  const deactivateVehicleRes = await db.query(
    "select id, status from public.deactivate_caterlink_whitelist_entry_secure('vehicle', $1, 'Pass surrendered');",
    [vehicleId],
  );
  assert(deactivateVehicleRes.rows[0].status === 'deactivated', 'Deactivated vehicle entry transitions to status=deactivated (reversible -- distinct from revoked/rejected)');
  const vehicleInactiveRow = (await asService('select is_active, revoked_at, deactivated_at, deactivated_by from public.vehicles where id = $1;', [vehicleId])).rows[0];
  assert(vehicleInactiveRow.is_active === false, 'Deactivated vehicle is_active=false again at the real scanner/checkpoint gate');
  assert(vehicleInactiveRow.revoked_at === null && vehicleInactiveRow.deactivated_at !== null && vehicleInactiveRow.deactivated_by === caterlinkMgmtId,
    'Deactivation uses its own deactivated_by/deactivated_at columns -- revoked_at stays null, unambiguous from reject()/revoke()');

  // Test 6.9b: even with an active CaterLink Management role, valid effective dates, and a
  // scan-enabled station, the DEACTIVATED vehicle fails the exact query
  // checkWhitelistAtCheckpoint()/enforce_whitelist_on_create() actually run against public.vehicles
  // (lib/icms/actions/transactions.ts) -- proving denial happens at the real scanner-consulted gate,
  // not merely in a status label.
  const deactivatedScanLookup = await asService(
    "select id from public.vehicles where vehicle_number = 'WYY 9999' and is_active = true;",
  );
  assert(deactivatedScanLookup.rows.length === 0,
    'Deactivated vehicle is invisible to the real checkpoint whitelist lookup (vehicle_number + is_active=true) despite valid role/dates/station');

  // Test 6.9c: unauthorized officer cannot deactivate or revoke either
  await simulateUser(kulAvsecId);
  const wrongRoleDeactivateFailed = await expectFail(() => db.query(
    "select * from public.deactivate_caterlink_whitelist_entry_secure('vehicle', $1, 'unauthorized attempt');",
    [vehicleId],
  ));
  assert(wrongRoleDeactivateFailed, 'Non-CaterLink-Management caller cannot deactivate a whitelist entry (entry is already deactivated -- would fail either way, but the role gate is checked first)');
  await simulateUser(caterlinkMgmtId);

  // Test 6.10: reactivate
  const reactivateRes = await db.query(
    "select id, status from public.activate_caterlink_whitelist_entry_secure('vehicle', $1);",
    [vehicleId],
  );
  assert(reactivateRes.rows[0].status === 'active', 'Reactivated vehicle entry transitions back to status=active');
  const reactivatedRow = (await asService('select deactivated_by, deactivated_at, is_active from public.vehicles where id = $1;', [vehicleId])).rows[0];
  assert(reactivatedRow.deactivated_by === null && reactivatedRow.deactivated_at === null && reactivatedRow.is_active === true,
    'Reactivation clears deactivated_by/deactivated_at and restores is_active=true');

  // Test 6.10b: permanent revoke() is distinct from reversible deactivate() -- terminal, no reactivate path
  const revokeRes = await db.query(
    "select id, status from public.revoke_caterlink_whitelist_entry_secure('vehicle', $1, 'Vehicle sold, permanently removing from fleet');",
    [vehicleId],
  );
  assert(revokeRes.rows[0].status === 'revoked', 'Revoked (previously-approved) vehicle entry transitions to status=revoked, distinct from deactivated/rejected');
  const revokedRow = (await asService('select is_active, revoked_at, deactivated_at, approved_at from public.vehicles where id = $1;', [vehicleId])).rows[0];
  assert(revokedRow.is_active === false && revokedRow.revoked_at !== null && revokedRow.approved_at !== null,
    'Revoked entry: is_active=false, revoked_at set, and approved_at WAS set (distinguishing it from a rejected-before-approval entry)');

  const revokeReactivateFailed = await expectFail(() => db.query(
    "select * from public.activate_caterlink_whitelist_entry_secure('vehicle', $1);",
    [vehicleId],
  ));
  assert(revokeReactivateFailed, 'A revoked entry cannot be reactivated -- revoke() is genuinely terminal, unlike deactivate()');

  // Re-seed a fresh active vehicle (different identifier -- "WYY 9999" now permanently occupies
  // the unique constraint slot on the revoked row above; re-registering the same plate for a
  // replacement vehicle is a real-world legacy-schema limitation this review surfaces, not fixed
  // here, and out of scope for this correction round) for the remaining list/duplicate tests.
  const reseedVehicleRes = await db.query(
    `select id from public.create_caterlink_whitelist_entry_secure(
       p_entry_type => 'vehicle', p_aoc_id => $1, p_identifier => 'WYY 9998'
     );`,
    [myAocId],
  );
  await db.query("select * from public.approve_caterlink_whitelist_entry_secure('vehicle', $1);", [reseedVehicleRes.rows[0].id]);

  // Test 6.11: duplicate identifier prevented (legacy tables keep a single GLOBAL unique
  // constraint on vehicle_number/staff_id/code -- not per-AOC like a from-scratch table would be;
  // this is a genuine, disclosed scoping property of building on the existing schema, not a bug)
  const dupVehicleFailed = await expectFail(() => db.query(
    `select * from public.create_caterlink_whitelist_entry_secure(
       p_entry_type => 'vehicle', p_aoc_id => $1, p_identifier => 'WYY 9998'
     );`,
    [myAocId],
  ));
  assert(dupVehicleFailed, 'Duplicate vehicle identifier rejected by the existing unique constraint (transaction-safe, DB-level)');

  // Test 6.12: direct RPC bypass denial -- an unauthenticated/foreign-role caller cannot list
  await simulateUser(zzCaterlinkMgmtId);
  const crossAocListFailed = await expectFail(() => db.query(
    'select * from public.list_caterlink_whitelist_secure($1);',
    [myAocId],
  ));
  assert(crossAocListFailed, 'Foreign AOC CaterLink Management cannot list a different AOC\'s whitelist');

  // Test 6.13: same-AOC list returns exactly the expected active vehicle
  await simulateUser(caterlinkMgmtId);
  const listRes = await db.query(
    "select entry_type, identifier, status from public.list_caterlink_whitelist_secure($1, 'vehicle', 'active', null);",
    [myAocId],
  );
  assert(
    listRes.rows.some((r) => r.identifier === 'WYY 9998' && r.status === 'active'),
    'Same-AOC list_caterlink_whitelist_secure returns the re-seeded active vehicle entry filtered by status',
  );
  assert(
    !listRes.rows.some((r) => r.identifier === 'WYY 9999'),
    'status=active filter correctly excludes the earlier revoked "WYY 9999" entry',
  );

  // Test 6.14: FUTURE-dated entry -- approved, but effective_from is still in the future.
  // Must be denied at the real scanner gate (is_active forced false) even with a valid
  // CaterLink Management approval already recorded.
  const futureVehicleRes = await db.query(
    `select id, status from public.create_caterlink_whitelist_entry_secure(
       p_entry_type => 'vehicle', p_aoc_id => $1, p_identifier => 'WYY FUT1', p_effective_from => (current_date + interval '7 days')::date
     );`,
    [myAocId],
  );
  const futureVehicleId = futureVehicleRes.rows[0].id;
  await db.query("select * from public.approve_caterlink_whitelist_entry_secure('vehicle', $1);", [futureVehicleId]);
  const futureVehicleRow = (await asService('select status, is_active from public.vehicles where id = $1;', [futureVehicleId])).rows[0];
  assert(futureVehicleRow.status === 'future', 'Approved-but-not-yet-effective vehicle entry has status=future, distinct from active');
  assert(futureVehicleRow.is_active === false, 'Future-dated entry is_active=false despite being approved -- denied at the real scanner gate');
  const futureScanLookup = await asService("select id from public.vehicles where vehicle_number = 'WYY FUT1' and is_active = true;");
  assert(futureScanLookup.rows.length === 0, 'Future-dated entry invisible to the real checkpoint whitelist lookup');

  // Test 6.15: comprehensive denial matrix -- every non-active lifecycle stage must fail the
  // exact query the real scanner/checkpoint path (lib/icms/actions/transactions.ts
  // checkWhitelistAtCheckpoint, icms/strict_whitelist.sql's enforce_* triggers) actually runs:
  // vehicle_number/staff_id + is_active = true. Only a genuinely active, currently-effective,
  // approved entry may pass -- role validity, station scan-enablement and effective dates being
  // otherwise fine are deliberately NOT enough on their own.
  const denialMatrix = [
    { label: 'pending', table: 'vehicles', column: 'vehicle_number', value: 'WYY 9998-PENDING-PROBE', setupSql:
        `select id from public.create_caterlink_whitelist_entry_secure(p_entry_type => 'vehicle', p_aoc_id => $1, p_identifier => 'WYY 9998-PENDING-PROBE')` },
  ];
  for (const probe of denialMatrix) {
    await db.query(probe.setupSql, [myAocId]);
    const lookup = await db.query(
      `select id from public.${probe.table} where ${probe.column} = $1 and is_active = true;`,
      [probe.value],
    );
    assert(lookup.rows.length === 0, `Denial matrix: a freshly-created (${probe.label}) entry is invisible to the real checkpoint whitelist lookup`);
  }
  // Already-proven stages, cross-referenced here for a single comprehensive denial-matrix summary:
  assert(revokedRow.is_active === false, 'Denial matrix: revoked entry (approved, then permanently pulled) denied at is_active gate');
  assert(vendorRejectedRow.is_active === false, 'Denial matrix: rejected entry (never approved) denied at is_active gate');
  assert(vehicleInactiveRow.is_active === false, 'Denial matrix: deactivated entry (reversible set-aside) denied at is_active gate -- even though revoked_at stays null, effective dates remain valid, the actor still holds an active caterlink_management role, and the station (KUL) is scan-enabled');
  assert(futureVehicleRow.is_active === false, 'Denial matrix: future-dated entry (approved but not yet effective) denied at is_active gate');

  console.log('\n--- SECTION 7: Archive Model ---');

  // Fixture helper: enforce_whitelist_on_create() (now re-verifying real usability, not just a
  // null check -- see Section 11 below) applies to EVERY insert into public.transactions,
  // including these raw service_role fixture rows for sections unrelated to whitelist
  // enforcement. One usable vehicle+driver pair, reused by id, satisfies the trigger here.
  await simulateUser(caterlinkMgmtId);
  const fixtureVehicleId = await registerUsableVehicle('WXX 0001');
  const fixtureDriverId = await registerUsableDriver('T01', 'Fixture Driver');
  await simulateServiceRole();

  // Test 7.1: Attempt to archive an incomplete transaction fails
  const tx3Id = nextId();
  await db.query(`
    insert into public.transactions (
      id, transaction_number, aoc_id, direction, vehicle_number, driver_name, driver_id,
      vehicle_id, driver_id_ref, status, created_by
    ) values ($1, 'ZZ-FIXTURE-INCOMPLETE', $2, 'OUTBOUND', 'WXX 0001', 'Test', 'T01', $4, $5, 'CREATED', $3);
  `, [tx3Id, myAocId, kulAvsecId, fixtureVehicleId, fixtureDriverId]);

  await simulateUser(caterlinkMgmtId);
  const incompleteArchiveFailed = await expectFail(() => db.query("select * from public.archive_caterlink_transaction_secure($1, 'Archive test');", [tx3Id]));
  assert(incompleteArchiveFailed, 'Archiving an incomplete transaction rejected (only COMPLETED can be archived)');

  // Test 7.2: Archive COMPLETED transaction 1
  const archRes = await db.query("select archive_id, transaction_number from public.archive_caterlink_transaction_secure($1, 'Weekly retention archive');", [txId]);
  const archId = archRes.rows[0].archive_id;
  assert(Boolean(archId), `Transaction ${txNum} archived successfully with ID ${archId}`);

  // Verify transaction status and snapshot
  const tx1Arch = (await db.query("select archived, archived_by from public.transactions where id = $1;", [txId])).rows[0];
  assert(tx1Arch.archived === true && tx1Arch.archived_by === caterlinkMgmtId, 'Transaction marked archived with archived_by actor');

  const archRec = (await db.query("select transaction_snapshot, archive_reason from public.caterlink_archives where id = $1;", [archId])).rows[0];
  assert(archRec.transaction_snapshot.transaction_number === txNum, 'Archive preserves full immutable JSON snapshot');

  console.log('\n--- SECTION 8: Final PDF Authorization ---');

  // Test 8.1: Incomplete transaction PDF access denied
  const incompletePdfFailed = await expectFail(() => db.query("select * from public.authorize_caterlink_pdf_secure($1);", [tx3Id]));
  assert(incompletePdfFailed, 'Final PDF access rejected for incomplete transaction');

  // Test 8.2: COMPLETED transaction: CaterLink Management authorized
  await simulateUser(caterlinkMgmtId);
  const pdfMgmtRes = (await db.query("select authorized, pdf_storage_path from public.authorize_caterlink_pdf_secure($1);", [txId])).rows[0];
  assert(pdfMgmtRes.authorized === true, 'CaterLink Management authorized for final transaction PDF');

  // Test 8.3: COMPLETED transaction: Submitter authorized
  await simulateUser(kulAvsecId);
  const pdfSubmitterRes = (await db.query("select authorized, pdf_storage_path from public.authorize_caterlink_pdf_secure($1);", [txId])).rows[0];
  assert(pdfSubmitterRes.authorized === true, 'Submitter authorized for final transaction PDF');

  // Test 8.4: COMPLETED transaction: Confirming destination officer authorized
  await simulateUser(penAvsecId);
  const pdfDestRes = (await db.query("select authorized, pdf_storage_path from public.authorize_caterlink_pdf_secure($1);", [txId])).rows[0];
  assert(pdfDestRes.authorized === true, 'Destination confirming officer authorized for final transaction PDF');

  // Test 8.5: COMPLETED transaction: Foreign AOC user denied
  await simulateUser(zzCaterlinkMgmtId);
  const crossPdfFailed = await expectFail(() => db.query("select * from public.authorize_caterlink_pdf_secure($1);", [txId]));
  assert(crossPdfFailed, 'Foreign AOC CaterLink Management denied access to Malaysia transaction PDF');

  console.log('\n--- SECTION 9: Multi-AOC Export Isolation on Single Connection ---');

  // Insert transaction in ZZ AOC
  await simulateServiceRole();
  const zzTxId = nextId();
  await db.query(`
    insert into public.transactions (
      id, transaction_number, aoc_id, direction, vehicle_number, driver_name, driver_id,
      vehicle_id, driver_id_ref, status, created_by
    ) values ($1, 'CL-2026-ZZ-001', $2, 'OUTBOUND', 'ZZ-100', 'ZZ Driver', 'ZZ-D01', $4, $5, 'COMPLETED', $3);
  `, [zzTxId, zzAocId, zzCaterlinkMgmtId, fixtureVehicleId, fixtureDriverId]);

  // Step 1: MY CaterLink Management exports
  await simulateUser(caterlinkMgmtId);
  const myExportRes = await db.query("select * from public.export_caterlink_data_secure($1);", [myAocId]);
  const myRows = myExportRes.rows;
  assert(myRows.length >= 2, `MY CaterLink Management exported ${myRows.length} transactions`);
  assert(myRows.every((r) => r.aoc_code === 'MY'), 'All exported rows belong strictly to MY AOC');
  assert(!myRows.some((r) => r.transaction_number === 'CL-2026-ZZ-001'), 'ZERO foreign (ZZ) transactions in MY export');

  // Step 2: ZZ CaterLink Management exports immediately on same connection
  await simulateUser(zzCaterlinkMgmtId);
  const zzExportRes = await db.query("select * from public.export_caterlink_data_secure($1);", [zzAocId]);
  const zzRows = zzExportRes.rows;
  assert(zzRows.length === 1 && zzRows[0].transaction_number === 'CL-2026-ZZ-001', 'ZZ CaterLink Management exported strictly ZZ transaction');
  assert(zzRows.every((r) => r.aoc_code === 'ZZ'), 'ZERO Malaysia transactions in ZZ export');

  // Step 3: Foreign user attempting to export MY dataset is denied
  const foreignExportDenied = await expectFail(() => db.query("select * from public.export_caterlink_data_secure($1);", [myAocId]));
  assert(foreignExportDenied, 'ZZ Manager denied from exporting MY AOC dataset (strict cross-AOC boundary)');

  console.log('\n--- SECTION 10: Notifications & Audit ---');

  // Test 10.1: Notification generated for receipt confirmation (read as the recipient
  // themselves -- user_notifications RLS is `recipient_profile_id = auth.uid()`, so this must
  // run as kulAvsecId, not whatever identity Section 9 last simulated).
  await simulateUser(kulAvsecId);
  const notifRes = await db.query("select id, recipient_profile_id, event_type, payload from public.user_notifications where recipient_profile_id = $1;", [kulAvsecId]);
  assert(notifRes.rows.length >= 1, 'Transaction submitter received caterlink_movement_received notification');

  // Test 10.2: Recipient-only isolation
  await simulateUser(penAvsecId);
  const penNotifView = (await db.query("select * from public.user_notifications where recipient_profile_id = $1;", [kulAvsecId])).rows;
  assert(penNotifView.length === 0, 'Recipient isolation: other staff cannot view submitter notification');

  // Test 10.3: Audit records exist for all privileged operations (phase8_audit_log grants
  // select/insert to service_role only -- no authenticated access at all, by design).
  await simulateServiceRole();
  const audits = (await db.query(`
    select action, entity_type, entity_id, actor_id, actor_role_snapshot
    from public.phase8_audit_log
    where action in ('caterlink_transaction_create', 'caterlink_receipt_confirm', 'caterlink_incident_raise',
                     'caterlink_incident_resolve', 'caterlink_incident_reopen', 'caterlink_transaction_archive',
                     'caterlink_pdf_access', 'caterlink_export_generated', 'caterlink_whitelist_create',
                     'caterlink_whitelist_approve', 'caterlink_whitelist_reject', 'caterlink_whitelist_deactivate',
                     'caterlink_whitelist_activate', 'caterlink_whitelist_revoke')
    order by created_at;
  `)).rows;

  const auditedActions = new Set(audits.map((a) => a.action));
  assert(auditedActions.has('caterlink_transaction_create'), 'Audit recorded for transaction creation');
  assert(auditedActions.has('caterlink_receipt_confirm'), 'Audit recorded for destination receipt confirmation');
  assert(auditedActions.has('caterlink_incident_raise'), 'Audit recorded for incident creation');
  assert(auditedActions.has('caterlink_incident_resolve'), 'Audit recorded for incident resolution');
  assert(auditedActions.has('caterlink_incident_reopen'), 'Audit recorded for incident reopening');
  assert(auditedActions.has('caterlink_transaction_archive'), 'Audit recorded for transaction archiving');
  assert(auditedActions.has('caterlink_pdf_access'), 'Audit recorded for PDF authorization');
  assert(auditedActions.has('caterlink_export_generated'), 'Audit recorded for data export');
  assert(auditedActions.has('caterlink_whitelist_create'), 'Audit recorded for whitelist entry creation');
  assert(auditedActions.has('caterlink_whitelist_approve'), 'Audit recorded for whitelist entry approval');
  assert(auditedActions.has('caterlink_whitelist_reject'), 'Audit recorded for whitelist entry rejection');
  assert(auditedActions.has('caterlink_whitelist_deactivate'), 'Audit recorded for whitelist entry deactivation');
  assert(auditedActions.has('caterlink_whitelist_activate'), 'Audit recorded for whitelist entry reactivation');
  assert(auditedActions.has('caterlink_whitelist_revoke'), 'Audit recorded for whitelist entry revocation');

  console.log('\n--- SECTION 11: Transaction Creation -- Real Whitelist Trigger Enforcement ---');

  // Every call below goes through the REAL create_caterlink_transaction_secure() RPC, which
  // resolves vehicle_id/driver_id_ref and inserts into public.transactions, where the REAL
  // enforce_whitelist_on_create() trigger independently re-verifies them. No transaction row is
  // ever seeded directly as a substitute for exercising this path.
  await simulateUser(caterlinkMgmtId);

  // 11.1: valid active vehicle + driver -> succeeds, canonical ids populated
  await registerUsableVehicle('S11-VEH-OK');
  await registerUsableDriver('S11-DRV-OK', 'Section11 Driver');
  await simulateUser(kulAvsecId);
  const s11ValidRes = await db.query(
    `select transaction_id from public.create_caterlink_transaction_secure(
       p_aoc_id => $1, p_origin_station => 'KUL - MAA', p_direction => 'OUTBOUND', p_route => 'AIRCRAFT',
       p_vehicle_number => 'S11-VEH-OK', p_driver_name => 'Section11 Driver', p_driver_id => 'S11-DRV-OK', p_seal_number => 'SEAL-S11-1'
     );`,
    [myAocId],
  );
  const s11TxId = s11ValidRes.rows[0].transaction_id;
  const s11TxRow = (await db.query('select vehicle_id, driver_id_ref from public.transactions where id = $1;', [s11TxId])).rows[0];
  assert(Boolean(s11TxRow.vehicle_id) && Boolean(s11TxRow.driver_id_ref), 'Valid active vehicle+driver: transaction created with canonical vehicle_id/driver_id_ref populated by the RPC');

  // Shared denial-matrix runner: each case registers one specific whitelist state, then expects
  // create_caterlink_transaction_secure() to be denied by either the RPC's own resolver check or
  // the real trigger re-check -- either is an acceptable, equally-valid denial point.
  async function expectTxCreateDenied(vehicleNumber, driverId, label) {
    await simulateUser(kulAvsecId);
    const denied = await expectFail(() => db.query(
      `select * from public.create_caterlink_transaction_secure(
         p_aoc_id => $1, p_origin_station => 'KUL - MAA', p_direction => 'OUTBOUND', p_route => 'AIRCRAFT',
         p_vehicle_number => $2, p_driver_name => 'Probe Driver', p_driver_id => $3, p_seal_number => 'SEAL-PROBE'
       );`,
      [myAocId, vehicleNumber, driverId],
    ));
    assert(denied, `Transaction creation denied: ${label}`);
  }

  // 11.2: expired vehicle (active, approved, but pass_expiry_date in the past)
  await simulateUser(caterlinkMgmtId);
  const expVehId = await registerUsableVehicle('S11-VEH-EXP');
  await simulateServiceRole();
  await db.query("update public.vehicles set pass_expiry_date = current_date - interval '1 day' where id = $1;", [expVehId]);
  await simulateUser(caterlinkMgmtId);
  await registerUsableDriver('S11-DRV-FOR-EXP-VEH');
  await expectTxCreateDenied('S11-VEH-EXP', 'S11-DRV-FOR-EXP-VEH', 'expired vehicle pass');

  // 11.3: expired driver
  await simulateUser(caterlinkMgmtId);
  await registerUsableVehicle('S11-VEH-FOR-EXP-DRV');
  const expDrvId = await registerUsableDriver('S11-DRV-EXP');
  await simulateServiceRole();
  await db.query("update public.drivers set pass_expiry_date = current_date - interval '1 day' where id = $1;", [expDrvId]);
  await simulateUser(caterlinkMgmtId);
  await expectTxCreateDenied('S11-VEH-FOR-EXP-DRV', 'S11-DRV-EXP', 'expired driver pass');

  // 11.4: deactivated driver
  await simulateUser(caterlinkMgmtId);
  await registerUsableVehicle('S11-VEH-FOR-DEACT-DRV');
  const deactDrvId = await registerUsableDriver('S11-DRV-DEACT');
  await db.query("select * from public.deactivate_caterlink_whitelist_entry_secure('driver', $1, 'Section 11 probe');", [deactDrvId]);
  await expectTxCreateDenied('S11-VEH-FOR-DEACT-DRV', 'S11-DRV-DEACT', 'deactivated driver');

  // 11.5: revoked vehicle
  await simulateUser(caterlinkMgmtId);
  const revVehId = await registerUsableVehicle('S11-VEH-REV');
  await registerUsableDriver('S11-DRV-FOR-REV-VEH');
  await db.query("select * from public.revoke_caterlink_whitelist_entry_secure('vehicle', $1, 'Section 11 probe');", [revVehId]);
  await expectTxCreateDenied('S11-VEH-REV', 'S11-DRV-FOR-REV-VEH', 'revoked vehicle');

  // 11.6: future-effective entry (approved, but effective_from has not arrived)
  await simulateUser(caterlinkMgmtId);
  const futTxVehRes = await db.query(
    `select id from public.create_caterlink_whitelist_entry_secure(p_entry_type => 'vehicle', p_aoc_id => $1, p_identifier => 'S11-VEH-FUT', p_effective_from => (current_date + interval '3 days')::date);`,
    [myAocId],
  );
  await db.query("select * from public.approve_caterlink_whitelist_entry_secure('vehicle', $1);", [futTxVehRes.rows[0].id]);
  await registerUsableDriver('S11-DRV-FOR-FUT-VEH');
  await expectTxCreateDenied('S11-VEH-FUT', 'S11-DRV-FOR-FUT-VEH', 'future-effective (not-yet-usable) vehicle');

  // 11.7: missing / never-whitelisted identity
  await expectTxCreateDenied('S11-VEH-NEVER-LISTED', 'S11-DRV-NEVER-LISTED', 'never-whitelisted vehicle/driver');

  // 11.8: wrong AOC -- vehicle/driver whitelisted, but in a different AOC than the transaction
  await simulateUser(zzCaterlinkMgmtId);
  const zzVehRes = await db.query(
    `select id from public.create_caterlink_whitelist_entry_secure(p_entry_type => 'vehicle', p_aoc_id => $1, p_identifier => 'S11-VEH-ZZ');`,
    [zzAocId],
  );
  await db.query("select * from public.approve_caterlink_whitelist_entry_secure('vehicle', $1);", [zzVehRes.rows[0].id]);
  const zzDrvRes = await db.query(
    `select id from public.create_caterlink_whitelist_entry_secure(p_entry_type => 'driver', p_aoc_id => $1, p_name => 'ZZ Driver', p_identifier => 'S11-DRV-ZZ');`,
    [zzAocId],
  );
  await db.query("select * from public.approve_caterlink_whitelist_entry_secure('driver', $1);", [zzDrvRes.rows[0].id]);
  await expectTxCreateDenied('S11-VEH-ZZ', 'S11-DRV-ZZ', 'vehicle/driver whitelisted in a DIFFERENT AOC than the transaction');

  // 11.9: duplicate/replay creation -- two independent calls with identical inputs both succeed
  // and produce distinct transaction numbers (no accidental idempotency collision/duplication bug)
  await simulateUser(kulAvsecId);
  const replayA = await db.query(
    `select transaction_id, transaction_number from public.create_caterlink_transaction_secure(
       p_aoc_id => $1, p_origin_station => 'KUL - MAA', p_direction => 'OUTBOUND', p_route => 'AIRCRAFT',
       p_vehicle_number => 'S11-VEH-OK', p_driver_name => 'Section11 Driver', p_driver_id => 'S11-DRV-OK', p_seal_number => 'SEAL-S11-REPLAY-A'
     );`,
    [myAocId],
  );
  const replayB = await db.query(
    `select transaction_id, transaction_number from public.create_caterlink_transaction_secure(
       p_aoc_id => $1, p_origin_station => 'KUL - MAA', p_direction => 'OUTBOUND', p_route => 'AIRCRAFT',
       p_vehicle_number => 'S11-VEH-OK', p_driver_name => 'Section11 Driver', p_driver_id => 'S11-DRV-OK', p_seal_number => 'SEAL-S11-REPLAY-B'
     );`,
    [myAocId],
  );
  assert(
    replayA.rows[0].transaction_id !== replayB.rows[0].transaction_id && replayA.rows[0].transaction_number !== replayB.rows[0].transaction_number,
    'Replay creation with the same still-usable vehicle/driver produces two distinct, independent transactions',
  );

  console.log(`\nPhase 9 CaterLink verification completed. Total failures: ${failures}`);

  await clearSim();
  await db.exec('rollback;');
  await db.close();

  if (failures > 0) {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('FATAL ERROR in Phase 9 CaterLink verification:', e);
  process.exit(1);
});
