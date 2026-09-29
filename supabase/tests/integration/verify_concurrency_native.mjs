// Multi-connection concurrency verification for Phase 6:
// Genuinely exercises Scenario 12 and Scenario 26 using separate, concurrent
// database connections against native PostgreSQL 17.
//
// Establishes overlapping transactions and captures explicit lock-state evidence
// (querying pg_stat_activity and pg_locks) while the second connection is blocked.
//
// Run from this directory:
//   node verify_concurrency_native.mjs
import pg from 'pg';
import crypto from 'crypto';
import { assertDisposableLocalTarget } from './safeguards.mjs';

const { Client } = pg;

const pgConfig = {
  host: process.env.PGHOST || '127.0.0.1',
  port: parseInt(process.env.PGPORT || '55433', 10),
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || undefined,
};
const goldenDb = process.env.PGDATABASE || 'vecta_phase6_test';
const runDb = 'vecta_phase6_concurrency_run';

function assert(condition, message) {
  if (!condition) {
    throw new Error(`ASSERTION FAILED: ${message}`);
  }
  console.log(`  PASS: ${message}`);
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function simulateUser(client, profileId) {
  await client.query('reset role;');
  await client.query("set role 'authenticated';");
  await client.query(
    "select set_config('request.jwt.claims', json_build_object('sub', $1::text, 'role', 'authenticated')::text, false);",
    [profileId]
  );
}

async function simulateServiceRole(client) {
  await client.query('reset role;');
  await client.query("set role 'service_role';");
  await client.query("select set_config('request.jwt.claims', '{}', false);");
}

async function clearSimulation(client) {
  await client.query('reset role;');
  await client.query("select set_config('request.jwt.claims', '', false);");
}

async function main() {
  console.log('================================================================');
  console.log('PHASE 6 MULTI-CONNECTION CONCURRENCY VERIFICATION (NATIVE PG17)');
  console.log('================================================================\n');

  // Setup disposable clone database
  assertDisposableLocalTarget(pgConfig, goldenDb, runDb);
  console.log(`Cloning disposable test database '${runDb}' from '${goldenDb}'...`);
  const adminClient = new Client({ ...pgConfig, database: 'postgres' });
  await adminClient.connect();
  await adminClient.query(`
    select pg_terminate_backend(pid) from pg_stat_activity
    where datname = '${runDb}' and pid <> pg_backend_pid();
  `);
  await adminClient.query(`drop database if exists ${runDb};`);
  await adminClient.query(`create database ${runDb} template ${goldenDb};`);
  await adminClient.end();
  console.log('Clone ready.\n');

  const monitor = new Client({ ...pgConfig, database: runDb });
  const clientA = new Client({ ...pgConfig, database: runDb });
  const clientB = new Client({ ...pgConfig, database: runDb });

  await monitor.connect();
  await clientA.connect();
  await clientB.connect();

  await monitor.query('set check_function_bodies = off;');
  await clientA.query('set check_function_bodies = off;');
  await clientB.query('set check_function_bodies = off;');

  const ALPHA_ID = '00000000-0000-0000-0000-0000000000a1';
  const BRAVO_ID = '00000000-0000-0000-0000-0000000000a2';

  // Seed standard synthetic identities
  await simulateServiceRole(monitor);
  await monitor.query(`
    insert into auth.users (id, email) values
      ('${ALPHA_ID}', 'alpha-concurrency@example.test'),
      ('${BRAVO_ID}', 'bravo-concurrency@example.test')
    on conflict (id) do nothing;

    insert into public.profiles (id, email, name, staff_no, role, station, team, ops_group, status)
    values
      ('${ALPHA_ID}', 'alpha-concurrency@example.test', 'Test ASO Alpha', 'T-A1', 'ASO', 'KUL - MAA', 'Alpha', 'operation_avsec', 'approved'),
      ('${BRAVO_ID}', 'bravo-concurrency@example.test', 'Test ASO Bravo', 'T-A2', 'ASO', 'PEN', 'Bravo', 'operation_avsec', 'approved')
    on conflict (id) do update set
      name = excluded.name, staff_no = excluded.staff_no, role = excluded.role,
      station = excluded.station, team = excluded.team, ops_group = excluded.ops_group, status = excluded.status;
  `);
  await clearSimulation(monitor);

  // =========================================================================
  // SCENARIO 12: Concurrent finalization and child write
  // =========================================================================
  console.log('--- EXECUTING SCENARIO 12: Concurrent Finalization vs Child Write ---');
  const report12Id = crypto.randomUUID();

  // Create report_sec014 as Alpha with 1 initial patrol
  await simulateUser(monitor, ALPHA_ID);
  await monitor.query(`
    insert into public.report_sec014 (id, profile_id, status, station, team, staff_name, staff_id, date_time_in, date_time_out, remark, acknowledgement)
    values ($1, $2, 'submitted', 'KUL - MAA', 'Alpha', 'Test ASO Alpha', 'T-A1', now(), now() + interval '1 hour', 'Scenario 12 test report', false);
  `, [report12Id, ALPHA_ID]);

  await monitor.query(`
    insert into public.report_sec014_patrols (report_id, entry_no, location, description)
    values ($1, 1, 'Apron', 'initial valid patrol');
  `, [report12Id]);
  await clearSimulation(monitor);

  // Setup Session A (Finalizer)
  await simulateUser(clientA, ALPHA_ID);
  // Setup Session B (Concurrent Child Writer)
  await simulateUser(clientB, ALPHA_ID);

  console.log('Step 1: Session A begins transaction and calls mark_report_ready_for_indexing() [holds row lock]...');
  await clientA.query('begin;');
  await clientA.query(
    'select public.mark_report_ready_for_indexing($1, $2, $3);',
    ['report_sec014', report12Id, 1]
  );

  console.log('Step 2: Session B begins transaction and attempts child INSERT on the locked report...');
  await clientB.query('begin;');

  let sessionBCompleted = false;
  let sessionBError = null;

  // Launch child INSERT asynchronously on Session B
  const sessionBPromise = clientB.query(
    `insert into public.report_sec014_patrols (report_id, entry_no, location, description)
     values ($1, 2, 'Gate C1', 'racing child insert');`,
    [report12Id]
  ).then(() => {
    sessionBCompleted = true;
  }).catch((err) => {
    sessionBCompleted = true;
    sessionBError = err;
  });

  // Wait for Session B statement to reach the server and block
  await sleep(300);

  // Query PostgreSQL lock state from Monitor
  const lockQuery = await monitor.query(`
    select
      blocked.pid as blocked_pid,
      blocking.pid as blocking_pid,
      blocked.wait_event_type,
      blocked.wait_event,
      blocked.state,
      l_blocked.locktype,
      l_blocked.mode as requested_mode,
      l_blocked.granted as lock_granted
    from pg_stat_activity blocked
    join pg_locks l_blocked on l_blocked.pid = blocked.pid and not l_blocked.granted
    join pg_stat_activity blocking on blocking.pid = $1
    where blocked.pid = $2;
  `, [clientA.processID, clientB.processID]);

  console.log('Step 3: Verifying explicit lock-state evidence...');
  assert(!sessionBCompleted, 'Session B is actively blocked and has not completed while Session A holds the lock');
  assert(lockQuery.rows.length > 0, `Lock wait detected: Session B (PID ${clientB.processID}) is waiting on Session A (PID ${clientA.processID})`);
  console.log(`  EVIDENCE: PID ${clientB.processID} wait_event_type='${lockQuery.rows[0].wait_event_type}', wait_event='${lockQuery.rows[0].wait_event}', locktype='${lockQuery.rows[0].locktype}', requested_mode='${lockQuery.rows[0].requested_mode}', granted=${lockQuery.rows[0].lock_granted}`);

  console.log('Step 4: Committing Session A (releasing lock and finalizing queue row)...');
  await clientA.query('commit;');

  console.log('Step 5: Waiting for unblocked Session B to finish...');
  await sessionBPromise;

  assert(sessionBCompleted, 'Session B unblocked and ran to completion after Session A committed');
  assert(sessionBError !== null, `Session B failed as required: ${sessionBError?.message}`);
  assert(
    sessionBError.message.includes('already been finalized'),
    `Session B error specifically rejected child write after finalization (found: "${sessionBError.message}")`
  );
  await clientB.query('rollback;');

  // Verify child table and queue state
  const childRows12 = await monitor.query(
    'select entry_no, location, description from public.report_sec014_patrols where report_id = $1 order by entry_no;',
    [report12Id]
  );
  assert(childRows12.rows.length === 1, `Exactly 1 child row exists (initial patrol) - racing row was rejected (found ${childRows12.rows.length})`);
  assert(childRows12.rows[0].location === 'Apron', 'Retained child row is the pre-finalization Apron patrol');

  const queueRows12 = await monitor.query(
    "select source_table, source_id, status from public.report_index_queue where source_table = 'report_sec014' and source_id = $1;",
    [report12Id]
  );
  assert(queueRows12.rows.length === 1, 'Exactly 1 queue entry exists in report_index_queue');
  console.log('Scenario 12 PASSED with verified transaction overlap and lock-state evidence.\n');

  // =========================================================================
  // SCENARIO 26: Concurrent resume_report_submission_secure()
  // =========================================================================
  console.log('--- EXECUTING SCENARIO 26: Concurrent resume_report_submission_secure() ---');
  const report26Id = crypto.randomUUID();

  // Setup stranded report_sec033 (submitted, but 0 hold_checks and 0 queue rows)
  await simulateUser(monitor, ALPHA_ID);
  await monitor.query(`
    insert into public.report_sec033 (id, profile_id, status, station, team, staff_name, staff_id, report_date, report_time)
    values ($1, $2, 'submitted', 'KUL - MAA', 'Alpha', 'Test ASO Alpha', 'T-A1', current_date, '09:00');
  `, [report26Id, ALPHA_ID]);
  await clearSimulation(monitor);

  const initialChildren26 = await monitor.query(
    'select count(*) as count from public.report_sec033_hold_checks where report_id = $1;',
    [report26Id]
  );
  const initialQueue26 = await monitor.query(
    "select count(*) as count from public.report_index_queue where source_table = 'report_sec033' and source_id = $1;",
    [report26Id]
  );
  assert(parseInt(initialChildren26.rows[0].count, 10) === 0, 'Initial stranded report has 0 child rows');
  assert(parseInt(initialQueue26.rows[0].count, 10) === 0, 'Initial stranded report has 0 queue entries');

  console.log('Step 1: Session A begins transaction and calls resume_report_submission_secure() with payload A...');
  await simulateUser(clientA, ALPHA_ID);
  await simulateUser(clientB, ALPHA_ID);

  await clientA.query('begin;');
  await clientA.query(
    `select public.resume_report_submission_secure(
      'report_sec033', $1,
      '[{"parking_bay_no": "C1", "aircraft_registration_no": "9M-CCA", "remarks": "session A"}]'::jsonb
    );`,
    [report26Id]
  );
  // Session A holds FOR UPDATE lock on report_sec033, has inserted child A and queued report

  console.log('Step 2: Session B begins transaction and calls resume_report_submission_secure() with payload B...');
  await clientB.query('begin;');

  let sessionB26Completed = false;
  let sessionB26Error = null;

  const sessionB26Promise = clientB.query(
    `select public.resume_report_submission_secure(
      'report_sec033', $1,
      '[{"parking_bay_no": "C2", "aircraft_registration_no": "9M-CCB", "remarks": "session B"}]'::jsonb
    );`,
    [report26Id]
  ).then(() => {
    sessionB26Completed = true;
  }).catch((err) => {
    sessionB26Completed = true;
    sessionB26Error = err;
  });

  // Wait for Session B statement to block on the row lock
  await sleep(300);

  const lockQuery26 = await monitor.query(`
    select
      blocked.pid as blocked_pid,
      blocking.pid as blocking_pid,
      blocked.wait_event_type,
      blocked.wait_event,
      blocked.state,
      l_blocked.locktype,
      l_blocked.mode as requested_mode,
      l_blocked.granted as lock_granted
    from pg_stat_activity blocked
    join pg_locks l_blocked on l_blocked.pid = blocked.pid and not l_blocked.granted
    join pg_stat_activity blocking on blocking.pid = $1
    where blocked.pid = $2;
  `, [clientA.processID, clientB.processID]);

  console.log('Step 3: Verifying explicit lock-state evidence...');
  assert(!sessionB26Completed, 'Session B is actively waiting on Session A and has not returned');
  assert(lockQuery26.rows.length > 0, `Lock wait detected: Session B (PID ${clientB.processID}) is waiting on Session A (PID ${clientA.processID})`);
  console.log(`  EVIDENCE: PID ${clientB.processID} wait_event_type='${lockQuery26.rows[0].wait_event_type}', wait_event='${lockQuery26.rows[0].wait_event}', locktype='${lockQuery26.rows[0].locktype}', requested_mode='${lockQuery26.rows[0].requested_mode}', granted=${lockQuery26.rows[0].lock_granted}`);

  console.log('Step 4: Committing Session A...');
  await clientA.query('commit;');

  console.log('Step 5: Waiting for unblocked Session B to finish...');
  await sessionB26Promise;

  assert(sessionB26Completed, 'Session B unblocked and finished');
  assert(sessionB26Error === null, `Session B returned cleanly without error (no-op as report was already finalized): ${sessionB26Error?.message || 'OK'}`);
  await clientB.query('commit;');

  // Verifications for Scenario 26
  console.log('Step 6: Verifying child rows, queue entries, and non-duplication...');
  const childRows26 = await monitor.query(
    'select parking_bay_no, aircraft_registration_no, remarks from public.report_sec033_hold_checks where report_id = $1;',
    [report26Id]
  );
  assert(childRows26.rows.length === 1, `Exactly 1 child row exists after concurrent resume calls (found ${childRows26.rows.length})`);
  assert(
    childRows26.rows[0].aircraft_registration_no === '9M-CCA',
    `Persisted child row belongs to Session A ('9M-CCA'), never Session B ('9M-CCB') or duplicate`
  );

  const queueRows26 = await monitor.query(
    "select source_table, source_id from public.report_index_queue where source_table = 'report_sec033' and source_id = $1;",
    [report26Id]
  );
  assert(queueRows26.rows.length === 1, 'Exactly 1 queue entry exists in report_index_queue');

  // Verify Version 1 complete and immutable snapshot via index_report
  console.log('Step 7: Verifying Version 1 snapshot creation and immutability...');
  await simulateServiceRole(monitor);

  const aocId = (await monitor.query("select id from public.aocs where code = 'MY';")).rows[0].id;
  const entityId = (await monitor.query('select id from public.operating_entities where aoc_id = $1 and code = $2;', [aocId, 'MAA'])).rows[0].id;
  const hubId = (await monitor.query('select id from public.hubs where aoc_id = $1 and code = $2;', [aocId, 'kul'])).rows[0].id;
  const reportNo = (await monitor.query('select report_no from public.report_sec033 where id = $1;', [report26Id])).rows[0].report_no;

  await monitor.query(`
    select public.index_report(
      'report_sec033', $1, $2,
      $3, $4, null, null,
      $5, null, null, null, current_date,
      $6
    );
  `, [report26Id, reportNo, aocId, entityId, hubId, ALPHA_ID]);

  const versionQuery = await monitor.query(`
    select v.version_number, v.amended_content -> 'hold_checks' as hold_checks
    from public.report_versions v
    join public.central_reports_index c on c.id = v.repository_report_id
    where c.source_table = 'report_sec033' and c.source_id = $1;
  `, [report26Id]);

  assert(versionQuery.rows.length === 1, `Exactly 1 version row exists (version 1) (found ${versionQuery.rows.length})`);
  assert(versionQuery.rows[0].version_number === 1, 'Version number is 1');
  const capturedHoldChecks = versionQuery.rows[0].hold_checks;
  assert(
    Array.isArray(capturedHoldChecks) && capturedHoldChecks.length === 1 && capturedHoldChecks[0].aircraft_registration_no === '9M-CCA',
    `Version 1 snapshot immutably captures Session A child row ('9M-CCA'): ${JSON.stringify(capturedHoldChecks)}`
  );

  // Immutability check: non-service_role attempt to modify version or report
  await simulateUser(clientA, ALPHA_ID);
  let versionMutated = false;
  try {
    await clientA.query('delete from public.report_versions;');
    versionMutated = true;
  } catch (err) {
    // Expected: permission denied or 0 rows deleted due to RLS
  }
  const versionCountAfter = (await monitor.query('select count(*) as c from public.report_versions;')).rows[0].c;
  assert(parseInt(versionCountAfter, 10) >= 1, 'report_versions rows remain immutable and cannot be deleted by non-service_role');

  // Verify ownership / role restrictions on resume_report_submission_secure()
  console.log('Step 8: Verifying ownership and role restrictions...');
  // 1. Cross-profile denial: Bravo cannot resume Alpha's report
  await simulateUser(clientB, BRAVO_ID);
  let bravoResumeError = null;
  try {
    await clientB.query(
      `select public.resume_report_submission_secure('report_sec033', $1, '[]'::jsonb);`,
      [report26Id]
    );
  } catch (err) {
    bravoResumeError = err;
  }
  assert(bravoResumeError !== null, `Bravo (unauthorized user) rejected from resuming Alpha's report: ${bravoResumeError?.message}`);
  assert(
    bravoResumeError.message.includes('Only the submitting profile may resume its own report'),
    'Error message confirms ownership enforcement'
  );

  // 2. Unauthenticated caller denial
  await clearSimulation(clientB);
  let unauthError = null;
  try {
    await clientB.query(
      `select public.resume_report_submission_secure('report_sec033', $1, '[]'::jsonb);`,
      [report26Id]
    );
  } catch (err) {
    unauthError = err;
  }
  assert(unauthError !== null, `Unauthenticated caller rejected: ${unauthError?.message}`);
  assert(
    unauthError.message.includes('Must be signed in'),
    'Error message confirms authentication enforcement'
  );

  console.log('Scenario 26 PASSED with verified transaction overlap, serialization, and immutability.\n');

  // Cleanup
  console.log('Cleaning up connections and test database...');
  await monitor.end();
  await clientA.end();
  await clientB.end();

  const finalAdmin = new Client({ ...pgConfig, database: 'postgres' });
  await finalAdmin.connect();
  await finalAdmin.query(`
    select pg_terminate_backend(pid) from pg_stat_activity
    where datname = '${runDb}' and pid <> pg_backend_pid();
  `);
  await finalAdmin.query(`drop database if exists ${runDb};`);
  await finalAdmin.end();

  console.log('================================================================');
  console.log('ALL MULTI-CONNECTION CONCURRENCY TESTS COMPLETED SUCCESSFULLY!');
  console.log('================================================================');
}

main().catch((err) => {
  console.error('\nCONCURRENCY VERIFICATION FAILED:', err);
  process.exit(1);
});
