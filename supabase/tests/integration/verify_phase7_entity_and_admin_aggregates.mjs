// Phase 7 closure: entity-scoped (MAA/AAX Boss/Admin) and Super Admin
// technical-status RPC verification. Same real-SQL-execution pattern as
// verify_phase7_dashboard_aggregates.mjs. Confirms:
//   1. MAA Boss sees ONLY staff with an active MAA membership, never AAX
//      staff, even when both work the same station.
//   2. AAX Boss sees ONLY staff with an active AAX membership.
//   3. A staff member with NO active entity membership at all is excluded
//      from BOTH entity views -- fails closed, never counted as
//      "unclassified -> visible anyway".
//   4. resolve_ops_dashboard_station_scope() now REJECTS maa_boss/aax_boss
//      (they must use the entity-scoped function instead of silently
//      getting a Malaysia-wide figure -- the bug this migration fixes).
//   5. MAA Admin's directory count matches only MAA's active membership
//      count, and is entity-labeled.
//   6. Super Admin's technical status is reachable only by super_admin,
//      and a non-super-admin caller (even Operation Manager) is denied.
//
// Run from this directory, AFTER `node migrate.mjs`:
//   node verify_phase7_entity_and_admin_aggregates.mjs
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { assertDisposableLocalTarget } from './safeguards.mjs';

const { Client } = pg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_DATA_DIR = path.join(__dirname, 'pgdata');
const RUN_DATA_DIR = path.join(__dirname, 'pgdata_phase7_entity_run');

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
  const runDb = 'vecta_phase7_entity_run';

  let db;

  if (isNative) {
    assertDisposableLocalTarget(pgConfig, goldenDb, runDb);
    console.log(`=== Running Phase 7 Entity/Admin Aggregate Verification against Native PostgreSQL (${pgConfig.host}:${pgConfig.port}) ===`);
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
    console.log('=== Running Phase 7 Entity/Admin Aggregate Verification against PGlite embedded engine ===');
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

  const MAA_STAFF = '00000000-0000-0000-0000-0000000000e1';
  const AAX_STAFF = '00000000-0000-0000-0000-0000000000e2';
  const NO_ENTITY_STAFF = '00000000-0000-0000-0000-0000000000e3';
  const MAA_BOSS = '00000000-0000-0000-0000-0000000000e4';
  const AAX_BOSS = '00000000-0000-0000-0000-0000000000e5';
  const MAA_ADMIN = '00000000-0000-0000-0000-0000000000e6';
  const SUPER_ADMIN = '00000000-0000-0000-0000-0000000000e7';
  const OPS_MGR = '00000000-0000-0000-0000-0000000000e8';
  const GRANTER = '00000000-0000-0000-0000-0000000000e9';

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

  await db.exec(`
    insert into auth.users (id, email) values
      ('${MAA_STAFF}', 'p7c-maa-staff@example.test'),
      ('${AAX_STAFF}', 'p7c-aax-staff@example.test'),
      ('${NO_ENTITY_STAFF}', 'p7c-no-entity-staff@example.test'),
      ('${MAA_BOSS}', 'p7c-maa-boss@example.test'),
      ('${AAX_BOSS}', 'p7c-aax-boss@example.test'),
      ('${MAA_ADMIN}', 'p7c-maa-admin@example.test'),
      ('${SUPER_ADMIN}', 'p7c-super-admin@example.test'),
      ('${OPS_MGR}', 'p7c-ops-mgr@example.test'),
      ('${GRANTER}', 'p7c-granter@example.test')
    on conflict (id) do nothing;
    insert into public.profiles (id, email, name, staff_no, role, station, team, ops_group, status)
    values
      ('${MAA_STAFF}', 'p7c-maa-staff@example.test', 'P7C MAA Staff', 'T-C1', 'ASO', 'KUL - MAA', 'Alpha', 'operation_avsec', 'approved'),
      ('${AAX_STAFF}', 'p7c-aax-staff@example.test', 'P7C AAX Staff', 'T-C2', 'ASO', 'KUL - MAA', 'Alpha', 'operation_avsec', 'approved'),
      ('${NO_ENTITY_STAFF}', 'p7c-no-entity-staff@example.test', 'P7C No Entity Staff', 'T-C3', 'ASO', 'KUL - MAA', 'Alpha', 'operation_avsec', 'approved'),
      ('${MAA_BOSS}', 'p7c-maa-boss@example.test', 'P7C MAA Boss', 'T-C4', 'MANAGEMENT', null, null, 'operation_avsec', 'approved'),
      ('${AAX_BOSS}', 'p7c-aax-boss@example.test', 'P7C AAX Boss', 'T-C5', 'MANAGEMENT', null, null, 'operation_avsec', 'approved'),
      ('${MAA_ADMIN}', 'p7c-maa-admin@example.test', 'P7C MAA Admin', 'T-C6', 'MANAGEMENT', null, null, 'operation_avsec', 'approved'),
      ('${SUPER_ADMIN}', 'p7c-super-admin@example.test', 'P7C Super Admin', 'T-C7', 'ADMIN', null, null, 'operation_avsec', 'approved'),
      ('${OPS_MGR}', 'p7c-ops-mgr@example.test', 'P7C Ops Mgr', 'T-C8', 'MANAGEMENT', null, null, 'operation_avsec', 'approved'),
      ('${GRANTER}', 'p7c-granter@example.test', 'P7C Granter', 'T-C9', 'ADMIN', null, null, 'operation_avsec', 'approved')
    on conflict (id) do update set
      name = excluded.name, staff_no = excluded.staff_no, role = excluded.role,
      station = excluded.station, team = excluded.team, ops_group = excluded.ops_group, status = excluded.status;
  `);

  const aocId = (await db.query("select id from public.aocs where code = 'MY';")).rows[0].id;
  const maaEntityId = (await db.query("select id from public.operating_entities where aoc_id = $1 and code = 'MAA';", [aocId])).rows[0].id;
  const aaxEntityId = (await db.query("select id from public.operating_entities where aoc_id = $1 and code = 'AAX';", [aocId])).rows[0].id;
  const operationDeptId = (await db.query("select id from public.departments where aoc_id = $1 and code = 'operation';", [aocId])).rows[0].id;

  const maaBossRoleId = (await db.query("select id from public.role_definitions where code = 'maa_boss';")).rows[0].id;
  const aaxBossRoleId = (await db.query("select id from public.role_definitions where code = 'aax_boss';")).rows[0].id;
  const maaAdminRoleId = (await db.query("select id from public.role_definitions where code = 'maa_admin';")).rows[0].id;
  const superAdminRoleId = (await db.query("select id from public.role_definitions where code = 'super_admin';")).rows[0].id;
  const opsMgrRoleId = (await db.query("select id from public.role_definitions where code = 'operation_manager';")).rows[0].id;

  // Entity memberships for the STAFF (not the bosses -- staffing rows are
  // per-staff-member, scoped via their own membership).
  await db.query(
    `insert into public.user_entity_memberships (profile_id, aoc_id, operating_entity_id, status, is_primary)
     values ($1, $2, $3, 'active', true), ($4, $2, $5, 'active', true);`,
    [MAA_STAFF, aocId, maaEntityId, AAX_STAFF, aaxEntityId],
  );
  // NO_ENTITY_STAFF gets no membership row at all -- must fail closed.

  await db.query(
    `insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, operating_entity_id, granted_by, grant_reason)
     values ($1, $2, $3, $4, $5, 'phase7 closure test fixture'),
            ($6, $7, $3, $8, $5, 'phase7 closure test fixture');`,
    [MAA_BOSS, maaBossRoleId, aocId, maaEntityId, GRANTER, AAX_BOSS, aaxBossRoleId, aaxEntityId],
  );
  await db.query(
    `insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, operating_entity_id, granted_by, grant_reason)
     values ($1, $2, $3, $4, $5, 'phase7 closure test fixture');`,
    [MAA_ADMIN, maaAdminRoleId, aocId, maaEntityId, GRANTER],
  );
  await db.query(
    `insert into public.user_role_assignments (profile_id, role_definition_id, granted_by, grant_reason)
     values ($1, $2, $3, 'phase7 closure test fixture');`,
    [SUPER_ADMIN, superAdminRoleId, GRANTER],
  );
  await db.query(
    `insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, granted_by, grant_reason)
     values ($1, $2, $3, $4, $5, 'phase7 closure test fixture');`,
    [OPS_MGR, opsMgrRoleId, aocId, operationDeptId, GRANTER],
  );

  const today = (await db.query('select current_date as d;')).rows[0].d;
  await db.query(
    `insert into public.duty_records (profile_id, station, team, duty_date, shift_code, status) values
       ($1, 'KUL - MAA', 'Alpha', $4, 'A', 'present'),
       ($2, 'KUL - MAA', 'Alpha', $4, 'B', 'present'),
       ($3, 'KUL - MAA', 'Alpha', $4, 'C', 'present');`,
    [MAA_STAFF, AAX_STAFF, NO_ENTITY_STAFF, today],
  );

  // --- 1/2/3: entity isolation + fail-closed for no-membership staff ---
  await simulateUser(MAA_BOSS);
  const maaResult = await db.query('select * from public.get_entity_dashboard_aggregate_secure($1);', [today]);
  await clearSim();
  assert(maaResult.rows[0].entity_code === 'MAA', 'MAA Boss gets an MAA-labeled result');
  assert(Number(maaResult.rows[0].total_staff) === 1, `MAA Boss sees exactly the 1 MAA-membership staff member, not AAX or no-membership staff (found ${maaResult.rows[0].total_staff})`);

  await simulateUser(AAX_BOSS);
  const aaxResult = await db.query('select * from public.get_entity_dashboard_aggregate_secure($1);', [today]);
  await clearSim();
  assert(aaxResult.rows[0].entity_code === 'AAX', 'AAX Boss gets an AAX-labeled result');
  assert(Number(aaxResult.rows[0].total_staff) === 1, `AAX Boss sees exactly the 1 AAX-membership staff member (found ${aaxResult.rows[0].total_staff})`);

  // --- 4: resolve_ops_dashboard_station_scope() now rejects MAA/AAX Boss ---
  await simulateUser(MAA_BOSS);
  await db.exec('savepoint sp_maa_boss_wrong_fn;');
  let maaBossRejected = false;
  try {
    await db.query('select * from public.get_ops_dashboard_aggregate_secure($1);', [today]);
  } catch (e) {
    maaBossRejected = /maa\/aax boss and admin roles use the entity-scoped dashboard functions/.test(e.message);
    await db.exec('rollback to savepoint sp_maa_boss_wrong_fn;');
  }
  await clearSim();
  assert(maaBossRejected, 'MAA Boss calling the STATION-scoped function is rejected, not silently given a Malaysia-wide figure (the bug this migration fixes)');

  // --- 5: MAA Admin directory summary ---
  await simulateUser(MAA_ADMIN);
  const maaAdminResult = await db.query('select * from public.get_entity_admin_summary_secure();');
  await clearSim();
  assert(maaAdminResult.rows[0].entity_code === 'MAA', 'MAA Admin gets an MAA-labeled directory summary');
  assert(Number(maaAdminResult.rows[0].active_staff_count) === 1, `MAA Admin's active_staff_count matches only MAA's 1 active membership (found ${maaAdminResult.rows[0].active_staff_count})`);

  // --- 6: Super Admin technical status, denied to everyone else ---
  await simulateUser(SUPER_ADMIN);
  const superAdminStatus = await db.query('select * from public.get_super_admin_technical_status_secure();');
  await clearSim();
  assert(superAdminStatus.rows.length === 1, 'Super Admin can call the technical-status RPC');

  await simulateUser(OPS_MGR);
  await db.exec('savepoint sp_ops_mgr_denied;');
  let opsMgrDeniedTechStatus = false;
  try {
    await db.query('select * from public.get_super_admin_technical_status_secure();');
  } catch (e) {
    opsMgrDeniedTechStatus = /caller holds no super_admin assignment/.test(e.message);
    await db.exec('rollback to savepoint sp_ops_mgr_denied;');
  }
  await clearSim();
  assert(opsMgrDeniedTechStatus, 'Operation Manager (a real, active, non-super-admin role) is denied the Super Admin technical-status RPC');

  console.log('\nAll Phase 7 entity/admin-aggregate checks passed.');
  await db.exec('rollback;');
  await db.close();
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
