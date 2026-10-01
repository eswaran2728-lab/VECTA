// Phase 9 whitelist/transaction correction (round 2): genuine two-
// connection concurrency verification for create_caterlink_transaction_
// secure()'s transaction-number generator (`v_seq := max(...) + 1`,
// read-then-write, no explicit lock). Two REAL, separate, concurrently-
// executing native PostgreSQL connections call the RPC for two DIFFERENT
// usable vehicles at the same station/AOC/year, proving the generator
// either serializes correctly (distinct numbers) or that a genuine
// collision is caught -- never silently producing two transactions with
// the same transaction_number.
//
// Requires native PostgreSQL (PGlite is single-connection). Run from
// this directory, AFTER `node migrate.mjs --native`:
//   node verify_phase9_transaction_creation_concurrency_native.mjs
import pg from 'pg';
import { assertDisposableLocalTarget } from './safeguards.mjs';

const { Client } = pg;

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
const runDb = 'vecta_phase9_txn_concurrency_run';
const OVERALL_TIMEOUT_MS = 45000;

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + msg);
  console.log('PASS:', msg);
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

const openClients = [];
function trackedClient(database) {
  const client = new Client({ ...pgConfig, database });
  openClients.push(client);
  return client;
}
async function closeAllTrackedClients() {
  for (const client of openClients) {
    try { await client.query('rollback;').catch(() => {}); } catch {}
    try { await client.end(); } catch {}
  }
}

async function main() {
  assertDisposableLocalTarget(pgConfig, goldenDb, runDb);
  console.log(`=== Phase 9 transaction-creation concurrency verification against Native PostgreSQL (${pgConfig.host}:${pgConfig.port}) ===`);

  console.log('Connecting admin client, recreating the disposable database...');
  const admin = trackedClient('postgres');
  await admin.connect();
  await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${runDb}' and pid <> pg_backend_pid();`);
  await admin.query(`drop database if exists ${runDb};`);
  await admin.query(`create database ${runDb} template ${goldenDb};`);

  const setup = trackedClient(runDb);
  await setup.connect();
  console.log('Setup client connected. Seeding fixtures (caterlink_management, two usable vehicles+drivers)...');
  await setSimServiceRole(setup);

  const myAocId = (await setup.query("select id from public.aocs where code = 'MY';")).rows[0].id;
  const myCaterlinkDeptId = (await setup.query("select id from public.departments where aoc_id = $1 and code = 'caterlink';", [myAocId])).rows[0].id;
  const myOperationDeptId = (await setup.query("select id from public.departments where aoc_id = $1 and code = 'operation';", [myAocId])).rows[0].id;
  const kulStationId = (await setup.query("select id from public.org_stations where code = 'KUL - MAA';")).rows[0].id;
  const kulHubId = (await setup.query('select hub_id from public.org_stations where id = $1;', [kulStationId])).rows[0].hub_id;
  const kulTeamId = (
    await setup.query(`insert into public.org_teams (station_id, name) values ($1, 'TxnConcTeam') on conflict (station_id, name) do update set name = excluded.name returning id;`, [kulStationId])
  ).rows[0].id;

  const mgmt = '00000000-0000-0000-0000-0000000000b1';
  const scanner = '00000000-0000-0000-0000-0000000000b2';
  await setup.query("insert into auth.users (id, email) values ($1, 'txn-conc-mgmt@example.test') on conflict (id) do nothing;", [mgmt]);
  await setup.query(
    "insert into public.profiles (id, email, name, staff_no, role, status) values ($1, 'txn-conc-mgmt@example.test', 'Txn Conc Mgmt', 'TCM-01', 'MANAGEMENT', 'approved') on conflict (id) do update set status = excluded.status;",
    [mgmt],
  );
  await setup.query(
    "insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, starts_at) select $1, id, $2, $3, now() - interval '1 day' from public.role_definitions where code = 'caterlink_management';",
    [mgmt, myAocId, myCaterlinkDeptId],
  );

  const myEntityId = (await setup.query("select id from public.operating_entities where aoc_id = $1 and code = 'MAA';", [myAocId])).rows[0].id;
  await setup.query("insert into auth.users (id, email) values ($1, 'txn-conc-scanner@example.test') on conflict (id) do nothing;", [scanner]);
  await setup.query(
    "insert into public.profiles (id, email, name, staff_no, role, status) values ($1, 'txn-conc-scanner@example.test', 'Txn Conc Scanner', 'TCS-01', 'ASO', 'approved') on conflict (id) do update set status = excluded.status;",
    [scanner],
  );
  const scannerMemId = (
    await setup.query(
      `insert into public.user_entity_memberships (profile_id, aoc_id, operating_entity_id, status, is_primary) values ($1, $2, $3, 'active', true) returning id;`,
      [scanner, myAocId, myEntityId],
    )
  ).rows[0].id;
  await setup.query(
    "insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, hub_id, station_id, team_id, entity_membership_id, starts_at) select $1, id, $2, $3, $4, $5, $6, $7, now() - interval '1 day' from public.role_definitions where code = 'aso';",
    [scanner, myAocId, myOperationDeptId, kulHubId, kulStationId, kulTeamId, scannerMemId],
  );

  await setSimUser(setup, mgmt);
  async function registerUsable(entryType, identifier, name) {
    const res = await setup.query(
      `select id from public.create_caterlink_whitelist_entry_secure(p_entry_type => $1, p_aoc_id => $2, p_name => $3, p_identifier => $4);`,
      [entryType, myAocId, name, identifier],
    );
    await setup.query(`select * from public.approve_caterlink_whitelist_entry_secure($1, $2);`, [entryType, res.rows[0].id]);
  }
  await registerUsable('vehicle', 'TXC-VEH-A', null);
  await registerUsable('driver', 'TXC-DRV-A', 'Txn Conc Driver A');
  await registerUsable('vehicle', 'TXC-VEH-B', null);
  await registerUsable('driver', 'TXC-DRV-B', 'Txn Conc Driver B');

  console.log('Fixtures seeded. Closing setup client, opening Session A / Session B...');
  await setup.end();

  const clientA = trackedClient(runDb);
  const clientB = trackedClient(runDb);
  await clientA.connect();
  await clientB.connect();
  await setSimUser(clientA, scanner);
  await setSimUser(clientB, scanner);

  console.log('Step 1: Both sessions concurrently create a CaterLink transaction for two different vehicles...');
  const [resA, resB] = await Promise.all([
    clientA.query(
      `select transaction_id, transaction_number from public.create_caterlink_transaction_secure(
         p_aoc_id => $1, p_origin_station => 'KUL - MAA', p_direction => 'OUTBOUND', p_route => 'AIRCRAFT',
         p_vehicle_number => 'TXC-VEH-A', p_driver_name => 'Txn Conc Driver A', p_driver_id => 'TXC-DRV-A', p_seal_number => 'SEAL-TXC-A'
       );`,
      [myAocId],
    ),
    clientB.query(
      `select transaction_id, transaction_number from public.create_caterlink_transaction_secure(
         p_aoc_id => $1, p_origin_station => 'KUL - MAA', p_direction => 'OUTBOUND', p_route => 'AIRCRAFT',
         p_vehicle_number => 'TXC-VEH-B', p_driver_name => 'Txn Conc Driver B', p_driver_id => 'TXC-DRV-B', p_seal_number => 'SEAL-TXC-B'
       );`,
      [myAocId],
    ),
  ]);

  const numA = resA.rows[0].transaction_number;
  const numB = resB.rows[0].transaction_number;
  console.log(`  Session A transaction_number: ${numA}`);
  console.log(`  Session B transaction_number: ${numB}`);
  assert(numA !== numB, 'Two genuinely concurrent create_caterlink_transaction_secure() calls produced DISTINCT transaction numbers -- no collision');
  assert(resA.rows[0].transaction_id !== resB.rows[0].transaction_id, 'Two genuinely concurrent calls produced two distinct transaction rows');

  const dupCountRes = await clientA.query(
    'select transaction_number, count(*)::int as n from public.transactions where transaction_number in ($1, $2) group by transaction_number;',
    [numA, numB],
  );
  for (const row of dupCountRes.rows) {
    assert(row.n === 1, `Exactly one transaction row exists for transaction_number ${row.transaction_number} -- no duplicate committed`);
  }

  console.log('\nScenario PASSED: concurrent CaterLink transaction creation produced no transaction_number collision.');
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
  console.log('PHASE 9 TRANSACTION-CREATION CONCURRENCY TEST COMPLETED SUCCESSFULLY!');
  console.log('================================================================');
} else {
  process.exitCode = 1;
}
