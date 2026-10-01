// Phase 10: genuine two-connection concurrency verification for the
// discussion board -- two different authenticated users replying to the
// SAME thread at the same time, proving (a) reply_count's `set x = x + 1`
// increment is never lost under real concurrent writers, (b) each
// replier's alias is generated correctly and independently (no race in
// resolve_discussion_alias()), and (c) no duplicate/partial row is ever
// committed.
//
// Requires native PostgreSQL. Run from this directory, AFTER
// `node migrate.mjs --native`:
//   node verify_phase10_discussion_concurrency_native.mjs
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
const runDb = 'vecta_phase10_discussion_concurrency_run';
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
  console.log(`=== Phase 10 discussion concurrency verification against Native PostgreSQL (${pgConfig.host}:${pgConfig.port}) ===`);

  const admin = trackedClient('postgres');
  await admin.connect();
  await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${runDb}' and pid <> pg_backend_pid();`);
  await admin.query(`drop database if exists ${runDb};`);
  await admin.query(`create database ${runDb} template ${goldenDb};`);

  const setup = trackedClient(runDb);
  await setup.connect();
  await setSimServiceRole(setup);

  const myAocId = (await setup.query("select id from public.aocs where code = 'MY';")).rows[0].id;
  const generalCategoryId = (await setup.query("select id from public.discussion_categories where code = 'general' and aoc_id is null;")).rows[0].id;
  const myOperationDeptId = (await setup.query("select id from public.departments where aoc_id = $1 and code = 'operation';", [myAocId])).rows[0].id;
  const myEntityId = (await setup.query("select id from public.operating_entities where aoc_id = $1 and code = 'MAA';", [myAocId])).rows[0].id;
  const kulStationId = (await setup.query("select id from public.org_stations where code = 'KUL - MAA';")).rows[0].id;
  const kulHubId = (await setup.query('select hub_id from public.org_stations where id = $1;', [kulStationId])).rows[0].hub_id;
  const kulTeamId = (
    await setup.query(`insert into public.org_teams (station_id, name) values ($1, 'P10ConcTeam') on conflict (station_id, name) do update set name = excluded.name returning id;`, [kulStationId])
  ).rows[0].id;

  const userA = '00000000-0000-0000-0000-0000000000d1';
  const userB = '00000000-0000-0000-0000-0000000000d2';
  const roleId = (await setup.query("select id from public.role_definitions where code = 'aso';")).rows[0].id;
  for (const [id, email] of [[userA, 'p10-conc-a@example.test'], [userB, 'p10-conc-b@example.test']]) {
    await setup.query("insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing;", [id, email]);
    await setup.query(
      "insert into public.profiles (id, email, name, staff_no, role, status) values ($1, $2, $3, $4, 'ASO', 'approved') on conflict (id) do update set status = excluded.status;",
      [id, email, `P10 Conc ${email}`, `P10C-${email.slice(0, 3)}`],
    );
    const memId = (
      await setup.query(
        `insert into public.user_entity_memberships (profile_id, aoc_id, operating_entity_id, status, is_primary) values ($1, $2, $3, 'active', true) returning id;`,
        [id, myAocId, myEntityId],
      )
    ).rows[0].id;
    await setup.query(
      "insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, hub_id, station_id, team_id, entity_membership_id, starts_at) values ($1, $2, $3, $4, $5, $6, $7, $8, now() - interval '1 day');",
      [id, roleId, myAocId, myOperationDeptId, kulHubId, kulStationId, kulTeamId, memId],
    );
  }

  const superAdminRoleId = (await setup.query("select id from public.role_definitions where code = 'super_admin';")).rows[0].id;
  const modA = '00000000-0000-0000-0000-0000000000d3';
  const modB = '00000000-0000-0000-0000-0000000000d4';
  for (const [id, email] of [[modA, 'p10-mod-a@example.test'], [modB, 'p10-mod-b@example.test']]) {
    await setup.query("insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing;", [id, email]);
    await setup.query(
      "insert into public.profiles (id, email, name, staff_no, role, status) values ($1, $2, $3, $4, 'ASO', 'approved') on conflict (id) do update set status = excluded.status;",
      [id, email, `P10 Mod ${email}`, `P10M-${email.slice(0, 3)}`],
    );
    await setup.query(
      "insert into public.user_role_assignments (profile_id, role_definition_id, starts_at) values ($1, $2, now() - interval '1 day');",
      [id, superAdminRoleId],
    );
  }

  await setSimUser(setup, userA);
  const threadRes = await setup.query(
    "select id from public.create_discussion_thread_secure($1, 'Concurrency probe thread', 'Body for the concurrency test.');",
    [generalCategoryId],
  );
  const threadId = threadRes.rows[0].id;
  console.log('Fixtures seeded. Closing setup client, opening Session A / Session B...');
  await setup.end();

  const clientA = trackedClient(runDb);
  const clientB = trackedClient(runDb);
  await clientA.connect();
  await clientB.connect();

  console.log('\n--- Step 1: Concurrent Thread Creation ---');
  await setSimUser(clientA, userA);
  await setSimUser(clientB, userB);
  const [threadA, threadB] = await Promise.all([
    clientA.query("select id, author_alias from public.create_discussion_thread_secure($1, 'Concurrent Thread A', 'Body A');", [generalCategoryId]),
    clientB.query("select id, author_alias from public.create_discussion_thread_secure($1, 'Concurrent Thread B', 'Body B');", [generalCategoryId]),
  ]);
  assert(threadA.rows[0].id !== threadB.rows[0].id, 'Concurrent thread creation produced 2 distinct thread rows');
  assert(Boolean(threadA.rows[0].author_alias) && Boolean(threadB.rows[0].author_alias), 'Both concurrent threads generated valid aliases');

  console.log('\n--- Step 2: Concurrent Replies from Different Authors ---');
  const [resA, resB] = await Promise.all([
    clientA.query("select id, author_alias from public.create_discussion_reply_secure($1, 'Reply from A.');", [threadId]),
    clientB.query("select id, author_alias from public.create_discussion_reply_secure($1, 'Reply from B.');", [threadId]),
  ]);

  assert(resA.rows[0].id !== resB.rows[0].id, 'Two genuinely concurrent replies produced two distinct reply rows');
  assert(resA.rows[0].author_alias !== resB.rows[0].author_alias, 'Two different concurrent repliers received two different aliases -- no race/collision in alias generation');

  const countRes = await clientA.query('select reply_count from public.discussion_threads where id = $1;', [threadId]);
  assert(countRes.rows[0].reply_count === 2, `reply_count correctly reflects both concurrent replies (found: ${countRes.rows[0].reply_count}) -- the increment was not lost under real concurrency`);

  const rowCountRes = await clientA.query('select count(*)::int as n from public.discussion_replies where thread_id = $1;', [threadId]);
  assert(rowCountRes.rows[0].n === 2, 'Exactly two reply rows exist after the race -- no duplicate/partial commit');

  console.log('\n--- Step 3: Concurrent Replies from the SAME Author (Alias Continuity Race) ---');
  await setSimUser(clientB, userA); // Both clients simulate userA concurrently
  const [sameUserReplyA, sameUserReplyB] = await Promise.all([
    clientA.query("select id, author_alias from public.create_discussion_reply_secure($1, 'Concurrent reply 1 from userA.');", [threadId]),
    clientB.query("select id, author_alias from public.create_discussion_reply_secure($1, 'Concurrent reply 2 from userA.');", [threadId]),
  ]);
  assert(sameUserReplyA.rows[0].id !== sameUserReplyB.rows[0].id, 'Same author concurrent replies created 2 distinct reply records');
  assert(sameUserReplyA.rows[0].author_alias === resA.rows[0].author_alias, 'First concurrent reply kept existing author alias');
  assert(sameUserReplyB.rows[0].author_alias === resA.rows[0].author_alias, 'Second concurrent reply kept existing author alias (alias determinism verified under race)');

  const totalReplyCount = await clientA.query('select reply_count from public.discussion_threads where id = $1;', [threadId]);
  assert(totalReplyCount.rows[0].reply_count === 4, `reply_count incremented to 4 under multiple concurrent reply waves (found: ${totalReplyCount.rows[0].reply_count})`);

  console.log('\n--- Step 4: Concurrent Edits on Content ---');
  await setSimUser(clientA, userA);
  await setSimUser(clientB, userA);
  const [editA, editB] = await Promise.all([
    clientA.query("select public.edit_discussion_content_secure('thread', $1, 'Concurrent edit from session A');", [threadId]),
    clientB.query("select public.edit_discussion_content_secure('thread', $1, 'Concurrent edit from session B');", [threadId]),
  ]);
  assert(editA.rows[0].edit_discussion_content_secure === true && editB.rows[0].edit_discussion_content_secure === true, 'Concurrent edits both completed cleanly without deadlocks');

  console.log('\n--- Step 5: Concurrent / Duplicate Reports ---');
  await setSimUser(clientA, userA);
  await setSimUser(clientB, userB);
  const [reportA, reportB] = await Promise.all([
    clientA.query("select public.report_discussion_content_secure('thread', $1, 'spam', 'Session A report') as id;", [threadId]),
    clientB.query("select public.report_discussion_content_secure('thread', $1, 'harassment', 'Session B report') as id;", [threadId]),
  ]);
  assert(reportA.rows[0].id !== reportB.rows[0].id, 'Two concurrent reports produced 2 distinct report records');
  const reportCountRes = await clientA.query('select report_count from public.discussion_threads where id = $1;', [threadId]);
  assert(reportCountRes.rows[0].report_count === 2, `report_count accurately incremented to 2 under concurrent reports (found: ${reportCountRes.rows[0].report_count})`);

  console.log('\n--- Step 6: Concurrent Moderation Operations ---');
  await setSimUser(clientA, modA);
  await setSimUser(clientB, modB);
  const [modOpA, modOpB] = await Promise.all([
    clientA.query("select public.moderate_discussion_content_secure('thread', $1, 'lock', 'Mod A locking thread');", [threadId]),
    clientB.query("select public.moderate_discussion_content_secure('thread', $1, 'hide', 'Mod B hiding thread');", [threadId]),
  ]);
  assert(modOpA.rows[0].moderate_discussion_content_secure === true, 'Moderation operation A succeeded');
  assert(modOpB.rows[0].moderate_discussion_content_secure === true, 'Moderation operation B succeeded');

  await setSimServiceRole(clientA);
  const modLogCount = await clientA.query("select count(*)::int as n from public.discussion_moderation_log where content_id = $1;", [threadId]);
  assert(modLogCount.rows[0].n === 2, 'Exactly 2 audit records created in discussion_moderation_log for the concurrent operations');

  console.log('\nAll 6 concurrency scenarios PASSED: thread creation, cross-author replies, same-author alias race, concurrent edits, duplicate reports, duplicate moderation.');
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
  console.log('PHASE 10 DISCUSSION CONCURRENCY TEST COMPLETED SUCCESSFULLY!');
  console.log('================================================================');
} else {
  process.exitCode = 1;
}
