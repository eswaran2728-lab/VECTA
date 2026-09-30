// Phase 8 certification (continuation): genuine multi-connection
// concurrency verification for every subsystem named as an unmet gate
// in the prior certification pass -- OT endorsement/final approval,
// Investigation resolve-vs-reopen, Investigation simultaneous
// assignment, SAT duplicate-upload metadata creation, SAT simultaneous
// replacement, and SAT failed-replacement preserving the active
// version. Every scenario below uses two REAL, separate, concurrently-
// executing native PostgreSQL connections -- never two sequential
// calls on one connection labeled as "concurrent".
//
// Requires native PostgreSQL (PGlite is single-connection). Run from
// this directory, AFTER `node migrate.mjs --native`:
//   node verify_phase8_concurrency_round2_native.mjs
import pg from 'pg';
import { assertDisposableLocalTarget } from './safeguards.mjs';

const { Client } = pg;

const pgConfig = {
  host: process.env.PGHOST || '127.0.0.1',
  port: parseInt(process.env.PGPORT || '55433', 10),
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || undefined,
};
const goldenDb = process.env.PGDATABASE || 'vecta_phase6_test';
const runDb = 'vecta_phase8_concurrency_round2_run';

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + msg);
  console.log('PASS:', msg);
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function setSimUser(client, profileId) {
  await client.query('reset role;');
  await client.query("set role 'authenticated';");
  await client.query(
    "select set_config('request.jwt.claims', json_build_object('sub', $1::text, 'role', 'authenticated')::text, false);",
    [profileId],
  );
}
async function setSimServiceRole(client) {
  await client.query('reset role;');
  await client.query("set role 'service_role';");
  await client.query("select set_config('request.jwt.claims', '{}', false);");
}

async function main() {
  assertDisposableLocalTarget(pgConfig, goldenDb, runDb);
  console.log(`=== Phase 8 Round 2 concurrency verification against Native PostgreSQL (${pgConfig.host}:${pgConfig.port}) ===`);

  const admin = new Client({ ...pgConfig, database: 'postgres' });
  await admin.connect();
  await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${runDb}' and pid <> pg_backend_pid();`);
  await admin.query(`drop database if exists ${runDb};`);
  await admin.query(`create database ${runDb} template ${goldenDb};`);

  const setup = new Client({ ...pgConfig, database: runDb });
  await setup.connect();
  await setSimServiceRole(setup);

  let seq = 0x20;
  function nextId() {
    seq += 1;
    return `00000000-0000-0000-0000-${seq.toString(16).padStart(12, '0')}`;
  }

  const GRANTER = nextId();
  const OPS_MGR = nextId();
  const STAFF_OPERATION = nextId();
  const INV_SSO = nextId();
  const SAT_ASO = nextId();
  const ids = [GRANTER, OPS_MGR, STAFF_OPERATION, INV_SSO, SAT_ASO];

  await setup.query(
    `insert into auth.users (id, email) values ${ids.map((_, i) => `($${i + 1}, 'p8c2-${i}@example.test')`).join(',')} on conflict (id) do nothing;`,
    ids,
  );
  await setup.query(
    `insert into public.profiles (id, email, name, staff_no, role, station, team, ops_group, status)
     values
       ($1, 'p8c2-0@example.test', 'Granter', 'T-C1', 'ADMIN', null, null, 'operation_avsec', 'approved'),
       ($2, 'p8c2-1@example.test', 'Ops Mgr', 'T-C2', 'ASO', null, null, 'operation_avsec', 'approved'),
       ($3, 'p8c2-2@example.test', 'Staff Op', 'T-C3', 'ASO', 'PEN', 'Alpha', 'operation_avsec', 'approved'),
       ($4, 'p8c2-3@example.test', 'Inv SSO', 'T-C4', 'ASO', null, null, 'operation_avsec', 'approved'),
       ($5, 'p8c2-4@example.test', 'Sat Aso', 'T-C5', 'ASO', 'KUL - MAA', 'Alpha', 'operation_avsec', 'approved')
     on conflict (id) do update set name = excluded.name, staff_no = excluded.staff_no, role = excluded.role,
       station = excluded.station, team = excluded.team, ops_group = excluded.ops_group, status = excluded.status;`,
    ids,
  );

  const aocId = (await setup.query("select id from public.aocs where code = 'MY';")).rows[0].id;
  const operationDeptId = (await setup.query("select id from public.departments where aoc_id = $1 and code = 'operation';", [aocId])).rows[0].id;
  const enforcementDeptId = (await setup.query("select id from public.departments where aoc_id = $1 and code = 'enforcement';", [aocId])).rows[0].id;
  const investigationUnitId = (await setup.query("select id from public.units where department_id = $1 and code = 'investigation';", [enforcementDeptId])).rows[0].id;
  const satUnitId = (await setup.query("select id from public.units where department_id = $1 and code = 'sat';", [enforcementDeptId])).rows[0].id;
  const penStationId = (await setup.query("select id from public.org_stations where code = 'PEN';")).rows[0].id;
  const penHubId = (await setup.query('select hub_id from public.org_stations where id = $1;', [penStationId])).rows[0].hub_id;
  const kulStationId = (await setup.query("select id from public.org_stations where code = 'KUL - MAA';")).rows[0].id;
  const kulHubId = (await setup.query('select hub_id from public.org_stations where id = $1;', [kulStationId])).rows[0].hub_id;
  const satAlphaTeamId = (
    await setup.query(`insert into public.org_teams (station_id, name) values ($1, 'Alpha') on conflict (station_id, name) do update set name = excluded.name returning id;`, [kulStationId])
  ).rows[0].id;
  const penAlphaTeamId = (
    await setup.query(`insert into public.org_teams (station_id, name) values ($1, 'Alpha') on conflict (station_id, name) do update set name = excluded.name returning id;`, [penStationId])
  ).rows[0].id;

  const roleId = {};
  for (const code of ['operation_manager', 'investigation_sso', 'sat_aso', 'aso']) {
    roleId[code] = (await setup.query('select id from public.role_definitions where code = $1;', [code])).rows[0].id;
  }
  const maaEntityId = (await setup.query("select id from public.operating_entities where aoc_id = $1 and code = 'MAA';", [aocId])).rows[0].id;

  async function grantMembership(profileId) {
    const row = await setup.query(
      `insert into public.user_entity_memberships (profile_id, aoc_id, operating_entity_id, status, is_primary) values ($1, $2, $3, 'active', true) returning id;`,
      [profileId, aocId, maaEntityId],
    );
    return row.rows[0].id;
  }
  async function grantAssignment(profileId, code, extra, needsMembership) {
    const cols = ['profile_id', 'role_definition_id', 'granted_by', 'grant_reason'];
    const vals = [profileId, roleId[code], GRANTER, 'phase8 round2 concurrency fixture'];
    if (needsMembership) {
      const membershipId = await grantMembership(profileId);
      cols.push('entity_membership_id');
      vals.push(membershipId);
    }
    for (const [k, v] of Object.entries(extra || {})) { cols.push(k); vals.push(v); }
    const placeholders = vals.map((_, i) => `$${i + 1}`).join(', ');
    await setup.query(`insert into public.user_role_assignments (${cols.join(', ')}) values (${placeholders});`, vals);
  }

  await grantAssignment(OPS_MGR, 'operation_manager', { aoc_id: aocId, department_id: operationDeptId }, false);
  await grantAssignment(INV_SSO, 'investigation_sso', { aoc_id: aocId, department_id: enforcementDeptId, unit_id: investigationUnitId }, true);
  await grantAssignment(SAT_ASO, 'sat_aso', { aoc_id: aocId, department_id: enforcementDeptId, unit_id: satUnitId, hub_id: kulHubId, station_id: kulStationId, team_id: satAlphaTeamId }, true);
  await grantAssignment(STAFF_OPERATION, 'aso', { aoc_id: aocId, department_id: operationDeptId, hub_id: penHubId, station_id: penStationId, team_id: penAlphaTeamId }, true);

  // =========================================================================
  // 1. OT: two connections racing to APPROVE the same already-endorsed
  //    request -- ordinary Postgres row-lock serialization on the UPDATE
  //    itself (no explicit FOR UPDATE needed; both connections attempt
  //    the same UPDATE ... WHERE status='endorsed' simultaneously).
  // =========================================================================
  {
    const otId = (
      await setup.query(
        `insert into public.overtime_requests (profile_id, station, team, work_date, category, reason, start_at, end_at, status)
         values ($1, 'PEN', 'Alpha', '2027-04-01', 'adhoc', 'x', now(), now() + interval '2 hours', 'endorsed') returning id;`,
        [STAFF_OPERATION],
      )
    ).rows[0].id;

    const connA = new Client({ ...pgConfig, database: runDb });
    const connB = new Client({ ...pgConfig, database: runDb });
    await connA.connect();
    await connB.connect();
    await setSimUser(connA, OPS_MGR);
    await setSimUser(connB, OPS_MGR);

    const [resA, resB] = await Promise.all([
      connA.query("update public.overtime_requests set status = 'approved' where id = $1 and status = 'endorsed' returning id;", [otId]).then((r) => ({ ok: true, rows: r.rows })).catch((e) => ({ ok: false, error: e.message })),
      connB.query("update public.overtime_requests set status = 'approved' where id = $1 and status = 'endorsed' returning id;", [otId]).then((r) => ({ ok: true, rows: r.rows })).catch((e) => ({ ok: false, error: e.message })),
    ]);
    await connA.end();
    await connB.end();

    const wonCount = [resA, resB].filter((r) => r.ok && r.rows.length === 1).length;
    const lostCount = [resA, resB].filter((r) => r.ok && r.rows.length === 0).length;
    assert(wonCount === 1, `Exactly one of two concurrent OT approvals actually transitioned the row (found ${wonCount})`);
    assert(lostCount === 1, `Exactly one of two concurrent OT approvals affected zero rows (already-approved by the other, WHERE status='endorsed' no longer matches) -- found ${lostCount}`);

    const verify = await setup.query('select status from public.overtime_requests where id = $1;', [otId]);
    assert(verify.rows[0].status === 'approved', 'The OT request ends in exactly one final approved state, never corrupted by the race');
  }

  // =========================================================================
  // 2. Investigation: two SIMULTANEOUS reopen attempts on the SAME
  //    already-resolved case. reopen_investigation_case_secure's own
  //    `for update` forces the second attempt to wait for the first's
  //    commit, then see the now-'reopened' status -- which no longer
  //    qualifies for reopen (only resolved/closed may be reopened) --
  //    so exactly one may succeed, never both (which would double-
  //    increment reopened_count or silently allow re-reopening).
  // =========================================================================
  {
    await setSimUser(setup, INV_SSO);
    const caseId = (await setup.query("select row_id as id from public.open_investigation_case_secure('Concurrency test case', 'theft', 'desc', 'high');")).rows[0].id;
    await setup.query("select public.resolve_investigation_case_secure($1, 'initial resolution');", [caseId]);
    await setSimServiceRole(setup);

    const connA = new Client({ ...pgConfig, database: runDb });
    const connB = new Client({ ...pgConfig, database: runDb });
    await connA.connect();
    await connB.connect();
    await setSimUser(connA, INV_SSO);
    await setSimUser(connB, INV_SSO);

    const [resA, resB] = await Promise.all([
      connA.query("select public.reopen_investigation_case_secure($1, 'reopen attempt A');", [caseId]).then(() => ({ ok: true })).catch((e) => ({ ok: false, error: e.message })),
      connB.query("select public.reopen_investigation_case_secure($1, 'reopen attempt B');", [caseId]).then(() => ({ ok: true })).catch((e) => ({ ok: false, error: e.message })),
    ]);
    await connA.end();
    await connB.end();

    const successCount = [resA, resB].filter((r) => r.ok).length;
    assert(successCount === 1, `Exactly one of two SIMULTANEOUS reopen attempts on the same resolved case succeeds (found ${successCount})`);
    const failed = [resA, resB].find((r) => !r.ok);
    assert(!!failed && /Only a resolved or closed case can be reopened/.test(failed.error || ''), 'The losing reopen attempt is correctly denied (the case is already "reopened" by the time it gets the lock), not a silent double-success');

    const verify = await setup.query('select status, reopened_count from public.investigation_cases where id = $1;', [caseId]);
    assert(verify.rows[0].status === 'reopened', 'The case ends in the reopened state, not corrupted by the race');
    assert(Number(verify.rows[0].reopened_count) === 1, 'reopened_count was incremented exactly once, never double-counted by the race');
  }

  // =========================================================================
  // 2b. Investigation: RESOLVE racing with REOPEN on an OPEN case (the
  //     literal "resolve versus reopen" scenario). reopen requires
  //     resolved/closed, so its outcome legitimately depends on lock
  //     acquisition order: if reopen's `for update` wins the case is
  //     still 'open' and it is correctly denied; if resolve wins first
  //     and commits, reopen then correctly sees 'resolved' and
  //     succeeds. Both outcomes are valid; what must NEVER happen is an
  //     inconsistent end state (e.g. reopened_count incremented while
  //     status stays 'open', or resolve's own state corrupted).
  // =========================================================================
  {
    await setSimUser(setup, INV_SSO);
    const caseId = (await setup.query("select row_id as id from public.open_investigation_case_secure('Resolve-vs-reopen race case', 'theft', 'desc', 'normal');")).rows[0].id;
    await setSimServiceRole(setup);

    const connA = new Client({ ...pgConfig, database: runDb });
    const connB = new Client({ ...pgConfig, database: runDb });
    await connA.connect();
    await connB.connect();
    await setSimUser(connA, INV_SSO);
    await setSimUser(connB, INV_SSO);

    const [resolveRes, reopenRes] = await Promise.all([
      connA.query("select public.resolve_investigation_case_secure($1, 'race resolution');", [caseId]).then(() => ({ ok: true })).catch((e) => ({ ok: false, error: e.message })),
      connB.query("select public.reopen_investigation_case_secure($1, 'race reopen attempt');", [caseId]).then(() => ({ ok: true })).catch((e) => ({ ok: false, error: e.message })),
    ]);
    await connA.end();
    await connB.end();

    assert(resolveRes.ok, 'The resolve side of the race always succeeds (an open case may always be resolved, regardless of a concurrent reopen attempt on it)');

    const verify = await setup.query('select status, reopened_count, resolved_at from public.investigation_cases where id = $1;', [caseId]);
    const finalStatus = verify.rows[0].status;
    if (reopenRes.ok) {
      assert(finalStatus === 'reopened' && Number(verify.rows[0].reopened_count) === 1, 'If reopen won the race (ran after resolve committed), the case ends correctly reopened with reopened_count = 1');
    } else {
      assert(/Only a resolved or closed case can be reopened/.test(reopenRes.error || ''), 'If reopen lost the race (ran before resolve committed, case still open), it is correctly denied with the state-machine error, not a silent failure');
      assert(finalStatus === 'resolved' && Number(verify.rows[0].reopened_count) === 0, 'The case ends correctly resolved, reopened_count untouched, when reopen loses the race');
    }
    assert(!!verify.rows[0].resolved_at, 'resolved_at is set regardless of which side of the race reopen landed on -- resolve\'s own state is never corrupted by the concurrent reopen attempt');
  }

  // =========================================================================
  // 3. Investigation: simultaneous assignment changes to the SAME case
  //    from two connections -- both succeed (assign has no state-machine
  //    restriction), but the final assigned_to must be exactly one
  //    deterministic value, never a corrupted/partial write.
  // =========================================================================
  {
    await setSimUser(setup, INV_SSO);
    const caseId = (await setup.query("select row_id as id from public.open_investigation_case_secure('Assignment race case', 'theft', 'desc', 'normal');")).rows[0].id;
    await setSimServiceRole(setup);
    const otherInvId = nextId();
    await setup.query(`insert into auth.users (id, email) values ($1, 'p8c2-other-inv@example.test') on conflict (id) do nothing;`, [otherInvId]);
    await setup.query(
      `insert into public.profiles (id, email, name, staff_no, role, station, team, ops_group, status) values ($1, 'p8c2-other-inv@example.test', 'Other Inv', 'T-C6', 'ASO', null, null, 'operation_avsec', 'approved')
       on conflict (id) do update set status = excluded.status;`,
      [otherInvId],
    );
    await grantAssignment(otherInvId, 'investigation_sso', { aoc_id: aocId, department_id: enforcementDeptId, unit_id: investigationUnitId }, true);

    const connA = new Client({ ...pgConfig, database: runDb });
    const connB = new Client({ ...pgConfig, database: runDb });
    await connA.connect();
    await connB.connect();
    await setSimUser(connA, INV_SSO);
    await setSimUser(connB, INV_SSO);

    const [resA, resB] = await Promise.all([
      connA.query('select public.assign_investigation_case_secure($1, $2);', [caseId, INV_SSO]).then(() => ({ ok: true })).catch((e) => ({ ok: false, error: e.message })),
      connB.query('select public.assign_investigation_case_secure($1, $2);', [caseId, otherInvId]).then(() => ({ ok: true })).catch((e) => ({ ok: false, error: e.message })),
    ]);
    await connA.end();
    await connB.end();

    assert(resA.ok && resB.ok, 'Both concurrent assignment writes complete without deadlock or corruption');
    const verify = await setup.query('select assigned_to from public.investigation_cases where id = $1;', [caseId]);
    assert(verify.rows[0].assigned_to === INV_SSO || verify.rows[0].assigned_to === otherInvId, 'The final assigned_to is exactly one of the two racing values -- never null, never a mixed/corrupted state');
  }

  // =========================================================================
  // 4. SAT: two SIMULTANEOUS uploads for the SAME team+date -- the
  //    partial unique index (not just the app-level `if exists` check)
  //    is what genuinely prevents duplicate metadata rows under a race.
  // =========================================================================
  {
    const connA = new Client({ ...pgConfig, database: runDb });
    const connB = new Client({ ...pgConfig, database: runDb });
    await connA.connect();
    await connB.connect();
    await setSimUser(connA, SAT_ASO);
    await setSimUser(connB, SAT_ASO);

    const [resA, resB] = await Promise.all([
      connA.query("select * from public.upload_sat_combined_report_secure('KUL - MAA', 'Alpha', '2027-04-02', '3-shift', 'sat/race-a.pdf');").then((r) => ({ ok: true, rows: r.rows })).catch((e) => ({ ok: false, error: e.message })),
      connB.query("select * from public.upload_sat_combined_report_secure('KUL - MAA', 'Alpha', '2027-04-02', '3-shift', 'sat/race-b.pdf');").then((r) => ({ ok: true, rows: r.rows })).catch((e) => ({ ok: false, error: e.message })),
    ]);
    await connA.end();
    await connB.end();

    const successCount = [resA, resB].filter((r) => r.ok).length;
    const failCount = [resA, resB].filter((r) => !r.ok).length;
    assert(successCount === 1, `Exactly one of two SIMULTANEOUS uploads for the same team/date succeeds (found ${successCount})`);
    assert(failCount === 1, `Exactly one is rejected -- either by the app-level exists-check or the structural partial unique index catching the race (found ${failCount})`);

    const verify = await setup.query(
      `select count(*)::int as c from public.sat_combined_reports where team_id = $1 and operational_date = '2027-04-02' and status = 'active';`,
      [satAlphaTeamId],
    );
    assert(verify.rows[0].c === 1, 'Exactly one active row exists for this team/date after the race -- the structural unique index holds even under simultaneous inserts');
  }

  // =========================================================================
  // 5. SAT: two SIMULTANEOUS replacement attempts on the SAME active
  //    report -- replace's `for update` lock serializes them; only one
  //    may supersede the original.
  // =========================================================================
  {
    await setSimUser(setup, SAT_ASO);
    const originalId = (
      await setup.query("select row_id as id from public.upload_sat_combined_report_secure('KUL - MAA', 'Alpha', '2027-04-03', '3-shift', 'sat/original.pdf');")
    ).rows[0].id;
    await setSimServiceRole(setup);

    const connA = new Client({ ...pgConfig, database: runDb });
    const connB = new Client({ ...pgConfig, database: runDb });
    await connA.connect();
    await connB.connect();
    await setSimUser(connA, SAT_ASO);
    await setSimUser(connB, SAT_ASO);

    const [resA, resB] = await Promise.all([
      connA.query("select * from public.replace_sat_combined_report_secure($1, '3-shift v2', 'sat/replace-a.pdf', 'race replacement A');", [originalId]).then((r) => ({ ok: true, rows: r.rows })).catch((e) => ({ ok: false, error: e.message })),
      connB.query("select * from public.replace_sat_combined_report_secure($1, '3-shift v2', 'sat/replace-b.pdf', 'race replacement B');", [originalId]).then((r) => ({ ok: true, rows: r.rows })).catch((e) => ({ ok: false, error: e.message })),
    ]);
    await connA.end();
    await connB.end();

    const successCount = [resA, resB].filter((r) => r.ok).length;
    assert(successCount === 1, `Exactly one of two SIMULTANEOUS replacement attempts on the same active report succeeds (found ${successCount})`);
    const failed = [resA, resB].find((r) => !r.ok);
    assert(!!failed && /Only the currently active combined report may be replaced/.test(failed.error || ''), 'The losing replacement attempt is correctly denied with the "already superseded" reason, not a silent failure');

    const activeCount = await setup.query(`select count(*)::int as c from public.sat_combined_reports where supersedes = $1 and status = 'active';`, [originalId]);
    assert(activeCount.rows[0].c === 1, 'Exactly one new active version exists after the race -- no duplicate/corrupted version chain');
  }

  // =========================================================================
  // 6. SAT: a FAILED replacement attempt (invalid -- wrong SAT ASO, not
  //    on this team) must NOT affect the currently accepted active
  //    version. Not a concurrency scenario by itself, but directly
  //    required by the certification checklist alongside the
  //    concurrency proof above, and most meaningfully verified in the
  //    same run against the same real report row.
  // =========================================================================
  {
    const wrongTeamAso = nextId();
    await setup.query(`insert into auth.users (id, email) values ($1, 'p8c2-wrong-team@example.test') on conflict (id) do nothing;`, [wrongTeamAso]);
    await setup.query(
      `insert into public.profiles (id, email, name, staff_no, role, station, team, ops_group, status) values ($1, 'p8c2-wrong-team@example.test', 'Wrong Team', 'T-C7', 'ASO', 'KUL - MAA', 'Bravo', 'operation_avsec', 'approved')
       on conflict (id) do update set status = excluded.status;`,
      [wrongTeamAso],
    );
    const bravoTeamId = (
      await setup.query(`insert into public.org_teams (station_id, name) values ($1, 'Bravo') on conflict (station_id, name) do update set name = excluded.name returning id;`, [kulStationId])
    ).rows[0].id;
    await grantAssignment(wrongTeamAso, 'sat_aso', { aoc_id: aocId, department_id: enforcementDeptId, unit_id: satUnitId, hub_id: kulHubId, station_id: kulStationId, team_id: bravoTeamId }, true);

    const currentActive = await setup.query(
      `select id, storage_path, version from public.sat_combined_reports where team_id = $1 and operational_date = '2027-04-03' and status = 'active';`,
      [satAlphaTeamId],
    );
    const activeId = currentActive.rows[0].id;
    const activePath = currentActive.rows[0].storage_path;
    const activeVersion = currentActive.rows[0].version;

    await setSimUser(setup, wrongTeamAso);
    let failed = false;
    try {
      await setup.query("select public.replace_sat_combined_report_secure($1, 'malicious replace', 'sat/attacker.pdf', 'unauthorized attempt');", [activeId]);
    } catch (e) {
      failed = /Only an active SAT ASO on this exact team/.test(e.message);
    }
    await setSimServiceRole(setup);
    assert(failed, 'A SAT ASO on a different team is denied replacing another team\'s active report');

    const afterFailed = await setup.query('select id, storage_path, version, status from public.sat_combined_reports where id = $1;', [activeId]);
    assert(afterFailed.rows[0].status === 'active', 'The currently active version remains active after a failed/unauthorized replacement attempt');
    assert(afterFailed.rows[0].storage_path === activePath && Number(afterFailed.rows[0].version) === activeVersion, 'The accepted active version is completely unmodified by the failed replacement attempt (same path, same version)');
  }

  console.log('\nAll Phase 8 Round 2 concurrency checks passed -- every scenario used two genuinely separate, concurrently-executing native PostgreSQL connections.');

  setup.on('error', () => {}); // suppressed: pg_terminate_backend below closes this connection from the server side
  await setup.end().catch(() => {});

  const cleanup = new Client({ ...pgConfig, database: 'postgres' });
  await cleanup.connect();
  await cleanup.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${runDb}' and pid <> pg_backend_pid();`);
  await cleanup.query(`drop database if exists ${runDb};`);
  await cleanup.end();
  await admin.end();
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
