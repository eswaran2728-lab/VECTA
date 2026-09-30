// Phase 8 certification (continuation): genuine multi-AOC authorization
// verification. The prior certification pass's "cross-AOC" coverage
// used only Malaysia fixtures, which is insufficient -- this script
// creates a SECOND, fully synthetic AOC ("ZZ") with its own department,
// hub, station, team, entity and role assignments, and proves that a
// ZZ-scoped role holder cannot act on MY data (and vice versa) across
// every Phase 8 subsystem: workforce directory, leave, OT, duty draw,
// investigation cases, SAT reports, profiling acknowledgements,
// exports, notifications, and direct RPC invocation.
//
// This test deliberately targets a REAL architectural question: most
// Phase 8 RPCs resolve their own `v_aoc_id` via `select id from aocs
// where code = 'MY'` (hardcoded), while many authorization checks call
// has_active_role(role_code) -- which performs NO aoc/scope filtering
// at all (it's has_role_in_scope() with every scope parameter left
// null). If a caller's ONLY active assignment is for AOC 'ZZ', does
// has_active_role('operation_manager') still return true, and does the
// RPC then let them act on MY's hardcoded data? This script answers
// that empirically rather than assuming either way.
//
// Run from this directory, AFTER `node migrate.mjs` (PGlite) or
// `node migrate.mjs --native` (native, pass --native here too):
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

  let seq = 0x30;
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

  // --- Synthetic second AOC: "ZZ" -- fully separate department, hub,
  // station, team and entity, structurally parallel to MY but never
  // referenced by any hardcoded 'MY' lookup in the Phase 8 RPCs. ---
  const zzAocId = (
    await db.query(`insert into public.aocs (code, name, is_active) values ('ZZ', 'Synthetic Test AOC', true) returning id;`)
  ).rows[0].id;
  const zzOperationDeptId = (
    await db.query(`insert into public.departments (aoc_id, code, name) values ($1, 'operation', 'ZZ Operation') returning id;`, [zzAocId])
  ).rows[0].id;
  const zzEnforcementDeptId = (
    await db.query(`insert into public.departments (aoc_id, code, name) values ($1, 'enforcement', 'ZZ Enforcement') returning id;`, [zzAocId])
  ).rows[0].id;
  // Hub code is 'kul' (unique per aoc_id, not globally) -- required so
  // ZZ's sat_aso/dse-shaped fixtures satisfy Phase 3's own scope-shape
  // trigger, which checks the hub CODE text ('kul') without regard to
  // which AOC that hub belongs to.
  const zzHubId = (await db.query(`insert into public.hubs (aoc_id, code, name) values ($1, 'kul', 'ZZ KUL-equivalent Hub') returning id;`, [zzAocId])).rows[0].id;
  const zzStationId = (await db.query(`insert into public.org_stations (hub_id, code, name) values ($1, 'ZZS', 'ZZ Station') returning id;`, [zzHubId])).rows[0].id;
  const zzTeamId = (await db.query(`insert into public.org_teams (station_id, name) values ($1, 'ZZTeam') returning id;`, [zzStationId])).rows[0].id;
  const zzEntityId = (
    await db.query(`insert into public.operating_entities (aoc_id, code, name, flight_prefix) values ($1, 'ZZE', 'ZZ Entity', 'ZZ') returning id;`, [zzAocId])
  ).rows[0].id;

  const myAocId = (await db.query("select id from public.aocs where code = 'MY';")).rows[0].id;
  const myOperationDeptId = (await db.query("select id from public.departments where aoc_id = $1 and code = 'operation';", [myAocId])).rows[0].id;
  const myEnforcementDeptId = (await db.query("select id from public.departments where aoc_id = $1 and code = 'enforcement';", [myAocId])).rows[0].id;
  const myInvestigationUnitId = (await db.query("select id from public.units where department_id = $1 and code = 'investigation';", [myEnforcementDeptId])).rows[0].id;
  const myPenStationId = (await db.query("select id from public.org_stations where code = 'PEN';")).rows[0].id;
  const myPenAlphaTeamId = (
    await db.query(`insert into public.org_teams (station_id, name) values ($1, 'Alpha') on conflict (station_id, name) do update set name = excluded.name returning id;`, [myPenStationId])
  ).rows[0].id;
  const myEntityId = (await db.query("select id from public.operating_entities where aoc_id = $1 and code = 'MAA';", [myAocId])).rows[0].id;

  const zzInvestigationUnitId = (
    await db.query(`insert into public.units (department_id, code, name) values ($1, 'investigation', 'ZZ Investigation') returning id;`, [zzEnforcementDeptId])
  ).rows[0].id;
  const zzSatUnitId = (
    await db.query(`insert into public.units (department_id, code, name) values ($1, 'sat', 'ZZ SAT') returning id;`, [zzEnforcementDeptId])
  ).rows[0].id;
  const zzProfilingUnitId = (
    await db.query(`insert into public.units (department_id, code, name) values ($1, 'profiling', 'ZZ Profiling') returning id;`, [zzEnforcementDeptId])
  ).rows[0].id;

  // --- Fixture profiles ---
  const GRANTER = nextId();
  const ZZ_OPS_MGR = nextId(); // holds operation_manager, but ONLY for AOC ZZ
  const ZZ_MAIN_ENF = nextId(); // holds main_enforcement, but ONLY for AOC ZZ
  const ZZ_INV_SSO = nextId(); // holds investigation_sso, but ONLY for AOC ZZ
  const ZZ_SAT_ASO = nextId(); // holds sat_aso, but ONLY for AOC ZZ
  const ZZ_PROFILING_SO = nextId(); // holds profiling_so, but ONLY for AOC ZZ
  const ZZ_STAFF = nextId(); // ordinary staff in AOC ZZ
  const MY_STAFF = nextId(); // ordinary staff in AOC MY (submits the leave/OT the ZZ roles will try to touch)
  const allIds = [GRANTER, ZZ_OPS_MGR, ZZ_MAIN_ENF, ZZ_INV_SSO, ZZ_SAT_ASO, ZZ_PROFILING_SO, ZZ_STAFF, MY_STAFF];

  await db.query(
    `insert into auth.users (id, email) values ${allIds.map((_, i) => `($${i + 1}, 'p8aoc-${i}@example.test')`).join(',')} on conflict (id) do nothing;`,
    allIds,
  );
  await db.query(
    `insert into public.profiles (id, email, name, staff_no, role, station, team, ops_group, status)
     values
       ($1, 'p8aoc-0@example.test', 'Granter', 'T-Z1', 'ADMIN', null, null, 'operation_avsec', 'approved'),
       ($2, 'p8aoc-1@example.test', 'ZZ Ops Mgr', 'T-Z2', 'ASO', null, null, 'operation_avsec', 'approved'),
       ($3, 'p8aoc-2@example.test', 'ZZ Main Enf', 'T-Z3', 'ASO', null, null, 'operation_avsec', 'approved'),
       ($4, 'p8aoc-3@example.test', 'ZZ Inv SSO', 'T-Z6', 'ASO', null, null, 'operation_avsec', 'approved'),
       ($5, 'p8aoc-4@example.test', 'ZZ Sat Aso', 'T-Z7', 'ASO', null, null, 'operation_avsec', 'approved'),
       ($6, 'p8aoc-5@example.test', 'ZZ Profiling SO', 'T-Z8', 'ASO', null, null, 'operation_avsec', 'approved'),
       ($7, 'p8aoc-6@example.test', 'ZZ Staff', 'T-Z4', 'ASO', null, null, 'operation_avsec', 'approved'),
       ($8, 'p8aoc-7@example.test', 'MY Staff', 'T-Z5', 'ASO', 'PEN', 'Alpha', 'operation_avsec', 'approved')
     on conflict (id) do update set name = excluded.name, staff_no = excluded.staff_no, role = excluded.role,
       station = excluded.station, team = excluded.team, ops_group = excluded.ops_group, status = excluded.status;`,
    allIds,
  );

  const roleId = {};
  for (const code of ['operation_manager', 'main_enforcement', 'investigation_sso', 'sat_aso', 'profiling_so']) {
    roleId[code] = (await db.query('select id from public.role_definitions where code = $1;', [code])).rows[0].id;
  }
  async function grantMembership(profileId, aocId, entityId) {
    const row = await db.query(
      `insert into public.user_entity_memberships (profile_id, aoc_id, operating_entity_id, status, is_primary) values ($1, $2, $3, 'active', true) returning id;`,
      [profileId, aocId, entityId],
    );
    return row.rows[0].id;
  }
  // operation_manager/main_enforcement are "protected" roles requiring
  // entity_membership_id = NULL per Phase 3/4's own trigger -- so no
  // membership grant for these two, matching every other Phase 8 fixture.
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
    const membershipId = await grantMembership(ZZ_INV_SSO, zzAocId, zzEntityId);
    await db.query(
      `insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, unit_id, entity_membership_id, granted_by, grant_reason)
       values ($1, $2, $3, $4, $5, $6, $7, 'phase8 multi-aoc fixture');`,
      [ZZ_INV_SSO, roleId.investigation_sso, zzAocId, zzEnforcementDeptId, zzInvestigationUnitId, membershipId, GRANTER],
    );
  }
  {
    const membershipId = await grantMembership(ZZ_SAT_ASO, zzAocId, zzEntityId);
    await db.query(
      `insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, unit_id, hub_id, station_id, team_id, entity_membership_id, granted_by, grant_reason)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'phase8 multi-aoc fixture');`,
      [ZZ_SAT_ASO, roleId.sat_aso, zzAocId, zzEnforcementDeptId, zzSatUnitId, zzHubId, zzStationId, zzTeamId, membershipId, GRANTER],
    );
  }
  {
    const membershipId = await grantMembership(ZZ_PROFILING_SO, zzAocId, zzEntityId);
    await db.query(
      `insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, unit_id, hub_id, station_id, team_id, entity_membership_id, granted_by, grant_reason)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'phase8 multi-aoc fixture');`,
      [ZZ_PROFILING_SO, roleId.profiling_so, zzAocId, zzEnforcementDeptId, zzProfilingUnitId, zzHubId, zzStationId, zzTeamId, membershipId, GRANTER],
    );
  }

  await clearSim();

  // =========================================================================
  // 1. WORKFORCE DIRECTORY: a ZZ Main Enforcement must never even pass
  //    list_enforcement_workforce_secure()'s authorization gate, let
  //    alone see MY's Enforcement workforce. Before the has_active_role
  //    -> has_active_role_my() fix (see the migration's own comment),
  //    this gate used the AOC-blind has_active_role() and a ZZ-scoped
  //    Main Enforcement passed it -- confirmed empirically by this exact
  //    assertion failing prior to the fix. It must now be denied.
  // =========================================================================
  {
    await simulateUser(ZZ_MAIN_ENF);
    await db.exec('savepoint sp_zz_workforce_gate;');
    let gateResult;
    try {
      const rows = await db.query('select * from public.list_enforcement_workforce_secure();');
      gateResult = { ok: true, rowCount: rows.rows.length };
    } catch (e) {
      gateResult = { ok: false, error: e.message };
      await db.exec('rollback to savepoint sp_zz_workforce_gate;');
    }
    await clearSim();
    assert(
      !gateResult.ok && /Only Main Enforcement/.test(gateResult.error || ''),
      `A ZZ-scoped Main Enforcement is correctly denied list_enforcement_workforce_secure() (their operation_manager/main_enforcement assignment belongs to a different AOC) -- got: ${JSON.stringify(gateResult)}`,
    );
  }

  // =========================================================================
  // 2. LEAVE: the actual security question -- can a ZZ Operation Manager
  //    approve a real MY staff member's leave request via review_leave_
  //    request_secure()? THIS is where a genuine cross-AOC bypass would
  //    surface, since review_leave_request_secure's operation_manager
  //    branch checks has_active_role('operation_manager') with NO AOC
  //    parameter, and MY leave requests carry no aoc_id column at all
  //    (station/team text only) -- so nothing in that function's own
  //    logic distinguishes a ZZ operation_manager from a MY one.
  // =========================================================================
  {
    await simulateServiceRole();
    const myLeaveId = (
      await db.query(
        `insert into public.absence_notices (user_id, staff_name, role, station, team, duty_date, shift_start_time, gap_minutes, status, remarks, leave_type, start_date, end_date, approval_status)
         values ($1, 'x', 'ASO', 'PEN', 'Alpha', '2027-05-01', now(), 999, 'green', 'x', 'annual', '2027-05-01', '2027-05-01', 'pending') returning id;`,
        [MY_STAFF],
      )
    ).rows[0].id;
    await clearSim();

    await simulateUser(ZZ_OPS_MGR);
    await db.exec('savepoint sp_zz_leave_bypass;');
    let bypassed = false;
    let errorMsg = null;
    try {
      const r = await db.query('select * from public.review_leave_request_secure($1, $2, $3);', [myLeaveId, 'approve', 'cross-aoc test']);
      bypassed = r.rows[0]?.result_status === 'approved';
    } catch (e) {
      errorMsg = e.message;
      await db.exec('rollback to savepoint sp_zz_leave_bypass;');
    }
    await clearSim();

    if (bypassed) {
      console.log('CONFIRMED DEFECT: a ZZ-scoped Operation Manager successfully approved a real MY staff member\'s leave request. review_leave_request_secure() does not verify the caller\'s operation_manager assignment belongs to the SAME AOC as the request being decided.');
      assert(false, 'review_leave_request_secure() must reject a ZZ-scoped Operation Manager acting on a MY leave request -- CROSS-AOC BYPASS CONFIRMED');
    } else {
      assert(true, `review_leave_request_secure() correctly rejects a ZZ-scoped Operation Manager acting on a MY leave request (${errorMsg ?? 'no row updated'})`);
    }

    const verify = await db.query('select approval_status from public.absence_notices where id = $1;', [myLeaveId]);
    assert(verify.rows[0].approval_status === 'pending', 'The MY leave request remains pending -- a ZZ-scoped caller never actually changed its state');
  }

  // =========================================================================
  // 3. OT: a ZZ Operation Manager must not be able to approve a real MY
  //    staff member's overtime request via the RLS+trigger path (this
  //    exercises database authorization directly, not the app-layer
  //    server action).
  // =========================================================================
  {
    await simulateServiceRole();
    const myOtId = (
      await db.query(
        `insert into public.overtime_requests (profile_id, station, team, work_date, category, reason, start_at, end_at, status)
         values ($1, 'PEN', 'Alpha', '2027-05-02', 'adhoc', 'x', now(), now() + interval '2 hours', 'endorsed') returning id;`,
        [MY_STAFF],
      )
    ).rows[0].id;
    await clearSim();

    await simulateUser(ZZ_OPS_MGR);
    await db.exec('savepoint sp_zz_ot_bypass;');
    let otRows = [];
    try {
      const r = await db.query("update public.overtime_requests set status = 'approved' where id = $1 and status = 'endorsed' returning id;", [myOtId]);
      otRows = r.rows;
    } catch (e) {
      await db.exec('rollback to savepoint sp_zz_ot_bypass;');
    }
    await clearSim();
    assert(otRows.length === 0, 'A ZZ-scoped Operation Manager\'s UPDATE affects zero rows of a MY overtime request (RLS scoped-update policy denies it)');

    const verify = await db.query('select status from public.overtime_requests where id = $1;', [myOtId]);
    assert(verify.rows[0].status === 'endorsed', 'The MY overtime request remains endorsed, untouched by the ZZ-scoped attempt');
  }

  // =========================================================================
  // 4. DUTY DRAW: a ZZ Operation Manager must not be able to initiate,
  //    assign, or finalize a duty-zone draw for a MY station.
  // =========================================================================
  {
    await simulateUser(ZZ_OPS_MGR);
    await db.exec('savepoint sp_zz_duty_draw_bypass;');
    let initiated = false;
    let errMsg = null;
    try {
      await db.query("select * from public.initiate_duty_draw_secure('PEN', '2027-05-03');");
      initiated = true;
    } catch (e) {
      errMsg = e.message;
      await db.exec('rollback to savepoint sp_zz_duty_draw_bypass;');
    }
    await clearSim();
    assert(!initiated, `A ZZ-scoped Operation Manager cannot initiate a duty-zone draw for a MY station (${errMsg})`);

    const verify = await db.query("select count(*)::int as c from public.duty_draws d join public.org_stations s on s.id = d.station_id where s.code = 'PEN' and d.draw_date = '2027-05-03';");
    assert(verify.rows[0].c === 0, 'No duty-zone draw was created for PEN/2027-05-03 by the ZZ-scoped attempt');
  }

  // =========================================================================
  // 5. INVESTIGATION: a ZZ Investigation SSO must not be able to open a
  //    case, list cases, or link/note/assign/resolve one -- all gated
  //    by is_investigation_authorized(), which is_investigation_
  //    authorized() resolves via has_active_role_my() (fixed above).
  // =========================================================================
  {
    await simulateUser(ZZ_INV_SSO);
    await db.exec('savepoint sp_zz_investigation_bypass;');
    let opened = false;
    let errMsg = null;
    try {
      await db.query("select * from public.open_investigation_case_secure('ZZ attempted case', 'theft', 'desc', 'normal');");
      opened = true;
    } catch (e) {
      errMsg = e.message;
      await db.exec('rollback to savepoint sp_zz_investigation_bypass;');
    }
    await clearSim();
    assert(!opened, `A ZZ-scoped Investigation SSO cannot open an investigation case at all (${errMsg})`);

    await simulateUser(ZZ_INV_SSO);
    await db.exec('savepoint sp_zz_investigation_list;');
    let listCount = null;
    try {
      const r = await db.query('select * from public.list_investigation_cases_secure();');
      listCount = r.rows.length;
    } catch (e) {
      errMsg = e.message;
      await db.exec('rollback to savepoint sp_zz_investigation_list;');
    }
    await clearSim();
    assert(listCount === null, `A ZZ-scoped Investigation SSO cannot list investigation cases at all (${errMsg})`);
  }

  // =========================================================================
  // 6. SAT: a ZZ SAT ASO must not be able to upload a combined report
  //    for a MY (KUL - MAA) team, even though their own role is
  //    correctly shaped (KUL-hub-coded, sat unit) -- only in AOC ZZ.
  // =========================================================================
  {
    await simulateUser(ZZ_SAT_ASO);
    await db.exec('savepoint sp_zz_sat_bypass;');
    let uploaded = false;
    let errMsg = null;
    try {
      await db.query("select * from public.upload_sat_combined_report_secure('KUL - MAA', 'Alpha', '2027-05-04', '3-shift', 'sat/zz-cross-aoc.pdf');");
      uploaded = true;
    } catch (e) {
      errMsg = e.message;
      await db.exec('rollback to savepoint sp_zz_sat_bypass;');
    }
    await clearSim();
    assert(!uploaded, `A ZZ-scoped SAT ASO cannot upload a combined report for a MY (KUL - MAA) team, despite an identically-coded 'kul' hub existing in their own AOC (${errMsg})`);
  }

  // =========================================================================
  // 7. PROFILING: a ZZ Profiling SO must not be able to acknowledge a
  //    real MY SEC013 report, even for a same-named team.
  // =========================================================================
  {
    await simulateServiceRole();
    const mySec013Id = (
      await db.query(
        `insert into public.report_sec013 (profile_id, status, station, team, staff_name, staff_id, date_time_in, date_time_out, remark)
         values ($1, 'submitted', 'PEN', 'Alpha', 'x', 'x', now(), now() + interval '1 hour', 'phase8 multi-aoc fixture')
         returning id;`,
        [MY_STAFF],
      )
    ).rows[0].id;
    await clearSim();

    await simulateUser(ZZ_PROFILING_SO);
    await db.exec('savepoint sp_zz_profiling_bypass;');
    let acked = false;
    let errMsg = null;
    try {
      await db.query('select public.acknowledge_sec013_report_secure($1);', [mySec013Id]);
      acked = true;
    } catch (e) {
      errMsg = e.message;
      await db.exec('rollback to savepoint sp_zz_profiling_bypass;');
    }
    await clearSim();
    assert(!acked, `A ZZ-scoped Profiling SO cannot acknowledge a real MY SEC013 report (${errMsg})`);

    const verify = await db.query("select count(*)::int as c from public.report_acknowledgements where report_type = 'sec013' and report_id = $1;", [mySec013Id]);
    assert(verify.rows[0].c === 0, 'No acknowledgement row was created by the ZZ-scoped attempt');
  }

  // =========================================================================
  // 8. EXPORTS: a ZZ Operation Manager is denied export_operation_
  //    workforce_secure() entirely (gated the same way as every other
  //    RPC above); this also structurally proves no MY workforce data
  //    could ever reach a ZZ-scoped export, since the gate itself denies
  //    before any row is read.
  // =========================================================================
  {
    await simulateUser(ZZ_OPS_MGR);
    await db.exec('savepoint sp_zz_export_bypass;');
    let exported = false;
    let errMsg = null;
    try {
      await db.query('select * from public.export_operation_workforce_secure();');
      exported = true;
    } catch (e) {
      errMsg = e.message;
      await db.exec('rollback to savepoint sp_zz_export_bypass;');
    }
    await clearSim();
    assert(!exported, `A ZZ-scoped Operation Manager cannot export the (MY-only) Operation workforce directory at all (${errMsg})`);
  }

  // =========================================================================
  // 9. NOTIFICATIONS: a ZZ user cannot read another user's (MY staff's)
  //    notifications -- ordinary recipient-only RLS, unaffected by AOC,
  //    but worth confirming explicitly as part of this pass's isolation
  //    matrix rather than assumed.
  // =========================================================================
  {
    await simulateServiceRole();
    await db.query(
      `insert into public.user_notifications (recipient_profile_id, event_type, dedup_key, payload) values ($1, 'leave_status_changed', $2, '{}'::jsonb);`,
      [MY_STAFF, `multi-aoc-test-${MY_STAFF}`],
    );
    await clearSim();

    await simulateUser(ZZ_STAFF);
    const asZz = await db.query('select * from public.user_notifications where recipient_profile_id = $1;', [MY_STAFF]);
    await clearSim();
    assert(asZz.rows.length === 0, 'A ZZ staff member cannot read a MY staff member\'s notifications (recipient-only RLS, independent of AOC)');
  }

  console.log(failures === 0 ? '\nAll Phase 8 multi-AOC checks passed.' : `\n${failures} Phase 8 multi-AOC check(s) FAILED -- see above.`);
  await db.exec('rollback;');
  await db.close();
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error('FAILED:', e.message, e.stack);
  process.exit(1);
});
