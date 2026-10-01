// Phase 11: Global & Malaysia AOC Announcements verification.
//
// Authoritative Business Rules:
//  1. Exactly two operational scopes: GLOBAL and AOC.
//     - GLOBAL: publisher is GHOD only. Audience is every active user across active AOCs.
//     - AOC (Malaysia): publishers are maa_boss, maa_admin, aax_boss, aax_admin only.
//       One Malaysia-wide channel broadcasting to both MAA and AAX personnel.
//       GHOD must NOT publish AOC announcements (GHOD uses Global channel).
//     - AirAsia Management is strictly read-only.
//     - Super Admin, Operation Manager, Main Enforcement, Compliance, CaterLink: strictly denied publishing.
//  2. Unapproved subscopes (entity, department, station) are strictly rejected.
//  3. Inactive, expired, future, revoked, ended, rejected, and deactivated assignments are rejected.
//  4. Cross-AOC reads, writes, acknowledgement lists, attachments, and recipient access fail closed.
//  5. Concurrency-safe, idempotent publishing and idempotent acknowledgements.
//  6. Published-content immutability and approved archive lifecycle enforced.
//  7. Acknowledgement report privacy matrix:
//     - GHOD accesses report for Global.
//     - MAA/AAX publishers access report for Malaysia AOC.
//     - AirAsia Management denied personnel acknowledgement and pending lists.
//     - Ordinary recipients see only their own acknowledgement state.
//     - All acknowledgement-report access is scope-authorized and audited.
//
// Run from this directory, AFTER `node migrate.mjs`:
//   node verify_phase11_announcements.mjs [--native]
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { assertDisposableLocalTarget } from './safeguards.mjs';

const { Client } = pg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_DATA_DIR = path.join(__dirname, 'pgdata');
const RUN_DATA_DIR = path.join(__dirname, 'pgdata_phase11_announcements_run');

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
  const runDb = 'vecta_phase11_announcements_run';

  let db;
  if (isNative) {
    assertDisposableLocalTarget(pgConfig, goldenDb, runDb);
    console.log(`=== Phase 11 announcements verification against Native PostgreSQL (${pgConfig.host}:${pgConfig.port}) ===`);
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
    console.log('=== Phase 11 announcements verification against PGlite embedded engine ===');
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

  let seq = 0xe0;
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
  `);

  function simulateUser(id) { return db.query('select pg_temp.simulate_user($1);', [id]); }
  function simulateServiceRole() { return db.exec('select pg_temp.simulate_service_role();'); }
  function simulateUnauthenticated() { return db.exec('select pg_temp.simulate_unauthenticated();'); }

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

  // Setup AOCs
  const myAocId = (await db.query("select id from public.aocs where code = 'MY';")).rows[0].id;
  const zzAocRes = await db.query(
    "insert into public.aocs (id, code, name, is_active) values ($1, 'ZZ', 'Foreign AOC', true) on conflict (code) do update set is_active = true returning id;",
    [nextId()],
  );
  const zzAocId = zzAocRes.rows[0].id;

  // Setup entities
  const myEntityId = (await db.query("select id from public.operating_entities where aoc_id = $1 and code = 'MAA';", [myAocId])).rows[0].id;
  const mySecondEntityId = (await db.query("select id from public.operating_entities where aoc_id = $1 and code = 'AAX';", [myAocId])).rows[0].id;
  const zzEntityId = nextId();
  await db.query("insert into public.operating_entities (id, aoc_id, code, name, flight_prefix) values ($1, $2, 'ZZE', 'ZZ Entity', 'ZZ') on conflict do nothing;", [zzEntityId, zzAocId]);

  // Setup roles lookup
  const roleRows = (await db.query("select id, code from public.role_definitions;")).rows;
  const roleMap = new Map(roleRows.map((r) => [r.code, r.id]));
  const noHodExists = parseInt((await db.query("select count(*) as cnt from public.role_definitions where code ilike '%hod%' and code <> 'ghod';")).rows[0].cnt, 10) === 0;

  // Setup departments, hubs, stations, teams
  const myDeptId = (await db.query("select id from public.departments where aoc_id = $1 and code = 'operation';", [myAocId])).rows[0].id;
  const zzDeptId = nextId();
  await db.query("insert into public.departments (id, aoc_id, code, name) values ($1, $2, 'operation', 'ZZ Operation') on conflict do nothing;", [zzDeptId, zzAocId]);

  const kulStationId = (await db.query("select id from public.org_stations where code = 'KUL - MAA';")).rows[0].id;
  const kulHubId = (await db.query('select hub_id from public.org_stations where id = $1;', [kulStationId])).rows[0].hub_id;
  const kulTeamId = (
    await db.query(`insert into public.org_teams (station_id, name) values ($1, 'P11Team') on conflict (station_id, name) do update set name = excluded.name returning id;`, [kulStationId])
  ).rows[0].id;

  const zzHubId = nextId();
  await db.query("insert into public.hubs (id, aoc_id, code, name) values ($1, $2, 'zzhub', 'ZZ Hub') on conflict do nothing;", [zzHubId, zzAocId]);
  const zzStationId = nextId();
  await db.query("insert into public.org_stations (id, hub_id, code, name, is_active) values ($1, $2, 'ZZS', 'ZZ Station', true) on conflict do nothing;", [zzStationId, zzHubId]);
  const zzTeamId = (
    await db.query(`insert into public.org_teams (station_id, name) values ($1, 'ZZTeam') on conflict (station_id, name) do update set name = excluded.name returning id;`, [zzStationId])
  ).rows[0].id;

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

  // 1. GHOD user (International global publisher)
  const ghodUserId = nextId();
  await createUser(ghodUserId, 'p11-ghod@example.test', 'Grace GHOD', 'P11-GHOD');
  await db.query(
    "insert into public.user_role_assignments (profile_id, role_definition_id, starts_at) values ($1, $2, now() - interval '1 day');",
    [ghodUserId, roleMap.get('ghod')],
  );

  // 2. Super Admin user (Technical platform admin - strictly denied Global or AOC publishing)
  const superAdminId = nextId();
  await createUser(superAdminId, 'p11-super@example.test', 'Sam SuperAdmin', 'P11-SA');
  await db.query(
    "insert into public.user_role_assignments (profile_id, role_definition_id, starts_at) values ($1, $2, now() - interval '1 day');",
    [superAdminId, roleMap.get('super_admin')],
  );

  // 3. AirAsia Management user (International executive dashboard - strictly read-only)
  const airasiaMgmtId = nextId();
  await createUser(airasiaMgmtId, 'p11-mgmt@example.test', 'Morgan Management', 'P11-MGMT');
  await db.query(
    "insert into public.user_role_assignments (profile_id, role_definition_id, starts_at) values ($1, $2, now() - interval '1 day');",
    [airasiaMgmtId, roleMap.get('airasia_management')],
  );

  // 4. Malaysia AOC Approved Publishers (MAA Boss, MAA Admin, AAX Boss, AAX Admin)
  const maaBossId = nextId();
  await createUser(maaBossId, 'p11-maaboss@example.test', 'Badrul MAABoss', 'P11-MB');
  await db.query(
    "insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, operating_entity_id, starts_at) values ($1, $2, $3, $4, now() - interval '1 day');",
    [maaBossId, roleMap.get('maa_boss'), myAocId, myEntityId],
  );

  const maaAdminId = nextId();
  await createUser(maaAdminId, 'p11-maaadmin@example.test', 'Aisha MAAAdmin', 'P11-MA');
  await db.query(
    "insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, operating_entity_id, starts_at) values ($1, $2, $3, $4, now() - interval '1 day');",
    [maaAdminId, roleMap.get('maa_admin'), myAocId, myEntityId],
  );

  const aaxBossId = nextId();
  await createUser(aaxBossId, 'p11-aaxboss@example.test', 'Chong AAXBoss', 'P11-XB');
  await db.query(
    "insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, operating_entity_id, starts_at) values ($1, $2, $3, $4, now() - interval '1 day');",
    [aaxBossId, roleMap.get('aax_boss'), myAocId, mySecondEntityId],
  );

  const aaxAdminId = nextId();
  await createUser(aaxAdminId, 'p11-aaxadmin@example.test', 'Danial AAXAdmin', 'P11-XA');
  await db.query(
    "insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, operating_entity_id, starts_at) values ($1, $2, $3, $4, now() - interval '1 day');",
    [aaxAdminId, roleMap.get('aax_admin'), myAocId, mySecondEntityId],
  );

  // 5. Operation Manager (NOT authorized for Global or AOC publishing)
  const opManagerId = nextId();
  await createUser(opManagerId, 'p11-opmgr@example.test', 'Omar OpMgr', 'P11-OM');
  await db.query(
    "insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, entity_membership_id, starts_at) values ($1, $2, $3, $4, NULL, now() - interval '1 day');",
    [opManagerId, roleMap.get('operation_manager'), myAocId, myDeptId],
  );

  // 6. Main Enforcement (NOT authorized for Global or AOC publishing)
  const mainEnfDeptId = (await db.query("select id from public.departments where aoc_id = $1 and code = 'enforcement';", [myAocId])).rows[0].id;
  const mainEnfId = nextId();
  await createUser(mainEnfId, 'p11-mainenf@example.test', 'Edward Enf', 'P11-ME');
  await db.query(
    "insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, entity_membership_id, starts_at) values ($1, $2, $3, $4, NULL, now() - interval '1 day');",
    [mainEnfId, roleMap.get('main_enforcement'), myAocId, mainEnfDeptId],
  );

  // 7. Compliance (NOT authorized for Global or AOC publishing)
  const compDeptId = (await db.query("select id from public.departments where aoc_id = $1 and code = 'compliance';", [myAocId])).rows[0].id;
  const complianceId = nextId();
  await createUser(complianceId, 'p11-comp@example.test', 'Chloe Comp', 'P11-CP');
  await db.query(
    "insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, entity_membership_id, starts_at) values ($1, $2, $3, $4, NULL, now() - interval '1 day');",
    [complianceId, roleMap.get('compliance'), myAocId, compDeptId],
  );

  // 8. CaterLink Management (NOT authorized for Global or AOC publishing)
  const caterlinkDeptId = (await db.query("select id from public.departments where aoc_id = $1 and code = 'caterlink';", [myAocId])).rows[0].id;
  const caterlinkMgmtId = nextId();
  await createUser(caterlinkMgmtId, 'p11-cater@example.test', 'Cath Cater', 'P11-CL');
  await db.query(
    "insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, entity_membership_id, starts_at) values ($1, $2, $3, $4, NULL, now() - interval '1 day');",
    [caterlinkMgmtId, roleMap.get('caterlink_management'), myAocId, caterlinkDeptId],
  );

  // 9. Malaysia Staff User 1 (ASO in MY MAA)
  const myStaff1Id = nextId();
  await createUser(myStaff1Id, 'p11-mystaff1@example.test', 'Siti Staff1', 'P11-S1');
  const myStaff1Mem = await grantMembership(myStaff1Id, myAocId, myEntityId);
  await db.query(
    "insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, hub_id, station_id, team_id, entity_membership_id, starts_at) values ($1, $2, $3, $4, $5, $6, $7, $8, now() - interval '1 day');",
    [myStaff1Id, roleMap.get('aso'), myAocId, myDeptId, kulHubId, kulStationId, kulTeamId, myStaff1Mem],
  );

  // 10. Malaysia Staff User 2 (SO in MY AAX - cross entity in same AOC)
  const myStaff2Id = nextId();
  await createUser(myStaff2Id, 'p11-mystaff2@example.test', 'Ali Staff2', 'P11-S2');
  const myStaff2Mem = await grantMembership(myStaff2Id, myAocId, mySecondEntityId);
  await db.query(
    "insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, hub_id, station_id, team_id, entity_membership_id, starts_at) values ($1, $2, $3, $4, $5, $6, $7, $8, now() - interval '1 day');",
    [myStaff2Id, roleMap.get('so'), myAocId, myDeptId, kulHubId, kulStationId, kulTeamId, myStaff2Mem],
  );

  // 11. Foreign ZZ Staff user (ASO in ZZ AOC)
  const zzStaffId = nextId();
  await createUser(zzStaffId, 'p11-zzstaff@example.test', 'Zoe ZZStaff', 'P11-ZZS');
  const zzStaffMem = await grantMembership(zzStaffId, zzAocId, zzEntityId);
  await db.query(
    "insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, hub_id, station_id, team_id, entity_membership_id, starts_at) values ($1, $2, $3, $4, $5, $6, $7, $8, now() - interval '1 day');",
    [zzStaffId, roleMap.get('aso'), zzAocId, zzDeptId, zzHubId, zzStationId, zzTeamId, zzStaffMem],
  );

  // 12. Invalid/Revoked/Deactivated users for assignment denial testing
  const revokedUserId = nextId();
  await createUser(revokedUserId, 'p11-revoked@example.test', 'Ron Revoked', 'P11-REV');
  await db.query(
    "insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, operating_entity_id, starts_at, revoked_at) values ($1, $2, $3, $4, now() - interval '1 day', now() - interval '1 hour');",
    [revokedUserId, roleMap.get('maa_boss'), myAocId, myEntityId],
  );

  const futureUserId = nextId();
  await createUser(futureUserId, 'p11-future@example.test', 'Fiona Future', 'P11-FUT');
  await db.query(
    "insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, operating_entity_id, starts_at) values ($1, $2, $3, $4, now() + interval '1 day');",
    [futureUserId, roleMap.get('maa_boss'), myAocId, myEntityId],
  );

  const endedUserId = nextId();
  await createUser(endedUserId, 'p11-ended@example.test', 'Evan Ended', 'P11-END');
  await db.query(
    "insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, operating_entity_id, starts_at, ends_at) values ($1, $2, $3, $4, now() - interval '5 days', now() - interval '1 hour');",
    [endedUserId, roleMap.get('maa_boss'), myAocId, myEntityId],
  );

  const deactivatedUserId = nextId();
  await createUser(deactivatedUserId, 'p11-deact@example.test', 'Dan Deactivated', 'P11-DEA', 'deactivated');
  await db.query(
    "insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, operating_entity_id, starts_at) values ($1, $2, $3, $4, now() - interval '1 day');",
    [deactivatedUserId, roleMap.get('maa_boss'), myAocId, myEntityId],
  );

  const rejectedUserId = nextId();
  await createUser(rejectedUserId, 'p11-rej@example.test', 'Rick Rejected', 'P11-REJ', 'rejected');
  await db.query(
    "insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, operating_entity_id, starts_at) values ($1, $2, $3, $4, now() - interval '1 day');",
    [rejectedUserId, roleMap.get('maa_boss'), myAocId, myEntityId],
  );

  const pendingUserId = nextId();
  await createUser(pendingUserId, 'p11-pend@example.test', 'Penny Pending', 'P11-PEN', 'pending');
  await db.query(
    "insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, operating_entity_id, starts_at) values ($1, $2, $3, $4, now() - interval '1 day');",
    [pendingUserId, roleMap.get('maa_boss'), myAocId, myEntityId],
  );

  console.log('\n--- SECTION 1: Authentication Boundary ---');
  await simulateUnauthenticated();
  const unauthFeed = await expectFail(() => db.query('select * from public.get_visible_announcements_secure();'));
  assert(unauthFeed.failed, 'Unauthenticated user denied announcement feed');

  const unauthDetail = await expectFail(() => db.query("select * from public.get_announcement_detail_secure('00000000-0000-0000-0000-000000000001'::uuid);"));
  assert(unauthDetail.failed, 'Unauthenticated user denied announcement detail');

  const unauthAck = await expectFail(() => db.query("select * from public.acknowledge_announcement_secure('00000000-0000-0000-0000-000000000001'::uuid);"));
  assert(unauthAck.failed, 'Unauthenticated user denied acknowledgement');

  const unauthCreate = await expectFail(() => db.query("select public.create_announcement_secure('Title', 'Body', 'global');"));
  assert(unauthCreate.failed, 'Unauthenticated user denied announcement creation');

  console.log('\n--- SECTION 2: Creation & Authoring Authorization (Strict Role Matrix) ---');
  assert(noHodExists, 'No generic HOD role exists in VECTA database (GHOD is the only head role)');

  // GHOD can create Global announcement
  await simulateUser(ghodUserId);
  const globalAnnRes = await db.query(
    "select public.create_announcement_secure('Global System Maintenance', 'VECTA global maintenance on Sunday.', 'global', null, 'system', 'important', 'published', now(), null, true, true) as id;",
  );
  const globalAnnId = globalAnnRes.rows[0].id;
  assert(Boolean(globalAnnId), 'GHOD successfully creates Global announcement');

  // GHOD CANNOT create Malaysia AOC announcement (GHOD must use Global channel)
  const ghodCreateAoc = await expectFail(() => db.query(
    "select public.create_announcement_secure('GHOD AOC Attempt', 'Unauthorized AOC post', 'aoc', $1);",
    [myAocId],
  ));
  assert(ghodCreateAoc.failed, 'GHOD denied creating Malaysia AOC announcement (must use Global channel)');

  // Super Admin CANNOT create Global announcement
  await simulateUser(superAdminId);
  const superCreateGlobal = await expectFail(() => db.query(
    "select public.create_announcement_secure('SuperAdmin Global', 'Unauthorized body', 'global');",
  ));
  assert(superCreateGlobal.failed, 'Super Admin denied creating Global announcement');

  // Super Admin CANNOT create Malaysia AOC announcement
  const superCreateAoc = await expectFail(() => db.query(
    "select public.create_announcement_secure('SuperAdmin AOC', 'Unauthorized body', 'aoc', $1);",
    [myAocId],
  ));
  assert(superCreateAoc.failed, 'Super Admin receives no automatic announcement publishing power');

  // AirAsia Management CANNOT create Global announcement (read-only executive)
  await simulateUser(airasiaMgmtId);
  const mgmtCreateGlobal = await expectFail(() => db.query(
    "select public.create_announcement_secure('Mgmt Global', 'Unauthorized body', 'global');",
  ));
  assert(mgmtCreateGlobal.failed, 'AirAsia Management denied creating Global announcement (read-only)');

  // AirAsia Management CANNOT create Malaysia AOC announcement
  const mgmtCreateAoc = await expectFail(() => db.query(
    "select public.create_announcement_secure('Mgmt AOC', 'Unauthorized body', 'aoc', $1);",
    [myAocId],
  ));
  assert(mgmtCreateAoc.failed, 'AirAsia Management denied creating Malaysia AOC announcement');

  // Operation Manager CANNOT create Global or AOC announcements
  await simulateUser(opManagerId);
  const opMgrCreateGlobal = await expectFail(() => db.query(
    "select public.create_announcement_secure('OpMgr Global', 'Unauthorized body', 'global');",
  ));
  assert(opMgrCreateGlobal.failed, 'Operation Manager denied creating Global announcement');

  const opMgrCreateAoc = await expectFail(() => db.query(
    "select public.create_announcement_secure('OpMgr AOC', 'Unauthorized body', 'aoc', $1);",
    [myAocId],
  ));
  assert(opMgrCreateAoc.failed, 'Operation Manager denied creating Malaysia AOC announcement');

  // Main Enforcement CANNOT create Global or AOC announcements
  await simulateUser(mainEnfId);
  const mainEnfCreateGlobal = await expectFail(() => db.query(
    "select public.create_announcement_secure('Enf Global', 'Unauthorized body', 'global');",
  ));
  assert(mainEnfCreateGlobal.failed, 'Main Enforcement denied creating Global announcement');

  const mainEnfCreateAoc = await expectFail(() => db.query(
    "select public.create_announcement_secure('MainEnf AOC', 'Unauthorized body', 'aoc', $1);",
    [myAocId],
  ));
  assert(mainEnfCreateAoc.failed, 'Main Enforcement denied creating Malaysia AOC announcement');

  // Compliance CANNOT create Global or AOC announcements
  await simulateUser(complianceId);
  const compCreateGlobal = await expectFail(() => db.query(
    "select public.create_announcement_secure('Comp Global', 'Unauthorized body', 'global');",
  ));
  assert(compCreateGlobal.failed, 'Compliance denied creating Global announcement');

  const compCreateAoc = await expectFail(() => db.query(
    "select public.create_announcement_secure('Comp AOC', 'Unauthorized body', 'aoc', $1);",
    [myAocId],
  ));
  assert(compCreateAoc.failed, 'Compliance denied creating Malaysia AOC announcement');

  // CaterLink Management CANNOT create Global or AOC announcements
  await simulateUser(caterlinkMgmtId);
  const clCreateGlobal = await expectFail(() => db.query(
    "select public.create_announcement_secure('CaterLink Global', 'Unauthorized body', 'global');",
  ));
  assert(clCreateGlobal.failed, 'CaterLink Management denied creating Global announcement');

  const clCreateAoc = await expectFail(() => db.query(
    "select public.create_announcement_secure('CaterLink AOC', 'Unauthorized body', 'aoc', $1);",
    [myAocId],
  ));
  assert(clCreateAoc.failed, 'CaterLink Management denied creating Malaysia AOC announcement');

  // Ordinary staff CANNOT create Global or AOC announcements
  await simulateUser(myStaff1Id);
  const staffCreateGlobal = await expectFail(() => db.query(
    "select public.create_announcement_secure('Staff Global', 'Unauthorized body', 'global');",
  ));
  assert(staffCreateGlobal.failed, 'Ordinary staff denied creating Global announcement');

  const staffCreateAoc = await expectFail(() => db.query(
    "select public.create_announcement_secure('Staff AOC', 'Unauthorized body', 'aoc', $1);",
    [myAocId],
  ));
  assert(staffCreateAoc.failed, 'Ordinary staff denied creating Malaysia AOC announcement');

  // MAA Boss CANNOT create Global announcement
  await simulateUser(maaBossId);
  const maaBossCreateGlobal = await expectFail(() => db.query(
    "select public.create_announcement_secure('MAA Boss Global', 'Unauthorized body', 'global');",
  ));
  assert(maaBossCreateGlobal.failed, 'MAA Boss denied creating Global announcement');

  // The 4 Approved Malaysia Leadership Roles CAN create Malaysia AOC announcement:
  // 1. MAA Boss
  const myAnnRes = await db.query(
    "select public.create_announcement_secure('KLIA Terminal 2 Security Briefing', 'All Malaysia AVSEC staff to note revised patrol protocol.', 'aoc', $1, 'security', 'urgent', 'published', now(), null, true, false) as id;",
    [myAocId],
  );
  const myAnnId = myAnnRes.rows[0].id;
  assert(Boolean(myAnnId), 'MAA Boss successfully creates Malaysia AOC announcement');

  // 2. MAA Admin
  await simulateUser(maaAdminId);
  const maaAdminAnnRes = await db.query(
    "select public.create_announcement_secure('MAA Admin Notice', 'Notice from MAA Admin.', 'aoc', $1, 'operational', 'normal') as id;",
    [myAocId],
  );
  assert(Boolean(maaAdminAnnRes.rows[0].id), 'MAA Admin successfully creates Malaysia AOC announcement');

  // 3. AAX Boss
  await simulateUser(aaxBossId);
  const aaxBossAnnRes = await db.query(
    "select public.create_announcement_secure('AAX Boss Notice', 'Notice from AAX Boss across Malaysia AOC.', 'aoc', $1, 'operational', 'normal') as id;",
    [myAocId],
  );
  const aaxAnnId = aaxBossAnnRes.rows[0].id;
  assert(Boolean(aaxAnnId), 'AAX Boss successfully creates Malaysia AOC announcement');

  // 4. AAX Admin
  await simulateUser(aaxAdminId);
  const aaxAdminAnnRes = await db.query(
    "select public.create_announcement_secure('AAX Admin Notice', 'Notice from AAX Admin.', 'aoc', $1, 'operational', 'normal') as id;",
    [myAocId],
  );
  assert(Boolean(aaxAdminAnnRes.rows[0].id), 'AAX Admin successfully creates Malaysia AOC announcement');

  console.log('\n--- SECTION 3: Unapproved Subscopes & Invalid Assignments Rejection ---');
  // Unapproved subscopes: entity, department, station must be rejected
  await simulateUser(maaBossId);
  const entityScopeTest = await expectFail(() => db.query(
    "select public.create_announcement_secure('Entity Post', 'Body', 'entity', $1);", [myAocId],
  ));
  assert(entityScopeTest.failed, 'entity scope value is rejected by create_announcement_secure');

  const deptScopeTest = await expectFail(() => db.query(
    "select public.create_announcement_secure('Dept Post', 'Body', 'department', $1);", [myAocId],
  ));
  assert(deptScopeTest.failed, 'department scope value is rejected by create_announcement_secure');

  const stationScopeTest = await expectFail(() => db.query(
    "select public.create_announcement_secure('Station Post', 'Body', 'station', $1);", [myAocId],
  ));
  assert(stationScopeTest.failed, 'station scope value is rejected by create_announcement_secure');

  // Inactive / Revoked / Ended / Future / Deactivated / Rejected / Pending assignment denials
  await simulateUser(revokedUserId);
  const revokedCreate = await expectFail(() => db.query("select public.create_announcement_secure('Revoked', 'Body', 'aoc', $1);", [myAocId]));
  assert(revokedCreate.failed, 'Revoked role assignment is rejected from creating announcements');

  await simulateUser(futureUserId);
  const futureCreate = await expectFail(() => db.query("select public.create_announcement_secure('Future', 'Body', 'aoc', $1);", [myAocId]));
  assert(futureCreate.failed, 'Future role assignment is rejected from creating announcements');

  await simulateUser(endedUserId);
  const endedCreate = await expectFail(() => db.query("select public.create_announcement_secure('Ended', 'Body', 'aoc', $1);", [myAocId]));
  assert(endedCreate.failed, 'Ended role assignment is rejected from creating announcements');

  await simulateUser(deactivatedUserId);
  const deactCreate = await expectFail(() => db.query("select public.create_announcement_secure('Deact', 'Body', 'aoc', $1);", [myAocId]));
  assert(deactCreate.failed, 'Deactivated profile is rejected from creating announcements');

  await simulateUser(rejectedUserId);
  const rejCreate = await expectFail(() => db.query("select public.create_announcement_secure('Rej', 'Body', 'aoc', $1);", [myAocId]));
  assert(rejCreate.failed, 'Rejected profile is rejected from creating announcements');

  await simulateUser(pendingUserId);
  const pendCreate = await expectFail(() => db.query("select public.create_announcement_secure('Pend', 'Body', 'aoc', $1);", [myAocId]));
  assert(pendCreate.failed, 'Pending profile is rejected from creating announcements');

  console.log('\n--- SECTION 4: Cross-AOC Access Fails Closed ---');
  // Foreign ZZ staff cannot publish in Malaysia AOC
  await simulateUser(zzStaffId);
  const zzStaffCreateMY = await expectFail(() => db.query(
    "select public.create_announcement_secure('ZZ Staff in MY', 'Cross-AOC attempt', 'aoc', $1);",
    [myAocId],
  ));
  assert(zzStaffCreateMY.failed, 'Cross-AOC write fails closed (foreign staff denied publishing in MY)');

  // MAA Boss cannot publish in ZZ AOC
  await simulateUser(maaBossId);
  const maaBossCreateZZ = await expectFail(() => db.query(
    "select public.create_announcement_secure('MAA Boss in ZZ', 'Cross-AOC attempt', 'aoc', $1);",
    [zzAocId],
  ));
  assert(maaBossCreateZZ.failed, 'Cross-AOC write fails closed (MAA Boss denied publishing in ZZ)');

  // Foreign staff cannot see Malaysia AOC announcement in feed
  await simulateUser(zzStaffId);
  const zzFeed = await db.query('select id from public.get_visible_announcements_secure();');
  assert(!zzFeed.rows.map(r => r.id).includes(myAnnId), 'Cross-AOC read fails closed: foreign staff feed excludes Malaysia announcement');

  // Foreign staff cannot retrieve Malaysia AOC announcement detail
  const zzDetail = await expectFail(() => db.query('select * from public.get_announcement_detail_secure($1);', [myAnnId]));
  assert(zzDetail.failed, 'Cross-AOC read fails closed: foreign staff denied detail of Malaysia announcement');

  // Foreign staff cannot acknowledge Malaysia AOC announcement
  const zzAck = await expectFail(() => db.query('select public.acknowledge_announcement_secure($1);', [myAnnId]));
  assert(zzAck.failed, 'Cross-AOC recipient action fails closed: foreign staff denied acknowledging Malaysia announcement');

  console.log('\n--- SECTION 5: Malaysia-wide AOC Audience (Broadcasts to MAA and AAX) ---');
  // MAA staff receives Malaysia AOC announcement (published by MAA Boss)
  await simulateUser(myStaff1Id);
  const maaFeed1 = await db.query('select id from public.get_visible_announcements_secure();');
  assert(maaFeed1.rows.map(r => r.id).includes(myAnnId), 'MAA staff user receives Malaysia announcement created by MAA Boss');

  // AAX staff receives Malaysia AOC announcement (published by MAA Boss)
  await simulateUser(myStaff2Id);
  const aaxFeed1 = await db.query('select id from public.get_visible_announcements_secure();');
  assert(aaxFeed1.rows.map(r => r.id).includes(myAnnId), 'AAX staff user receives Malaysia announcement created by MAA Boss');

  // MAA staff receives Malaysia AOC announcement (published by AAX Boss)
  await simulateUser(myStaff1Id);
  const maaFeed2 = await db.query('select id from public.get_visible_announcements_secure();');
  assert(maaFeed2.rows.map(r => r.id).includes(aaxAnnId), 'MAA staff user receives Malaysia announcement created by AAX Boss');

  // AAX staff receives Malaysia AOC announcement (published by AAX Boss)
  await simulateUser(myStaff2Id);
  const aaxFeed2 = await db.query('select id from public.get_visible_announcements_secure();');
  assert(aaxFeed2.rows.map(r => r.id).includes(aaxAnnId), 'AAX staff user receives Malaysia announcement created by AAX Boss');

  console.log('\n--- SECTION 6: Mandatory Acknowledgement & Concurrency/Idempotency ---');
  // First acknowledgement succeeds
  await simulateUser(myStaff1Id);
  const ackRes1 = await db.query('select public.acknowledge_announcement_secure($1);', [myAnnId]);
  assert(ackRes1.rows[0].acknowledge_announcement_secure === true, 'Eligible user successfully acknowledges announcement');

  // Duplicate acknowledgement is safe and idempotent
  const ackResDup = await db.query('select public.acknowledge_announcement_secure($1);', [myAnnId]);
  assert(ackResDup.rows[0].acknowledge_announcement_secure === true, 'Duplicate acknowledgement call is safe and idempotent');

  // Feed reflects acknowledged = true
  const staffFeedAfterAck = await db.query('select id, acknowledged, acknowledged_at from public.get_visible_announcements_secure();');
  const ackRow = staffFeedAfterAck.rows.find(r => r.id === myAnnId);
  assert(ackRow && ackRow.acknowledged === true && Boolean(ackRow.acknowledged_at), 'Feed reflects acknowledged status and timestamp');

  console.log('\n--- SECTION 7: Acknowledgement Report Privacy Matrix & Auditing ---');
  // 1. GHOD can access acknowledgement report for Global announcements
  await simulateUser(ghodUserId);
  const ghodGlobalReportRes = await db.query(
    'select public.get_announcement_acknowledgement_report_secure($1) as report;',
    [globalAnnId],
  );
  const ghodGlobalReport = ghodGlobalReportRes.rows[0].report;
  assert(typeof ghodGlobalReport.total_eligible === 'number', 'GHOD successfully retrieves Global announcement acknowledgement report');
  assert(Array.isArray(ghodGlobalReport.acknowledged_list), 'GHOD receives Global acknowledged recipient identities');
  assert(Array.isArray(ghodGlobalReport.pending_list), 'GHOD receives Global pending recipient identities');

  // 2. GHOD CANNOT access acknowledgement report for Malaysia AOC announcements
  const ghodAocReportDenied = await expectFail(() => db.query(
    'select public.get_announcement_acknowledgement_report_secure($1);',
    [myAnnId],
  ));
  assert(ghodAocReportDenied.failed, 'GHOD denied accessing acknowledgement report for Malaysia AOC announcement');

  // 3. Malaysia publishers CAN access report for Malaysia AOC announcements
  await simulateUser(maaBossId);
  const maaBossReportRes = await db.query(
    'select public.get_announcement_acknowledgement_report_secure($1) as report;',
    [myAnnId],
  );
  const maaBossReport = maaBossReportRes.rows[0].report;
  assert(typeof maaBossReport.total_eligible === 'number', 'MAA Boss retrieves Malaysia AOC acknowledgement report');
  assert(maaBossReport.acknowledged_count === 1, 'Report reflects accurate acknowledged count');
  assert(Array.isArray(maaBossReport.acknowledged_list), 'MAA Boss receives acknowledged personnel list');
  assert(Array.isArray(maaBossReport.pending_list), 'MAA Boss receives pending recipient list');

  await simulateUser(aaxAdminId);
  const aaxAdminReportRes = await db.query(
    'select public.get_announcement_acknowledgement_report_secure($1) as report;',
    [myAnnId],
  );
  assert(typeof aaxAdminReportRes.rows[0].report.total_eligible === 'number', 'AAX Admin retrieves Malaysia AOC acknowledgement report');

  // 4. Malaysia publishers CANNOT access report for Global announcement
  const maaGlobalReportDenied = await expectFail(() => db.query(
    'select public.get_announcement_acknowledgement_report_secure($1);',
    [globalAnnId],
  ));
  assert(maaGlobalReportDenied.failed, 'MAA Boss denied accessing Global acknowledgement report');

  // 5. AirAsia Management is strictly denied acknowledgement reports for BOTH Global and AOC
  await simulateUser(airasiaMgmtId);
  const mgmtGlobalReportDenied = await expectFail(() => db.query(
    'select public.get_announcement_acknowledgement_report_secure($1);',
    [globalAnnId],
  ));
  assert(mgmtGlobalReportDenied.failed, 'AirAsia Management denied Global acknowledgement report');

  const mgmtAocReportDenied = await expectFail(() => db.query(
    'select public.get_announcement_acknowledgement_report_secure($1);',
    [myAnnId],
  ));
  assert(mgmtAocReportDenied.failed, 'AirAsia Management denied Malaysia AOC acknowledgement report');

  // 6. Ordinary recipient denied full acknowledgement report
  await simulateUser(myStaff1Id);
  const staffReportDenied = await expectFail(() => db.query(
    'select public.get_announcement_acknowledgement_report_secure($1);',
    [myAnnId],
  ));
  assert(staffReportDenied.failed, 'Ordinary staff denied accessing full acknowledgement report');

  // 7. Ordinary recipient can only see their own acknowledgement state
  const directAcks = await db.query('select * from public.announcement_acknowledgements where announcement_id = $1;', [myAnnId]);
  assert(directAcks.rows.every(r => r.user_id === myStaff1Id), 'Ordinary recipient sees only their own acknowledgement row via RLS');

  // 8. Acknowledgement report access is audited
  await simulateServiceRole();
  const ackAuditRows = (await db.query("select * from public.announcement_audit_log where action = 'view_acknowledgement_report';")).rows;
  assert(ackAuditRows.length >= 3, 'All acknowledgement report accesses are audited in announcement_audit_log');

  console.log('\n--- SECTION 8: Published-Content Immutability & Archive Lifecycle ---');
  // Attempting to modify title/body of published announcement is blocked
  await simulateUser(maaBossId);
  const updateContentPublished = await expectFail(() => db.query(
    "select public.update_announcement_secure($1, 'Tampered Title', 'Tampered Body');",
    [myAnnId],
  ));
  assert(updateContentPublished.failed, 'Published announcement title/body update rejected (immutability trigger)');

  // Direct DELETE of published announcement is blocked
  const deletePublished = await expectFail(() => db.query(
    'delete from public.announcements where id = $1;',
    [myAnnId],
  ));
  assert(deletePublished.failed, 'Direct DELETE of published announcement rejected (delete guard trigger)');

  // Archive lifecycle: approved publisher can archive
  const archiveRes = await db.query("select public.archive_announcement_secure($1, 'Replaced by newer protocol');", [myAnnId]);
  assert(archiveRes.rows[0].archive_announcement_secure === true, 'Approved publisher successfully archives announcement');

  // Archived announcement cannot be modified
  const updateArchived = await expectFail(() => db.query(
    "select public.update_announcement_secure($1, 'Altered after archive', 'Body');",
    [myAnnId],
  ));
  assert(updateArchived.failed, 'Archived announcement cannot be edited');

  // Archived announcement cannot be re-published
  const publishArchived = await expectFail(() => db.query(
    'select public.publish_announcement_secure($1);',
    [myAnnId],
  ));
  assert(publishArchived.failed, 'Archived announcement cannot be re-published');

  // Archived announcement cannot be deleted
  const deleteArchived = await expectFail(() => db.query(
    'delete from public.announcements where id = $1;',
    [myAnnId],
  ));
  assert(deleteArchived.failed, 'Archived announcement cannot be deleted');

  // Archived announcement is excluded from default feed
  await simulateUser(myStaff1Id);
  const staffFeedAfterArchive = await db.query('select id from public.get_visible_announcements_secure(null, null, false);');
  assert(!staffFeedAfterArchive.rows.map(r => r.id).includes(myAnnId), 'Archived announcement is excluded from default active feed');

  console.log('\n--- SECTION 9: Attachments & Pre-Publication Secrecy ---');
  // Draft announcement creation
  await simulateUser(maaBossId);
  const draftRes = await db.query(
    "select public.create_announcement_secure('Secret Upcoming Protocol', 'Draft body', 'aoc', $1, 'security', 'urgent', 'draft') as id;",
    [myAocId],
  );
  const draftId = draftRes.rows[0].id;

  // Add attachment to draft
  const attachRes = await db.query(
    "select public.add_announcement_attachment_secure($1, 'announcements/guide.pdf', 'Secret_Guide.pdf', 1048576, 'application/pdf') as id;",
    [draftId],
  );
  assert(Boolean(attachRes.rows[0].id), 'Publisher successfully adds attachment to draft announcement');

  // Recipient CANNOT see draft attachment before publication
  await simulateUser(myStaff1Id);
  const draftAttachDenied = await expectFail(() => db.query(
    'select * from public.get_announcement_attachments_secure($1);',
    [draftId],
  ));
  assert(draftAttachDenied.failed, 'Draft attachment is secret and invisible to recipient before publication');

  // Foreign staff cannot see attachments of Malaysia announcement
  await simulateUser(zzStaffId);
  const zzAttachDenied = await expectFail(() => db.query(
    'select * from public.get_announcement_attachments_secure($1);',
    [draftId],
  ));
  assert(zzAttachDenied.failed, 'Foreign staff denied retrieving attachments across AOCs');

  // Publish draft: now recipient can see attachment
  await simulateUser(maaBossId);
  await db.query('select public.publish_announcement_secure($1);', [draftId]);

  await simulateUser(myStaff1Id);
  const staffAttachRes = await db.query('select * from public.get_announcement_attachments_secure($1);', [draftId]);
  assert(staffAttachRes.rows.length === 1 && staffAttachRes.rows[0].file_name === 'Secret_Guide.pdf', 'Attachment becomes visible to recipient once announcement is published');

  console.log('\n--- SECTION 10: Concurrency-Safe Idempotent Publishing ---');
  await simulateUser(maaBossId);
  const pubAgain = await db.query('select public.publish_announcement_secure($1);', [draftId]);
  assert(pubAgain.rows[0].publish_announcement_secure === true, 'Publishing an already-published announcement is safe and idempotent');

  console.log(`\nPhase 11 announcements verification completed. Total failures: ${failures}`);

  await db.exec('rollback;');
  await db.close();

  if (failures > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Unhandled verification error:', err);
  process.exit(1);
});
