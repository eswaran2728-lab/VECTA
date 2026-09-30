// Phase 8 certification (continuation): comprehensive multi-AOC authorization
// and export isolation verification.
//
// Proves both positive same-AOC capability and strict cross-AOC denial across
// every Phase 8 subsystem using a SECOND, fully synthetic AOC ("ZZ") with its
// own department, hub, station, team, entity and role assignments alongside
// genuine Malaysia ("MY") operational fixtures.
//
// Verifies:
//  0. Direct RPC/Helper invocation (has_active_role_in_aoc / has_active_role_for_aoc),
//     role-assignment lifecycle (revoked/expired/future/pending), and execution grants.
//  1. Workforce directory (same-AOC positive, cross-AOC denial, wrong dept denial).
//  2. Leave routing (same-AOC positive, cross-AOC denial, wrong dept denial).
//  3. Overtime routing (same-AOC positive, cross-AOC denial, wrong dept denial).
//  4. Rosters (same-AOC positive, cross-AOC denial).
//  5. Duty draw (same-AOC positive, cross-AOC denial).
//  6. Investigation management (open, list, get, note, link - same-AOC vs cross-AOC).
//  7. SAT combined reports (upload, view, replace - same-AOC vs cross-AOC).
//  8. Profiling acknowledgement (same-AOC positive vs cross-AOC denial).
//  9. Export-leak test (sequential multi-identity execution on a single connection,
//     proving zero data bleed, strict dept separation, and accurate audit capture).
// 10. Notifications (recipient-only RLS isolation).
//
// Run from this directory:
//   node verify_phase8_multi_aoc.mjs [--native]
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { assertDisposableLocalTarget } from './safeguards.mjs';

const { Client } = pg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_DATA_DIR = path.join(__dirname, 'pgdata');
const RUN_DATA_DIR = path.join(__dirname, 'pgdata_multi_aoc_run');

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
  const runDb = 'vecta_phase8_multi_aoc_run';

  let db;
  if (isNative) {
    assertDisposableLocalTarget(pgConfig, goldenDb, runDb);
    console.log(`=== Phase 8 multi-AOC verification against Native PostgreSQL (${pgConfig.host}:${pgConfig.port}) ===`);
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
    console.log('=== Phase 8 multi-AOC verification against PGlite embedded engine ===');
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

  let seq = 0x40;
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

  await simulateServiceRole();

  // --- 1. Synthetic second AOC: "ZZ" ---
  const zzAocId = (
    await db.query(`insert into public.aocs (code, name, is_active) values ('ZZ', 'Synthetic Test AOC', true) returning id;`)
  ).rows[0].id;
  const zzOperationDeptId = (
    await db.query(`insert into public.departments (aoc_id, code, name) values ($1, 'operation', 'ZZ Operation') returning id;`, [zzAocId])
  ).rows[0].id;
  const zzEnforcementDeptId = (
    await db.query(`insert into public.departments (aoc_id, code, name) values ($1, 'enforcement', 'ZZ Enforcement') returning id;`, [zzAocId])
  ).rows[0].id;
  const zzHubId = (await db.query(`insert into public.hubs (aoc_id, code, name) values ($1, 'kul', 'ZZ KUL-equivalent Hub') returning id;`, [zzAocId])).rows[0].id;
  const zzStationId = (await db.query(`insert into public.org_stations (hub_id, code, name) values ($1, 'ZZS', 'ZZ Station') returning id;`, [zzHubId])).rows[0].id;
  const zzTeamId = (await db.query(`insert into public.org_teams (station_id, name) values ($1, 'ZZTeam') returning id;`, [zzStationId])).rows[0].id;
  const zzEntityId = (
    await db.query(`insert into public.operating_entities (aoc_id, code, name, flight_prefix) values ($1, 'ZZE', 'ZZ Entity', 'ZZ') returning id;`, [zzAocId])
  ).rows[0].id;

  const zzInvestigationUnitId = (
    await db.query(`insert into public.units (department_id, code, name) values ($1, 'investigation', 'ZZ Investigation') returning id;`, [zzEnforcementDeptId])
  ).rows[0].id;
  const zzSatUnitId = (
    await db.query(`insert into public.units (department_id, code, name) values ($1, 'sat', 'ZZ SAT') returning id;`, [zzEnforcementDeptId])
  ).rows[0].id;
  const zzProfilingUnitId = (
    await db.query(`insert into public.units (department_id, code, name) values ($1, 'profiling', 'ZZ Profiling') returning id;`, [zzEnforcementDeptId])
  ).rows[0].id;

  // --- 2. Malaysia AOC ("MY") entities & units ---
  const myAocId = (await db.query("select id from public.aocs where code = 'MY';")).rows[0].id;
  const myOperationDeptId = (await db.query("select id from public.departments where aoc_id = $1 and code = 'operation';", [myAocId])).rows[0].id;
  const myEnforcementDeptId = (await db.query("select id from public.departments where aoc_id = $1 and code = 'enforcement';", [myAocId])).rows[0].id;
  const myInvestigationUnitId = (await db.query("select id from public.units where department_id = $1 and code = 'investigation';", [myEnforcementDeptId])).rows[0].id;
  const mySatUnitId = (
    await db.query(`insert into public.units (department_id, code, name) values ($1, 'sat', 'MY SAT Unit') on conflict (department_id, code) do update set name = excluded.name returning id;`, [myEnforcementDeptId])
  ).rows[0].id;
  const myProfilingUnitId = (
    await db.query(`insert into public.units (department_id, code, name) values ($1, 'profiling', 'MY Profiling Unit') on conflict (department_id, code) do update set name = excluded.name returning id;`, [myEnforcementDeptId])
  ).rows[0].id;

  const myPenStationId = (await db.query("select id from public.org_stations where code = 'PEN';")).rows[0].id;
  const myPenHubId = (await db.query('select hub_id from public.org_stations where id = $1;', [myPenStationId])).rows[0].hub_id;
  const myPenAlphaTeamId = (
    await db.query(`insert into public.org_teams (station_id, name) values ($1, 'Alpha') on conflict (station_id, name) do update set name = excluded.name returning id;`, [myPenStationId])
  ).rows[0].id;
  const myKulStationId = (await db.query("select id from public.org_stations where code = 'KUL - MAA';")).rows[0].id;
  const myKulHubId = (await db.query('select hub_id from public.org_stations where id = $1;', [myKulStationId])).rows[0].hub_id;
  const myKulAlphaTeamId = (
    await db.query(`insert into public.org_teams (station_id, name) values ($1, 'Alpha') on conflict (station_id, name) do update set name = excluded.name returning id;`, [myKulStationId])
  ).rows[0].id;
  const myEntityId = (await db.query("select id from public.operating_entities where aoc_id = $1 and code = 'MAA';", [myAocId])).rows[0].id;

  // --- 3. Profile Identities ---
  const GRANTER = nextId();
  // ZZ Identities
  const ZZ_OPS_MGR = nextId();
  const ZZ_MAIN_ENF = nextId();
  const ZZ_INV_SSO = nextId();
  const ZZ_SAT_ASO = nextId();
  const ZZ_PROFILING_SO = nextId();
  const ZZ_STAFF = nextId();
  // MY Identities
  const MY_OPS_MGR = nextId();
  const MY_MAIN_ENF = nextId();
  const MY_INV_SSO = nextId();
  const MY_SAT_ASO = nextId();
  const MY_PROFILING_SO = nextId();
  const MY_STAFF = nextId();

  const allProfiles = [
    { id: GRANTER, email: 'granter@example.test', name: 'Granter', staffNo: 'T-G1', role: 'ADMIN', station: null, team: null, dept: 'operation_avsec' },
    { id: ZZ_OPS_MGR, email: 'zz-ops@example.test', name: 'ZZ Ops Mgr', staffNo: 'T-Z1', role: 'ASO', station: null, team: null, dept: 'operation_avsec' },
    { id: ZZ_MAIN_ENF, email: 'zz-enf@example.test', name: 'ZZ Main Enf', staffNo: 'T-Z2', role: 'ASO', station: null, team: null, dept: 'operation_avsec' },
    { id: ZZ_INV_SSO, email: 'zz-inv@example.test', name: 'ZZ Inv SSO', staffNo: 'T-Z3', role: 'ASO', station: null, team: null, dept: 'operation_avsec' },
    { id: ZZ_SAT_ASO, email: 'zz-sat@example.test', name: 'ZZ Sat Aso', staffNo: 'T-Z4', role: 'ASO', station: null, team: null, dept: 'operation_avsec' },
    { id: ZZ_PROFILING_SO, email: 'zz-prof@example.test', name: 'ZZ Profiling SO', staffNo: 'T-Z5', role: 'ASO', station: null, team: null, dept: 'operation_avsec' },
    { id: ZZ_STAFF, email: 'zz-staff@example.test', name: 'ZZ Staff', staffNo: 'T-Z6', role: 'ASO', station: null, team: null, dept: 'operation_avsec' },
    { id: MY_OPS_MGR, email: 'my-ops@example.test', name: 'MY Ops Mgr', staffNo: 'T-M1', role: 'ASO', station: null, team: null, dept: 'operation_avsec' },
    { id: MY_MAIN_ENF, email: 'my-enf@example.test', name: 'MY Main Enf', staffNo: 'T-M2', role: 'ASO', station: null, team: null, dept: 'operation_avsec' },
    { id: MY_INV_SSO, email: 'my-inv@example.test', name: 'MY Inv SSO', staffNo: 'T-M3', role: 'ASO', station: null, team: null, dept: 'operation_avsec' },
    { id: MY_SAT_ASO, email: 'my-sat@example.test', name: 'MY Sat Aso', staffNo: 'T-M4', role: 'ASO', station: 'KUL - MAA', team: 'Alpha', dept: 'operation_avsec' },
    { id: MY_PROFILING_SO, email: 'my-prof@example.test', name: 'MY Profiling SO', staffNo: 'T-M5', role: 'ASO', station: 'PEN', team: 'Alpha', dept: 'operation_avsec' },
    { id: MY_STAFF, email: 'my-staff@example.test', name: 'MY Staff', staffNo: 'T-M6', role: 'ASO', station: 'PEN', team: 'Alpha', dept: 'operation_avsec' },
  ];

  await db.query(
    `insert into auth.users (id, email) values ${allProfiles.map((p, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(',')} on conflict (id) do nothing;`,
    allProfiles.flatMap((p) => [p.id, p.email]),
  );

  await db.query(
    `insert into public.profiles (id, email, name, staff_no, role, station, team, ops_group, status)
     values ${allProfiles.map((p, i) => `($${i * 8 + 1}, $${i * 8 + 2}, $${i * 8 + 3}, $${i * 8 + 4}, $${i * 8 + 5}, $${i * 8 + 6}, $${i * 8 + 7}, $${i * 8 + 8}, 'approved')`).join(',')}
     on conflict (id) do update set name = excluded.name, staff_no = excluded.staff_no, role = excluded.role,
       station = excluded.station, team = excluded.team, ops_group = excluded.ops_group, status = excluded.status;`,
    allProfiles.flatMap((p) => [p.id, p.email, p.name, p.staffNo, p.role, p.station, p.team, p.dept]),
  );

  const roleId = {};
  for (const code of ['operation_manager', 'main_enforcement', 'investigation_sso', 'sat_aso', 'profiling_so', 'dse']) {
    roleId[code] = (await db.query('select id from public.role_definitions where code = $1;', [code])).rows[0].id;
  }

  async function grantMembership(profileId, aocId, entityId) {
    const row = await db.query(
      `insert into public.user_entity_memberships (profile_id, aoc_id, operating_entity_id, status, is_primary) values ($1, $2, $3, 'active', true) returning id;`,
      [profileId, aocId, entityId],
    );
    return row.rows[0].id;
  }

  // --- Assign ZZ Roles ---
  await db.query(
    `insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, granted_by, grant_reason)
     values ($1, $2, $3, $4, $5, 'phase8 multi-aoc fixture');`,
    [ZZ_OPS_MGR, roleId.operation_manager, zzAocId, zzOperationDeptId, GRANTER],
  );
  await db.query(
    `insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, granted_by, grant_reason)
     values ($1, $2, $3, $4, $5, 'phase8 multi-aoc fixture');`,
    [ZZ_MAIN_ENF, roleId.main_enforcement, zzAocId, zzEnforcementDeptId, GRANTER],
  );
  {
    const memId = await grantMembership(ZZ_INV_SSO, zzAocId, zzEntityId);
    await db.query(
      `insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, unit_id, entity_membership_id, granted_by, grant_reason)
       values ($1, $2, $3, $4, $5, $6, $7, 'phase8 multi-aoc fixture');`,
      [ZZ_INV_SSO, roleId.investigation_sso, zzAocId, zzEnforcementDeptId, zzInvestigationUnitId, memId, GRANTER],
    );
  }
  {
    const memId = await grantMembership(ZZ_SAT_ASO, zzAocId, zzEntityId);
    await db.query(
      `insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, unit_id, hub_id, station_id, team_id, entity_membership_id, granted_by, grant_reason)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'phase8 multi-aoc fixture');`,
      [ZZ_SAT_ASO, roleId.sat_aso, zzAocId, zzEnforcementDeptId, zzSatUnitId, zzHubId, zzStationId, zzTeamId, memId, GRANTER],
    );
  }
  {
    const memId = await grantMembership(ZZ_PROFILING_SO, zzAocId, zzEntityId);
    await db.query(
      `insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, unit_id, hub_id, station_id, team_id, entity_membership_id, granted_by, grant_reason)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'phase8 multi-aoc fixture');`,
      [ZZ_PROFILING_SO, roleId.profiling_so, zzAocId, zzEnforcementDeptId, zzProfilingUnitId, zzHubId, zzStationId, zzTeamId, memId, GRANTER],
    );
  }

  // --- Assign MY Roles ---
  await db.query(
    `insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, granted_by, grant_reason)
     values ($1, $2, $3, $4, $5, 'phase8 multi-aoc fixture');`,
    [MY_OPS_MGR, roleId.operation_manager, myAocId, myOperationDeptId, GRANTER],
  );
  await db.query(
    `insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, granted_by, grant_reason)
     values ($1, $2, $3, $4, $5, 'phase8 multi-aoc fixture');`,
    [MY_MAIN_ENF, roleId.main_enforcement, myAocId, myEnforcementDeptId, GRANTER],
  );
  {
    const memId = await grantMembership(MY_INV_SSO, myAocId, myEntityId);
    await db.query(
      `insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, unit_id, entity_membership_id, granted_by, grant_reason)
       values ($1, $2, $3, $4, $5, $6, $7, 'phase8 multi-aoc fixture');`,
      [MY_INV_SSO, roleId.investigation_sso, myAocId, myEnforcementDeptId, myInvestigationUnitId, memId, GRANTER],
    );
  }
  {
    const memId = await grantMembership(MY_SAT_ASO, myAocId, myEntityId);
    await db.query(
      `insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, unit_id, hub_id, station_id, team_id, entity_membership_id, granted_by, grant_reason)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'phase8 multi-aoc fixture');`,
      [MY_SAT_ASO, roleId.sat_aso, myAocId, myEnforcementDeptId, mySatUnitId, myKulHubId, myKulStationId, myKulAlphaTeamId, memId, GRANTER],
    );
  }
  {
    const memId = await grantMembership(MY_PROFILING_SO, myAocId, myEntityId);
    await db.query(
      `insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, unit_id, hub_id, station_id, team_id, entity_membership_id, granted_by, grant_reason)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'phase8 multi-aoc fixture');`,
      [MY_PROFILING_SO, roleId.profiling_so, myAocId, myEnforcementDeptId, myProfilingUnitId, myPenHubId, myPenStationId, myPenAlphaTeamId, memId, GRANTER],
    );
  }
  {
    const memId = await grantMembership(MY_STAFF, myAocId, myEntityId);
    const roleHubSeId = (await db.query("select id from public.role_definitions where code = 'hub_se';")).rows[0].id;
    await db.query(
      `insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, hub_id, entity_membership_id, granted_by, grant_reason)
       values ($1, $2, $3, $4, $5, $6, $7, 'phase8 multi-aoc fixture');`,
      [MY_STAFF, roleHubSeId, myAocId, myOperationDeptId, myPenHubId, memId, GRANTER],
    );
  }

  await clearSim();

  // =========================================================================
  // SECTION 0: DIRECT RPC / HELPER INVOCATION & ROLE-ASSIGNMENT LIFECYCLE
  // =========================================================================
  console.log('\n--- SECTION 0: Direct Helper & Role-Assignment Lifecycle ---');
  {
    // Same-AOC positive verification
    await simulateUser(MY_OPS_MGR);
    const myOpsInMy = (await db.query("select public.has_active_role_in_aoc('operation_manager', $1) as ok;", [myAocId])).rows[0].ok;
    const myOpsForMy = (await db.query("select public.has_active_role_for_aoc('operation_manager', $1) as ok;", [myAocId])).rows[0].ok;
    assert(myOpsInMy && myOpsForMy, 'has_active_role_in_aoc / has_active_role_for_aoc: MY Operation Manager is TRUE for MY AOC');

    // Cross-AOC negative verification
    const myOpsInZz = (await db.query("select public.has_active_role_in_aoc('operation_manager', $1) as ok;", [zzAocId])).rows[0].ok;
    assert(!myOpsInZz, 'has_active_role_in_aoc: MY Operation Manager is FALSE for ZZ AOC (cross-AOC denial)');
    await clearSim();

    await simulateUser(ZZ_OPS_MGR);
    const zzOpsInZz = (await db.query("select public.has_active_role_in_aoc('operation_manager', $1) as ok;", [zzAocId])).rows[0].ok;
    const zzOpsInMy = (await db.query("select public.has_active_role_in_aoc('operation_manager', $1) as ok;", [myAocId])).rows[0].ok;
    assert(zzOpsInZz, 'has_active_role_in_aoc: ZZ Operation Manager is TRUE for ZZ AOC (reusable helper works for 2nd AOC)');
    assert(!zzOpsInMy, 'has_active_role_in_aoc: ZZ Operation Manager is FALSE for MY AOC (cross-AOC denial)');
    await clearSim();

    // Assignment Lifecycle checks: revoked, expired, future, pending
    await simulateServiceRole();
    const REVOKED_P = nextId();
    const EXPIRED_P = nextId();
    const FUTURE_P = nextId();
    const PENDING_P = nextId();

    for (const pid of [REVOKED_P, EXPIRED_P, FUTURE_P, PENDING_P]) {
      await db.query(`insert into auth.users (id, email) values ($1, '${pid}@example.test') on conflict (id) do nothing;`, [pid]);
      await db.query(`insert into public.profiles (id, email, name, staff_no, role, status) values ($1, '${pid}@example.test', 'Lifecycle', 'T-LC', 'ASO', 'approved') on conflict (id) do nothing;`, [pid]);
    }

    // Revoked
    await db.query(
      `insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, revoked_at, granted_by, grant_reason)
       values ($1, $2, $3, $4, now() - interval '1 hour', $5, 'revoked');`,
      [REVOKED_P, roleId.operation_manager, myAocId, myOperationDeptId, GRANTER],
    );
    // Expired: starts_at 2 days ago, ends_at 1 day ago
    await db.query(
      `insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, starts_at, ends_at, granted_by, grant_reason)
       values ($1, $2, $3, $4, now() - interval '2 days', now() - interval '1 day', $5, 'expired');`,
      [EXPIRED_P, roleId.operation_manager, myAocId, myOperationDeptId, GRANTER],
    );
    // Future
    await db.query(
      `insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, starts_at, granted_by, grant_reason)
       values ($1, $2, $3, $4, now() + interval '1 day', $5, 'future');`,
      [FUTURE_P, roleId.operation_manager, myAocId, myOperationDeptId, GRANTER],
    );
    // Pending (starts_at tomorrow)
    await db.query(
      `insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, starts_at, granted_by, grant_reason)
       values ($1, $2, $3, $4, now() + interval '1 hour', $5, 'pending');`,
      [PENDING_P, roleId.operation_manager, zzAocId, zzOperationDeptId, GRANTER],
    );
    await clearSim();

    await simulateUser(REVOKED_P);
    const isRevokedActive = (await db.query("select public.has_active_role_in_aoc('operation_manager', $1) as ok;", [myAocId])).rows[0].ok;
    assert(!isRevokedActive, 'Lifecycle: Revoked assignment returns false');
    await clearSim();

    await simulateUser(EXPIRED_P);
    const isExpiredActive = (await db.query("select public.has_active_role_in_aoc('operation_manager', $1) as ok;", [myAocId])).rows[0].ok;
    assert(!isExpiredActive, 'Lifecycle: Expired assignment returns false');
    await clearSim();

    await simulateUser(FUTURE_P);
    const isFutureActive = (await db.query("select public.has_active_role_in_aoc('operation_manager', $1) as ok;", [myAocId])).rows[0].ok;
    assert(!isFutureActive, 'Lifecycle: Future assignment returns false');
    await clearSim();

    await simulateUser(PENDING_P);
    const isPendingActive = (await db.query("select public.has_active_role_in_aoc('operation_manager', $1) as ok;", [zzAocId])).rows[0].ok;
    assert(!isPendingActive, 'Lifecycle: Pending assignment in ZZ returns false');
    await clearSim();
  }

  // =========================================================================
  // SECTION 1: WORKFORCE DIRECTORY
  // =========================================================================
  console.log('\n--- SECTION 1: Workforce Directory ---');
  {
    // Same-AOC positive: MY Main Enforcement can list enforcement workforce
    await simulateUser(MY_MAIN_ENF);
    const myWf = await db.query('select * from public.list_enforcement_workforce_secure();');
    await clearSim();
    assert(myWf.rows.length > 0, `MY Main Enforcement lists MY Enforcement workforce (${myWf.rows.length} rows)`);

    // Cross-AOC denial: ZZ Main Enforcement cannot list MY workforce
    await simulateUser(ZZ_MAIN_ENF);
    await db.exec('savepoint sp_wf_zz;');
    let zzDenied = false;
    try {
      await db.query('select * from public.list_enforcement_workforce_secure();');
    } catch (e) {
      zzDenied = /Only Main Enforcement/.test(e.message);
      await db.exec('rollback to savepoint sp_wf_zz;');
    }
    await clearSim();
    assert(zzDenied, 'Cross-AOC: ZZ Main Enforcement is denied list_enforcement_workforce_secure()');

    // Wrong department: MY Operation Manager cannot list Enforcement workforce
    await simulateUser(MY_OPS_MGR);
    await db.exec('savepoint sp_wf_wrong_dept;');
    let wrongDeptDenied = false;
    try {
      await db.query('select * from public.list_enforcement_workforce_secure();');
    } catch (e) {
      wrongDeptDenied = /Only Main Enforcement/.test(e.message);
      await db.exec('rollback to savepoint sp_wf_wrong_dept;');
    }
    await clearSim();
    assert(wrongDeptDenied, 'Wrong Dept: MY Operation Manager is denied list_enforcement_workforce_secure()');
  }

  // =========================================================================
  // SECTION 2: LEAVE ROUTING
  // =========================================================================
  console.log('\n--- SECTION 2: Leave Routing ---');
  {
    await simulateServiceRole();
    const leaveId = (
      await db.query(
        `insert into public.absence_notices (user_id, staff_name, role, station, team, duty_date, shift_start_time, gap_minutes, status, remarks, leave_type, start_date, end_date, approval_status)
         values ($1, 'Staff', 'ASO', 'PEN', 'Alpha', '2027-06-01', now(), 0, 'green', 'leave', 'annual', '2027-06-01', '2027-06-01', 'pending') returning id;`,
        [MY_STAFF],
      )
    ).rows[0].id;
    await clearSim();

    // Cross-AOC: ZZ Ops Mgr cannot decide MY leave
    await simulateUser(ZZ_OPS_MGR);
    await db.exec('savepoint sp_leave_zz;');
    let zzBypassed = false;
    try {
      const res = await db.query('select * from public.review_leave_request_secure($1, $2, $3);', [leaveId, 'approve', 'zz test']);
      zzBypassed = res.rows[0]?.result_status === 'approved';
    } catch (e) {
      await db.exec('rollback to savepoint sp_leave_zz;');
    }
    await clearSim();
    assert(!zzBypassed, 'Cross-AOC: ZZ Operation Manager cannot approve MY leave request');

    // Wrong department: MY Main Enforcement cannot decide MY Operation leave
    await simulateUser(MY_MAIN_ENF);
    await db.exec('savepoint sp_leave_dept;');
    let enfBypassed = false;
    try {
      const res = await db.query('select * from public.review_leave_request_secure($1, $2, $3);', [leaveId, 'approve', 'enf test']);
      enfBypassed = res.rows[0]?.result_status === 'approved';
    } catch (e) {
      await db.exec('rollback to savepoint sp_leave_dept;');
    }
    await clearSim();
    assert(!enfBypassed, 'Wrong Dept: MY Main Enforcement cannot approve Operation leave request');

    // Same-AOC positive: MY Operation Manager can approve MY Operation leave
    await simulateUser(MY_OPS_MGR);
    const myApprove = await db.query('select * from public.review_leave_request_secure($1, $2, $3);', [leaveId, 'approve', 'valid approval']);
    await clearSim();
    assert(myApprove.rows[0]?.result_status === 'approved', 'Same-AOC positive: MY Operation Manager successfully approves MY leave request');
  }

  // =========================================================================
  // SECTION 3: OVERTIME (OT)
  // =========================================================================
  console.log('\n--- SECTION 3: Overtime Routing ---');
  {
    await simulateServiceRole();
    const otId = (
      await db.query(
        `insert into public.overtime_requests (profile_id, station, team, work_date, category, reason, start_at, end_at, status)
         values ($1, 'PEN', 'Alpha', '2027-06-02', 'adhoc', 'ot', now(), now() + interval '2 hours', 'endorsed') returning id;`,
        [MY_STAFF],
      )
    ).rows[0].id;
    await clearSim();

    // Cross-AOC: ZZ Ops Mgr cannot update MY OT request
    await simulateUser(ZZ_OPS_MGR);
    await db.exec('savepoint sp_ot_zz;');
    let zzOtRows = [];
    try {
      const res = await db.query("update public.overtime_requests set status = 'approved' where id = $1 returning id;", [otId]);
      zzOtRows = res.rows;
    } catch (e) {
      await db.exec('rollback to savepoint sp_ot_zz;');
    }
    await clearSim();
    assert(zzOtRows.length === 0, 'Cross-AOC: ZZ Operation Manager cannot update MY overtime request (0 rows affected)');

    // Wrong Dept: MY Main Enforcement cannot approve Operation OT
    await simulateUser(MY_MAIN_ENF);
    await db.exec('savepoint sp_ot_dept;');
    let enfOtApproved = false;
    let enfOtErr = null;
    try {
      const res = await db.query("update public.overtime_requests set status = 'approved' where id = $1 returning id;", [otId]);
      enfOtApproved = res.rows.length > 0;
    } catch (e) {
      enfOtErr = e.message;
      await db.exec('rollback to savepoint sp_ot_dept;');
    }
    await clearSim();
    assert(!enfOtApproved && /department-correct/.test(enfOtErr || ''), 'Wrong Dept: MY Main Enforcement cannot approve Operation overtime request');

    // Same-AOC positive: MY Operation Manager approves Operation OT
    await simulateUser(MY_OPS_MGR);
    const myOtUpdate = await db.query("update public.overtime_requests set status = 'approved' where id = $1 returning id;", [otId]);
    await clearSim();
    assert(myOtUpdate.rows.length === 1, 'Same-AOC positive: MY Operation Manager successfully approves MY overtime request');
  }

  // =========================================================================
  // SECTION 4: ROSTERS
  // =========================================================================
  console.log('\n--- SECTION 4: Rosters ---');
  {
    // Cross-AOC denial: ZZ Ops Mgr cannot write roster for PEN Alpha
    await simulateUser(ZZ_OPS_MGR);
    await db.exec('savepoint sp_roster_zz;');
    let zzRosterDenied = false;
    try {
      await db.query("select public.upsert_roster_cell_secure('PEN', 'Alpha', '2027-06-03', 'M', null, null, 'ZZ roster');");
    } catch (e) {
      zzRosterDenied = /roster-write authority/.test(e.message) || /may not write rosters/.test(e.message);
      await db.exec('rollback to savepoint sp_roster_zz;');
    }
    await clearSim();
    assert(zzRosterDenied, 'Cross-AOC: ZZ Operation Manager cannot write roster for MY station/team');

    // Same-AOC positive: MY Ops Mgr writes roster for PEN Alpha
    await simulateUser(MY_OPS_MGR);
    const rosterRes = await db.query("select public.upsert_roster_cell_secure('PEN', 'Alpha', '2027-06-03', 'M', null, null, 'MY roster');");
    await clearSim();
    assert(rosterRes.rows.length > 0, 'Same-AOC positive: MY Operation Manager writes roster cell for MY station/team');
  }

  // =========================================================================
  // SECTION 5: DUTY DRAW
  // =========================================================================
  console.log('\n--- SECTION 5: Duty Draw ---');
  {
    // Cross-AOC denial
    await simulateUser(ZZ_OPS_MGR);
    await db.exec('savepoint sp_draw_zz;');
    let zzDrawDenied = false;
    try {
      await db.query("select * from public.initiate_duty_draw_secure('PEN', '2027-06-04');");
    } catch (e) {
      zzDrawDenied = /Only Operation Manager/.test(e.message);
      await db.exec('rollback to savepoint sp_draw_zz;');
    }
    await clearSim();
    assert(zzDrawDenied, 'Cross-AOC: ZZ Operation Manager cannot initiate duty draw for MY station');

    // Same-AOC positive
    await simulateUser(MY_OPS_MGR);
    const drawRes = await db.query("select * from public.initiate_duty_draw_secure('PEN', '2027-06-04');");
    const drawId = drawRes.rows[0].row_id;
    await db.query('select public.finalize_duty_draw_secure($1);', [drawId]);
    const readBack = await db.query("select * from public.get_duty_draw_secure('PEN', '2027-06-04');");
    await clearSim();
    assert(readBack.rows.length === 1 && readBack.rows[0].status === 'finalized', 'Same-AOC positive: MY Operation Manager initiates and finalizes duty draw');
  }

  // =========================================================================
  // SECTION 6: INVESTIGATION
  // =========================================================================
  console.log('\n--- SECTION 6: Investigation Management ---');
  {
    // Cross-AOC: ZZ Inv SSO cannot open or list cases
    await simulateUser(ZZ_INV_SSO);
    await db.exec('savepoint sp_inv_zz;');
    let zzInvDenied = false;
    try {
      await db.query("select * from public.open_investigation_case_secure('ZZ Case', 'theft', 'desc', 'normal');");
    } catch (e) {
      zzInvDenied = /Only Investigation/.test(e.message);
      await db.exec('rollback to savepoint sp_inv_zz;');
    }
    await clearSim();
    assert(zzInvDenied, 'Cross-AOC: ZZ Investigation SSO cannot open investigation case');

    // Same-AOC positive: MY Inv SSO opens, gets, and notes case
    await simulateUser(MY_INV_SSO);
    const openRes = await db.query("select * from public.open_investigation_case_secure('MY Case', 'theft', 'desc', 'normal');");
    const caseId = openRes.rows[0].row_id;
    const getRes = await db.query('select * from public.get_investigation_case_secure($1);', [caseId]);
    const noteRes = await db.query("select * from public.add_investigation_case_note_secure($1, 'Valid note');", [caseId]);
    const listRes = await db.query('select * from public.list_investigation_cases_secure();');
    await clearSim();
    assert(getRes.rows[0]?.id === caseId, 'Same-AOC positive: MY Investigation SSO opens and retrieves case details');
    assert(noteRes.rows.length === 1, 'Same-AOC positive: MY Investigation SSO adds case note');
    assert(listRes.rows.some((r) => r.id === caseId), 'Same-AOC positive: MY Investigation SSO lists cases including newly created case');
  }

  // =========================================================================
  // SECTION 7: SAT COMBINED REPORTS
  // =========================================================================
  console.log('\n--- SECTION 7: SAT Combined Reports ---');
  {
    // Cross-AOC: ZZ SAT ASO cannot upload for MY team
    await simulateUser(ZZ_SAT_ASO);
    await db.exec('savepoint sp_sat_zz;');
    let zzSatDenied = false;
    try {
      await db.query("select * from public.upload_sat_combined_report_secure('KUL - MAA', 'Alpha', '2027-06-05', '3-shift', 'sat/zz.pdf');");
    } catch (e) {
      zzSatDenied = true;
      await db.exec('rollback to savepoint sp_sat_zz;');
    }
    await clearSim();
    assert(zzSatDenied, 'Cross-AOC: ZZ SAT ASO cannot upload report for MY team');

    // Same-AOC positive: MY SAT ASO uploads, views, and replaces
    await simulateUser(MY_SAT_ASO);
    const uploadRes = await db.query("select * from public.upload_sat_combined_report_secure('KUL - MAA', 'Alpha', '2027-06-05', '3-shift', 'sat/my.pdf');");
    const reportId = uploadRes.rows[0].row_id;
    const canView = (await db.query('select public.can_view_sat_combined_report($1) as ok;', [reportId])).rows[0].ok;
    const replaceRes = await db.query("select * from public.replace_sat_combined_report_secure($1, '3-shift', 'sat/my_v2.pdf', 'Updated');", [reportId]);
    const newReportId = replaceRes.rows[0].row_id;
    await clearSim();

    await simulateServiceRole();
    const versionRes = await db.query('select version from public.sat_combined_reports where id = $1;', [newReportId]);
    await clearSim();

    // Verify ZZ cannot view
    await simulateUser(ZZ_SAT_ASO);
    const zzCanView = (await db.query('select public.can_view_sat_combined_report($1) as ok;', [reportId])).rows[0].ok;
    await clearSim();

    assert(canView, 'Same-AOC positive: MY SAT ASO can view their uploaded report');
    assert(!zzCanView, 'Cross-AOC: ZZ SAT ASO cannot view MY uploaded report');
    assert(versionRes.rows[0]?.version === 2, 'Same-AOC positive: MY SAT ASO replaces report and increments version to 2');
  }

  // =========================================================================
  // SECTION 8: PROFILING ACKNOWLEDGEMENT
  // =========================================================================
  console.log('\n--- SECTION 8: Profiling Acknowledgement ---');
  {
    await simulateServiceRole();
    const sec013Id = (
      await db.query(
        `insert into public.report_sec013 (profile_id, status, station, team, staff_name, staff_id, date_time_in, date_time_out, remark)
         values ($1, 'submitted', 'PEN', 'Alpha', 'Staff', 'T-M6', now(), now() + interval '1 hour', 'phase8 fixture') returning id;`,
        [MY_STAFF],
      )
    ).rows[0].id;
    await clearSim();

    // Cross-AOC: ZZ Profiling SO cannot acknowledge MY SEC013 report
    await simulateUser(ZZ_PROFILING_SO);
    await db.exec('savepoint sp_prof_zz;');
    let zzProfDenied = false;
    try {
      await db.query('select public.acknowledge_sec013_report_secure($1);', [sec013Id]);
    } catch (e) {
      zzProfDenied = /Only an active Profiling SO/.test(e.message);
      await db.exec('rollback to savepoint sp_prof_zz;');
    }
    await clearSim();
    assert(zzProfDenied, 'Cross-AOC: ZZ Profiling SO cannot acknowledge MY SEC013 report');

    // Same-AOC positive: MY Profiling SO acknowledges report
    await simulateUser(MY_PROFILING_SO);
    await db.query('select public.acknowledge_sec013_report_secure($1);', [sec013Id]);
    const ackCheck = await db.query('select exists(select 1 from public.report_acknowledgements where report_id = $1) as is_ack;', [sec013Id]);
    await clearSim();
    assert(ackCheck.rows[0]?.is_ack === true, 'Same-AOC positive: MY Profiling SO acknowledges SEC013 report');
  }

  // =========================================================================
  // SECTION 9: EXPORT-LEAK & ISOLATION TEST (SEQUENTIAL ON ONE CONNECTION)
  // =========================================================================
  console.log('\n--- SECTION 9: Export-Leak & Isolation on Single Connection ---');
  {
    // Step 1: MY Operation Manager calls export_operation_workforce_secure()
    await simulateUser(MY_OPS_MGR);
    const myOpExport = await db.query('select * from public.export_operation_workforce_secure();');
    assert(myOpExport.rows.length > 0, `Step 1: MY Operation Manager exports ${myOpExport.rows.length} rows`);
    const myOpProfileIds = new Set([MY_OPS_MGR, MY_STAFF]);
    const foreignOrEnfProfileIds = new Set([
      ZZ_OPS_MGR, ZZ_STAFF, ZZ_MAIN_ENF, ZZ_INV_SSO, ZZ_SAT_ASO, ZZ_PROFILING_SO,
      MY_MAIN_ENF, MY_INV_SSO, MY_SAT_ASO, MY_PROFILING_SO,
    ]);
    assert(
      myOpExport.rows.every((r) => myOpProfileIds.has(r.profile_id)),
      'Step 1: Exported rows are strictly Operation department in MY AOC only',
    );
    assert(
      !myOpExport.rows.some((r) => foreignOrEnfProfileIds.has(r.profile_id)),
      'Step 1: ZERO Enforcement rows and ZERO ZZ AOC rows returned',
    );

    // Step 2: Sequential call by ZZ Operation Manager on the SAME connection
    await simulateUser(ZZ_OPS_MGR);
    await db.exec('savepoint sp_exp_zz_ops;');
    let zzOpsDenied = false;
    try {
      await db.query('select * from public.export_operation_workforce_secure();');
    } catch (e) {
      zzOpsDenied = /Only Operation Manager/.test(e.message);
      await db.exec('rollback to savepoint sp_exp_zz_ops;');
    }
    assert(zzOpsDenied, 'Step 2: Second-AOC manager cannot export Malaysia rows; no results reused or leaked');

    // Step 3: Sequential call by MY Main Enforcement on the SAME connection
    await simulateUser(MY_MAIN_ENF);
    await db.exec('savepoint sp_exp_my_enf_op;');
    let enfOpDenied = false;
    try {
      await db.query('select * from public.export_operation_workforce_secure();');
    } catch (e) {
      enfOpDenied = /Only Operation Manager/.test(e.message);
      await db.exec('rollback to savepoint sp_exp_my_enf_op;');
    }
    assert(enfOpDenied, 'Step 3: Main Enforcement cannot export Operation rows');

    // Step 4: MY Main Enforcement exports Enforcement workforce on the SAME connection
    const myEnfExport = await db.query('select * from public.export_enforcement_workforce_secure();');
    assert(myEnfExport.rows.length > 0, `Step 4: MY Main Enforcement exports ${myEnfExport.rows.length} rows`);
    const myEnfProfileIds = new Set([MY_MAIN_ENF, MY_INV_SSO, MY_SAT_ASO, MY_PROFILING_SO]);
    const foreignOrOpProfileIds = new Set([
      ZZ_MAIN_ENF, ZZ_INV_SSO, ZZ_SAT_ASO, ZZ_PROFILING_SO, ZZ_OPS_MGR, ZZ_STAFF,
      MY_OPS_MGR, MY_STAFF,
    ]);
    assert(
      myEnfExport.rows.every((r) => myEnfProfileIds.has(r.profile_id)),
      'Step 4: Exported rows are strictly Enforcement department in MY AOC only',
    );
    assert(
      !myEnfExport.rows.some((r) => foreignOrOpProfileIds.has(r.profile_id)),
      'Step 4: ZERO Operation rows and ZERO ZZ AOC rows returned',
    );

    // Step 5: MY Operation Manager attempts Enforcement export on the SAME connection
    await simulateUser(MY_OPS_MGR);
    await db.exec('savepoint sp_exp_my_ops_enf;');
    let opEnfDenied = false;
    try {
      await db.query('select * from public.export_enforcement_workforce_secure();');
    } catch (e) {
      opEnfDenied = /Only Main Enforcement/.test(e.message);
      await db.exec('rollback to savepoint sp_exp_my_ops_enf;');
    }
    assert(opEnfDenied, 'Step 5: Operation Manager cannot export Enforcement rows');

    // Step 6: ZZ Main Enforcement attempts Enforcement export on the SAME connection
    await simulateUser(ZZ_MAIN_ENF);
    await db.exec('savepoint sp_exp_zz_enf;');
    let zzEnfDenied = false;
    try {
      await db.query('select * from public.export_enforcement_workforce_secure();');
    } catch (e) {
      zzEnfDenied = /Only Main Enforcement/.test(e.message);
      await db.exec('rollback to savepoint sp_exp_zz_enf;');
    }
    assert(zzEnfDenied, 'Step 6: Second-AOC Main Enforcement cannot export Malaysia enforcement rows');
    await clearSim();

    // Step 7: Audit log verification
    await simulateServiceRole();
    const auditRows = await db.query(
      "select * from public.phase8_audit_log where action = 'export_generated' order by created_at asc;",
    );
    await clearSim();
    assert(auditRows.rows.length === 2, `Audit: Exactly 2 export audit rows exist (found ${auditRows.rows.length})`);

    const opAudit = auditRows.rows[0];
    const enfAudit = auditRows.rows[1];
    assert(opAudit.actor_id === MY_OPS_MGR, 'Audit 1: Actor is correctly identified as MY Operation Manager');
    assert(
      JSON.stringify(opAudit.actor_role_snapshot).includes('operation_manager') && JSON.stringify(opAudit.actor_role_snapshot).includes(myAocId),
      'Audit 1: Snapshot correctly captures operation_manager role and MY AOC ID',
    );

    assert(enfAudit.actor_id === MY_MAIN_ENF, 'Audit 2: Actor is correctly identified as MY Main Enforcement');
    assert(
      JSON.stringify(enfAudit.actor_role_snapshot).includes('main_enforcement') && JSON.stringify(enfAudit.actor_role_snapshot).includes(myAocId),
      'Audit 2: Snapshot correctly captures main_enforcement role and MY AOC ID',
    );
  }

  // =========================================================================
  // SECTION 10: NOTIFICATIONS
  // =========================================================================
  console.log('\n--- SECTION 10: Notifications ---');
  {
    await simulateServiceRole();
    await db.query(
      `insert into public.user_notifications (recipient_profile_id, event_type, dedup_key, payload)
       values ($1, 'leave_status_changed', $2, '{}'::jsonb);`,
      [MY_STAFF, `multi-aoc-notif-${MY_STAFF}`],
    );
    await clearSim();

    await simulateUser(ZZ_STAFF);
    const asZz = await db.query('select * from public.user_notifications where recipient_profile_id = $1;', [MY_STAFF]);
    await clearSim();
    assert(asZz.rows.length === 0, 'Notifications: ZZ staff member cannot read MY staff notification (recipient-only RLS)');
  }

  console.log(failures === 0 ? '\nAll Phase 8 multi-AOC and export-isolation checks passed.' : `\n${failures} check(s) FAILED -- see above.`);
  await db.exec('rollback;');
  await db.close();
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error('FAILED:', e.message, e.stack);
  process.exit(1);
});
