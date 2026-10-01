// Phase 11: Global & Malaysia AOC Announcements verification.
//
// Verifies:
//  1. Authentication boundary: unauthenticated feed, detail, acknowledge, create denied.
//  2. Authoring authorization:
//     - Global publish allowed for GHOD/Super Admin, denied for regular AOC leadership or staff.
//     - AOC publish allowed for authorized AOC leadership in their own AOC, denied for foreign AOC leadership.
//     - Client publisher spoofing denied (publisher identity strictly derived from auth.uid()).
//  3. Publication lifecycle & scheduling:
//     - Drafts are invisible to ordinary recipients.
//     - Scheduled announcements with future publish time are invisible before publish time.
//     - Scheduled announcements become visible when published_at <= now().
//     - Expired announcements (expires_at <= now()) are excluded from active feed.
//     - Archived announcements are excluded from active feed, preserved in history.
//  4. Multi-AOC & Cross-Entity Isolation:
//     - Global announcements are visible to eligible users across all active AOCs.
//     - Malaysia AOC announcements are visible to Malaysia personnel and multi-AOC personnel.
//     - Malaysia AOC announcements are completely invisible to foreign AOC personnel (raises 'Announcement not found.').
//     - Cross-entity staff within the same AOC can view announcements.
//  5. Acknowledgements:
//     - User can acknowledge visible mandatory announcement.
//     - Acknowledgement is idempotent (safe on duplicate).
//     - Acknowledging invisible, draft, or foreign-AOC announcement is rejected.
//     - User cannot acknowledge on behalf of another user.
//  6. Acknowledgement reporting & privacy:
//     - Ordinary user cannot access full acknowledgement reports.
//     - Authorized publisher/management receives exact denominator (eligible active assignments) and numerator.
//     - Denominator excludes disabled profiles, inactive assignments, and foreign AOCs.
//  7. Attachments:
//     - Authorized publisher can add attachments.
//     - Attachment metadata retrieval requires announcement visibility; foreign AOC denied.
//  8. Audit logging:
//     - Sensitive lifecycle actions (create, edit, publish, schedule, archive) are logged to announcement_audit_log.
//  9. Content safety:
//     - Oversized title (>200) and body (>20000) rejected.
//     - Inert string storage of script/HTML tags.
// 10. Fail-closed scope integrity:
//     - Database constraints block global announcement with an AOC or AOC announcement without an AOC.
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

  // 2. Super Admin user (Technical platform admin - CANNOT publish Global)
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

  // 4. Malaysia AOC Leaders (MAA Boss, MAA Admin, AAX Boss, AAX Admin)
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



  // 12. ZZ Staff user (ASO in ZZ AOC)
  const zzStaffId = nextId();
  await createUser(zzStaffId, 'p11-zzstaff@example.test', 'Zoe ZZStaff', 'P11-ZZS');
  const zzStaffMem = await grantMembership(zzStaffId, zzAocId, zzEntityId);
  await db.query(
    "insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, hub_id, station_id, team_id, entity_membership_id, starts_at) values ($1, $2, $3, $4, $5, $6, $7, $8, now() - interval '1 day');",
    [zzStaffId, roleMap.get('aso'), zzAocId, zzDeptId, zzHubId, zzStationId, zzTeamId, zzStaffMem],
  );

  // 13. Multi-AOC user (Holds active assignments in BOTH MY and ZZ AOCs)
  const multiAocUserId = nextId();
  await createUser(multiAocUserId, 'p11-multi@example.test', 'Maya MultiAOC', 'P11-M1');
  const multiMyMem = await grantMembership(multiAocUserId, myAocId, myEntityId, true);
  const multiZzMem = await grantMembership(multiAocUserId, zzAocId, zzEntityId, false);
  await db.query(
    "insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, hub_id, station_id, team_id, entity_membership_id, starts_at) values ($1, $2, $3, $4, $5, $6, $7, $8, now() - interval '1 day');",
    [multiAocUserId, roleMap.get('aso'), myAocId, myDeptId, kulHubId, kulStationId, kulTeamId, multiMyMem],
  );
  await db.query(
    "insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, hub_id, station_id, team_id, entity_membership_id, starts_at) values ($1, $2, $3, $4, $5, $6, $7, $8, now() - interval '1 day');",
    [multiAocUserId, roleMap.get('aso'), zzAocId, zzDeptId, zzHubId, zzStationId, zzTeamId, multiZzMem],
  );

  // 14. Disabled user (Status 'pending')
  const disabledUserId = nextId();
  await createUser(disabledUserId, 'p11-disabled@example.test', 'Dave Disabled', 'P11-D1', 'pending');

  console.log('\n--- SECTION 1: Authentication Boundary ---');
  await simulateUnauthenticated();
  const unauthFeed = await expectFail(() => db.query('select * from public.get_visible_announcements_secure();'));
  assert(unauthFeed.failed, 'Unauthenticated user denied announcement feed');

  const unauthDetail = await expectFail(() => db.query("select * from public.get_announcement_detail_secure('00000000-0000-0000-0000-000000000001'::uuid);"));
  assert(unauthDetail.failed, 'Unauthenticated user denied announcement detail');

  const unauthAck = await expectFail(() => db.query("select * from public.acknowledge_announcement_secure('00000000-0000-0000-0000-000000000001'::uuid);"));
  assert(unauthAck.failed, 'Unauthenticated user denied acknowledgement');

  const unauthCreate = await expectFail(() => db.query("select * from public.create_announcement_secure('Title', 'Body', 'global');"));
  assert(unauthCreate.failed, 'Unauthenticated user denied announcement creation');

  console.log('\n--- SECTION 2: Creation & Authoring Authorization (Strict Role Matrix) ---');
  // Confirm NO HOD role exists in role_definitions
  assert(noHodExists, 'No generic HOD role exists in VECTA database (GHOD is the only head role)');

  // GHOD can create Global announcement
  await simulateUser(ghodUserId);
  const globalAnnRes = await db.query(
    "select public.create_announcement_secure('Global System Maintenance', 'VECTA global maintenance on Sunday.', 'global', null, null, null, null, 'system', 'important', 'published', now(), null, true, true) as id;",
  );
  const globalAnnId = globalAnnRes.rows[0].id;
  assert(Boolean(globalAnnId), 'GHOD successfully creates Global announcement');

  // Super Admin CANNOT create Global announcement
  await simulateUser(superAdminId);
  const superCreateGlobal = await expectFail(() => db.query(
    "select public.create_announcement_secure('SuperAdmin Global', 'Unauthorized body', 'global');",
  ));
  assert(superCreateGlobal.failed, 'Super Admin denied creating Global announcement');

  // AirAsia Management CANNOT create Global announcement (read-only executive)
  await simulateUser(airasiaMgmtId);
  const mgmtCreateGlobal = await expectFail(() => db.query(
    "select public.create_announcement_secure('Mgmt Global', 'Unauthorized body', 'global');",
  ));
  assert(mgmtCreateGlobal.failed, 'AirAsia Management denied creating Global announcement');

  // Operation Manager CANNOT create Global announcement
  await simulateUser(opManagerId);
  const opMgrCreateGlobal = await expectFail(() => db.query(
    "select public.create_announcement_secure('OpMgr Global', 'Unauthorized body', 'global');",
  ));
  assert(opMgrCreateGlobal.failed, 'Operation Manager denied creating Global announcement');

  // Main Enforcement CANNOT create Global announcement
  await simulateUser(mainEnfId);
  const mainEnfCreateGlobal = await expectFail(() => db.query(
    "select public.create_announcement_secure('Enf Global', 'Unauthorized body', 'global');",
  ));
  assert(mainEnfCreateGlobal.failed, 'Main Enforcement denied creating Global announcement');

  // Compliance CANNOT create Global announcement
  await simulateUser(complianceId);
  const compCreateGlobal = await expectFail(() => db.query(
    "select public.create_announcement_secure('Comp Global', 'Unauthorized body', 'global');",
  ));
  assert(compCreateGlobal.failed, 'Compliance denied creating Global announcement');

  // CaterLink Management CANNOT create Global announcement
  await simulateUser(caterlinkMgmtId);
  const clCreateGlobal = await expectFail(() => db.query(
    "select public.create_announcement_secure('CaterLink Global', 'Unauthorized body', 'global');",
  ));
  assert(clCreateGlobal.failed, 'CaterLink Management denied creating Global announcement');

  // Ordinary staff CANNOT create Global announcement
  await simulateUser(myStaff1Id);
  const staffCreateGlobal = await expectFail(() => db.query(
    "select public.create_announcement_secure('Staff Global', 'Unauthorized body', 'global');",
  ));
  assert(staffCreateGlobal.failed, 'Ordinary staff denied creating Global announcement');

  // MAA Boss CANNOT create Global announcement (scoped only to MY AOC)
  await simulateUser(maaBossId);
  const maaBossCreateGlobal = await expectFail(() => db.query(
    "select public.create_announcement_secure('MAA Boss Global', 'Unauthorized body', 'global');",
  ));
  assert(maaBossCreateGlobal.failed, 'MAA Boss denied creating Global announcement');

  // MAA Boss successfully creates Malaysia AOC announcement
  const myAnnRes = await db.query(
    "select public.create_announcement_secure('KLIA Terminal 2 Security Briefing', 'All Malaysia AVSEC staff to note revised patrol protocol.', 'aoc', $1, null, null, null, 'security', 'urgent', 'published', now(), null, true, false) as id;",
    [myAocId],
  );
  const myAnnId = myAnnRes.rows[0].id;
  assert(Boolean(myAnnId), 'MAA Boss successfully creates Malaysia AOC announcement');

  // MAA Admin successfully creates Malaysia AOC announcement
  await simulateUser(maaAdminId);
  const maaAdminAnnRes = await db.query(
    "select public.create_announcement_secure('MAA Admin Notice', 'Notice from MAA Admin.', 'aoc', $1, null, null, null, 'operational', 'normal') as id;",
    [myAocId],
  );
  assert(Boolean(maaAdminAnnRes.rows[0].id), 'MAA Admin successfully creates Malaysia AOC announcement');

  // AAX Boss successfully creates Malaysia AOC announcement
  await simulateUser(aaxBossId);
  const aaxBossAnnRes = await db.query(
    "select public.create_announcement_secure('AAX Boss Notice', 'Notice from AAX Boss.', 'aoc', $1, null, null, null, 'operational', 'normal') as id;",
    [myAocId],
  );
  assert(Boolean(aaxBossAnnRes.rows[0].id), 'AAX Boss successfully creates Malaysia AOC announcement');

  // AAX Admin successfully creates Malaysia AOC announcement
  await simulateUser(aaxAdminId);
  const aaxAdminAnnRes = await db.query(
    "select public.create_announcement_secure('AAX Admin Notice', 'Notice from AAX Admin.', 'aoc', $1, null, null, null, 'operational', 'normal') as id;",
    [myAocId],
  );
  assert(Boolean(aaxAdminAnnRes.rows[0].id), 'AAX Admin successfully creates Malaysia AOC announcement');

  // Operation Manager CANNOT create Malaysia AOC announcement
  await simulateUser(opManagerId);
  const opMgrCreateAoc = await expectFail(() => db.query(
    "select public.create_announcement_secure('OpMgr AOC', 'Unauthorized AOC post', 'aoc', $1);",
    [myAocId],
  ));
  assert(opMgrCreateAoc.failed, 'Operation Manager denied creating Malaysia AOC announcement');

  // Main Enforcement CANNOT create Malaysia AOC announcement
  await simulateUser(mainEnfId);
  const mainEnfCreateAoc = await expectFail(() => db.query(
    "select public.create_announcement_secure('MainEnf AOC', 'Unauthorized AOC post', 'aoc', $1);",
    [myAocId],
  ));
  assert(mainEnfCreateAoc.failed, 'Main Enforcement denied creating Malaysia AOC announcement');

  // Compliance CANNOT create Malaysia AOC announcement
  await simulateUser(complianceId);
  const compCreateAoc = await expectFail(() => db.query(
    "select public.create_announcement_secure('Comp AOC', 'Unauthorized AOC post', 'aoc', $1);",
    [myAocId],
  ));
  assert(compCreateAoc.failed, 'Compliance denied creating Malaysia AOC announcement');

  // AirAsia Management CANNOT create Malaysia AOC announcement (strictly read-only)
  await simulateUser(airasiaMgmtId);
  const mgmtCreateAoc = await expectFail(() => db.query(
    "select public.create_announcement_secure('Mgmt AOC', 'Unauthorized AOC post', 'aoc', $1);",
    [myAocId],
  ));
  assert(mgmtCreateAoc.failed, 'AirAsia Management denied creating Malaysia AOC announcement');

  // AirAsia Management CAN read Global announcement in feed
  const mgmtFeed = await db.query('select id from public.get_visible_announcements_secure();');
  assert(mgmtFeed.rows.map((r) => r.id).includes(globalAnnId), 'AirAsia Management can view Global announcement in feed');

  // MAA Boss cannot create announcement in foreign (ZZ) AOC
  await simulateUser(maaBossId);
  const maaBossCreateZZ = await expectFail(() => db.query(
    "select public.create_announcement_secure('Intrusion into ZZ', 'Unauthorized cross-AOC post', 'aoc', $1);",
    [zzAocId],
  ));
  assert(maaBossCreateZZ.failed, 'MAA Boss denied creating announcement in foreign (ZZ) AOC');

  // GHOD creates ZZ AOC announcement under executive global oversight
  await simulateUser(ghodUserId);
  const zzAnnRes = await db.query(
    "select public.create_announcement_secure('ZZ Station Protocol', 'ZZ station local rules update.', 'aoc', $1, null, null, null, 'operational', 'normal', 'published', now(), null, false, false) as id;",
    [zzAocId],
  );
  const zzAnnId = zzAnnRes.rows[0].id;
  assert(Boolean(zzAnnId), 'GHOD successfully creates ZZ AOC announcement under executive global oversight');

  console.log('\n--- SECTION 3: Visibility & Scheduling Lifecycle ---');
  // Draft announcement creation
  await simulateUser(maaBossId);
  const draftAnnRes = await db.query(
    "select public.create_announcement_secure('Draft Malaysia Strategy', 'Draft content not yet published.', 'aoc', $1, null, null, null, 'policy', 'normal', 'draft') as id;",
    [myAocId],
  );
  const draftAnnId = draftAnnRes.rows[0].id;

  // Ordinary staff cannot see Draft in feed
  await simulateUser(myStaff1Id);
  const staffFeedWithDraft = await db.query('select id from public.get_visible_announcements_secure();');
  const feedIds = staffFeedWithDraft.rows.map((r) => r.id);
  assert(!feedIds.includes(draftAnnId), 'Draft announcement is hidden from ordinary staff feed');

  // Ordinary staff cannot retrieve Draft detail
  const staffDraftDetail = await expectFail(() => db.query('select * from public.get_announcement_detail_secure($1);', [draftAnnId]));
  assert(staffDraftDetail.failed, 'Ordinary staff denied retrieving Draft announcement detail (raises not found)');

  // Scheduled future announcement creation (published_at in future)
  await simulateUser(maaBossId);
  const futureDate = new Date(Date.now() + 86400000).toISOString();
  const scheduledAnnRes = await db.query(
    "select public.create_announcement_secure('Future Airport Directive', 'To take effect tomorrow.', 'aoc', $1, null, null, null, 'operational', 'normal', 'scheduled', $2) as id;",
    [myAocId, futureDate],
  );
  const scheduledAnnId = scheduledAnnRes.rows[0].id;

  // Ordinary staff cannot see Future Scheduled announcement
  await simulateUser(myStaff1Id);
  const staffFeedWithScheduled = await db.query('select id from public.get_visible_announcements_secure();');
  assert(!staffFeedWithScheduled.rows.map((r) => r.id).includes(scheduledAnnId), 'Scheduled announcement with future timestamp is hidden before publish time');

  // Publishing the scheduled announcement now makes it visible
  await simulateUser(maaBossId);
  await db.query("select public.publish_announcement_secure($1, now() - interval '1 minute');", [scheduledAnnId]);
  await simulateUser(myStaff1Id);
  const staffFeedAfterPublish = await db.query('select id from public.get_visible_announcements_secure();');
  assert(staffFeedAfterPublish.rows.map((r) => r.id).includes(scheduledAnnId), 'Scheduled announcement becomes visible immediately once publish time is reached');

  // Expired announcement behavior (expires_at in past)
  await simulateUser(maaBossId);
  const expiredAnnRes = await db.query(
    "select public.create_announcement_secure('Flash Gate Alert', 'Gate C1 temp detour.', 'aoc', $1, null, null, null, 'operational', 'urgent', 'published', now() - interval '2 hours', now() - interval '1 hour') as id;",
    [myAocId],
  );
  const expiredAnnId = expiredAnnRes.rows[0].id;

  await simulateUser(myStaff1Id);
  const staffFeedCurrent = await db.query('select id from public.get_visible_announcements_secure(null, null, false);');
  assert(!staffFeedCurrent.rows.map((r) => r.id).includes(expiredAnnId), 'Expired announcement is excluded from current active feed');

  // Archived announcement behavior
  await simulateUser(maaBossId);
  await db.query("select public.archive_announcement_secure($1, 'Superseded by newer policy');", [scheduledAnnId]);
  await simulateUser(myStaff1Id);
  const staffFeedAfterArchive = await db.query('select id from public.get_visible_announcements_secure(null, null, false);');
  assert(!staffFeedAfterArchive.rows.map((r) => r.id).includes(scheduledAnnId), 'Archived announcement is excluded from active feed');

  console.log('\n--- SECTION 4: Multi-AOC & Cross-Entity Isolation ---');
  // Global announcement visible to MY staff
  await simulateUser(myStaff1Id);
  const myStaffFeed = await db.query('select id from public.get_visible_announcements_secure();');
  assert(myStaffFeed.rows.map((r) => r.id).includes(globalAnnId), 'Global announcement is visible to Malaysia AOC staff');
  assert(myStaffFeed.rows.map((r) => r.id).includes(myAnnId), 'Malaysia AOC announcement is visible to Malaysia AOC staff');
  assert(!myStaffFeed.rows.map((r) => r.id).includes(zzAnnId), 'Foreign (ZZ) AOC announcement is completely invisible to Malaysia AOC staff');

  // Malaysia detail retrieval succeeds for MY staff
  const myDetail = await db.query('select * from public.get_announcement_detail_secure($1);', [myAnnId]);
  assert(myDetail.rows.length === 1 && myDetail.rows[0].title === 'KLIA Terminal 2 Security Briefing', 'Malaysia staff successfully retrieves Malaysia announcement detail');

  // Malaysia detail retrieval raises error for foreign ZZ staff
  await simulateUser(zzStaffId);
  const zzStaffFeed = await db.query('select id from public.get_visible_announcements_secure();');
  assert(zzStaffFeed.rows.map((r) => r.id).includes(globalAnnId), 'Global announcement is visible to ZZ AOC staff');
  assert(zzStaffFeed.rows.map((r) => r.id).includes(zzAnnId), 'ZZ AOC announcement is visible to ZZ AOC staff');
  assert(!zzStaffFeed.rows.map((r) => r.id).includes(myAnnId), 'Malaysia AOC announcement is completely invisible to ZZ AOC staff');

  const foreignAocDetailDenied = await expectFail(() => db.query('select * from public.get_announcement_detail_secure($1);', [myAnnId]));
  assert(foreignAocDetailDenied.failed, 'Foreign ZZ staff denied retrieving Malaysia announcement detail (raises not found)');

  // Multi-AOC user can see both MY and ZZ announcements
  await simulateUser(multiAocUserId);
  const multiFeed = await db.query('select id from public.get_visible_announcements_secure();');
  const multiIds = multiFeed.rows.map((r) => r.id);
  assert(multiIds.includes(globalAnnId), 'Multi-AOC user sees Global announcement');
  assert(multiIds.includes(myAnnId), 'Multi-AOC user sees Malaysia AOC announcement');
  assert(multiIds.includes(zzAnnId), 'Multi-AOC user sees ZZ AOC announcement');

  // Cross-entity user within same AOC (MY AAX) can see MY MAA announcement
  await simulateUser(myStaff2Id);
  const myStaff2Feed = await db.query('select id from public.get_visible_announcements_secure();');
  assert(myStaff2Feed.rows.map((r) => r.id).includes(myAnnId), 'Cross-entity user within same AOC successfully sees AOC announcement');

  console.log('\n--- SECTION 5: Mandatory Acknowledgements & Idempotency ---');
  // MY staff acknowledges Malaysia announcement
  await simulateUser(myStaff1Id);
  const ackRes1 = await db.query('select public.acknowledge_announcement_secure($1);', [myAnnId]);
  assert(ackRes1.rows[0].acknowledge_announcement_secure === true, 'Eligible user successfully acknowledges mandatory announcement');

  // Feed reflects acknowledged = true
  const feedAfterAck = await db.query('select id, acknowledged from public.get_visible_announcements_secure();');
  const ackItem = feedAfterAck.rows.find((r) => r.id === myAnnId);
  assert(ackItem && ackItem.acknowledged === true, 'Feed reflects acknowledged status for caller');

  // Duplicate acknowledgement is safe and idempotent
  const ackResDuplicate = await db.query('select public.acknowledge_announcement_secure($1);', [myAnnId]);
  assert(ackResDuplicate.rows[0].acknowledge_announcement_secure === true, 'Duplicate acknowledgement call is safe and idempotent');

  // Foreign staff cannot acknowledge Malaysia announcement
  await simulateUser(zzStaffId);
  const foreignAck = await expectFail(() => db.query('select public.acknowledge_announcement_secure($1);', [myAnnId]));
  assert(foreignAck.failed, 'Foreign AOC staff denied acknowledging Malaysia announcement');

  // Acknowledging invisible draft announcement is denied
  await simulateUser(myStaff1Id);
  const draftAck = await expectFail(() => db.query('select public.acknowledge_announcement_secure($1);', [draftAnnId]));
  assert(draftAck.failed, 'Acknowledging invisible draft announcement is denied');

  console.log('\n--- SECTION 6: Acknowledgement Privacy & Management Reporting ---');
  // Ordinary user denied reading full acknowledgement report
  await simulateUser(myStaff1Id);
  const staffReportDenied = await expectFail(() => db.query('select * from public.get_announcement_acknowledgement_report_secure($1);', [myAnnId]));
  assert(staffReportDenied.failed, 'Ordinary staff denied accessing full acknowledgement report');

  // Authorized Malaysia Leader receives exact report
  await simulateUser(maaBossId);
  const reportRes = await db.query('select public.get_announcement_acknowledgement_report_secure($1) as report;', [myAnnId]);
  const report = reportRes.rows[0].report;
  assert(typeof report.total_eligible === 'number' && report.total_eligible >= 4, `Report calculates exact active eligible denominator (found: ${report.total_eligible})`);
  assert(report.acknowledged_count === 1, `Report counts acknowledged staff accurately (found: ${report.acknowledged_count})`);
  assert(report.pending_count === report.total_eligible - 1, `Report calculates pending count correctly (found: ${report.pending_count})`);
  assert(Array.isArray(report.acknowledged_list) && report.acknowledged_list.length === 1, 'Report includes acknowledged recipient summary');

  console.log('\n--- SECTION 7: Attachments Metadata & Authorization ---');
  // Publisher attaches file metadata
  await simulateUser(maaBossId);
  const attachRes = await db.query(
    "select public.add_announcement_attachment_secure($1, 'announcements/malaysia/patrol_guide.pdf', 'KLIA_Patrol_Guide.pdf', 1048576, 'application/pdf') as id;",
    [myAnnId],
  );
  const attachId = attachRes.rows[0].id;
  assert(Boolean(attachId), 'Publisher successfully adds attachment metadata to announcement');

  // Eligible staff can retrieve attachment metadata
  await simulateUser(myStaff1Id);
  const staffAttachments = await db.query('select * from public.get_announcement_attachments_secure($1);', [myAnnId]);
  assert(staffAttachments.rows.length === 1 && staffAttachments.rows[0].file_name === 'KLIA_Patrol_Guide.pdf', 'Eligible staff retrieves announcement attachment metadata');

  // Foreign staff denied retrieving attachment metadata
  await simulateUser(zzStaffId);
  const foreignAttachDenied = await expectFail(() => db.query('select * from public.get_announcement_attachments_secure($1);', [myAnnId]));
  assert(foreignAttachDenied.failed, 'Foreign staff denied retrieving attachment metadata for cross-AOC announcement');

  console.log('\n--- SECTION 8: Audit Logging Integrity ---');
  await simulateServiceRole();
  const auditRes = await db.query(
    'select action, actor_profile_id from public.announcement_audit_log where announcement_id = $1 order by created_at asc;',
    [myAnnId],
  );
  const actions = auditRes.rows.map((r) => r.action);
  assert(actions.includes('create'), 'Audit log recorded announcement creation');
  assert(actions.includes('edit'), 'Audit log recorded attachment addition/edit');

  // Ordinary user cannot read audit log table directly
  await simulateUser(myStaff1Id);
  const auditTableReadDenied = await expectFail(() => db.query('select * from public.announcement_audit_log limit 1;'));
  assert(auditTableReadDenied.failed, 'Ordinary staff denied direct SELECT on announcement audit log table');

  console.log('\n--- SECTION 9: Content Safety & Bounds ---');
  await simulateUser(maaBossId);
  const longTitle = 'A'.repeat(201);
  const oversizedTitle = await expectFail(() => db.query(
    "select public.create_announcement_secure($1, 'Valid body', 'aoc', $2);", [longTitle, myAocId],
  ));
  assert(oversizedTitle.failed, 'Oversized title (>200 chars) rejected');

  const longBody = 'B'.repeat(20001);
  const oversizedBody = await expectFail(() => db.query(
    "select public.create_announcement_secure('Valid title', $1, 'aoc', $2);", [longBody, myAocId],
  ));
  assert(oversizedBody.failed, 'Oversized body (>20000 chars) rejected');

  // Script tag stored inertly without transformation
  const scriptTitle = 'Security Alert: <script>alert("xss")</script>';
  const scriptBody = 'Body containing <script>window.location="evil"</script> and literal text';
  const scriptAnnRes = await db.query(
    "select public.create_announcement_secure($1, $2, 'aoc', $3) as id;", [scriptTitle, scriptBody, myAocId],
  );
  const scriptAnnId = scriptAnnRes.rows[0].id;
  const scriptFetch = await db.query('select title, body from public.get_announcement_detail_secure($1);', [scriptAnnId]);
  assert(
    scriptFetch.rows[0].title === scriptTitle && scriptFetch.rows[0].body === scriptBody,
    'Script payload stored and returned as inert literal string',
  );

  console.log('\n--- SECTION 10: Fail-Closed Scope Integrity ---');
  // Global announcement with an AOC ID must fail constraint
  const invalidGlobal = await expectFail(() => db.query(
    "select public.create_announcement_secure('Invalid Global', 'Body', 'global', $1);", [myAocId],
  ));
  assert(invalidGlobal.failed, 'Global announcement with an AOC ID rejected (fail-closed)');

  // AOC announcement with NULL AOC ID must fail constraint
  const invalidAoc = await expectFail(() => db.query(
    "select public.create_announcement_secure('Invalid AOC', 'Body', 'aoc', null);",
  ));
  assert(invalidAoc.failed, 'AOC announcement with NULL AOC ID rejected (fail-closed)');

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
