// Phase 8 Part D: genuine multi-connection concurrency verification for
// the leave-request capacity rule (review_leave_request_secure()'s
// pg_advisory_xact_lock serialization). Uses two REAL, separate
// PostgreSQL connections -- not two sequential calls on one connection --
// to prove the race condition the spec calls out ("Concurrent approvals
// must not allow the capacity rule to be bypassed") is actually closed,
// not just closed in a single-connection simulation.
//
// Scenario: a team already has exactly 2 approved overlapping annual-
// leave rows (capacity is 3). Two DIFFERENT pending requests for that
// same team/dates are approved AT THE SAME TIME from two separate
// connections. Exactly one of them may become the 3rd approval; the
// other must either block until the first commits (and then correctly
// see the capacity already reached) or be denied outright -- in no
// case may BOTH succeed, which would silently admit a 4th concurrent
// approval past the stated cap of 3.
//
// Requires --native (a real, separate, running PostgreSQL connection);
// this cannot be meaningfully exercised against PGlite, which is
// single-connection.
//
// Run from this directory, AFTER `node migrate.mjs --native`:
//   node verify_phase8_leave_concurrency_native.mjs
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
const runDb = 'vecta_phase8_leave_concurrency_run';

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + msg);
  console.log('PASS:', msg);
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function simulateUser(client, profileId) {
  await client.query('reset role;');
  await client.query("set role 'authenticated';");
  await client.query(
    "select set_config('request.jwt.claims', json_build_object('sub', $1::text, 'role', 'authenticated')::text, false);",
    [profileId],
  );
}

async function simulateServiceRole(client) {
  await client.query('reset role;');
  await client.query("set role 'service_role';");
  await client.query("select set_config('request.jwt.claims', '{}', false);");
}

async function main() {
  assertDisposableLocalTarget(pgConfig, goldenDb, runDb);
  console.log(`=== Phase 8 leave-concurrency verification against Native PostgreSQL (${pgConfig.host}:${pgConfig.port}) ===`);

  const admin = new Client({ ...pgConfig, database: 'postgres' });
  await admin.connect();
  await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${runDb}' and pid <> pg_backend_pid();`);
  await admin.query(`drop database if exists ${runDb};`);
  await admin.query(`create database ${runDb} template ${goldenDb};`);

  const setup = new Client({ ...pgConfig, database: runDb });
  await setup.connect();

  const DSE = '00000000-0000-0000-0000-0000000000c1';
  const GRANTER = '00000000-0000-0000-0000-0000000000c2';
  const APPROVED_A = '00000000-0000-0000-0000-0000000000c3';
  const APPROVED_B = '00000000-0000-0000-0000-0000000000c4';
  const PENDING_C = '00000000-0000-0000-0000-0000000000c5';
  const PENDING_D = '00000000-0000-0000-0000-0000000000c6';

  await simulateServiceRole(setup);
  const ids = [DSE, GRANTER, APPROVED_A, APPROVED_B, PENDING_C, PENDING_D];
  await setup.query(
    `insert into auth.users (id, email) values ${ids.map((_, i) => `($${i + 1}, 'p8lc-${i}@example.test')`).join(',')} on conflict (id) do nothing;`,
    ids,
  );
  await setup.query(
    `insert into public.profiles (id, email, name, staff_no, role, station, team, ops_group, status)
     values
       ($1, 'p8lc-0@example.test', 'DSE', 'T-C1', 'ASO', 'KUL - MAA', 'LcTeam', 'operation_avsec', 'approved'),
       ($2, 'p8lc-1@example.test', 'Granter', 'T-C2', 'ADMIN', null, null, 'operation_avsec', 'approved'),
       ($3, 'p8lc-2@example.test', 'A', 'T-C3', 'ASO', 'KUL - MAA', 'LcTeam', 'operation_avsec', 'approved'),
       ($4, 'p8lc-3@example.test', 'B', 'T-C4', 'ASO', 'KUL - MAA', 'LcTeam', 'operation_avsec', 'approved'),
       ($5, 'p8lc-4@example.test', 'C', 'T-C5', 'ASO', 'KUL - MAA', 'LcTeam', 'operation_avsec', 'approved'),
       ($6, 'p8lc-5@example.test', 'D', 'T-C6', 'ASO', 'KUL - MAA', 'LcTeam', 'operation_avsec', 'approved')
     on conflict (id) do update set name = excluded.name, staff_no = excluded.staff_no, role = excluded.role,
       station = excluded.station, team = excluded.team, ops_group = excluded.ops_group, status = excluded.status;`,
    [DSE, GRANTER, APPROVED_A, APPROVED_B, PENDING_C, PENDING_D],
  );

  const aocId = (await setup.query("select id from public.aocs where code = 'MY';")).rows[0].id;
  const maaEntityId = (await setup.query("select id from public.operating_entities where aoc_id = $1 and code = 'MAA';", [aocId])).rows[0].id;
  const operationDeptId = (await setup.query("select id from public.departments where aoc_id = $1 and code = 'operation';", [aocId])).rows[0].id;
  const kulStationId = (await setup.query("select id from public.org_stations where code = 'KUL - MAA';")).rows[0].id;
  const kulHubId = (await setup.query('select hub_id from public.org_stations where id = $1;', [kulStationId])).rows[0].hub_id;
  const teamId = (
    await setup.query(
      `insert into public.org_teams (station_id, name) values ($1, 'LcTeam') on conflict (station_id, name) do update set name = excluded.name returning id;`,
      [kulStationId],
    )
  ).rows[0].id;

  const membershipId = (
    await setup.query(
      `insert into public.user_entity_memberships (profile_id, aoc_id, operating_entity_id, status, is_primary)
       values ($1, $2, $3, 'active', true) returning id;`,
      [DSE, aocId, maaEntityId],
    )
  ).rows[0].id;
  const dseRoleId = (await setup.query("select id from public.role_definitions where code = 'dse';")).rows[0].id;
  await setup.query(
    `insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, hub_id, station_id, team_id, entity_membership_id, granted_by, grant_reason)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'phase8 leave concurrency fixture');`,
    [DSE, dseRoleId, aocId, operationDeptId, kulHubId, kulStationId, teamId, membershipId, GRANTER],
  );

  // Exactly 2 already-approved overlapping annual-leave rows (capacity is 3).
  for (const uid of [APPROVED_A, APPROVED_B]) {
    await setup.query(
      `insert into public.absence_notices (user_id, staff_name, role, station, team, duty_date, shift_start_time, gap_minutes, status, remarks, leave_type, start_date, end_date, approval_status)
       values ($1, 'x', 'ASO', 'KUL - MAA', 'LcTeam', '2027-02-10', now(), 999, 'green', 'x', 'annual', '2027-02-10', '2027-02-12', 'approved');`,
      [uid],
    );
  }
  // Two DIFFERENT pending requests, overlapping the same dates -- each
  // would independently be "the 3rd" if evaluated against a stale count.
  const pendingC = await setup.query(
    `insert into public.absence_notices (user_id, staff_name, role, station, team, duty_date, shift_start_time, gap_minutes, status, remarks, leave_type, start_date, end_date, approval_status)
     values ($1, 'x', 'ASO', 'KUL - MAA', 'LcTeam', '2027-02-11', now(), 999, 'green', 'x', 'annual', '2027-02-11', '2027-02-11', 'pending') returning id;`,
    [PENDING_C],
  );
  const pendingD = await setup.query(
    `insert into public.absence_notices (user_id, staff_name, role, station, team, duty_date, shift_start_time, gap_minutes, status, remarks, leave_type, start_date, end_date, approval_status)
     values ($1, 'x', 'ASO', 'KUL - MAA', 'LcTeam', '2027-02-11', now(), 999, 'green', 'x', 'annual', '2027-02-11', '2027-02-11', 'pending') returning id;`,
    [PENDING_D],
  );
  const pendingCId = pendingC.rows[0].id;
  const pendingDId = pendingD.rows[0].id;
  await setup.end();

  // --- Two GENUINELY SEPARATE, concurrent connections, both simulating
  // the SAME DSE (the only person authorized to review this team's leave
  // below the cap), racing to approve two different pending requests. ---
  const connA = new Client({ ...pgConfig, database: runDb });
  const connB = new Client({ ...pgConfig, database: runDb });
  await connA.connect();
  await connB.connect();
  await simulateUser(connA, DSE);
  await simulateUser(connB, DSE);

  await connA.query('begin;');
  await connB.query('begin;');

  // B's advisory-lock attempt will BLOCK until A commits (releasing the
  // lock) -- so B must be fired, and A must be committed, WITHOUT
  // awaiting B first (awaiting B before committing A would deadlock: B
  // cannot return until A releases the lock at commit). Firing B's
  // query, then immediately committing A while B is still in flight, is
  // exactly what makes this a genuine concurrent-connection test rather
  // than two sequential calls.
  const resultAPromise = connA.query('select * from public.review_leave_request_secure($1, $2, $3);', [pendingCId, 'approve', null]);
  await resultAPromise;
  const resultBPromise = connB
    .query('select * from public.review_leave_request_secure($1, $2, $3);', [pendingDId, 'approve', null])
    .catch((e) => ({ error: e.message }));
  // Give B a moment to actually reach and block on the advisory lock
  // (still held by A, uncommitted) before A commits -- proves B was
  // genuinely blocked by A's still-open transaction, not just run after
  // it sequentially.
  await sleep(200);
  await connA.query('commit;');
  const resultB = await resultBPromise;
  let finalResultB = resultB;
  await connB.query('commit;').catch(() => connB.query('rollback;').catch(() => {}));

  await connA.end();
  await connB.end();

  const verify = new Client({ ...pgConfig, database: runDb });
  await verify.connect();
  const finalStatuses = await verify.query('select id, approval_status from public.absence_notices where id in ($1, $2) order by id;', [pendingCId, pendingDId]);
  const approvedCount = finalStatuses.rows.filter((r) => r.approval_status === 'approved').length;
  const deniedCount = finalStatuses.rows.filter((r) => r.approval_status === 'pending').length;

  console.log('Final statuses:', finalStatuses.rows);
  console.log('B result:', finalResultB.error ? `denied (${finalResultB.error})` : 'approved');

  assert(approvedCount === 1, `Exactly ONE of the two concurrently-approved requests actually became 'approved' (the 3rd, filling the capacity exactly) -- found ${approvedCount}`);
  assert(deniedCount === 1, `Exactly ONE of the two concurrently-approved requests was correctly denied/left pending (would have been the 4th, over capacity, and requires Operation Manager escalation) -- found ${deniedCount}`);
  assert(
    !!finalResultB.error && /must be escalated to the Operation Manager/.test(finalResultB.error),
    'The losing concurrent request receives the correct escalation error, not a silent failure or a bypassed cap',
  );

  console.log('\nAll Phase 8 leave-concurrency checks passed -- the advisory-lock serialization genuinely prevents the capacity race under two real, concurrent database connections.');
  await verify.end();
  await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${runDb}' and pid <> pg_backend_pid();`);
  await admin.query(`drop database if exists ${runDb};`);
  await admin.end();
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
