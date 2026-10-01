// Phase 12: WOIS AI 2.0 verification -- Malaysia AOC eligibility, conversation
// ownership/isolation, audit scoping, and direct-table-bypass denial.
//
// Authoritative rules under test:
//  1. is_wois_eligible_secure(): approved, actively-assigned Malaysia AOC
//     staff only. Pending/rejected/revoked/expired/future/ended/deactivated
//     and foreign-AOC callers are NOT eligible.
//  2. Conversation create/rename/delete/list/append are ownership-checked
//     and (for create/append) eligibility-gated; cross-user and cross-AOC
//     access fails closed.
//  3. Soft-deleted conversations are excluded from list_wois_conversations_secure().
//  4. wois_audit_log is written only through record_wois_audit_event_secure()
//     and is readable only by its own actor -- never by another user.
//  5. Direct INSERT into wois_conversations/wois_messages by `authenticated`
//     is denied -- all writes must go through the secure RPCs above.
//
// Run from this directory, AFTER `node migrate.mjs`:
//   node verify_phase12_wois_ai.mjs [--native]
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { assertDisposableLocalTarget } from './safeguards.mjs';

const { Client } = pg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_DATA_DIR = path.join(__dirname, 'pgdata');
const RUN_DATA_DIR = path.join(__dirname, 'pgdata_phase12_wois_run');

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
  const runDb = 'vecta_phase12_wois_run';

  let db;
  if (isNative) {
    assertDisposableLocalTarget(pgConfig, goldenDb, runDb);
    console.log(`=== Phase 12 WOIS AI verification against Native PostgreSQL (${pgConfig.host}:${pgConfig.port}) ===`);
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
    console.log('=== Phase 12 WOIS AI verification against PGlite embedded engine ===');
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

  let seq = 0xf0;
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
  `);

  function simulateUser(id) { return db.query('select pg_temp.simulate_user($1);', [id]); }
  function simulateServiceRole() { return db.exec('select pg_temp.simulate_service_role();'); }

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

  const myAocId = (await db.query("select id from public.aocs where code = 'MY';")).rows[0].id;
  const zzAocRes = await db.query(
    "insert into public.aocs (id, code, name, is_active) values ($1, 'P12ZZ', 'P12 Foreign AOC', true) on conflict (code) do update set is_active = true returning id;",
    [nextId()],
  );
  const zzAocId = zzAocRes.rows[0].id;

  const myEntityId = (await db.query("select id from public.operating_entities where aoc_id = $1 and code = 'MAA';", [myAocId])).rows[0].id;
  const zzEntityId = nextId();
  await db.query("insert into public.operating_entities (id, aoc_id, code, name, flight_prefix) values ($1, $2, 'P12ZE', 'P12 ZZ Entity', 'PZ') on conflict do nothing;", [zzEntityId, zzAocId]);
  const roleRows = (await db.query("select id, code from public.role_definitions;")).rows;
  const roleMap = new Map(roleRows.map((r) => [r.code, r.id]));

  const myDeptId = (await db.query("select id from public.departments where aoc_id = $1 and code = 'operation';", [myAocId])).rows[0].id;
  const kulStationId = (await db.query("select id from public.org_stations where code = 'KUL - MAA';")).rows[0].id;
  const kulHubId = (await db.query('select hub_id from public.org_stations where id = $1;', [kulStationId])).rows[0].hub_id;
  const kulTeamId = (
    await db.query(`insert into public.org_teams (station_id, name) values ($1, 'P12Team') on conflict (station_id, name) do update set name = excluded.name returning id;`, [kulStationId])
  ).rows[0].id;

  const zzDeptId = nextId();
  await db.query("insert into public.departments (id, aoc_id, code, name) values ($1, $2, 'operation', 'P12 ZZ Operation') on conflict do nothing;", [zzDeptId, zzAocId]);
  const zzHubId = nextId();
  await db.query("insert into public.hubs (id, aoc_id, code, name) values ($1, $2, 'p12zzhub', 'P12 ZZ Hub') on conflict do nothing;", [zzHubId, zzAocId]);
  const zzStationId = nextId();
  await db.query("insert into public.org_stations (id, hub_id, code, name, is_active) values ($1, $2, 'P12ZS', 'P12 ZZ Station', true) on conflict do nothing;", [zzStationId, zzHubId]);
  const zzTeamId = (
    await db.query(`insert into public.org_teams (station_id, name) values ($1, 'P12ZZTeam') on conflict (station_id, name) do update set name = excluded.name returning id;`, [zzStationId])
  ).rows[0].id;

  // Every ASO assignment below needs the full team scope (department, hub,
  // station, team) in addition to the entity membership -- mirrors the
  // Phase 11 test harness's own ASO fixture shape exactly.
  async function insertAsoAssignment(profileId, aocId, membershipId, deptId, hubId, stationId, teamId, extraCols = '', extraVals = [], extraParamsSql = '') {
    await db.query(
      `insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, hub_id, station_id, team_id, entity_membership_id, starts_at${extraCols}) values ($1, $2, $3, $4, $5, $6, $7, $8, now() - interval '1 day'${extraParamsSql});`,
      [profileId, roleMap.get('aso'), aocId, deptId, hubId, stationId, teamId, membershipId, ...extraVals],
    );
  }

  async function createUser(id, email, name, staffNo, status = 'approved') {
    await db.query("insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing;", [id, email]);
    await db.query(
      "insert into public.profiles (id, email, name, staff_no, role, status) values ($1, $2, $3, $4, 'ASO', $5) on conflict (id) do update set email = excluded.email, name = excluded.name, staff_no = excluded.staff_no, status = excluded.status;",
      [id, email, name, staffNo, status],
    );
  }

  async function grantMembership(profileId, aocId, entityId, isPrimary = true) {
    const row = await db.query(
      `insert into public.user_entity_memberships (profile_id, aoc_id, operating_entity_id, status, is_primary) values ($1, $2, $3, 'active', $4) returning id;`,
      [profileId, aocId, entityId, isPrimary],
    );
    return row.rows[0].id;
  }

  console.log('\n--- SECTION 1: Eligibility (is_wois_eligible_secure) ---');

  // 1. Approved, active Malaysia ASO -- eligible.
  const myStaffId = nextId();
  await createUser(myStaffId, 'p12-mystaff@example.test', 'Siti Staff', 'P12-S1');
  const myStaffMem = await grantMembership(myStaffId, myAocId, myEntityId);
  await insertAsoAssignment(myStaffId, myAocId, myStaffMem, myDeptId, kulHubId, kulStationId, kulTeamId);
  await simulateUser(myStaffId);
  const myStaffEligible = (await db.query('select public.is_wois_eligible_secure() as eligible;')).rows[0].eligible;
  assert(myStaffEligible === true, 'Approved, active Malaysia ASO is eligible for WOIS AI');

  // 2. Foreign-AOC staff -- not eligible.
  await simulateServiceRole();
  const zzStaffId = nextId();
  await createUser(zzStaffId, 'p12-zzstaff@example.test', 'Zed Foreign', 'P12-Z1');
  const zzStaffMem = await grantMembership(zzStaffId, zzAocId, zzEntityId);
  await insertAsoAssignment(zzStaffId, zzAocId, zzStaffMem, zzDeptId, zzHubId, zzStationId, zzTeamId);
  await simulateUser(zzStaffId);
  const zzStaffEligible = (await db.query('select public.is_wois_eligible_secure() as eligible;')).rows[0].eligible;
  assert(zzStaffEligible === false, 'Foreign-AOC staff is NOT eligible for WOIS AI (Malaysia-only in Phase 12)');

  // 3. Pending profile -- not eligible.
  await simulateServiceRole();
  const pendingId = nextId();
  await createUser(pendingId, 'p12-pending@example.test', 'Penny Pending', 'P12-PEN', 'pending');
  const pendingMem = await grantMembership(pendingId, myAocId, myEntityId);
  await insertAsoAssignment(pendingId, myAocId, pendingMem, myDeptId, kulHubId, kulStationId, kulTeamId);
  await simulateUser(pendingId);
  assert((await db.query('select public.is_wois_eligible_secure() as e;')).rows[0].e === false, 'Pending profile is NOT eligible');

  // 4. Revoked assignment -- not eligible.
  await simulateServiceRole();
  const revokedId = nextId();
  await createUser(revokedId, 'p12-revoked@example.test', 'Ron Revoked', 'P12-REV');
  const revokedMem = await grantMembership(revokedId, myAocId, myEntityId);
  await insertAsoAssignment(revokedId, myAocId, revokedMem, myDeptId, kulHubId, kulStationId, kulTeamId, ', revoked_at', [], ", now() - interval '1 hour'");
  await simulateUser(revokedId);
  assert((await db.query('select public.is_wois_eligible_secure() as e;')).rows[0].e === false, 'Revoked assignment is NOT eligible');

  // 5. Future assignment -- not eligible.
  await simulateServiceRole();
  const futureId = nextId();
  await createUser(futureId, 'p12-future@example.test', 'Fiona Future', 'P12-FUT');
  const futureMem = await grantMembership(futureId, myAocId, myEntityId);
  await db.query(
    `insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, hub_id, station_id, team_id, entity_membership_id, starts_at) values ($1, $2, $3, $4, $5, $6, $7, $8, now() + interval '1 day');`,
    [futureId, roleMap.get('aso'), myAocId, myDeptId, kulHubId, kulStationId, kulTeamId, futureMem],
  );
  await simulateUser(futureId);
  assert((await db.query('select public.is_wois_eligible_secure() as e;')).rows[0].e === false, 'Future-dated assignment is NOT eligible');

  // 6. Ended assignment -- not eligible.
  await simulateServiceRole();
  const endedId = nextId();
  await createUser(endedId, 'p12-ended@example.test', 'Eddy Ended', 'P12-END');
  const endedMem = await grantMembership(endedId, myAocId, myEntityId);
  await db.query(
    `insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, hub_id, station_id, team_id, entity_membership_id, starts_at, ends_at) values ($1, $2, $3, $4, $5, $6, $7, $8, now() - interval '5 days', now() - interval '1 hour');`,
    [endedId, roleMap.get('aso'), myAocId, myDeptId, kulHubId, kulStationId, kulTeamId, endedMem],
  );
  await simulateUser(endedId);
  assert((await db.query('select public.is_wois_eligible_secure() as e;')).rows[0].e === false, 'Ended assignment is NOT eligible');

  // 7. Deactivated profile -- not eligible.
  await simulateServiceRole();
  const deactId = nextId();
  await createUser(deactId, 'p12-deact@example.test', 'Dina Deactivated', 'P12-DEA', 'deactivated');
  const deactMem = await grantMembership(deactId, myAocId, myEntityId);
  await insertAsoAssignment(deactId, myAocId, deactMem, myDeptId, kulHubId, kulStationId, kulTeamId);
  await simulateUser(deactId);
  assert((await db.query('select public.is_wois_eligible_secure() as e;')).rows[0].e === false, 'Deactivated profile is NOT eligible');

  // 8. Rejected profile -- not eligible.
  await simulateServiceRole();
  const rejId = nextId();
  await createUser(rejId, 'p12-rej@example.test', 'Rex Rejected', 'P12-REJ', 'rejected');
  const rejMem = await grantMembership(rejId, myAocId, myEntityId);
  await insertAsoAssignment(rejId, myAocId, rejMem, myDeptId, kulHubId, kulStationId, kulTeamId);
  await simulateUser(rejId);
  assert((await db.query('select public.is_wois_eligible_secure() as e;')).rows[0].e === false, 'Rejected profile is NOT eligible');

  console.log('\n--- SECTION 2: Conversation Lifecycle (ownership + eligibility) ---');

  // Eligible user creates a conversation.
  await simulateUser(myStaffId);
  const convId = (await db.query("select public.create_wois_conversation_secure('My First Chat') as id;")).rows[0].id;
  assert(Boolean(convId), 'Eligible user creates a WOIS conversation');

  // Ineligible (foreign AOC) user cannot create a conversation.
  await simulateUser(zzStaffId);
  const zzCreateDenied = await expectFail(() => db.query("select public.create_wois_conversation_secure('Should Fail');"));
  assert(zzCreateDenied.failed, 'Ineligible (foreign-AOC) user cannot create a WOIS conversation');

  // Eligible owner appends messages.
  await simulateUser(myStaffId);
  await db.query(
    "select public.append_wois_message_secure($1, 'user', 'What is the search timing for an A330?');",
    [convId],
  );
  await db.query(
    "select public.append_wois_message_secure($1, 'assistant', 'A330 requires at least 45 minutes.', 'VERIFIED', 'sop');",
    [convId],
  );
  const ownMessages = (await db.query('select * from public.list_wois_messages_secure($1);', [convId])).rows;
  assert(ownMessages.length === 2, 'Owner sees both appended messages via list_wois_messages_secure');

  // Cross-user: a different eligible Malaysia user cannot read or append to
  // this conversation.
  await simulateServiceRole();
  const myStaff2Id = nextId();
  await createUser(myStaff2Id, 'p12-mystaff2@example.test', 'Ali Staff2', 'P12-S2');
  const myStaff2Mem = await grantMembership(myStaff2Id, myAocId, myEntityId);
  await insertAsoAssignment(myStaff2Id, myAocId, myStaff2Mem, myDeptId, kulHubId, kulStationId, kulTeamId);
  await simulateUser(myStaff2Id);
  const crossUserRead = await expectFail(() => db.query('select * from public.list_wois_messages_secure($1);', [convId]));
  assert(crossUserRead.failed, 'Cross-user read of another user\'s conversation fails closed');
  const crossUserAppend = await expectFail(() => db.query("select public.append_wois_message_secure($1, 'user', 'Trying to butt in');", [convId]));
  assert(crossUserAppend.failed, 'Cross-user append to another user\'s conversation fails closed');
  const crossUserRename = await expectFail(() => db.query("select public.rename_wois_conversation_secure($1, 'Hijacked Title');", [convId]));
  assert(crossUserRename.failed, 'Cross-user rename of another user\'s conversation fails closed');
  const crossUserDelete = await expectFail(() => db.query('select public.delete_wois_conversation_secure($1);', [convId]));
  assert(crossUserDelete.failed, 'Cross-user delete of another user\'s conversation fails closed');

  // Cross-AOC: the foreign-AOC (ineligible) user cannot append either, even
  // if it somehow knew the conversation id.
  await simulateUser(zzStaffId);
  const crossAocAppend = await expectFail(() => db.query("select public.append_wois_message_secure($1, 'user', 'Foreign AOC attempt');", [convId]));
  assert(crossAocAppend.failed, 'Cross-AOC (ineligible) append fails closed');

  // A revoked-assignment (ineligible) user cannot append to someone else's
  // conversation either way -- both the ownership check and the eligibility
  // re-check independently deny it.
  await simulateUser(revokedId);
  const revokedAppendDenied = await expectFail(() => db.query("select public.append_wois_message_secure($1, 'user', 'Should fail -- ineligible');", [convId]));
  assert(revokedAppendDenied.failed, 'Revoked-assignment user cannot append to another user\'s conversation (eligibility re-checked every call)');

  // Rename/delete by the true owner succeed.
  await simulateUser(myStaffId);
  const renamed = (await db.query("select public.rename_wois_conversation_secure($1, 'Renamed Chat') as ok;", [convId])).rows[0].ok;
  assert(renamed === true, 'Owner can rename their own conversation');

  const listBeforeDelete = (await db.query('select * from public.list_wois_conversations_secure();')).rows;
  assert(listBeforeDelete.some((c) => c.id === convId && c.title === 'Renamed Chat'), 'Renamed conversation appears with new title in the owner\'s list');

  const deleted = (await db.query('select public.delete_wois_conversation_secure($1) as ok;', [convId])).rows[0].ok;
  assert(deleted === true, 'Owner can delete (soft-delete) their own conversation');

  const listAfterDelete = (await db.query('select * from public.list_wois_conversations_secure();')).rows;
  assert(!listAfterDelete.some((c) => c.id === convId), 'Soft-deleted conversation is excluded from list_wois_conversations_secure()');

  const appendAfterDelete = await expectFail(() => db.query("select public.append_wois_message_secure($1, 'user', 'After delete');", [convId]));
  assert(appendAfterDelete.failed, 'Appending to a deleted conversation fails closed');

  console.log('\n--- SECTION 3: Audit Log Scoping ---');

  const ownAuditRows = (await db.query('select * from public.wois_audit_log where actor_profile_id = $1;', [myStaffId])).rows;
  assert(ownAuditRows.length > 0, 'Owner has audit rows recorded for their own WOIS actions');
  assert(ownAuditRows.some((r) => r.event_type === 'conversation_created'), 'conversation_created event is audited');
  assert(ownAuditRows.some((r) => r.event_type === 'conversation_deleted'), 'conversation_deleted event is audited');

  // Another user cannot see myStaffId's audit rows via RLS (owner-only read).
  await simulateUser(myStaff2Id);
  const foreignAuditRead = (await db.query('select * from public.wois_audit_log where actor_profile_id = $1;', [myStaffId])).rows;
  assert(foreignAuditRead.length === 0, 'A different user cannot read another user\'s wois_audit_log rows (RLS owner-only)');

  console.log('\n--- SECTION 4: Direct Table Bypass Denied ---');

  await simulateUser(myStaffId);
  const directInsertConv = await expectFail(() => db.query(
    "insert into public.wois_conversations (user_id, title) values ($1, 'Bypass Attempt');",
    [myStaffId],
  ));
  assert(directInsertConv.failed, 'Direct INSERT into wois_conversations by an authenticated client is denied -- must go through create_wois_conversation_secure()');

  const secondConvId = (await db.query("select public.create_wois_conversation_secure('Second Chat') as id;")).rows[0].id;
  const directInsertMsg = await expectFail(() => db.query(
    "insert into public.wois_messages (conversation_id, sender, body) values ($1, 'user', 'Bypass Attempt');",
    [secondConvId],
  ));
  assert(directInsertMsg.failed, 'Direct INSERT into wois_messages by an authenticated client is denied -- must go through append_wois_message_secure()');

  console.log('\n--- SECTION 5: Unauthenticated/Anonymous Denial ---');

  await db.exec("set role anon;");
  const anonEligible = await expectFail(() => db.query('select public.is_wois_eligible_secure();'));
  assert(anonEligible.failed, 'anon role has no execute grant on is_wois_eligible_secure() -- permission denied, not a false result');
  const anonCreate = await expectFail(() => db.query("select public.create_wois_conversation_secure('Anon Attempt');"));
  assert(anonCreate.failed, 'anon role cannot create a WOIS conversation');
  await simulateServiceRole();

  console.log(`\nPhase 12 WOIS AI verification completed. Total failures: ${failures}`);

  await db.exec('rollback;');
  await db.close();
  if (!isNative) {
    fs.rmSync(RUN_DATA_DIR, { recursive: true, force: true });
  }

  process.exit(failures > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
