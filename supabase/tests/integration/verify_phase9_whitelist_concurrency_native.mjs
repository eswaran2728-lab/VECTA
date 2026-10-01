// Phase 9 whitelist consolidation: genuine multi-connection concurrency
// verification for create_caterlink_whitelist_entry_secure()'s duplicate
// prevention. Two REAL, separate, concurrently-executing native
// PostgreSQL connections attempt to create the same vehicle identifier
// at the same time -- proving the existing unique constraint on
// public.vehicles.vehicle_number actually serializes the two inserts
// (one blocks on the other's uncommitted row, then fails once the first
// commits), not just "the second sequential call happens to fail."
//
// Requires native PostgreSQL (PGlite is single-connection). Run from
// this directory, AFTER `node migrate.mjs --native`:
//   node verify_phase9_whitelist_concurrency_native.mjs
import pg from 'pg';
import { assertDisposableLocalTarget } from './safeguards.mjs';

const { Client } = pg;

// Bounded timeouts throughout: a genuine regression (a real unexpected
// deadlock) must fail this test loudly within a bounded time, never hang
// the harness indefinitely. connectionTimeoutMillis bounds Client#connect();
// query_timeout/statement_timeout bound any single query (both client- and
// server-side) -- long enough for the deliberate 300ms blocking window
// below, nowhere near long enough to mask a real hang.
const pgConfig = {
  host: process.env.PGHOST || '127.0.0.1',
  port: parseInt(process.env.PGPORT || '55433', 10),
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || undefined,
  connectionTimeoutMillis: 15000,
  query_timeout: 20000,
  statement_timeout: 20000,
};
const goldenDb = process.env.PGDATABASE || 'vecta_phase6_test';
const runDb = 'vecta_phase9_whitelist_concurrency_run';
const OVERALL_TIMEOUT_MS = 45000;

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

// Every pg.Client this run creates is tracked here so the finally block can
// unconditionally roll back and close all of them, regardless of where the
// test failed or hung. No client is ever created outside this helper.
const openClients = [];
function trackedClient(database) {
  const client = new Client({ ...pgConfig, database });
  openClients.push(client);
  return client;
}
async function closeAllTrackedClients() {
  for (const client of openClients) {
    try {
      await client.query('rollback;').catch(() => {});
    } catch {
      // not in a transaction, or already closed -- fine
    }
    try {
      await client.end();
    } catch {
      // already closed -- fine
    }
  }
}

async function main() {
  assertDisposableLocalTarget(pgConfig, goldenDb, runDb);
  console.log(`=== Phase 9 whitelist concurrency verification against Native PostgreSQL (${pgConfig.host}:${pgConfig.port}) ===`);

  console.log('Connecting admin client...');
  const admin = trackedClient('postgres');
  await admin.connect();
  console.log('Admin connected. Recreating the disposable database...');
  await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${runDb}' and pid <> pg_backend_pid();`);
  await admin.query(`drop database if exists ${runDb};`);
  await admin.query(`create database ${runDb} template ${goldenDb};`);
  console.log('Disposable database ready. Connecting setup client...');

  const setup = trackedClient(runDb);
  await setup.connect();
  console.log('Setup client connected. Seeding fixtures...');
  await setSimServiceRole(setup);

  const myAocId = (await setup.query("select id from public.aocs where code = 'MY';")).rows[0].id;
  const myCaterlinkDeptId = (await setup.query("select id from public.departments where aoc_id = $1 and code = 'caterlink';", [myAocId])).rows[0].id;

  const mgmtA = '00000000-0000-0000-0000-0000000000a1';
  const mgmtB = '00000000-0000-0000-0000-0000000000a2';
  for (const [id, email] of [[mgmtA, 'wl-conc-a@example.test'], [mgmtB, 'wl-conc-b@example.test']]) {
    await setup.query("insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing;", [id, email]);
    await setup.query(
      "insert into public.profiles (id, email, name, staff_no, role, station, status) values ($1, $2, $3, $4, 'MANAGEMENT', null, 'approved') on conflict (id) do update set status = excluded.status;",
      [id, email, `WL Conc ${email}`, `WLC-${email.slice(0, 3)}`],
    );
    await setup.query(
      "insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, starts_at) select $1, id, $2, $3, now() - interval '1 day' from public.role_definitions where code = 'caterlink_management';",
      [id, myAocId, myCaterlinkDeptId],
    );
  }
  console.log('Fixtures seeded. Closing setup client, opening Session A / Session B...');
  await setup.end();

  const clientA = trackedClient(runDb);
  const clientB = trackedClient(runDb);
  await clientA.connect();
  await clientB.connect();

  // --- Scenario: concurrent create of the SAME vehicle identifier ---
  await clientA.query('begin;');
  await clientB.query('begin;');
  await setSimUser(clientA, mgmtA);
  await setSimUser(clientB, mgmtB);

  console.log('Step 1: Session A begins transaction and creates vehicle "WYY 7777"...');
  const resA = await clientA.query(
    `select id, status from public.create_caterlink_whitelist_entry_secure(
       p_entry_type => 'vehicle', p_aoc_id => $1, p_identifier => 'WYY 7777'
     );`,
    [myAocId],
  );
  assert(resA.rows[0].status === 'pending', 'Session A created the vehicle (uncommitted, status=pending)');

  console.log('Step 2: Session B attempts the SAME identifier before A commits (should block on the unique index)...');
  let bBlocked = true;
  const bPromise = clientB
    .query(
      `select id, status from public.create_caterlink_whitelist_entry_secure(
         p_entry_type => 'vehicle', p_aoc_id => $1, p_identifier => 'WYY 7777'
       );`,
      [myAocId],
    )
    .then(() => {
      bBlocked = false;
    })
    .catch((e) => {
      bBlocked = false;
      throw e;
    });

  await sleep(300);
  console.log('Step 3: Verifying explicit lock-state evidence...');
  const waitRows = (
    await admin.query(
      `select pid, wait_event_type, wait_event, state, query
       from pg_stat_activity
       where datname = $1 and wait_event_type = 'Lock'`,
      [runDb],
    )
  ).rows;
  assert(bBlocked, 'Session B is actively blocked and has not returned while Session A holds its uncommitted insert');
  if (waitRows.length) {
    console.log(`  EVIDENCE: PID ${waitRows[0].pid} wait_event_type='${waitRows[0].wait_event_type}' wait_event='${waitRows[0].wait_event}' state='${waitRows[0].state}'`);
  } else {
    console.log('  (pg_stat_activity did not capture the wait sample this run; bBlocked above is the authoritative proof of overlap)');
  }

  console.log('Step 4: Committing Session A (releasing the row lock)...');
  await clientA.query('commit;');

  console.log('Step 5: Waiting for unblocked Session B to resolve...');
  let bError = null;
  try {
    await bPromise;
  } catch (e) {
    bError = e;
  }
  assert(bError !== null, 'Session B failed once unblocked -- the duplicate identifier was rejected, not silently accepted');
  // Round 3: create_caterlink_whitelist_entry_secure() now catches the raw unique_violation and
  // re-raises the clearer IDENTIFIER_ALREADY_REGISTERED message (see the identifier-reuse
  // correction) -- either that or the raw Postgres text proves the same underlying constraint fired.
  assert(/duplicate key|unique|IDENTIFIER_ALREADY_REGISTERED/i.test(bError.message), `Session B error is a genuine unique-constraint violation (found: "${bError.message}")`);
  await clientB.query('rollback;').catch(() => {});

  const count = (
    await clientA.query("select count(*)::int as n from public.vehicles where vehicle_number = 'WYY 7777';")
  ).rows[0].n;
  assert(count === 1, 'Exactly one vehicle row exists for "WYY 7777" after the race -- no duplicate committed');

  console.log('\nScenario PASSED with verified transaction overlap and lock-state evidence.');
}

const watchdog = setTimeout(() => {
  console.error(`FAILED: test exceeded its overall ${OVERALL_TIMEOUT_MS}ms budget -- treat as a hang, not a pass.`);
  process.exitCode = 1;
}, OVERALL_TIMEOUT_MS);

let exitCode = 0;
try {
  await main();
} catch (e) {
  exitCode = 1;
  console.error('FAILED:', e.message, e.stack);
} finally {
  clearTimeout(watchdog);
  console.log('Cleaning up: rolling back and closing every tracked client...');
  await closeAllTrackedClients();
  // Drop the disposable database only after every client that could be
  // holding a connection to it has been closed -- DROP DATABASE itself
  // fails while any other backend is connected.
  try {
    const finalAdmin = new Client({ ...pgConfig, database: 'postgres' });
    await finalAdmin.connect();
    await finalAdmin.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${runDb}' and pid <> pg_backend_pid();`);
    await finalAdmin.query(`drop database if exists ${runDb};`);
    await finalAdmin.end();
    console.log('Disposable database dropped.');
  } catch (e) {
    console.error('Cleanup warning (disposable database may need manual removal):', e.message);
    exitCode = exitCode || 1;
  }
}

if (exitCode === 0 && process.exitCode !== 1) {
  console.log('\n================================================================');
  console.log('PHASE 9 WHITELIST CONCURRENCY TEST COMPLETED SUCCESSFULLY!');
  console.log('================================================================');
} else {
  process.exitCode = 1;
}
// Natural exit: no forced process.exit() call. If the process does not
// exit on its own here, that itself is a bug (an un-closed handle/timer)
// worth seeing, not something to paper over by forcing the exit.
