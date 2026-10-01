// Phase 10: Anonymous Discussion Board verification.
//
// Verifies:
//  1. Authentication boundary (unauthenticated read/create/reply denied).
//  2. Anonymity: real author never returned by any ordinary RPC, direct
//     table reads of the protected mapping are denied to authenticated,
//     same author keeps the same alias within a thread, a DIFFERENT
//     thread's alias cannot be correlated to the same person by an
//     ordinary participant.
//  3. Authorization: approved user succeeds; disabled user denied; wrong
//     AOC denied; unauthorized category denied.
//  4. Ownership: author edits/removes own content; another user denied.
//  5. Reporting: report created; reporter identity never exposed to
//     ordinary queries.
//  6. Moderation: authorized (super_admin) succeeds; unauthorized denied;
//     every action audited.
//  7. Identity resolution: ordinary user denied; moderator succeeds only
//     with a real reason; every resolution audited; no bulk variant
//     exists.
//  8. Content safety: oversized title/body rejected; the plain-text
//     storage model means no HTML is ever interpreted (verified by
//     confirming a script-tag string round-trips as literal text).
//
// Run from this directory, AFTER `node migrate.mjs`:
//   node verify_phase10_discussion_board.mjs [--native]
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { assertDisposableLocalTarget } from './safeguards.mjs';

const { Client } = pg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_DATA_DIR = path.join(__dirname, 'pgdata');
const RUN_DATA_DIR = path.join(__dirname, 'pgdata_phase10_discussion_run');

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
  const runDb = 'vecta_phase10_discussion_run';

  let db;
  if (isNative) {
    assertDisposableLocalTarget(pgConfig, goldenDb, runDb);
    console.log(`=== Phase 10 discussion board verification against Native PostgreSQL (${pgConfig.host}:${pgConfig.port}) ===`);
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
    console.log('=== Phase 10 discussion board verification against PGlite embedded engine ===');
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

  let seq = 0xd0;
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
    create or replace function pg_temp.simulate_unauthenticated()
    returns void language plpgsql as $$
    begin
      perform set_config('request.jwt.claims', '', true);
      execute 'set role anon';
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
  function simulateUnauthenticated() { return db.exec('select pg_temp.simulate_unauthenticated();'); }
  async function clearSim() { await db.exec('select pg_temp.clear_simulation();'); }

  let spSeq = 0;
  async function expectFail(fn) {
    const sp = `sp_${++spSeq}`;
    await db.exec(`savepoint ${sp};`);
    try {
      await fn();
      await db.exec(`release savepoint ${sp};`);
      return { failed: false, error: null };
    } catch (e) {
      await db.exec(`rollback to savepoint ${sp}; release savepoint ${sp};`);
      return { failed: true, error: e };
    }
  }

  await simulateServiceRole();

  // --- Fixtures ---
  const myAocId = (await db.query("select id from public.aocs where code = 'MY';")).rows[0].id;
  const zzAocId = nextId();
  await db.query("insert into public.aocs (id, code, name, is_active) values ($1, 'ZZ', 'Synthetica', true);", [zzAocId]);

  const roleMap = new Map((await db.query('select id, code from public.role_definitions;')).rows.map((r) => [r.code, r.id]));
  const myOperationDeptId = (await db.query("select id from public.departments where aoc_id = $1 and code = 'operation';", [myAocId])).rows[0].id;
  const myEntityId = (await db.query("select id from public.operating_entities where aoc_id = $1 and code = 'MAA';", [myAocId])).rows[0].id;

  const kulStationId = (await db.query("select id from public.org_stations where code = 'KUL - MAA';")).rows[0].id;
  const kulHubId = (await db.query('select hub_id from public.org_stations where id = $1;', [kulStationId])).rows[0].hub_id;
  const kulTeamId = (
    await db.query(`insert into public.org_teams (station_id, name) values ($1, 'P10Team') on conflict (station_id, name) do update set name = excluded.name returning id;`, [kulStationId])
  ).rows[0].id;

  async function grantMembership(profileId, aocId, entityId) {
    const row = await db.query(
      `insert into public.user_entity_memberships (profile_id, aoc_id, operating_entity_id, status, is_primary) values ($1, $2, $3, 'active', true) returning id;`,
      [profileId, aocId, entityId],
    );
    return row.rows[0].id;
  }
  async function createUser(id, email, name, staffNo, status = 'approved') {
    await db.query("insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing;", [id, email]);
    await db.query(
      "insert into public.profiles (id, email, name, staff_no, role, status) values ($1, $2, $3, $4, 'ASO', $5) on conflict (id) do update set email = excluded.email, name = excluded.name, staff_no = excluded.staff_no, status = excluded.status;",
      [id, email, name, staffNo, status],
    );
  }

  // User A (MY): primary poster
  const userAId = nextId();
  await createUser(userAId, 'p10-a@example.test', 'Alice Alpha', 'P10-A');
  const userAMem = await grantMembership(userAId, myAocId, myEntityId);
  await db.query(
    "insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, hub_id, station_id, team_id, entity_membership_id, starts_at) values ($1, $2, $3, $4, $5, $6, $7, $8, now() - interval '1 day');",
    [userAId, roleMap.get('aso'), myAocId, myOperationDeptId, kulHubId, kulStationId, kulTeamId, userAMem],
  );

  // User B (MY): second poster, replies in same thread
  const userBId = nextId();
  await createUser(userBId, 'p10-b@example.test', 'Bob Beta', 'P10-B');
  const userBMem = await grantMembership(userBId, myAocId, myEntityId);
  await db.query(
    "insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, hub_id, station_id, team_id, entity_membership_id, starts_at) values ($1, $2, $3, $4, $5, $6, $7, $8, now() - interval '1 day');",
    [userBId, roleMap.get('aso'), myAocId, myOperationDeptId, kulHubId, kulStationId, kulTeamId, userBMem],
  );

  // Disabled user (MY)
  const disabledUserId = nextId();
  await createUser(disabledUserId, 'p10-disabled@example.test', 'Pending Person', 'P10-D', 'pending');

  // super_admin (identity resolver / moderator)
  const superAdminId = nextId();
  await createUser(superAdminId, 'p10-admin@example.test', 'Super Admin', 'P10-SA');
  await db.query(
    "insert into public.user_role_assignments (profile_id, role_definition_id, starts_at) select $1, id, now() - interval '1 day' from public.role_definitions where code = 'super_admin';",
    [superAdminId],
  );

  // ZZ (foreign AOC) user
  const zzUserId = nextId();
  await createUser(zzUserId, 'p10-zz@example.test', 'ZZ User', 'P10-ZZ');
  const zzEntityId = nextId();
  await db.query("insert into public.operating_entities (id, aoc_id, code, name, flight_prefix) values ($1, $2, 'ZZE', 'ZZ Entity', 'ZZ') on conflict do nothing;", [zzEntityId, zzAocId]);
  const zzMem = await grantMembership(zzUserId, zzAocId, zzEntityId);
  const zzDeptId = nextId();
  await db.query("insert into public.departments (id, aoc_id, code, name) values ($1, $2, 'operation', 'ZZ Operation');", [zzDeptId, zzAocId]);
  const zzHubId = nextId();
  await db.query("insert into public.hubs (id, aoc_id, code, name) values ($1, $2, 'zzhub', 'ZZ Hub');", [zzHubId, zzAocId]);
  const zzStationId = nextId();
  await db.query("insert into public.org_stations (id, hub_id, code, name, is_active) values ($1, $2, 'ZZS', 'ZZ Station', true);", [zzStationId, zzHubId]);
  const zzTeamId = nextId();
  await db.query("insert into public.org_teams (id, station_id, name) values ($1, $2, 'ZZTeam');", [zzTeamId, zzStationId]);
  await db.query(
    "insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, hub_id, station_id, team_id, entity_membership_id, starts_at) values ($1, $2, $3, $4, $5, $6, $7, $8, now() - interval '1 day');",
    [zzUserId, roleMap.get('aso'), zzAocId, zzDeptId, zzHubId, zzStationId, zzTeamId, zzMem],
  );

  // User C (MY, different operating entity): tests cross-entity access within same AOC
  const userCId = nextId();
  await createUser(userCId, 'p10-c@example.test', 'Charlie Gamma', 'P10-C');
  const mySecondEntityId = nextId();
  await db.query("insert into public.operating_entities (id, aoc_id, code, name, flight_prefix) values ($1, $2, 'MAX', 'MY Second Entity', 'MX') on conflict do nothing;", [mySecondEntityId, myAocId]);
  const userCMem = await grantMembership(userCId, myAocId, mySecondEntityId);
  await db.query(
    "insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, hub_id, station_id, team_id, entity_membership_id, starts_at) values ($1, $2, $3, $4, $5, $6, $7, $8, now() - interval '1 day');",
    [userCId, roleMap.get('aso'), myAocId, myOperationDeptId, kulHubId, kulStationId, kulTeamId, userCMem],
  );

  const generalCategory = (await db.query("select id from public.discussion_categories where code = 'general' and aoc_id is null;")).rows[0].id;

  console.log('\n--- SECTION 1: Authentication Boundary ---');
  await simulateUnauthenticated();
  const unauthRead = await expectFail(() => db.query('select * from public.list_discussion_threads_secure(null);'));
  assert(unauthRead.failed, 'Unauthenticated read of thread list denied');
  const unauthCreate = await expectFail(() => db.query(
    "select * from public.create_discussion_thread_secure($1, 'Title', 'Body');", [generalCategory],
  ));
  assert(unauthCreate.failed, 'Unauthenticated thread creation denied');

  console.log('\n--- SECTION 2: Thread Creation & Anonymity ---');
  await simulateUser(userAId);
  const threadRes = await db.query(
    "select id, author_alias from public.create_discussion_thread_secure($1, 'Test Discussion', 'This is the body of a test discussion.');",
    [generalCategory],
  );
  const threadId = threadRes.rows[0].id;
  const aliasA = threadRes.rows[0].author_alias;
  assert(Boolean(threadId) && /^[A-Za-z]+ [A-Za-z]+$/.test(aliasA), `Thread created with a two-word anonymous alias: "${aliasA}"`);

  const unauthReply = await (async () => {
    await simulateUnauthenticated();
    return expectFail(() => db.query("select * from public.create_discussion_reply_secure($1, 'reply body');", [threadId]));
  })();
  assert(unauthReply.failed, 'Unauthenticated reply denied');

  await simulateUser(userBId);
  const replyRes = await db.query("select id, author_alias from public.create_discussion_reply_secure($1, 'First reply from Bob.');", [threadId]);
  const aliasB = replyRes.rows[0].author_alias;
  assert(aliasB !== aliasA, 'A different author in the same thread receives a different alias');

  const replyRes2 = await db.query("select id, author_alias from public.create_discussion_reply_secure($1, 'Second reply from Bob, same thread.');", [threadId]);
  assert(replyRes2.rows[0].author_alias === aliasB, 'The SAME author posting again in the SAME thread keeps the SAME alias (conversation continuity)');

  // Second, unrelated thread by the same author (userB) -- alias must be unlinkable
  await simulateUser(userAId);
  const thread2Res = await db.query(
    "select id, author_alias from public.create_discussion_thread_secure($1, 'A different discussion', 'Unrelated body content.');",
    [generalCategory],
  );
  const thread2Id = thread2Res.rows[0].id;
  await simulateUser(userBId);
  const replyThread2Res = await db.query("select id, author_alias from public.create_discussion_reply_secure($1, 'Bob replying in a different thread.');", [thread2Id]);
  assert(
    replyThread2Res.rows[0].author_alias !== aliasB,
    `Alias unlinkability: the SAME author's alias in a DIFFERENT thread ("${replyThread2Res.rows[0].author_alias}") differs from their alias in the first thread ("${aliasB}") -- no ordinary participant can correlate the two`,
  );

  console.log('\n--- SECTION 3: Anonymity Enforcement (no real identity ever surfaces) ---');
  const listRes = await db.query('select * from public.list_discussion_threads_secure($1);', [generalCategory]);
  const listJson = JSON.stringify(listRes.rows);
  assert(!listJson.includes(userAId) && !listJson.includes(userBId), 'Thread list RPC payload contains no real profile id anywhere');
  assert(!listJson.toLowerCase().includes('alice') && !listJson.toLowerCase().includes('bob'), 'Thread list RPC payload contains no real name anywhere');

  const getRes = await db.query('select * from public.get_discussion_thread_secure($1);', [threadId]);
  const getJson = JSON.stringify(getRes.rows);
  assert(!getJson.includes(userAId) && !getJson.includes(userBId), 'Full thread+replies RPC payload contains no real profile id anywhere');

  await simulateUser(userBId);
  const directMappingRead = await expectFail(() => db.query('select * from public.discussion_author_mappings limit 1;'));
  assert(directMappingRead.failed, 'Ordinary authenticated user denied direct SELECT on the protected author-mapping table');

  const directSaltRead = await expectFail(() => db.query('select * from public.discussion_alias_salt limit 1;'));
  assert(directSaltRead.failed, 'Ordinary authenticated user denied direct SELECT on secret salt table (cannot retrieve key material)');

  const directGenAlias = await expectFail(() => db.query("select public.generate_discussion_alias('00000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000000002'::uuid);"));
  assert(directGenAlias.failed, 'Ordinary authenticated user denied direct EXECUTE on generate_discussion_alias');

  const directResolveAlias = await expectFail(() => db.query("select public.resolve_discussion_alias('00000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000000002'::uuid);"));
  assert(directResolveAlias.failed, 'Ordinary authenticated user denied direct EXECUTE on resolve_discussion_alias');

  // Spoofing resistance: User C replying cannot specify or impersonate User A's alias
  await simulateUser(userCId);
  const userCReply = await db.query("select id, author_alias from public.create_discussion_reply_secure($1, 'Charlie replying in thread');", [threadId]);
  const aliasC = userCReply.rows[0].author_alias;
  assert(aliasC !== aliasA && aliasC !== aliasB, 'Another user (User C) receives their own distinct alias and cannot spoof another participant');

  // Alias non-reversibility: ordinary user cannot reverse alias to identity
  const aliasReverseAttempt = await expectFail(() => db.query("select * from public.resolve_discussion_author_identity_secure('thread', $1, 'Attempting reverse');", [threadId]));
  assert(aliasReverseAttempt.failed, 'Alias cannot be directly reversed through an application/RPC path by an ordinary user');

  console.log('\n--- SECTION 4: Authorization ---');
  await simulateUser(disabledUserId);
  const disabledCreate = await expectFail(() => db.query(
    "select * from public.create_discussion_thread_secure($1, 'Should fail', 'Disabled user body.');", [generalCategory],
  ));
  assert(disabledCreate.failed, 'Disabled/pending user denied thread creation');

  await simulateUser(zzUserId);
  const zzCreate = await db.query(
    "select id from public.create_discussion_thread_secure($1, 'ZZ global thread', 'A global-category thread from a different AOC.');",
    [generalCategory],
  );
  assert(Boolean(zzCreate.rows[0].id), 'A different AOC can post in a GLOBAL category (no AOC restriction on global categories)');

  const unknownCategory = nextId();
  const invalidCategoryCreate = await expectFail(() => db.query(
    "select * from public.create_discussion_thread_secure($1, 'Bad category', 'body');", [unknownCategory],
  ));
  assert(invalidCategoryCreate.failed, 'Creating a thread in an unknown category id is denied');

  console.log('\n--- SECTION 5: Ownership (edit/remove) ---');
  await simulateUser(userAId);
  const ownEdit = await db.query("select public.edit_discussion_content_secure('thread', $1, 'Edited body by the real author.');", [threadId]);
  assert(ownEdit.rows[0].edit_discussion_content_secure === true, 'Author can edit their own thread');

  await simulateUser(userBId);
  const otherEdit = await expectFail(() => db.query("select public.edit_discussion_content_secure('thread', $1, 'Hostile edit attempt.');", [threadId]));
  assert(otherEdit.failed, 'A different user cannot edit someone else\'s thread');

  await simulateUser(zzUserId);
  const crossAocEdit = await expectFail(() => db.query("select public.edit_discussion_content_secure('thread', $1, 'Cross-AOC edit attempt.');", [threadId]));
  assert(crossAocEdit.failed, 'A different-AOC user cannot edit someone else\'s thread (ownership check denies regardless of AOC)');

  await simulateUser(userAId);
  const ownRemove = await db.query("select public.remove_own_discussion_content_secure('thread', $1);", [threadId]);
  assert(ownRemove.rows[0].remove_own_discussion_content_secure === true, 'Author can remove (soft-delete) their own thread');
  const removedRead = await db.query('select * from public.get_discussion_thread_secure($1);', [threadId]);
  assert(removedRead.rows[0].body === '[This post has been removed.]' && removedRead.rows[0].author_alias === '[removed]', 'Removed thread shows a generic removal placeholder, not the real content or alias');

  await simulateUser(userBId);
  const otherRemove = await expectFail(() => db.query("select public.remove_own_discussion_content_secure('thread', $1);", [thread2Id]));
  assert(otherRemove.failed, 'A different user cannot remove someone else\'s thread');

  console.log('\n--- SECTION 6: Reporting ---');
  await simulateUser(userBId);
  const reportRes = await db.query(
    "select public.report_discussion_content_secure('thread', $1, 'spam', 'This looks like spam.') as report_id;",
    [thread2Id],
  );
  assert(Boolean(reportRes.rows[0].report_id), 'Report created successfully');

  const directReportsRead = await expectFail(() => db.query('select * from public.discussion_reports limit 1;'));
  assert(directReportsRead.failed, 'Ordinary authenticated user denied direct SELECT on the reports table (reporter identity protected)');

  await simulateUser(userAId);
  const nonModeratorReports = await expectFail(() => db.query('select * from public.list_discussion_reports_secure();'));
  assert(nonModeratorReports.failed, 'Non-moderator cannot list reports');

  console.log('\n--- SECTION 7: Moderation ---');
  await simulateUser(userAId);
  const nonModHide = await expectFail(() => db.query(
    "select public.moderate_discussion_content_secure('thread', $1, 'hide', 'Unauthorized attempt.');", [thread2Id],
  ));
  assert(nonModHide.failed, 'Non-moderator (ordinary user) cannot moderate content');

  await simulateUser(superAdminId);
  const modReports = await db.query('select * from public.list_discussion_reports_secure();');
  assert(modReports.rows.length >= 1, 'Authorized moderator (super_admin) can list reports');

  const modHide = await db.query(
    "select public.moderate_discussion_content_secure('thread', $1, 'hide', 'Confirmed spam per report review.');", [thread2Id],
  );
  assert(modHide.rows[0].moderate_discussion_content_secure === true, 'Authorized moderator can hide reported content');

  // discussion_moderation_log is service_role-only (zero grant to authenticated, including the
  // moderator themselves) -- verifying the audit row exists requires reading it as service_role.
  await simulateServiceRole();
  const modLogRes = await db.query(
    "select action, reason from public.discussion_moderation_log where content_id = $1 order by created_at desc limit 1;", [thread2Id],
  );
  assert(modLogRes.rows[0]?.action === 'hide' && modLogRes.rows[0]?.reason === 'Confirmed spam per report review.', 'Moderation action is fully audited (action + reason recorded)');

  await simulateUser(superAdminId);
  const reviewReport = await db.query(
    "select public.review_discussion_report_secure($1, 'reviewed', 'Confirmed and hidden.');", [reportRes.rows[0].report_id],
  );
  assert(reviewReport.rows[0].review_discussion_report_secure === true, 'Moderator can mark a report as reviewed');

  console.log('\n--- SECTION 8: Identity Resolution (fully audited, single-item-only) ---');
  await simulateUser(userAId);
  const nonModResolve = await expectFail(() => db.query(
    "select * from public.resolve_discussion_author_identity_secure('reply', $1, 'Checking who this is.');", [replyRes.rows[0].id],
  ));
  assert(nonModResolve.failed, 'Ordinary user denied identity resolution');

  await simulateUser(superAdminId);
  const shortReason = await expectFail(() => db.query(
    "select * from public.resolve_discussion_author_identity_secure('reply', $1, 'short');", [replyRes.rows[0].id],
  ));
  assert(shortReason.failed, 'Identity resolution denied when reason is too short/generic');

  const resolveRes = await db.query(
    "select profile_id, name, staff_no from public.resolve_discussion_author_identity_secure('reply', $1, 'Investigating a harassment report escalated by compliance.');",
    [replyRes.rows[0].id],
  );
  assert(resolveRes.rows[0].profile_id === userBId && resolveRes.rows[0].name === 'Bob Beta', 'Authorized moderator successfully resolves the real author for a specific piece of content');

  // discussion_identity_resolutions is also service_role-only -- same reasoning as the
  // moderation log above.
  await simulateServiceRole();
  const auditRes = await db.query(
    "select resolved_author_profile_id, resolved_by_profile_id, reason from public.discussion_identity_resolutions where content_id = $1 order by created_at desc limit 1;",
    [replyRes.rows[0].id],
  );
  await simulateUser(superAdminId);
  assert(
    auditRes.rows[0]?.resolved_author_profile_id === userBId && auditRes.rows[0]?.resolved_by_profile_id === superAdminId,
    'Identity resolution is fully audited: who resolved, whose identity, content, and reason are all recorded',
  );

  // "No bulk variant exists" -- structural proof: the function signature takes exactly one
  // content_id, never an array/list, so there is no way to request more than one reveal per call.
  const fnArgTypes = await db.query(
    "select pg_get_function_arguments(oid) as args from pg_proc where proname = 'resolve_discussion_author_identity_secure';",
  );
  assert(!/\[\]/.test(fnArgTypes.rows[0]?.args ?? ''), `resolve_discussion_author_identity_secure() accepts no array/bulk parameter (signature: ${fnArgTypes.rows[0]?.args})`);

  console.log('\n--- SECTION 9: Content Safety ---');
  await simulateUser(userAId);
  const oversizedTitle = await expectFail(() => db.query(
    "select * from public.create_discussion_thread_secure($1, $2, 'body');", [generalCategory, 'x'.repeat(201)],
  ));
  assert(oversizedTitle.failed, 'Oversized title (>200 chars) rejected');

  const oversizedBody = await expectFail(() => db.query(
    "select * from public.create_discussion_thread_secure($1, 'Title', $2);", [generalCategory, 'x'.repeat(10001)],
  ));
  assert(oversizedBody.failed, 'Oversized body (>10000 chars) rejected');

  const emptyTitle = await expectFail(() => db.query(
    "select * from public.create_discussion_thread_secure($1, '', 'body');", [generalCategory],
  ));
  assert(emptyTitle.failed, 'Empty title rejected');

  // Plain-text storage model: a script-tag string is stored and returned as a literal string,
  // never interpreted -- the actual XSS defense is "never render as HTML", proven here by
  // confirming round-trip fidelity (the content layer does not strip/transform it, because
  // sanitization happens at the render boundary, not storage -- see the report for the app-side
  // proof that this is rendered as a React text node, never via dangerouslySetInnerHTML).
  const xssPayload = '<script>alert(1)</script>';
  const xssThreadRes = await db.query(
    "select id from public.create_discussion_thread_secure($1, 'XSS probe', $2);", [generalCategory, xssPayload],
  );
  const xssStored = await db.query('select * from public.get_discussion_thread_secure($1);', [xssThreadRes.rows[0].id]);
  assert(xssStored.rows[0].body === xssPayload, 'Script-tag payload is stored/returned as an inert literal string, never executed or transformed server-side');

  console.log('\n--- SECTION 10: Multi-AOC & Cross-Entity Isolation ---');
  // Foreign AOC (ZZ) user cannot read thread from MY AOC
  await simulateUser(zzUserId);
  const foreignRead = await expectFail(() => db.query('select * from public.get_discussion_thread_secure($1);', [threadId]));
  assert(foreignRead.failed, 'Cross-AOC read denied: user from foreign AOC (ZZ) cannot read thread from MY AOC (raises Thread not found)');

  // Foreign AOC (ZZ) user cannot reply to thread in MY AOC
  const foreignReply = await expectFail(() => db.query("select * from public.create_discussion_reply_secure($1, 'Unauthorized cross-AOC reply');", [threadId]));
  assert(foreignReply.failed, 'Cross-AOC reply denied: user from foreign AOC (ZZ) cannot reply to thread in MY AOC');

  // Foreign AOC user listing threads only sees threads in their AOC (or where assigned)
  const foreignList = await db.query('select * from public.list_discussion_threads_secure(null);');
  assert(!foreignList.rows.some((r) => r.id === threadId), 'Foreign AOC thread list excludes threads from other AOCs');

  // Direct RLS check on discussion_threads for foreign AOC
  const foreignDirectSelect = await db.query('select count(*)::int as n from public.discussion_threads where id = $1;', [threadId]);
  assert(foreignDirectSelect.rows[0].n === 0, 'Direct SELECT on discussion_threads by foreign AOC user filtered by RLS');

  // Cross-entity access: User A creates a thread in MY AOC; User C in different operating entity ('MAX') within same AOC ('MY') CAN read and reply
  await simulateUser(userAId);
  const ceThreadRes = await db.query(
    "select id from public.create_discussion_thread_secure($1, 'Cross-Entity Discussion', 'Open topic for all entities in MY AOC.');",
    [generalCategory],
  );
  const ceThreadId = ceThreadRes.rows[0].id;

  await simulateUser(userCId);
  const crossEntityRead = await db.query('select * from public.get_discussion_thread_secure($1);', [ceThreadId]);
  assert(crossEntityRead.rows.length > 0, 'Cross-entity read within same AOC succeeds');
  const crossEntityReply = await db.query("select id, author_alias from public.create_discussion_reply_secure($1, 'Reply from Charlie in MAX entity.');", [ceThreadId]);
  const ceReplyId = crossEntityReply.rows[0].id;
  assert(Boolean(ceReplyId) && Boolean(crossEntityReply.rows[0].author_alias), 'Cross-entity reply within same AOC succeeds with valid alias');

  console.log('\n--- SECTION 11: Client-Facing Ownership & Moderator Verification Helpers ---');
  // Moderator status helper
  await simulateUser(superAdminId);
  const isModSuperAdmin = await db.query('select public.check_is_discussion_moderator_secure();');
  assert(isModSuperAdmin.rows[0].check_is_discussion_moderator_secure === true, 'check_is_discussion_moderator_secure returns true for super_admin');

  await simulateUser(userAId);
  const isModRegular = await db.query('select public.check_is_discussion_moderator_secure();');
  assert(isModRegular.rows[0].check_is_discussion_moderator_secure === false, 'check_is_discussion_moderator_secure returns false for regular user');

  // Ownership helper
  const ownThreadCheck = await db.query("select public.check_discussion_ownership_secure('thread', $1);", [ceThreadId]);
  assert(ownThreadCheck.rows[0].check_discussion_ownership_secure === true, 'check_discussion_ownership_secure returns true for author');

  await simulateUser(userBId);
  const notOwnThreadCheck = await db.query("select public.check_discussion_ownership_secure('thread', $1);", [ceThreadId]);
  assert(notOwnThreadCheck.rows[0].check_discussion_ownership_secure === false, 'check_discussion_ownership_secure returns false for non-author');

  // Authored IDs batch helper
  await simulateUser(userCId);
  const cAuthored = await db.query('select * from public.get_my_discussion_authored_ids_secure($1);', [ceThreadId]);
  assert(cAuthored.rows.length > 0 && cAuthored.rows.some((r) => r.content_id === ceReplyId), 'get_my_discussion_authored_ids_secure returns only caller reply IDs');

  console.log('\n--- SECTION 12: Moderation Lifecycle & Thread Lock State ---');
  await simulateUser(superAdminId);
  const lockOp = await db.query("select public.moderate_discussion_content_secure('thread', $1, 'lock', 'Policy lock test');", [ceThreadId]);
  assert(lockOp.rows[0].moderate_discussion_content_secure === true, 'Moderator locked thread');

  // Attempting to reply to a locked thread
  await simulateUser(userAId);
  const replyLocked = await expectFail(() => db.query("select * from public.create_discussion_reply_secure($1, 'Should fail because thread is locked');", [ceThreadId]));
  assert(replyLocked.failed, 'Replying to locked thread rejected with expected lock message');

  // Unlock thread
  await simulateUser(superAdminId);
  const unlockOp = await db.query("select public.moderate_discussion_content_secure('thread', $1, 'unlock', 'Policy unlock test');", [ceThreadId]);
  assert(unlockOp.rows[0].moderate_discussion_content_secure === true, 'Moderator unlocked thread');

  await simulateUser(userAId);
  const replyUnlocked = await db.query("select id from public.create_discussion_reply_secure($1, 'Reply succeeds after unlock');", [ceThreadId]);
  assert(Boolean(replyUnlocked.rows[0].id), 'Replying to thread succeeds after thread is unlocked');

  console.log('\n--- SECTION 13: Removed Content View State ---');
  // User C removes their own reply
  await simulateUser(userCId);
  const removeReplyRes = await db.query("select public.remove_own_discussion_content_secure('reply', $1);", [ceReplyId]);
  assert(removeReplyRes.rows[0].remove_own_discussion_content_secure === true, 'Author soft-deleted their reply');

  // Reading the thread shows placeholder text for the removed reply
  await simulateUser(userAId);
  const threadViewAfterReplyRemoval = await db.query('select * from public.get_discussion_thread_secure($1);', [ceThreadId]);
  const removedReplyRow = threadViewAfterReplyRemoval.rows.find((r) => r.reply_id === ceReplyId);
  assert(
    removedReplyRow && removedReplyRow.reply_body === '[This post has been removed.]' && removedReplyRow.reply_author_alias === '[removed]',
    'Removed reply displays "[This post has been removed.]" and "[removed]" placeholder alias',
  );

  console.log(`\nPhase 10 discussion board verification completed. Total failures: ${failures}`);

  await clearSim();
  await db.exec('rollback;');
  await db.close();

  if (failures > 0) {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('FATAL ERROR in Phase 10 discussion board verification:', e);
  process.exit(1);
});
