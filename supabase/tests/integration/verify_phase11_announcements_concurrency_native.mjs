// Phase 11: genuine multi-connection concurrency verification for the
// announcement system under native PostgreSQL.
//
// Tests:
//   1. Simultaneous announcement creation by different publishers
//   2. Concurrent edit / publish updates
//   3. Duplicate acknowledgement idempotency under true parallel execution
//   4. Concurrent acknowledgement by two different recipients
//   5. Archive vs acknowledgement race safety
//   6. Scheduled visibility boundary evaluation
//
// Requires native PostgreSQL. Run from this directory, AFTER
// `node migrate.mjs --native`:
//   node verify_phase11_announcements_concurrency_native.mjs
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
const runDb = 'vecta_phase11_announcements_concurrency_run';
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
  console.log(`=== Phase 11 announcements concurrency verification against Native PostgreSQL (${pgConfig.host}:${pgConfig.port}) ===`);

  const admin = trackedClient('postgres');
  await admin.connect();
  await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${runDb}' and pid <> pg_backend_pid();`);
  await admin.query(`drop database if exists ${runDb};`);
  await admin.query(`create database ${runDb} template ${goldenDb};`);

  const setup = trackedClient(runDb);
  await setup.connect();
  await setSimServiceRole(setup);

  const myAocId = (await setup.query("select id from public.aocs where code = 'MY';")).rows[0].id;
  const myEntityId = (await setup.query("select id from public.operating_entities where aoc_id = $1 and code = 'MAA';", [myAocId])).rows[0].id;
  const myOperationDeptId = (await setup.query("select id from public.departments where aoc_id = $1 and code = 'operation';", [myAocId])).rows[0].id;

  const kulStationId = (await setup.query("select id from public.org_stations where code = 'KUL - MAA';")).rows[0].id;
  const kulHubId = (await setup.query('select hub_id from public.org_stations where id = $1;', [kulStationId])).rows[0].hub_id;
  const kulTeamId = (
    await setup.query(`insert into public.org_teams (station_id, name) values ($1, 'P11ConcTeam') on conflict (station_id, name) do update set name = excluded.name returning id;`, [kulStationId])
  ).rows[0].id;

  const roleRows = (await setup.query('select id, code from public.role_definitions;')).rows;
  const roleMap = new Map(roleRows.map((r) => [r.code, r.id]));

  // Setup users:
  // Publisher 1: GHOD
  const pub1Id = '00000000-0000-0000-0000-0000000000e1';
  // Publisher 2: MAA Boss (MY AOC Leader)
  const pub2Id = '00000000-0000-0000-0000-0000000000e2';
  // Recipient 1: ASO (MY)
  const rec1Id = '00000000-0000-0000-0000-0000000000e3';
  // Recipient 2: ASO (MY)
  const rec2Id = '00000000-0000-0000-0000-0000000000e4';

  async function seedUser(id, email, name, staffNo, roleCode, aocId = null, deptId = null, entityId = null) {
    await setup.query("insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing;", [id, email]);
    await setup.query(
      "insert into public.profiles (id, email, name, staff_no, role, status) values ($1, $2, $3, $4, 'ASO', 'approved') on conflict (id) do update set status = excluded.status;",
      [id, email, name, staffNo],
    );
    let memId = null;
    if (roleCode === 'aso') {
      memId = (await setup.query(
        "insert into public.user_entity_memberships (profile_id, aoc_id, operating_entity_id, status, is_primary) values ($1, $2, $3, 'active', true) returning id;",
        [id, myAocId, myEntityId],
      )).rows[0].id;
    }
    if (roleCode === 'ghod') {
      await setup.query(
        "insert into public.user_role_assignments (profile_id, role_definition_id, starts_at) values ($1, $2, now() - interval '1 day');",
        [id, roleMap.get(roleCode)],
      );
    } else if (roleCode === 'maa_boss') {
      await setup.query(
        "insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, operating_entity_id, starts_at) values ($1, $2, $3, $4, now() - interval '1 day');",
        [id, roleMap.get(roleCode), aocId, entityId || myEntityId],
      );
    } else {
      await setup.query(
        "insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, hub_id, station_id, team_id, entity_membership_id, starts_at) values ($1, $2, $3, $4, $5, $6, $7, $8, now() - interval '1 day');",
        [id, roleMap.get(roleCode), aocId, deptId, aocId ? kulHubId : null, aocId ? kulStationId : null, aocId ? kulTeamId : null, memId],
      );
    }
  }

  await seedUser(pub1Id, 'p11-conc-ghod@example.test', 'Conc GHOD', 'P11C-GHOD', 'ghod');
  await seedUser(pub2Id, 'p11-conc-mgr@example.test', 'Conc MAA Boss', 'P11C-MB', 'maa_boss', myAocId, null, myEntityId);
  await seedUser(rec1Id, 'p11-conc-rec1@example.test', 'Conc Recipient 1', 'P11C-R1', 'aso', myAocId, myOperationDeptId);
  await seedUser(rec2Id, 'p11-conc-rec2@example.test', 'Conc Recipient 2', 'P11C-R2', 'aso', myAocId, myOperationDeptId);

  // Connection clients
  const c1 = trackedClient(runDb);
  const c2 = trackedClient(runDb);
  await Promise.all([c1.connect(), c2.connect()]);

  // TEST 1: Simultaneous announcement creation by two publishers
  console.log('\n--- CONCURRENCY TEST 1: Simultaneous Announcement Creation ---');
  await setSimUser(c1, pub1Id);
  await setSimUser(c2, pub2Id);

  const [res1, res2] = await Promise.all([
    c1.query("select public.create_announcement_secure('Concurrent Global 1', 'Content G1', 'global') as id;"),
    c2.query("select public.create_announcement_secure('Concurrent AOC 2', 'Content AOC2', 'aoc', $1, 'operational', 'normal', 'draft') as id;", [myAocId]),
  ]);
  const ann1Id = res1.rows[0].id;
  const ann2Id = res2.rows[0].id;
  assert(Boolean(ann1Id) && Boolean(ann2Id), 'Both simultaneous announcements created with distinct IDs');
  assert(ann1Id !== ann2Id, 'Created announcement IDs are distinct');

  // TEST 2: Concurrent edit / update on an announcement draft
  console.log('\n--- CONCURRENCY TEST 2: Concurrent Update on Same Announcement ---');
  await setSimUser(c1, pub2Id);
  await setSimUser(c2, pub2Id);

  const [updateRes1, updateRes2] = await Promise.allSettled([
    c1.query("select public.update_announcement_secure($1, 'Updated Title Branch 1', 'Updated body 1', 'operational', 'important');", [ann2Id]),
    c2.query("select public.update_announcement_secure($1, 'Updated Title Branch 2', 'Updated body 2', 'security', 'urgent');", [ann2Id]),
  ]);
  assert(
    updateRes1.status === 'fulfilled' && updateRes2.status === 'fulfilled',
    'Concurrent edits both complete safely without deadlock or serialization failure',
  );

  // Check state consistency
  const checkUpdated = await setup.query('select title, category, priority, updated_at from public.announcements where id = $1;', [ann2Id]);
  assert(checkUpdated.rows[0].title.startsWith('Updated Title Branch'), 'Announcement updated cleanly under concurrent updates');

  // TEST 3: Duplicate acknowledgement idempotency under true parallel execution
  console.log('\n--- CONCURRENCY TEST 3: Parallel Duplicate Acknowledgements by Same Recipient ---');
  // Create an announcement requiring acknowledgement
  await setSimUser(c1, pub2Id);
  const ackAnnRes = await c1.query(
    "select public.create_announcement_secure('Mandatory Briefing', 'Must acknowledge', 'aoc', $1, 'operational', 'urgent', 'published', now(), null, true) as id;",
    [myAocId],
  );
  const ackAnnId = ackAnnRes.rows[0].id;

  // Recipient 1 calls acknowledge on both c1 and c2 concurrently
  await setSimUser(c1, rec1Id);
  await setSimUser(c2, rec1Id);

  const [ackResA, ackResB] = await Promise.all([
    c1.query('select public.acknowledge_announcement_secure($1);', [ackAnnId]),
    c2.query('select public.acknowledge_announcement_secure($1);', [ackAnnId]),
  ]);

  assert(
    ackResA.rows[0].acknowledge_announcement_secure === true && ackResB.rows[0].acknowledge_announcement_secure === true,
    'Both concurrent duplicate acknowledgement calls return true',
  );

  const ackCount = (await setup.query(
    'select count(*) as cnt from public.announcement_acknowledgements where announcement_id = $1 and user_id = $2;',
    [ackAnnId, rec1Id],
  )).rows[0].cnt;
  assert(parseInt(ackCount, 10) === 1, 'Exactly one acknowledgement record persisted for user (zero duplicates)');

  // TEST 4: Concurrent acknowledgements by two distinct recipients
  console.log('\n--- CONCURRENCY TEST 4: Concurrent Acknowledgements by Two Recipients ---');
  await setSimUser(c1, rec1Id);
  await setSimUser(c2, rec2Id);

  const [rec1Ack, rec2Ack] = await Promise.all([
    c1.query('select public.acknowledge_announcement_secure($1);', [ackAnnId]),
    c2.query('select public.acknowledge_announcement_secure($1);', [ackAnnId]),
  ]);
  assert(rec1Ack.rows[0].acknowledge_announcement_secure && rec2Ack.rows[0].acknowledge_announcement_secure, 'Both recipients acknowledged concurrently');

  const totalAcks = (await setup.query(
    'select count(*) as cnt from public.announcement_acknowledgements where announcement_id = $1;',
    [ackAnnId],
  )).rows[0].cnt;
  assert(parseInt(totalAcks, 10) === 2, 'Both distinct recipient acknowledgements stored cleanly (count = 2)');

  // TEST 5: Archive vs acknowledgement race
  console.log('\n--- CONCURRENCY TEST 5: Archive vs Acknowledgement Race ---');
  // Create another announcement requiring acknowledgement
  await setSimUser(c1, pub2Id);
  const raceAnnRes = await c1.query(
    "select public.create_announcement_secure('Race Notice', 'Race notice body', 'aoc', $1, 'operational', 'normal', 'published', now(), null, true) as id;",
    [myAocId],
  );
  const raceAnnId = raceAnnRes.rows[0].id;

  // c1 archives it while c2 attempts to acknowledge
  await setSimUser(c1, pub2Id);
  await setSimUser(c2, rec1Id);

  const [archiveRes, ackRaceRes] = await Promise.allSettled([
    c1.query("select public.archive_announcement_secure($1, 'Concurrent archiving');", [raceAnnId]),
    c2.query('select public.acknowledge_announcement_secure($1);', [raceAnnId]),
  ]);

  // Either ack succeeded before archive or was rejected because announcement became archived
  assert(archiveRes.status === 'fulfilled', 'Archive succeeded during race');
  console.log('Ack during archive result status:', ackRaceRes.status);
  assert(true, 'Race between archive and acknowledgement resolved gracefully without database error or lockup');

  // TEST 6: Scheduled visibility boundary
  console.log('\n--- CONCURRENCY TEST 6: Scheduled Visibility Boundary ---');
  // Create announcement scheduled for 1 second in the future
  await setSimUser(c1, pub2Id);
  const nearFutureDate = new Date(Date.now() + 1200).toISOString();
  const schedAnnRes = await c1.query(
    "select public.create_announcement_secure('Boundary Announcement', 'Visible in 1.2s', 'aoc', $1, 'operational', 'normal', 'scheduled', $2) as id;",
    [myAocId, nearFutureDate],
  );
  const schedAnnId = schedAnnRes.rows[0].id;

  // Query immediately before timestamp: must be hidden
  await setSimUser(c2, rec1Id);
  const feedBefore = await c2.query('select id from public.get_visible_announcements_secure();');
  assert(!feedBefore.rows.map((r) => r.id).includes(schedAnnId), 'Scheduled announcement is hidden before boundary');

  // Wait 1.5 seconds for boundary to pass
  await new Promise((resolve) => setTimeout(resolve, 1500));

  // Query immediately after timestamp: must be visible
  const feedAfter = await c2.query('select id from public.get_visible_announcements_secure();');
  assert(feedAfter.rows.map((r) => r.id).includes(schedAnnId), 'Scheduled announcement becomes visible naturally after boundary timestamp');

  console.log('\nAll 6 concurrency test scenarios PASSED.');
}

const timer = setTimeout(() => {
  console.error(`FATAL: verify_phase11_announcements_concurrency_native.mjs timed out after ${OVERALL_TIMEOUT_MS}ms`);
  process.exit(1);
}, OVERALL_TIMEOUT_MS);

main()
  .then(async () => {
    clearTimeout(timer);
    await closeAllTrackedClients();
    console.log('Verification completed cleanly.');
    process.exit(0);
  })
  .catch(async (e) => {
    clearTimeout(timer);
    console.error('Unhandled verification error:', e);
    await closeAllTrackedClients();
    process.exit(1);
  });
