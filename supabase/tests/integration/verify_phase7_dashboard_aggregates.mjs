// Phase 7 dashboard aggregate RPC verification (genuine SQL execution
// against a fresh copy of the migrated database, same pattern as
// verify_export_isolation.mjs). Confirms, for
// resolve_ops_dashboard_station_scope() / get_ops_dashboard_aggregate_secure()
// / get_ops_dashboard_hub_breakdown_secure():
//   1. A station-scoped role (ASO at a specific station) sees ONLY duty
//      records at its own station -- never another station's.
//   2. A Malaysia-wide role (Operation Manager) sees every station's duty
//      records, not just its own.
//   3. An international role (AirAsia Management) sees the same
//      Malaysia-wide totals -- confirms the "unrestricted" scope_kind.
//   4. Super Admin gets an explicit authorization failure, never a silent
//      empty/zero result -- "no automatic operational report access" is
//      enforced, not just documented.
//   5. A profile with NO active role assignment at all also gets an
//      explicit authorization failure, not a silent global or empty view.
//   6. Small-group suppression: a station with fewer than 3 duty records
//      is folded into 'combined_below_threshold' in the hub breakdown, not
//      shown as its own (near-identifying) row.
//
// Run from this directory, AFTER `node migrate.mjs`:
//   node verify_phase7_dashboard_aggregates.mjs
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { assertDisposableLocalTarget } from './safeguards.mjs';

const { Client } = pg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_DATA_DIR = path.join(__dirname, 'pgdata');
const RUN_DATA_DIR = path.join(__dirname, 'pgdata_phase7_aggregates_run');

function copyDir(src, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true });
}

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + msg);
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
  const runDb = 'vecta_phase7_aggregates_run';

  let db;

  if (isNative) {
    assertDisposableLocalTarget(pgConfig, goldenDb, runDb);
    console.log(`=== Running Phase 7 Aggregate Verification against Native PostgreSQL (${pgConfig.host}:${pgConfig.port}) ===`);
    const admin = new Client({ ...pgConfig, database: 'postgres' });
    await admin.connect();
    await admin.query(`
      select pg_terminate_backend(pid) from pg_stat_activity
      where datname = '${runDb}' and pid <> pg_backend_pid();
    `);
    await admin.query(`drop database if exists ${runDb};`);
    await admin.query(`create database ${runDb} template ${goldenDb};`);

    const client = new Client({ ...pgConfig, database: runDb });
    await client.connect();

    db = {
      exec: (sql) => client.query(sql),
      query: (sql, params) => client.query(sql, params),
      close: async () => {
        await client.end();
        await admin.query(`
          select pg_terminate_backend(pid) from pg_stat_activity
          where datname = '${runDb}' and pid <> pg_backend_pid();
        `);
        await admin.query(`drop database if exists ${runDb};`);
        await admin.end();
      },
    };
  } else {
    console.log('=== Running Phase 7 Aggregate Verification against PGlite embedded engine ===');
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

  const PEN_ASO = '00000000-0000-0000-0000-0000000000f1';
  const OPS_MGR = '00000000-0000-0000-0000-0000000000f2';
  const AA_MGMT = '00000000-0000-0000-0000-0000000000f3';
  const SUPER_ADMIN = '00000000-0000-0000-0000-0000000000f4';
  const NO_ROLE = '00000000-0000-0000-0000-0000000000f5';
  const GRANTER = '00000000-0000-0000-0000-0000000000f6';

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
  function simulateUser(id) {
    return db.query('select pg_temp.simulate_user($1);', [id]);
  }
  function simulateServiceRole() {
    return db.exec('select pg_temp.simulate_service_role();');
  }
  async function clearSim() {
    await db.exec('select pg_temp.clear_simulation();');
  }

  await simulateServiceRole();

  // --- Fixture setup ---
  await db.exec(`
    insert into auth.users (id, email) values
      ('${PEN_ASO}', 'p7-pen-aso@example.test'),
      ('${OPS_MGR}', 'p7-ops-mgr@example.test'),
      ('${AA_MGMT}', 'p7-aa-mgmt@example.test'),
      ('${SUPER_ADMIN}', 'p7-super-admin@example.test'),
      ('${NO_ROLE}', 'p7-no-role@example.test'),
      ('${GRANTER}', 'p7-granter@example.test')
    on conflict (id) do nothing;
    insert into public.profiles (id, email, name, staff_no, role, station, team, ops_group, status)
    values
      ('${PEN_ASO}', 'p7-pen-aso@example.test', 'P7 PEN ASO', 'T-P7A', 'ASO', 'PEN', 'Alpha', 'operation_avsec', 'approved'),
      ('${OPS_MGR}', 'p7-ops-mgr@example.test', 'P7 Ops Mgr', 'T-P7B', 'MANAGEMENT', null, null, 'operation_avsec', 'approved'),
      ('${AA_MGMT}', 'p7-aa-mgmt@example.test', 'P7 AA Mgmt', 'T-P7C', 'MANAGEMENT', null, null, 'operation_avsec', 'approved'),
      ('${SUPER_ADMIN}', 'p7-super-admin@example.test', 'P7 Super Admin', 'T-P7D', 'ADMIN', null, null, 'operation_avsec', 'approved'),
      ('${NO_ROLE}', 'p7-no-role@example.test', 'P7 No Role', 'T-P7E', 'ASO', 'KUL - MAA', 'Bravo', 'operation_avsec', 'approved'),
      ('${GRANTER}', 'p7-granter@example.test', 'P7 Granter', 'T-P7F', 'ADMIN', null, null, 'operation_avsec', 'approved')
    on conflict (id) do update set
      name = excluded.name, staff_no = excluded.staff_no, role = excluded.role,
      station = excluded.station, team = excluded.team, ops_group = excluded.ops_group, status = excluded.status;
  `);

  const aocId = (await db.query("select id from public.aocs where code = 'MY';")).rows[0].id;
  const maaEntityId = (await db.query("select id from public.operating_entities where aoc_id = $1 and code = 'MAA';", [aocId])).rows[0].id;
  const penStationId = (await db.query("select id from public.org_stations where code = 'PEN';")).rows[0].id;
  const kulStationId = (await db.query("select id from public.org_stations where code = 'KUL - MAA';")).rows[0].id;
  const penHubId = (await db.query('select hub_id from public.org_stations where id = $1;', [penStationId])).rows[0].hub_id;
  const operationDeptId = (await db.query("select id from public.departments where aoc_id = $1 and code = 'operation';", [aocId])).rows[0].id;
  const penTeamId = (
    await db.query(
      `insert into public.org_teams (station_id, name) values ($1, 'Alpha')
       on conflict (station_id, name) do update set name = excluded.name
       returning id;`,
      [penStationId],
    )
  ).rows[0].id;

  const asoRoleId = (await db.query("select id from public.role_definitions where code = 'aso';")).rows[0].id;
  const opsMgrRoleId = (await db.query("select id from public.role_definitions where code = 'operation_manager';")).rows[0].id;
  const aaMgmtRoleId = (await db.query("select id from public.role_definitions where code = 'airasia_management';")).rows[0].id;
  const superAdminRoleId = (await db.query("select id from public.role_definitions where code = 'super_admin';")).rows[0].id;

  // ASO is an entity-administered role (Phase 4 trigger) -- needs an active
  // user_entity_memberships row before user_role_assignments will accept it.
  const penMembership = await db.query(
    `insert into public.user_entity_memberships (profile_id, aoc_id, operating_entity_id, status, is_primary)
     values ($1, $2, $3, 'active', true) returning id;`,
    [PEN_ASO, aocId, maaEntityId],
  );
  const penMembershipId = penMembership.rows[0].id;

  await db.query(
    `insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, hub_id, station_id, team_id, entity_membership_id, granted_by, grant_reason)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'phase7 test fixture');`,
    [PEN_ASO, asoRoleId, aocId, operationDeptId, penHubId, penStationId, penTeamId, penMembershipId, GRANTER],
  );
  await db.query(
    `insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, granted_by, grant_reason)
     values ($1, $2, $3, $4, $5, 'phase7 test fixture');`,
    [OPS_MGR, opsMgrRoleId, aocId, operationDeptId, GRANTER],
  );
  await db.query(
    `insert into public.user_role_assignments (profile_id, role_definition_id, granted_by, grant_reason)
     values ($1, $2, $3, 'phase7 test fixture');`,
    [AA_MGMT, aaMgmtRoleId, GRANTER],
  );
  await db.query(
    `insert into public.user_role_assignments (profile_id, role_definition_id, granted_by, grant_reason)
     values ($1, $2, $3, 'phase7 test fixture');`,
    [SUPER_ADMIN, superAdminRoleId, GRANTER],
  );
  // NO_ROLE gets no user_role_assignments row at all.

  // Duty records: 4 at PEN (>= suppression threshold), 1 at KUL - MAA
  // (below threshold -- must be suppressed into 'combined_below_threshold').
  const today = (await db.query('select current_date as d;')).rows[0].d;
  for (const shiftCode of ['A', 'B', 'C', 'D']) {
    await db.query(
      `insert into public.duty_records (profile_id, station, team, duty_date, shift_code, status)
       values ($1, 'PEN', 'Alpha', $2, $3, 'present');`,
      [PEN_ASO, today, shiftCode],
    );
  }
  await db.query(
    `insert into public.duty_records (profile_id, station, team, duty_date, shift_code, status)
     values ($1, 'KUL - MAA', 'Bravo', $2, 'A', 'present');`,
    [NO_ROLE, today],
  );

  // --- 1. Station-scoped role sees only its own station ---
  await simulateUser(PEN_ASO);
  const penSummary = await db.query('select * from public.get_ops_dashboard_aggregate_secure($1);', [today]);
  await clearSim();
  assert(penSummary.rows[0].scope_kind === 'station_scoped', "PEN ASO's aggregate is station_scoped, not unrestricted");
  assert(Number(penSummary.rows[0].total_staff) === 4, `PEN ASO sees exactly its own station's 4 duty records (found ${penSummary.rows[0].total_staff})`);

  // --- 2. Malaysia-wide role (Operation Manager) sees every station ---
  await simulateUser(OPS_MGR);
  const opsMgrSummary = await db.query('select * from public.get_ops_dashboard_aggregate_secure($1);', [today]);
  await clearSim();
  assert(opsMgrSummary.rows[0].scope_kind === 'unrestricted', 'Operation Manager gets an unrestricted (Malaysia-wide) scope');
  assert(Number(opsMgrSummary.rows[0].total_staff) === 5, `Operation Manager sees all 5 duty records across stations (found ${opsMgrSummary.rows[0].total_staff})`);

  // --- 3. International role sees the same Malaysia-wide totals ---
  await simulateUser(AA_MGMT);
  const aaSummary = await db.query('select * from public.get_ops_dashboard_aggregate_secure($1);', [today]);
  await clearSim();
  assert(aaSummary.rows[0].scope_kind === 'unrestricted', 'AirAsia Management gets an unrestricted (Malaysia-wide) scope');
  assert(Number(aaSummary.rows[0].total_staff) === 5, `AirAsia Management sees all 5 duty records (found ${aaSummary.rows[0].total_staff})`);

  // --- 4. Super Admin explicitly denied, not silently empty ---
  await simulateUser(SUPER_ADMIN);
  await db.exec('savepoint sp_super_admin;');
  let superAdminDenied = false;
  try {
    await db.query('select * from public.get_ops_dashboard_aggregate_secure($1);', [today]);
  } catch (e) {
    superAdminDenied = /super_admin has no automatic operational dashboard access/.test(e.message);
    await db.exec('rollback to savepoint sp_super_admin;');
  }
  await clearSim();
  assert(superAdminDenied, 'Super Admin gets an explicit authorization error, not a silent empty/global result');

  // --- 5. No active assignment at all -> explicit denial, not implicit global/empty ---
  await simulateUser(NO_ROLE);
  await db.exec('savepoint sp_no_role;');
  let noRoleDenied = false;
  try {
    await db.query('select * from public.get_ops_dashboard_aggregate_secure($1);', [today]);
  } catch (e) {
    noRoleDenied = /no active role assignment grants operational dashboard access/.test(e.message);
    await db.exec('rollback to savepoint sp_no_role;');
  }
  await clearSim();
  assert(noRoleDenied, 'A profile with no active role assignment gets an explicit denial, not a silent global or empty view');

  // --- 6. Small-group suppression on the hub breakdown ---
  await simulateUser(OPS_MGR);
  const breakdown = await db.query('select * from public.get_ops_dashboard_hub_breakdown_secure($1);', [today]);
  await clearSim();
  const kulHubRow = breakdown.rows.find((r) => r.hub_code === 'kul');
  assert(!kulHubRow, "the 1-record KUL hub is never shown as its own row (would be a near-identifying disclosure)");
  const combinedRow = breakdown.rows.find((r) => r.hub_code === 'combined_below_threshold');
  assert(!!combinedRow && Number(combinedRow.total_staff) === 1, `the 1-record KUL hub is folded into 'combined_below_threshold' (found ${combinedRow?.total_staff})`);
  const northernHubRow = breakdown.rows.find((r) => r.hub_code === 'northern');
  assert(!!northernHubRow && Number(northernHubRow.total_staff) === 4, `the 4-record PEN (northern hub) row is shown individually, not suppressed (found ${northernHubRow?.total_staff})`);

  console.log('\nAll Phase 7 dashboard-aggregate checks passed.');
  await db.exec('rollback;');
  await db.close();
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
