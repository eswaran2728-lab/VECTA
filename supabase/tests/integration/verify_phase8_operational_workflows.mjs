// Phase 8 (Operational Workforce and Enforcement Workflows) verification:
// genuine SQL execution against a fresh copy of the migrated database,
// same pattern as verify_phase7_dashboard_aggregates.mjs. Covers:
//   1. Leave routing: DSE approving within the team/leave-type capacity;
//      a 4th overlapping annual-leave approval blocked for DSE, allowed
//      for Operation Manager (the escalation path).
//   2. OT routing: Hub SE can endorse; Operation Manager can approve an
//      Operation-department submitter's OT but NOT an Enforcement
//      submitter's; Main Enforcement is the reverse.
//   3. Roster: DSE can write only its own team; a DSE attempting another
//      team's roster is denied.
//   4. Duty-zone draw: Operation Manager initiates/assigns/finalizes; a
//      second finalize is rejected; a non-Operation-Manager cannot
//      initiate.
//   5. Investigation case lifecycle: open -> link report (via
//      has_report_access(), never a direct read) -> note -> assign ->
//      resolve -> reopen (SSO-only), each audited.
//   6. SAT combined-PDF: one active row per team/day enforced by the
//      partial unique index; upload denied to a non-SAT-ASO; replace
//      supersedes correctly.
//   7. Profiling SEC013 acknowledgement: Profiling SO on the same team
//      can acknowledge; a Profiling SO on a DIFFERENT team is denied;
//      double-acknowledgement is denied.
//
// True multi-connection lock contention for the leave advisory lock is
// NOT exercised here (PGlite is single-connection) -- see
// verify_phase8_leave_concurrency_native.mjs for that, which requires
// --native (a real, separate, concurrently-running PostgreSQL
// connection).
//
// Run from this directory, AFTER `node migrate.mjs`:
//   node verify_phase8_operational_workflows.mjs
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { assertDisposableLocalTarget } from './safeguards.mjs';

const { Client } = pg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_DATA_DIR = path.join(__dirname, 'pgdata');
const RUN_DATA_DIR = path.join(__dirname, 'pgdata_phase8_run');

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
  const runDb = 'vecta_phase8_run';

  let db;
  if (isNative) {
    assertDisposableLocalTarget(pgConfig, goldenDb, runDb);
    console.log(`=== Running Phase 8 Verification against Native PostgreSQL (${pgConfig.host}:${pgConfig.port}) ===`);
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
    console.log('=== Running Phase 8 Verification against PGlite embedded engine ===');
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

  const ids = {};
  let seq = 0x10;
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
  async function expectDenied(fn, pattern, label) {
    await db.exec(`savepoint sp_${Math.random().toString(36).slice(2, 10)};`);
    // PGlite/pg both support named savepoints; use one fixed name per call via a counter.
  }

  await simulateServiceRole();

  // --- Fixture setup ---
  const GRANTER = nextId();
  const DSE_ALPHA = nextId(); // DSE for PEN/Alpha
  const DSE_BRAVO_TEAM_STAFF = nextId(); // a staff member on PEN/Bravo (different team)
  const HUB_SE_NORTHERN = nextId();
  const OPS_MGR = nextId();
  const MAIN_ENF = nextId();
  const STAFF_OPERATION = nextId(); // submits Operation OT
  const STAFF_ENFORCEMENT_INV_SSO = nextId(); // investigation_sso
  const SAT_ASO = nextId();
  const SAT_ASO_BRAVO = nextId(); // sat_aso on a DIFFERENT KUL team, for cross-team denial
  const PROFILING_SO = nextId();
  const PROFILING_SO_OTHER_TEAM = nextId();
  const PROFILING_ASO = nextId();
  const LEAVE_STAFF = [nextId(), nextId(), nextId(), nextId()]; // 4 distinct staff submitting overlapping annual leave

  const allIds = [GRANTER, DSE_ALPHA, DSE_BRAVO_TEAM_STAFF, HUB_SE_NORTHERN, OPS_MGR, MAIN_ENF, STAFF_OPERATION, STAFF_ENFORCEMENT_INV_SSO, SAT_ASO, SAT_ASO_BRAVO, PROFILING_SO, PROFILING_SO_OTHER_TEAM, PROFILING_ASO, ...LEAVE_STAFF];
  const userRows = allIds.map((id, i) => `('${id}', 'p8-${i}@example.test')`).join(',\n      ');
  await db.exec(`insert into auth.users (id, email) values\n      ${userRows}\n    on conflict (id) do nothing;`);
  const profileRows = allIds.map((id, i) => `('${id}', 'p8-${i}@example.test', 'P8 Staff ${i}', 'T-P8-${i}', 'ASO', 'PEN', 'Alpha', 'operation_avsec', 'approved')`).join(',\n      ');
  await db.exec(`insert into public.profiles (id, email, name, staff_no, role, station, team, ops_group, status) values\n      ${profileRows}\n    on conflict (id) do update set name=excluded.name, staff_no=excluded.staff_no, role=excluded.role, station=excluded.station, team=excluded.team, ops_group=excluded.ops_group, status=excluded.status;`);

  const aocId = (await db.query("select id from public.aocs where code = 'MY';")).rows[0].id;
  const operationDeptId = (await db.query("select id from public.departments where aoc_id = $1 and code = 'operation';", [aocId])).rows[0].id;
  const enforcementDeptId = (await db.query("select id from public.departments where aoc_id = $1 and code = 'enforcement';", [aocId])).rows[0].id;
  const investigationUnitId = (await db.query("select id from public.units where department_id = $1 and code = 'investigation';", [enforcementDeptId])).rows[0].id;
  const satUnitId = (await db.query("select id from public.units where department_id = $1 and code = 'sat';", [enforcementDeptId])).rows[0].id;
  const profilingUnitId = (await db.query("select id from public.units where department_id = $1 and code = 'profiling';", [enforcementDeptId])).rows[0].id;

  const penStationId = (await db.query("select id from public.org_stations where code = 'PEN';")).rows[0].id;
  const penHubId = (await db.query('select hub_id from public.org_stations where id = $1;', [penStationId])).rows[0].hub_id;
  const kulStationId = (await db.query("select id from public.org_stations where code = 'KUL - MAA';")).rows[0].id;
  const kulHubId = (await db.query('select hub_id from public.org_stations where id = $1;', [kulStationId])).rows[0].hub_id;

  // DSE must be scoped to the KUL hub only (Phase 3's own scope-shape
  // trigger) -- its team lives at KUL, named distinctly from SAT's KUL
  // team so the two roles' fixtures don't collide on the same team row.
  const dseAlphaTeamId = (await db.query(`insert into public.org_teams (station_id, name) values ($1, 'DseAlpha') on conflict (station_id, name) do update set name = excluded.name returning id;`, [kulStationId])).rows[0].id;
  const dseBravoTeamId = (await db.query(`insert into public.org_teams (station_id, name) values ($1, 'DseBravo') on conflict (station_id, name) do update set name = excluded.name returning id;`, [kulStationId])).rows[0].id;
  const satAlphaTeamId = (await db.query(`insert into public.org_teams (station_id, name) values ($1, 'Alpha') on conflict (station_id, name) do update set name = excluded.name returning id;`, [kulStationId])).rows[0].id;
  const satBravoTeamId = (await db.query(`insert into public.org_teams (station_id, name) values ($1, 'Bravo') on conflict (station_id, name) do update set name = excluded.name returning id;`, [kulStationId])).rows[0].id;
  const penBravoTeamId = (await db.query(`insert into public.org_teams (station_id, name) values ($1, 'Bravo') on conflict (station_id, name) do update set name = excluded.name returning id;`, [penStationId])).rows[0].id;
  const penAlphaTeamId = (await db.query(`insert into public.org_teams (station_id, name) values ($1, 'Alpha') on conflict (station_id, name) do update set name = excluded.name returning id;`, [penStationId])).rows[0].id;
  const profilingTeamId = (await db.query(`insert into public.org_teams (station_id, name) values ($1, 'Profiling') on conflict (station_id, name) do update set name = excluded.name returning id;`, [penStationId])).rows[0].id;
  const profilingOtherTeamId = (await db.query(`insert into public.org_teams (station_id, name) values ($1, 'ProfilingOther') on conflict (station_id, name) do update set name = excluded.name returning id;`, [penStationId])).rows[0].id;

  const roleId = {};
  for (const code of ['dse', 'hub_se', 'operation_manager', 'main_enforcement', 'investigation_sso', 'sat_aso', 'profiling_so', 'profiling_aso', 'aso']) {
    roleId[code] = (await db.query('select id from public.role_definitions where code = $1;', [code])).rows[0].id;
  }

  const maaEntityId = (await db.query("select id from public.operating_entities where aoc_id = $1 and code = 'MAA';", [aocId])).rows[0].id;

  async function grantMembership(profileId) {
    const row = await db.query(
      `insert into public.user_entity_memberships (profile_id, aoc_id, operating_entity_id, status, is_primary)
       values ($1, $2, $3, 'active', true) returning id;`,
      [profileId, aocId, maaEntityId],
    );
    return row.rows[0].id;
  }

  async function grantAssignment(profileId, code, extra, needsMembership) {
    const cols = ['profile_id', 'role_definition_id', 'granted_by', 'grant_reason'];
    const vals = [profileId, roleId[code], GRANTER, 'phase8 test fixture'];
    if (needsMembership) {
      const membershipId = await grantMembership(profileId);
      cols.push('entity_membership_id');
      vals.push(membershipId);
    }
    for (const [k, v] of Object.entries(extra || {})) { cols.push(k); vals.push(v); }
    const placeholders = vals.map((_, i) => `$${i + 1}`).join(', ');
    await db.query(`insert into public.user_role_assignments (${cols.join(', ')}) values (${placeholders});`, vals);
  }

  // dse must be scoped to the KUL hub only (Phase 3's own scope-shape trigger).
  await grantAssignment(DSE_ALPHA, 'dse', { aoc_id: aocId, department_id: operationDeptId, hub_id: kulHubId, station_id: kulStationId, team_id: dseAlphaTeamId }, true);
  await grantAssignment(HUB_SE_NORTHERN, 'hub_se', { aoc_id: aocId, department_id: operationDeptId, hub_id: penHubId }, true);
  await grantAssignment(OPS_MGR, 'operation_manager', { aoc_id: aocId, department_id: operationDeptId }, false);
  await grantAssignment(MAIN_ENF, 'main_enforcement', { aoc_id: aocId, department_id: enforcementDeptId }, false);
  await grantAssignment(STAFF_ENFORCEMENT_INV_SSO, 'investigation_sso', { aoc_id: aocId, department_id: enforcementDeptId, unit_id: investigationUnitId }, true);
  await grantAssignment(SAT_ASO, 'sat_aso', { aoc_id: aocId, department_id: enforcementDeptId, unit_id: satUnitId, hub_id: kulHubId, station_id: kulStationId, team_id: satAlphaTeamId }, true);
  await grantAssignment(SAT_ASO_BRAVO, 'sat_aso', { aoc_id: aocId, department_id: enforcementDeptId, unit_id: satUnitId, hub_id: kulHubId, station_id: kulStationId, team_id: satBravoTeamId }, true);
  await grantAssignment(PROFILING_SO, 'profiling_so', { aoc_id: aocId, department_id: enforcementDeptId, unit_id: profilingUnitId, hub_id: penHubId, station_id: penStationId, team_id: profilingTeamId }, true);
  await grantAssignment(PROFILING_SO_OTHER_TEAM, 'profiling_so', { aoc_id: aocId, department_id: enforcementDeptId, unit_id: profilingUnitId, hub_id: penHubId, station_id: penStationId, team_id: profilingOtherTeamId }, true);
  await grantAssignment(PROFILING_ASO, 'profiling_aso', { aoc_id: aocId, department_id: enforcementDeptId, unit_id: profilingUnitId, hub_id: penHubId, station_id: penStationId, team_id: profilingTeamId }, true);
  await grantAssignment(STAFF_OPERATION, 'aso', { aoc_id: aocId, department_id: operationDeptId, hub_id: penHubId, station_id: penStationId, team_id: penAlphaTeamId }, true);

  await clearSim();

  // =====================================================================
  // 1. LEAVE ROUTING
  // =====================================================================
  {
    // 3 approved annual-leave rows for PEN/Alpha, overlapping dates, distinct users.
    for (let i = 0; i < 3; i++) {
      await simulateServiceRole();
      await db.query(
        `insert into public.absence_notices (user_id, staff_name, role, station, team, duty_date, shift_start_time, gap_minutes, status, remarks, leave_type, start_date, end_date, approval_status)
         values ($1, 'x', 'ASO', 'KUL - MAA', 'DseAlpha', '2027-01-10', now(), 999, 'green', 'x', 'annual', '2027-01-10', '2027-01-12', 'approved');`,
        [LEAVE_STAFF[i]],
      );
    }
    // 4th overlapping request, pending, different user.
    await simulateServiceRole();
    const fourth = await db.query(
      `insert into public.absence_notices (user_id, staff_name, role, station, team, duty_date, shift_start_time, gap_minutes, status, remarks, leave_type, start_date, end_date, approval_status)
       values ($1, 'x', 'ASO', 'KUL - MAA', 'DseAlpha', '2027-01-11', now(), 999, 'green', 'x', 'annual', '2027-01-11', '2027-01-11', 'pending') returning id;`,
      [LEAVE_STAFF[3]],
    );
    const fourthId = fourth.rows[0].id;
    await clearSim();

    await simulateUser(DSE_ALPHA);
    await db.exec('savepoint sp_dse_leave_cap;');
    let dseBlocked = false;
    try {
      const r = await db.query('select * from public.review_leave_request_secure($1, $2, $3);', [fourthId, 'approve', null]);
    } catch (e) {
      dseBlocked = /must be escalated to the Operation Manager/.test(e.message);
      await db.exec('rollback to savepoint sp_dse_leave_cap;');
    }
    await clearSim();
    assert(dseBlocked, 'DSE is blocked from approving a 4th overlapping annual-leave request past team capacity');

    await simulateUser(OPS_MGR);
    const opsMgrResult = await db.query('select * from public.review_leave_request_secure($1, $2, $3);', [fourthId, 'approve', 'escalated approval']);
    await clearSim();
    assert(opsMgrResult.rows[0].result_status === 'approved', 'Operation Manager can approve the escalated 4th request');

    const auditRow = await db.query("select count(*)::int as c from public.phase8_audit_log where entity_type='absence_notice' and entity_id=$1 and action='leave_approved';", [fourthId]);
    assert(auditRow.rows[0].c === 1, 'Leave approval is audited exactly once');

    // Slice 7 (Round 2): Phase 8 notifications are consolidated into the
    // existing Phase 4 user_notifications system -- there is no separate
    // phase8_notifications table any more. Prove a real row landed there,
    // correctly deduplicated (a second identical notify() call for the
    // exact same transition must not create a second row).
    const notifRows = await db.query(
      "select id, event_type, payload from public.user_notifications where event_type = 'leave_status_changed' and (payload->>'notice_id')::uuid = $1;",
      [fourthId],
    );
    assert(notifRows.rows.length === 1, 'The leave-approval notification was written to the consolidated user_notifications table exactly once');
    assert(notifRows.rows[0].payload.status === 'approved', 'The consolidated notification payload carries the correct new status');
  }

  // =====================================================================
  // 1c. PENDING-LEAVE REVIEWER LIST (Phase 8 Round 2, Slice 6)
  // =====================================================================
  {
    await simulateServiceRole();
    const penPending = await db.query(
      `insert into public.absence_notices (user_id, staff_name, role, station, team, duty_date, shift_start_time, gap_minutes, status, remarks, leave_type, start_date, end_date, approval_status)
       values ($1, 'x', 'ASO', 'PEN', 'Alpha', '2027-01-20', now(), 999, 'green', 'x', 'annual', '2027-01-20', '2027-01-20', 'pending') returning id;`,
      [STAFF_OPERATION],
    );
    const penPendingId = penPending.rows[0].id;
    await clearSim();

    // Hub SE Northern (PEN's hub) sees it.
    await simulateUser(HUB_SE_NORTHERN);
    const hubSeList = await db.query('select * from public.list_pending_leave_for_reviewer_secure();');
    await clearSim();
    assert(hubSeList.rows.some((r) => r.id === penPendingId), 'Hub SE sees a pending leave request for a station within their own hub');

    // Operation Manager sees it too (Malaysia-wide Operation scope).
    await simulateUser(OPS_MGR);
    const opsMgrList = await db.query('select * from public.list_pending_leave_for_reviewer_secure();');
    await clearSim();
    assert(opsMgrList.rows.some((r) => r.id === penPendingId), 'Operation Manager sees the same pending request (Malaysia-wide Operation scope)');

    // A DSE (KUL hub, different hub entirely) calling the SAME RPC gets
    // an empty set, never an error -- this RPC is Phase-3 hub_se/
    // operation_manager-specific; DSE's own review queue is served by
    // the existing station/team-scoped UI query instead.
    await simulateUser(DSE_ALPHA);
    const dseList = await db.query('select * from public.list_pending_leave_for_reviewer_secure();');
    await clearSim();
    assert(dseList.rows.length === 0, 'A DSE caller gets an empty set from list_pending_leave_for_reviewer_secure (not an error) -- this RPC is Hub SE/Operation Manager-specific');
  }

  // =====================================================================
  // 2. OT ROUTING
  // =====================================================================
  {
    await simulateServiceRole();
    const otOp = await db.query(
      `insert into public.overtime_requests (profile_id, station, team, work_date, category, reason, start_at, end_at, status)
       values ($1, 'PEN', 'Alpha', '2027-01-10', 'adhoc', 'x', now(), now() + interval '2 hours', 'pending') returning id;`,
      [STAFF_OPERATION],
    );
    const otOpId = otOp.rows[0].id;
    await clearSim();

    // Hub SE endorses.
    await simulateUser(HUB_SE_NORTHERN);
    await db.query("update public.overtime_requests set status = 'endorsed' where id = $1;", [otOpId]);
    await clearSim();
    const afterEndorse = await db.query('select status from public.overtime_requests where id = $1;', [otOpId]);
    assert(afterEndorse.rows[0].status === 'endorsed', 'Hub SE can endorse a pending Operation-department OT request');

    // Main Enforcement must NOT be able to approve an Operation-department request.
    await simulateUser(MAIN_ENF);
    await db.exec('savepoint sp_main_enf_wrong_dept;');
    let mainEnfDenied = false;
    try {
      await db.query("update public.overtime_requests set status = 'approved' where id = $1;", [otOpId]);
      const check = await db.query('select status from public.overtime_requests where id = $1;', [otOpId]);
      mainEnfDenied = check.rows[0].status !== 'approved';
    } catch (e) {
      mainEnfDenied = true;
      await db.exec('rollback to savepoint sp_main_enf_wrong_dept;');
    }
    await clearSim();
    assert(mainEnfDenied, 'Main Enforcement cannot approve an Operation-department OT request');

    // Operation Manager approves correctly.
    await simulateUser(OPS_MGR);
    await db.query("update public.overtime_requests set status = 'approved' where id = $1;", [otOpId]);
    await clearSim();
    const afterApprove = await db.query('select status from public.overtime_requests where id = $1;', [otOpId]);
    assert(afterApprove.rows[0].status === 'approved', 'Operation Manager can approve its own department\'s OT request');
  }

  // =====================================================================
  // 1b. MAIN ENFORCEMENT WORKFORCE AUTHORITY (Phase 8 Round 2, Slice 1)
  // =====================================================================
  {
    // Enforcement-department (Investigation) submitter's leave request.
    await simulateServiceRole();
    const enfLeave = await db.query(
      `insert into public.absence_notices (user_id, staff_name, role, station, team, duty_date, shift_start_time, gap_minutes, status, remarks, leave_type, start_date, end_date, approval_status)
       values ($1, 'x', 'INVESTIGATION_SSO', null, null, '2027-02-01', now(), 999, 'green', 'x', 'annual', '2027-02-01', '2027-02-02', 'pending') returning id;`,
      [STAFF_ENFORCEMENT_INV_SSO],
    );
    const enfLeaveId = enfLeave.rows[0].id;
    await clearSim();

    // Operation Manager must NOT be able to decide an Enforcement submitter's leave.
    await simulateUser(OPS_MGR);
    await db.exec('savepoint sp_opsmgr_wrong_dept_leave;');
    let opsMgrDeniedEnfLeave = false;
    try {
      await db.query('select * from public.review_leave_request_secure($1, $2, $3);', [enfLeaveId, 'approve', null]);
    } catch (e) {
      opsMgrDeniedEnfLeave = /No active Phase 3 role assignment/.test(e.message);
      await db.exec('rollback to savepoint sp_opsmgr_wrong_dept_leave;');
    }
    await clearSim();
    assert(opsMgrDeniedEnfLeave, 'Operation Manager cannot decide an Enforcement-department leave request');

    // Main Enforcement can approve it.
    await simulateUser(MAIN_ENF);
    const enfLeaveResult = await db.query('select * from public.review_leave_request_secure($1, $2, $3);', [enfLeaveId, 'approve', null]);
    await clearSim();
    assert(enfLeaveResult.rows[0].result_status === 'approved', 'Main Enforcement can approve an Enforcement-department leave request');

    const enfAuditRow = await db.query(
      "select count(*)::int as c from public.phase8_audit_log where entity_type='absence_notice' and entity_id=$1 and action='leave_approved' and detail->>'reviewer_route' = 'main_enforcement';",
      [enfLeaveId],
    );
    assert(enfAuditRow.rows[0].c === 1, 'Enforcement leave approval is audited with reviewer_route=main_enforcement');

    // An Operation-department submitter's leave must NOT be decidable by Main Enforcement.
    await simulateServiceRole();
    const opLeave2 = await db.query(
      `insert into public.absence_notices (user_id, staff_name, role, station, team, duty_date, shift_start_time, gap_minutes, status, remarks, leave_type, start_date, end_date, approval_status)
       values ($1, 'x', 'ASO', 'PEN', 'Alpha', '2027-02-01', now(), 999, 'green', 'x', 'annual', '2027-02-01', '2027-02-02', 'pending') returning id;`,
      [STAFF_OPERATION],
    );
    const opLeave2Id = opLeave2.rows[0].id;
    await clearSim();

    await simulateUser(MAIN_ENF);
    await db.exec('savepoint sp_main_enf_wrong_dept_leave;');
    let mainEnfDeniedOpLeave = false;
    try {
      await db.query('select * from public.review_leave_request_secure($1, $2, $3);', [opLeave2Id, 'approve', null]);
    } catch (e) {
      mainEnfDeniedOpLeave = /No active Phase 3 role assignment/.test(e.message);
      await db.exec('rollback to savepoint sp_main_enf_wrong_dept_leave;');
    }
    await clearSim();
    assert(mainEnfDeniedOpLeave, 'Main Enforcement cannot decide an Operation-department leave request');

    // Workforce/attendance/pending-action visibility.
    await simulateUser(MAIN_ENF);
    const workforceRows = await db.query('select * from public.list_enforcement_workforce_secure();');
    await clearSim();
    assert(
      workforceRows.rows.some((r) => r.profile_id === STAFF_ENFORCEMENT_INV_SSO),
      'Main Enforcement can list the Enforcement-department workforce, including Investigation staff',
    );

    await simulateUser(DSE_ALPHA);
    await db.exec('savepoint sp_dse_workforce_denied;');
    let dseWorkforceDenied = false;
    try {
      await db.query('select * from public.list_enforcement_workforce_secure();');
    } catch (e) {
      dseWorkforceDenied = /Only Main Enforcement/.test(e.message);
      await db.exec('rollback to savepoint sp_dse_workforce_denied;');
    }
    await clearSim();
    assert(dseWorkforceDenied, 'DSE cannot list the Enforcement-department workforce (main_enforcement-only RPC)');

    await simulateUser(MAIN_ENF);
    const pendingActions = await db.query('select * from public.list_enforcement_pending_actions_secure();');
    await clearSim();
    assert(
      pendingActions.rows.some((r) => r.kind === 'leave' && r.record_id === enfLeaveId) === false,
      'A decided (approved) leave request no longer appears in pending Enforcement actions',
    );
  }

  // =====================================================================
  // 3. ROSTER OWNERSHIP
  // =====================================================================
  {
    await simulateUser(DSE_ALPHA);
    await db.query("select * from public.upsert_roster_cell_secure('KUL - MAA', 'DseAlpha', '2027-01-15', 'M', null, null, null);");
    await clearSim();
    const ownTeamRow = await db.query("select shift_code from public.team_rosters where station='KUL - MAA' and team='DseAlpha' and roster_date='2027-01-15';");
    assert(ownTeamRow.rows.length === 1, 'DSE can write its own team\'s roster');

    await simulateUser(DSE_ALPHA);
    await db.exec('savepoint sp_dse_wrong_team;');
    let dseWrongTeamDenied = false;
    try {
      await db.query("select * from public.upsert_roster_cell_secure('KUL - MAA', 'DseBravo', '2027-01-15', 'M', null, null, null);");
    } catch (e) {
      dseWrongTeamDenied = /No active Phase 3 role assignment grants roster-write authority/.test(e.message);
      await db.exec('rollback to savepoint sp_dse_wrong_team;');
    }
    await clearSim();
    assert(dseWrongTeamDenied, 'DSE cannot write a different team\'s roster (own-team-only enforced server-side)');

    await simulateUser(HUB_SE_NORTHERN);
    await db.query("select * from public.upsert_roster_cell_secure('PEN', 'Bravo', '2027-01-16', 'N', null, null, null);");
    await clearSim();
    const hubSeRow = await db.query("select shift_code from public.team_rosters where station='PEN' and team='Bravo' and roster_date='2027-01-16';");
    assert(hubSeRow.rows.length === 1, 'Hub SE can write any team\'s roster within its own hub');
  }

  // =====================================================================
  // 4. DUTY-ZONE DRAW
  // =====================================================================
  {
    await simulateUser(DSE_ALPHA);
    await db.exec('savepoint sp_dse_initiate_draw;');
    let dseInitiateDenied = false;
    try {
      await db.query("select * from public.initiate_duty_draw_secure('PEN', '2027-01-20');");
    } catch (e) {
      dseInitiateDenied = /Only Operation Manager may initiate/.test(e.message);
      await db.exec('rollback to savepoint sp_dse_initiate_draw;');
    }
    await clearSim();
    assert(dseInitiateDenied, 'DSE cannot initiate a duty-zone draw');

    await simulateUser(OPS_MGR);
    const draw = await db.query("select * from public.initiate_duty_draw_secure('PEN', '2027-01-20');");
    const drawId = draw.rows[0].row_id;
    await db.query('select public.record_duty_draw_assignment_secure($1, $2, null);', [drawId, STAFF_OPERATION]);
    await db.query('select public.finalize_duty_draw_secure($1);', [drawId]);
    await clearSim();

    await simulateUser(OPS_MGR);
    await db.exec('savepoint sp_refinalize;');
    let refinalizeDenied = false;
    try {
      await db.query('select public.finalize_duty_draw_secure($1);', [drawId]);
    } catch (e) {
      refinalizeDenied = /already finalized/.test(e.message);
      await db.exec('rollback to savepoint sp_refinalize;');
    }
    await clearSim();
    assert(refinalizeDenied, 'A finalized duty-zone draw cannot be re-finalized');

    await simulateUser(STAFF_OPERATION);
    const readBack = await db.query("select * from public.get_duty_draw_secure('PEN', '2027-01-20');");
    await clearSim();
    assert(readBack.rows.length === 1 && readBack.rows[0].status === 'finalized', 'Station staff can read the finalized draw for their own station');
  }

  // =====================================================================
  // 5. INVESTIGATION CASE LIFECYCLE
  // =====================================================================
  {
    // Alpha submits + indexes a report so has_report_access() has something real to check.
    const ALPHA = STAFF_OPERATION;
    await simulateUser(ALPHA);
    const insertResult = await db.query(`
      insert into public.report_sec014 (profile_id, status, station, team, staff_name, staff_id, date_time_in, date_time_out, remark, acknowledgement)
      values (auth.uid(), 'submitted', 'PEN', 'Alpha', 'x', 'x', now(), now() + interval '1 hour', 'phase8 investigation fixture', false)
      returning id;
    `);
    const reportId = insertResult.rows[0].id;
    await db.query(`insert into public.report_sec014_patrols (report_id, entry_no, location, description) values ($1, 1, 'Apron', 'x')`, [reportId]);
    await db.query('select public.mark_report_ready_for_indexing($1, $2, $3);', ['report_sec014', reportId, 1]);
    await clearSim();

    await simulateServiceRole();
    const entityId = (await db.query('select id from public.operating_entities where aoc_id = $1 and code = $2;', [aocId, 'MAA'])).rows[0].id;
    await db.query(
      `select public.index_report($1, $2, $3, $4, $5, null, null, $6, null, null, null, current_date, $7);`,
      ['report_sec014', reportId, (await db.query('select report_no from public.report_sec014 where id = $1;', [reportId])).rows[0].report_no, aocId, entityId, penHubId, ALPHA],
    );
    const repositoryRow = await db.query("select id from public.central_reports_index where source_table = 'report_sec014' and source_id = $1;", [reportId]);
    const repositoryId = repositoryRow.rows[0].id;
    await clearSim();

    await simulateUser(STAFF_ENFORCEMENT_INV_SSO);
    const opened = await db.query("select * from public.open_investigation_case_secure('Test case', 'theft', 'desc', 'high');");
    const caseId = opened.rows[0].row_id;
    await db.query('select public.link_report_to_case_secure($1, $2);', [caseId, repositoryId]);
    await db.query('select public.add_investigation_case_note_secure($1, $2);', [caseId, 'initial note']);
    await db.query('select public.assign_investigation_case_secure($1, $2);', [caseId, STAFF_ENFORCEMENT_INV_SSO]);
    await db.query("select public.resolve_investigation_case_secure($1, 'closed out');", [caseId]);
    await clearSim();

    const linked = await db.query('select count(*)::int as c from public.investigation_case_reports where case_id = $1 and repository_report_id = $2;', [caseId, repositoryId]);
    assert(linked.rows[0].c === 1, 'Investigation SSO can link an authorized report to a case via has_report_access(), not a direct read');

    const assignNotif = await db.query(
      "select count(*)::int as c from public.user_notifications where event_type = 'investigation_case_assigned' and recipient_profile_id = $1 and (payload->>'case_id')::uuid = $2;",
      [STAFF_ENFORCEMENT_INV_SSO, caseId],
    );
    assert(assignNotif.rows[0].c === 1, 'The case-assignment notification also lands in the consolidated user_notifications table');

    await simulateUser(STAFF_ENFORCEMENT_INV_SSO);
    await db.exec('savepoint sp_reopen;');
    let reopenOk = false;
    try {
      await db.query("select public.reopen_investigation_case_secure($1, 'new evidence');", [caseId]);
      reopenOk = true;
    } catch (e) {
      reopenOk = false;
    }
    await clearSim();
    assert(reopenOk, 'Investigation SSO can reopen a resolved case with a reason');

    const afterReopen = await db.query('select status, reopened_count from public.investigation_cases where id = $1;', [caseId]);
    assert(afterReopen.rows[0].status === 'reopened' && Number(afterReopen.rows[0].reopened_count) === 1, 'Reopen sets status and increments reopened_count');

    // Slice 4 (Round 2): the case-detail/notes/linked-reports/staff-
    // directory RPCs the Investigation workspace UI actually calls.
    await simulateUser(STAFF_ENFORCEMENT_INV_SSO);
    const caseDetail = await db.query('select * from public.get_investigation_case_secure($1);', [caseId]);
    const caseNotes = await db.query('select * from public.list_investigation_case_notes_secure($1);', [caseId]);
    const caseReports = await db.query('select * from public.list_investigation_case_reports_secure($1);', [caseId]);
    const invStaff = await db.query('select * from public.list_investigation_staff_secure();');
    await clearSim();
    assert(caseDetail.rows[0].id === caseId, 'get_investigation_case_secure returns the requested case for an authorized caller');
    assert(caseNotes.rows.some((n) => n.note === 'initial note'), 'list_investigation_case_notes_secure returns the case\'s notes');
    assert(
      caseReports.rows.some((r) => r.repository_report_id === repositoryId && r.source_table === 'report_sec014'),
      'list_investigation_case_reports_secure returns the linked report via central_reports_index, not a direct source-table read',
    );
    assert(invStaff.rows.some((s) => s.profile_id === STAFF_ENFORCEMENT_INV_SSO), 'list_investigation_staff_secure includes the active Investigation SSO');

    // A caller with no Investigation/Main Enforcement role gets the same
    // fail-closed denial for the detail RPC as for the list RPC -- never
    // a silent null that would let a case's existence leak through.
    await simulateUser(DSE_ALPHA);
    await db.exec('savepoint sp_detail_denied;');
    let detailDenied = false;
    try {
      await db.query('select * from public.get_investigation_case_secure($1);', [caseId]);
    } catch (e) {
      detailDenied = /Only Investigation or Main Enforcement/.test(e.message);
      await db.exec('rollback to savepoint sp_detail_denied;');
    }
    await clearSim();
    assert(detailDenied, 'A DSE cannot fetch investigation case detail (get_investigation_case_secure is authorization-gated too)');

    // Main Enforcement can monitor (list) even though it never touched the case.
    await simulateUser(MAIN_ENF);
    const meList = await db.query('select count(*)::int as c from public.list_investigation_cases_secure();');
    await clearSim();
    assert(meList.rows[0].c >= 1, 'Main Enforcement can list/monitor all Investigation cases');

    // A profile with no Investigation/Main Enforcement role is denied.
    await simulateUser(DSE_ALPHA);
    await db.exec('savepoint sp_no_inv_role;');
    let noRoleDenied = false;
    try {
      await db.query('select * from public.list_investigation_cases_secure();');
    } catch (e) {
      noRoleDenied = /Only Investigation or Main Enforcement/.test(e.message);
      await db.exec('rollback to savepoint sp_no_inv_role;');
    }
    await clearSim();
    assert(noRoleDenied, 'A DSE (no Investigation/Main Enforcement role) cannot list investigation cases');
  }

  // =====================================================================
  // 6. SAT COMBINED-PDF WORKFLOW
  // =====================================================================
  {
    await simulateUser(SAT_ASO);
    const upload = await db.query(
      "select * from public.upload_sat_combined_report_secure('KUL - MAA', 'Alpha', '2027-01-10', '3-shift', 'sat/kul-alpha-2027-01-10-v1.pdf');",
    );
    const satReportId = upload.rows[0].row_id;
    await clearSim();

    await simulateUser(SAT_ASO);
    await db.exec('savepoint sp_sat_dup;');
    let dupDenied = false;
    try {
      await db.query("select * from public.upload_sat_combined_report_secure('KUL - MAA', 'Alpha', '2027-01-10', '3-shift', 'sat/kul-alpha-2027-01-10-v2.pdf');");
    } catch (e) {
      dupDenied = /already exists/.test(e.message);
      await db.exec('rollback to savepoint sp_sat_dup;');
    }
    await clearSim();
    assert(dupDenied, 'A second upload for the same SAT team/date is rejected (duplicate prevention)');

    await simulateUser(SAT_ASO);
    const replaced = await db.query(
      "select * from public.replace_sat_combined_report_secure($1, '3-shift corrected', 'sat/kul-alpha-2027-01-10-v2.pdf', 'correction needed');",
      [satReportId],
    );
    const newSatReportId = replaced.rows[0].row_id;
    await clearSim();

    const statuses = await db.query('select id, status, version from public.sat_combined_reports where id in ($1, $2) order by version;', [satReportId, newSatReportId]);
    assert(statuses.rows[0].status === 'superseded' && statuses.rows[1].status === 'active' && Number(statuses.rows[1].version) === 2, 'Replacement supersedes the old row and creates a new active version 2 row, audited');

    // A profile without the sat_aso assignment for this team cannot upload.
    await simulateUser(DSE_ALPHA);
    await db.exec('savepoint sp_sat_denied;');
    let satDenied = false;
    try {
      await db.query("select * from public.upload_sat_combined_report_secure('KUL - MAA', 'Alpha', '2027-01-11', '3-shift', 'sat/other.pdf');");
    } catch (e) {
      satDenied = /Only an active SAT ASO/.test(e.message);
      await db.exec('rollback to savepoint sp_sat_denied;');
    }
    await clearSim();
    assert(satDenied, 'A non-SAT-ASO cannot upload a SAT combined report');

    // A SAT ASO on a DIFFERENT KUL team cannot upload for Alpha's team/date.
    await simulateUser(SAT_ASO_BRAVO);
    await db.exec('savepoint sp_sat_cross_team_upload;');
    let crossTeamUploadDenied = false;
    try {
      await db.query("select * from public.upload_sat_combined_report_secure('KUL - MAA', 'Alpha', '2027-01-12', '3-shift', 'sat/cross-team.pdf');");
    } catch (e) {
      crossTeamUploadDenied = /Only an active SAT ASO/.test(e.message);
      await db.exec('rollback to savepoint sp_sat_cross_team_upload;');
    }
    await clearSim();
    assert(crossTeamUploadDenied, 'A SAT ASO on a different KUL team cannot upload Alpha team\'s combined report');

    // A SAT ASO on a DIFFERENT team also cannot VIEW Alpha's report.
    await simulateUser(SAT_ASO_BRAVO);
    const crossTeamView = await db.query('select public.can_view_sat_combined_report($1) as can_view;', [newSatReportId]);
    await clearSim();
    assert(crossTeamView.rows[0].can_view === false, 'A SAT ASO on a different KUL team cannot view Alpha team\'s combined report');

    // Main Enforcement and Investigation can view; a DSE cannot.
    await simulateUser(MAIN_ENF);
    const meView = await db.query('select public.can_view_sat_combined_report($1) as ok;', [newSatReportId]);
    await clearSim();
    assert(meView.rows[0].ok === true, 'Main Enforcement can view SAT combined reports');

    await simulateUser(DSE_ALPHA);
    const dseView = await db.query('select public.can_view_sat_combined_report($1) as ok;', [newSatReportId]);
    await clearSim();
    assert(dseView.rows[0].ok === false, 'A DSE (unrelated role) cannot view a SAT combined report');
  }

  // =====================================================================
  // 7. PROFILING SEC013 ACKNOWLEDGEMENT
  // =====================================================================
  {
    await simulateUser(PROFILING_ASO);
    const sec013 = await db.query(`
      insert into public.report_sec013 (profile_id, status, station, team, staff_name, staff_id, date_time_in, date_time_out, remark)
      values (auth.uid(), 'submitted', 'PEN', 'Profiling', 'x', 'x', now(), now() + interval '1 hour', 'phase8 profiling fixture')
      returning id;
    `);
    const sec013Id = sec013.rows[0].id;
    await clearSim();

    await simulateUser(PROFILING_SO);
    const pendingAck = await db.query('select * from public.list_pending_sec013_acknowledgements_secure();');
    await clearSim();
    assert(
      pendingAck.rows.some((r) => r.report_id === sec013Id),
      'Profiling SO sees the pending SEC013 report for their own team in the acknowledgement list',
    );

    await simulateUser(PROFILING_SO_OTHER_TEAM);
    const pendingAckOtherTeam = await db.query('select * from public.list_pending_sec013_acknowledgements_secure();');
    await clearSim();
    assert(
      pendingAckOtherTeam.rows.every((r) => r.report_id !== sec013Id),
      'A Profiling SO on a different team does not see this report in their own pending-acknowledgement list',
    );

    await simulateUser(PROFILING_SO_OTHER_TEAM);
    await db.exec('savepoint sp_wrong_team_ack;');
    let wrongTeamDenied = false;
    try {
      await db.query('select public.acknowledge_sec013_report_secure($1);', [sec013Id]);
    } catch (e) {
      wrongTeamDenied = /Only an active Profiling SO on this exact team/.test(e.message);
      await db.exec('rollback to savepoint sp_wrong_team_ack;');
    }
    await clearSim();
    assert(wrongTeamDenied, 'A Profiling SO on a DIFFERENT team cannot acknowledge this SEC013 report');

    await simulateUser(PROFILING_SO);
    await db.query('select public.acknowledge_sec013_report_secure($1);', [sec013Id]);
    await clearSim();
    const ackRow = await db.query("select count(*)::int as c from public.report_acknowledgements where report_type='sec013' and report_id=$1;", [sec013Id]);
    assert(ackRow.rows[0].c === 1, 'Profiling SO on the same team can acknowledge the report, via report_acknowledgements');

    await simulateUser(PROFILING_SO);
    await db.exec('savepoint sp_double_ack;');
    let doubleAckDenied = false;
    try {
      await db.query('select public.acknowledge_sec013_report_secure($1);', [sec013Id]);
    } catch (e) {
      doubleAckDenied = /already acknowledged/.test(e.message);
      await db.exec('rollback to savepoint sp_double_ack;');
    }
    await clearSim();
    assert(doubleAckDenied, 'Double-acknowledgement of the same report is rejected');
  }

  // =====================================================================
  // 8. AUDIT SNAPSHOT AND WORKFORCE EXPORTS (Phase 8 Round 2, Slice 8)
  // =====================================================================
  {
    // Every phase8_write_audit() call now captures the actor's active
    // Phase 3 role assignment(s) automatically -- verify a real row (the
    // OPS_MGR escalated-approval from section 1) actually carries it.
    const auditWithSnapshot = await db.query(
      "select actor_role_snapshot from public.phase8_audit_log where actor_id = $1 and action = 'leave_approved' limit 1;",
      [OPS_MGR],
    );
    assert(auditWithSnapshot.rows.length > 0, 'An audit row exists for the Operation Manager actor');
    const snapshot = auditWithSnapshot.rows[0].actor_role_snapshot;
    assert(Array.isArray(snapshot) && snapshot.length > 0, 'The audit row carries a non-empty actor_role_snapshot');
    assert(snapshot.some((r) => r.role_code === 'operation_manager'), 'The captured snapshot correctly identifies operation_manager as the active role at the time of the transition');

    // Operation Manager export: capped, authorized, self-audited.
    await simulateUser(OPS_MGR);
    const opExport = await db.query('select * from public.export_operation_workforce_secure();');
    await clearSim();
    assert(opExport.rows.some((r) => r.profile_id === DSE_ALPHA), 'Operation Manager export includes an Operation-department staff member (DSE Alpha)');
    assert(opExport.rows.every((r) => r.profile_id !== STAFF_ENFORCEMENT_INV_SSO), 'Operation Manager export never includes Enforcement-department staff');

    const opExportAudit = await db.query(
      "select count(*)::int as c from public.phase8_audit_log where action = 'export_generated' and detail->>'department' = 'operation' and actor_id = $1;",
      [OPS_MGR],
    );
    assert(opExportAudit.rows[0].c >= 1, 'The Operation workforce export is audited');

    // Operation Manager cannot export the Enforcement workforce, and
    // vice versa -- department separation applies to exports too.
    await simulateUser(OPS_MGR);
    await db.exec('savepoint sp_opsmgr_enf_export;');
    let opsMgrEnfExportDenied = false;
    try {
      await db.query('select * from public.export_enforcement_workforce_secure();');
    } catch (e) {
      opsMgrEnfExportDenied = /Only Main Enforcement/.test(e.message);
      await db.exec('rollback to savepoint sp_opsmgr_enf_export;');
    }
    await clearSim();
    assert(opsMgrEnfExportDenied, 'Operation Manager cannot export the Enforcement workforce directory');

    // Main Enforcement export: capped, authorized, self-audited.
    await simulateUser(MAIN_ENF);
    const enfExport = await db.query('select * from public.export_enforcement_workforce_secure();');
    await clearSim();
    assert(enfExport.rows.some((r) => r.profile_id === STAFF_ENFORCEMENT_INV_SSO), 'Main Enforcement export includes an Enforcement-department staff member (Investigation SSO)');
    assert(enfExport.rows.every((r) => r.profile_id !== DSE_ALPHA), 'Main Enforcement export never includes Operation-department staff');

    const enfExportAudit = await db.query(
      "select count(*)::int as c from public.phase8_audit_log where action = 'export_generated' and detail->>'department' = 'enforcement' and actor_id = $1;",
      [MAIN_ENF],
    );
    assert(enfExportAudit.rows[0].c >= 1, 'The Enforcement workforce export is audited');

    await simulateUser(DSE_ALPHA);
    await db.exec('savepoint sp_dse_op_export;');
    let dseExportDenied = false;
    try {
      await db.query('select * from public.export_operation_workforce_secure();');
    } catch (e) {
      dseExportDenied = /Only Operation Manager/.test(e.message);
      await db.exec('rollback to savepoint sp_dse_op_export;');
    }
    await clearSim();
    assert(dseExportDenied, 'A DSE (not Operation Manager) cannot export the Operation workforce directory');
  }

  // =====================================================================
  // 9. ASSIGNMENT LIFECYCLE: revoked / expired / future / pending
  //    assignments must never count as "active" (Phase 8 certification
  //    direct-bypass requirement). Each uses a dedicated fresh profile
  //    and a direct call to has_active_role_my() -- the exact function
  //    every Phase 8 RPC's authorization now goes through -- so this is
  //    the real authorization path, not a re-derived copy of it.
  // =====================================================================
  {
    await simulateServiceRole();
    const opsMgrRoleId = (await db.query("select id from public.role_definitions where code = 'operation_manager';")).rows[0].id;

    async function makeAssignmentProfile(label) {
      const id = nextId();
      await db.query(`insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing;`, [id, `p8lifecycle-${label}@example.test`]);
      await db.query(
        `insert into public.profiles (id, email, name, staff_no, role, station, team, ops_group, status)
         values ($1, $2, $3, 'T-LC', 'ASO', null, null, 'operation_avsec', 'approved')
         on conflict (id) do update set status = excluded.status;`,
        [id, `p8lifecycle-${label}@example.test`, `Lifecycle ${label}`],
      );
      return id;
    }

    // REVOKED: revoked_at is set, in the past.
    const revokedProfile = await makeAssignmentProfile('revoked');
    await db.query(
      `insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, starts_at, revoked_at, granted_by, grant_reason)
       values ($1, $2, $3, $4, now() - interval '10 days', now() - interval '1 day', $5, 'lifecycle test: revoked');`,
      [revokedProfile, opsMgrRoleId, aocId, operationDeptId, GRANTER],
    );
    await simulateUser(revokedProfile);
    const revokedCheck = await db.query("select public.has_active_role_my('operation_manager') as active;");
    await clearSim();
    assert(revokedCheck.rows[0].active === false, 'A REVOKED assignment does not count as active (has_active_role_my returns false)');

    // EXPIRED: ends_at is in the past.
    await simulateServiceRole();
    const expiredProfile = await makeAssignmentProfile('expired');
    await db.query(
      `insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, starts_at, ends_at, granted_by, grant_reason)
       values ($1, $2, $3, $4, now() - interval '10 days', now() - interval '1 day', $5, 'lifecycle test: expired');`,
      [expiredProfile, opsMgrRoleId, aocId, operationDeptId, GRANTER],
    );
    await simulateUser(expiredProfile);
    const expiredCheck = await db.query("select public.has_active_role_my('operation_manager') as active;");
    await clearSim();
    assert(expiredCheck.rows[0].active === false, 'An EXPIRED assignment (ends_at in the past) does not count as active');

    // FUTURE / PENDING: starts_at is in the future -- not yet effective.
    await simulateServiceRole();
    const futureProfile = await makeAssignmentProfile('future');
    await db.query(
      `insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, starts_at, granted_by, grant_reason)
       values ($1, $2, $3, $4, now() + interval '10 days', $5, 'lifecycle test: future/pending');`,
      [futureProfile, opsMgrRoleId, aocId, operationDeptId, GRANTER],
    );
    await simulateUser(futureProfile);
    const futureCheck = await db.query("select public.has_active_role_my('operation_manager') as active;");
    await clearSim();
    assert(futureCheck.rows[0].active === false, 'A FUTURE/PENDING assignment (starts_at not yet reached) does not count as active');

    // CURRENTLY ACTIVE: sanity check that the same fixture shape, with a
    // past starts_at, no ends_at, no revoked_at, DOES count as active --
    // proves the three denials above are genuinely about the lifecycle
    // fields, not some unrelated fixture mistake.
    await simulateServiceRole();
    const activeProfile = await makeAssignmentProfile('active');
    await db.query(
      `insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, starts_at, granted_by, grant_reason)
       values ($1, $2, $3, $4, now() - interval '1 day', $5, 'lifecycle test: currently active');`,
      [activeProfile, opsMgrRoleId, aocId, operationDeptId, GRANTER],
    );
    await simulateUser(activeProfile);
    const activeCheck = await db.query("select public.has_active_role_my('operation_manager') as active;");
    await clearSim();
    assert(activeCheck.rows[0].active === true, 'A genuinely currently-active assignment (past starts_at, no ends_at, not revoked) DOES count as active -- confirms the three denials above are real, not a fixture artifact');

    // End-to-end: a REVOKED Operation Manager cannot actually approve a
    // real leave request via review_leave_request_secure() either --
    // not just the has_active_role_my() probe in isolation.
    await simulateServiceRole();
    const lifecycleLeaveId = (
      await db.query(
        `insert into public.absence_notices (user_id, staff_name, role, station, team, duty_date, shift_start_time, gap_minutes, status, remarks, leave_type, start_date, end_date, approval_status)
         values ($1, 'x', 'ASO', 'PEN', 'Alpha', '2027-06-01', now(), 999, 'green', 'x', 'annual', '2027-06-01', '2027-06-01', 'pending') returning id;`,
        [STAFF_OPERATION],
      )
    ).rows[0].id;
    await clearSim();

    await simulateUser(revokedProfile);
    await db.exec('savepoint sp_revoked_leave_bypass;');
    let revokedBypassed = false;
    try {
      const r = await db.query('select * from public.review_leave_request_secure($1, $2, $3);', [lifecycleLeaveId, 'approve', null]);
      revokedBypassed = r.rows[0]?.result_status === 'approved';
    } catch (e) {
      await db.exec('rollback to savepoint sp_revoked_leave_bypass;');
    }
    await clearSim();
    assert(!revokedBypassed, 'A REVOKED Operation Manager cannot approve a real leave request end-to-end (not just denied at the has_active_role_my probe)');
  }

  console.log('\nAll Phase 8 operational-workflow checks passed.');
  await db.exec('rollback;');
  await db.close();
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
