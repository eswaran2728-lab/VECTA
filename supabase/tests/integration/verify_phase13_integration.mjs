// Phase 13: integration, legacy transition readiness, rollout controls --
// closure verification.
//
// Authoritative behaviors under test:
//  1. The two cron-only functions found over-granted during the Phase 13
//     audit (flag_attendance_anomalies, trigger_sheets_sync) are no longer
//     callable by `authenticated` or `anon` -- only service_role.
//  2. The legacy-role mapping report and release-readiness report are
//     readable only by an approved Super Admin, never by any other role,
//     and every access is audited (phase13_readiness_access_log).
//  3. The legacy-role mapping report correctly identifies a legacy
//     MANAGEMENT/ADMIN/ENFORCEMENT profile as having (or lacking) an
//     active Phase 3 scoped-role replacement assignment -- this is the
//     read-only evidence behind the retirement gate; it never writes.
//  4. A different user's phase13_readiness_access_log rows are not
//     readable by anyone but a Super Admin.
//
// Run from this directory, AFTER `node migrate.mjs`:
//   node verify_phase13_integration.mjs [--native]
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { assertDisposableLocalTarget } from './safeguards.mjs';

const { Client } = pg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_DATA_DIR = path.join(__dirname, 'pgdata');
const RUN_DATA_DIR = path.join(__dirname, 'pgdata_phase13_integration_run');

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
  const runDb = 'vecta_phase13_integration_run';

  let db;
  if (isNative) {
    assertDisposableLocalTarget(pgConfig, goldenDb, runDb);
    console.log(`=== Phase 13 integration verification against Native PostgreSQL (${pgConfig.host}:${pgConfig.port}) ===`);
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
    console.log('=== Phase 13 integration verification against PGlite embedded engine ===');
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

  let seq = 0x100;
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
  const roleRows = (await db.query("select id, code from public.role_definitions;")).rows;
  const roleMap = new Map(roleRows.map((r) => [r.code, r.id]));

  async function createUser(id, email, name, staffNo, legacyRole = 'ASO', status = 'approved') {
    await db.query("insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing;", [id, email]);
    await db.query(
      "insert into public.profiles (id, email, name, staff_no, role, status) values ($1, $2, $3, $4, $5, $6) on conflict (id) do update set email = excluded.email, name = excluded.name, staff_no = excluded.staff_no, role = excluded.role, status = excluded.status;",
      [id, email, name, staffNo, legacyRole, status],
    );
  }

  console.log('\n--- SECTION 1: Over-granted cron-only functions are now locked down ---');

  const superAdminId = nextId();
  // Canonical Super Admin: an approved profile holding an active Phase 3
  // super_admin role assignment (no scope, no entity membership). The
  // legacy profile role is deliberately an ordinary one -- authority must
  // come from the assignment alone.
  await createUser(superAdminId, 'p13-super@example.test', 'Sam SuperAdmin', 'P13-SA', 'ASO');
  await db.query(
    "insert into public.user_role_assignments (profile_id, role_definition_id, starts_at) values ($1, $2, now() - interval '1 day');",
    [superAdminId, roleMap.get('super_admin')],
  );

  const ordinaryStaffId = nextId();
  await createUser(ordinaryStaffId, 'p13-staff@example.test', 'Ally Staff', 'P13-ST', 'ASO');

  await simulateUser(ordinaryStaffId);
  const staffFlagDenied = await expectFail(() => db.query('select public.flag_attendance_anomalies();'));
  assert(staffFlagDenied.failed, 'An ordinary authenticated staff member cannot call flag_attendance_anomalies() directly');

  const staffSheetsDenied = await expectFail(() => db.query('select public.trigger_sheets_sync();'));
  assert(staffSheetsDenied.failed, 'An ordinary authenticated staff member cannot call trigger_sheets_sync() directly');

  await db.exec('set role anon;');
  const anonSheetsDenied = await expectFail(() => db.query('select public.trigger_sheets_sync();'));
  assert(anonSheetsDenied.failed, 'anon cannot call trigger_sheets_sync() -- no more default PUBLIC execute grant');
  await simulateServiceRole();

  console.log('\n--- SECTION 2: Legacy role mapping report -- Super-Admin-only, audited ---');

  const legacyMgmtId = nextId();
  await createUser(legacyMgmtId, 'p13-legacymgmt@example.test', 'Mona Management', 'P13-MM', 'MANAGEMENT');

  const legacyAdminWithReplacementId = nextId();
  await createUser(legacyAdminWithReplacementId, 'p13-legacyadmin@example.test', 'Alan Admin', 'P13-AA', 'ADMIN');
  const opsDeptId = (await db.query("select id from public.departments where aoc_id = $1 and code = 'operation';", [myAocId])).rows[0].id;
  await db.query(
    "insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, starts_at) values ($1, $2, $3, $4, now() - interval '1 day');",
    [legacyAdminWithReplacementId, roleMap.get('operation_manager'), myAocId, opsDeptId],
  );

  await simulateUser(ordinaryStaffId);
  const staffReportDenied = await expectFail(() => db.query('select * from public.view_legacy_role_mapping_report_secure();'));
  assert(staffReportDenied.failed, 'An ordinary staff member cannot view the legacy-role mapping report');

  await simulateUser(superAdminId);
  const legacyReport = (await db.query('select * from public.view_legacy_role_mapping_report_secure();')).rows;
  const mgmtRow = legacyReport.find((r) => r.profile_id === legacyMgmtId);
  const adminRow = legacyReport.find((r) => r.profile_id === legacyAdminWithReplacementId);

  assert(Boolean(mgmtRow), 'The legacy MANAGEMENT profile appears in the mapping report');
  assert(mgmtRow?.has_replacement_assignment === false, 'A legacy profile with no active scoped-role assignment is correctly flagged as having NO replacement');
  assert(Boolean(adminRow), 'The legacy ADMIN profile with a replacement assignment appears in the mapping report');
  assert(adminRow?.has_replacement_assignment === true, 'A legacy profile WITH an active scoped-role assignment is correctly flagged as having a replacement');
  assert((adminRow?.active_replacement_role_codes ?? []).includes('operation_manager'), 'The replacement role code is reported accurately');

  const auditRows = (await db.query("select * from public.phase13_readiness_access_log where actor_profile_id = $1 and report_type = 'legacy_role_mapping';", [superAdminId])).rows;
  assert(auditRows.length > 0, 'Viewing the legacy-role mapping report is audited');

  console.log('\n--- SECTION 3: Release-readiness report -- Super-Admin-only, audited, no secrets ---');

  await simulateUser(ordinaryStaffId);
  const staffReadinessDenied = await expectFail(() => db.query('select public.view_release_readiness_report_secure();'));
  assert(staffReadinessDenied.failed, 'An ordinary staff member cannot view the release-readiness report');

  await simulateUser(superAdminId);
  const readiness = (await db.query('select public.view_release_readiness_report_secure() as report;')).rows[0].report;
  assert(typeof readiness.legacy_profiles_without_replacement_assignment === 'number', 'Release-readiness report includes a legacy-profiles-without-replacement count');
  assert(typeof readiness.orphaned_role_assignments === 'number', 'Release-readiness report includes an orphaned-role-assignments count');
  assert(readiness.legacy_profiles_without_replacement_assignment >= 1, 'The unreplaced legacy MANAGEMENT profile is reflected in the readiness count');

  const reportText = JSON.stringify(readiness);
  assert(!/sk-[a-zA-Z0-9]{10,}/.test(reportText), 'Release-readiness report never contains an API-key-shaped value');
  assert(!reportText.toLowerCase().includes('password'), 'Release-readiness report never contains a password field');

  const readinessAuditRows = (await db.query("select * from public.phase13_readiness_access_log where actor_profile_id = $1 and report_type = 'release_readiness';", [superAdminId])).rows;
  assert(readinessAuditRows.length > 0, 'Viewing the release-readiness report is audited');

  console.log('\n--- SECTION 4: Audit log is Super-Admin-readable only (no cross-user leak) ---');

  await simulateUser(ordinaryStaffId);
  const crossUserAuditRead = (await db.query('select * from public.phase13_readiness_access_log where actor_profile_id = $1;', [superAdminId])).rows;
  assert(crossUserAuditRead.length === 0, "An ordinary staff member cannot read the Super Admin's readiness-access audit rows (RLS Super-Admin-only read)");

  console.log('\n--- SECTION 5: Canonical super_admin authorization matrix (readiness reports + audit log) ---');

  const superRoleId = roleMap.get('super_admin');
  const opMgrRoleId = roleMap.get('operation_manager');

  async function tryAccess(id) {
    await simulateUser(id);
    const report = await expectFail(() => db.query('select public.view_release_readiness_report_secure();'));
    const mapping = await expectFail(() => db.query('select * from public.view_legacy_role_mapping_report_secure();'));
    const audit = (await db.query('select count(*)::int as n from public.phase13_readiness_access_log;')).rows[0].n;
    await simulateServiceRole();
    return { reportAllowed: !report.failed, mappingAllowed: !mapping.failed, auditVisible: audit };
  }

  async function newUser(label, legacyRole = 'ASO', status = 'approved') {
    const id = nextId();
    await createUser(id, `p13-${label}@example.test`, `P13 ${label}`, `P13-${label}`.slice(0, 20), legacyRole, status);
    return id;
  }
  async function grantSuper(id, startsSql, endsSql) {
    await db.query(
      `insert into public.user_role_assignments (profile_id, role_definition_id, starts_at, ends_at) values ($1, $2, ${startsSql}, ${endsSql});`,
      [id, superRoleId],
    );
  }

  // 5a. Active super_admin assignment: allowed everywhere.
  const activeRes = await tryAccess(superAdminId);
  assert(activeRes.reportAllowed && activeRes.mappingAllowed, 'Active super_admin assignment: both readiness reports allowed');
  assert(activeRes.auditVisible > 0, 'Active super_admin assignment: readiness audit log readable');

  // 5b. Revoked assignment: denied.
  const revokedId = await newUser('revoked');
  await grantSuper(revokedId, "now() - interval '2 day'", 'null');
  await db.query("update public.user_role_assignments set revoked_at = now() where profile_id = $1;", [revokedId]);
  const revokedRes = await tryAccess(revokedId);
  assert(!revokedRes.reportAllowed && !revokedRes.mappingAllowed && revokedRes.auditVisible === 0, 'Revoked super_admin assignment is denied (reports + audit log)');

  // 5c. Expired assignment: denied.
  const expiredId = await newUser('expired');
  await grantSuper(expiredId, "now() - interval '3 day'", "now() - interval '1 day'");
  const expiredRes = await tryAccess(expiredId);
  assert(!expiredRes.reportAllowed && !expiredRes.mappingAllowed && expiredRes.auditVisible === 0, 'Expired super_admin assignment is denied (reports + audit log)');

  // 5d. Future-dated assignment: denied.
  const futureId = await newUser('future');
  await grantSuper(futureId, "now() + interval '1 day'", 'null');
  const futureRes = await tryAccess(futureId);
  assert(!futureRes.reportAllowed && !futureRes.mappingAllowed && futureRes.auditVisible === 0, 'Future-dated super_admin assignment is denied (reports + audit log)');

  // 5e. Inactive role definition: denied (temporarily deactivate, then restore).
  const inactiveRoleId = await newUser('inactiverole');
  await grantSuper(inactiveRoleId, "now() - interval '1 day'", 'null');
  await db.query("update public.role_definitions set is_active = false where code = 'super_admin';");
  const inactiveRes = await tryAccess(inactiveRoleId);
  const inactiveActiveHolder = await tryAccess(superAdminId);
  await db.query("update public.role_definitions set is_active = true where code = 'super_admin';");
  assert(!inactiveRes.reportAllowed && !inactiveRes.mappingAllowed && inactiveRes.auditVisible === 0, 'Inactive super_admin role definition is denied (reports + audit log)');
  assert(!inactiveActiveHolder.reportAllowed, 'Inactive super_admin role definition denies even a holder of an otherwise-active assignment');

  // 5f/5g. Pending / rejected profile holding an otherwise-active assignment: denied.
  const pendingId = await newUser('pendingsa');
  await grantSuper(pendingId, "now() - interval '1 day'", 'null');
  await db.query("update public.profiles set status = 'pending' where id = $1;", [pendingId]);
  const pendingRes = await tryAccess(pendingId);
  assert(!pendingRes.reportAllowed && !pendingRes.mappingAllowed && pendingRes.auditVisible === 0, 'Pending profile with an active super_admin assignment is denied');

  const rejectedId = await newUser('rejectedsa');
  await grantSuper(rejectedId, "now() - interval '1 day'", 'null');
  await db.query("update public.profiles set status = 'rejected' where id = $1;", [rejectedId]);
  const rejectedRes = await tryAccess(rejectedId);
  assert(!rejectedRes.reportAllowed && !rejectedRes.mappingAllowed && rejectedRes.auditVisible === 0, 'Rejected profile with an active super_admin assignment is denied');

  // 5h/5i. Legacy ADMIN / MANAGEMENT without a super_admin assignment: denied.
  const legacyAdminNoSuper = await newUser('legacyadmin2', 'ADMIN');
  const adminRes = await tryAccess(legacyAdminNoSuper);
  assert(!adminRes.reportAllowed && !adminRes.mappingAllowed && adminRes.auditVisible === 0, 'Legacy ADMIN profile without an active super_admin assignment is denied');

  const legacyMgmtNoSuper = await newUser('legacymgmt2', 'MANAGEMENT');
  const mgmtRes = await tryAccess(legacyMgmtNoSuper);
  assert(!mgmtRes.reportAllowed && !mgmtRes.mappingAllowed && mgmtRes.auditVisible === 0, 'Legacy MANAGEMENT profile without an active super_admin assignment is denied');

  // 5j. Ordinary operational role (operation_manager, department-scoped): denied.
  const opMgrId = await newUser('opmgr');
  await db.query(
    "insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, starts_at) values ($1, $2, $3, $4, now() - interval '1 day');",
    [opMgrId, opMgrRoleId, myAocId, opsDeptId],
  );
  const opMgrRes = await tryAccess(opMgrId);
  assert(!opMgrRes.reportAllowed && !opMgrRes.mappingAllowed && opMgrRes.auditVisible === 0, 'Ordinary operational role (operation_manager) is denied');

  // 5k. Anonymous caller: denied (reports + audit log).
  await simulateServiceRole();
  await db.exec('set role anon;');
  const anonReport = await expectFail(() => db.query('select public.view_release_readiness_report_secure();'));
  const anonMapping = await expectFail(() => db.query('select * from public.view_legacy_role_mapping_report_secure();'));
  let anonAuditRows = 0;
  const anonAudit = await expectFail(async () => {
    anonAuditRows = (await db.query('select count(*)::int as n from public.phase13_readiness_access_log;')).rows[0].n;
  });
  assert(anonReport.failed && anonMapping.failed, 'Anonymous caller is denied both readiness reports');
  assert(anonAudit.failed || anonAuditRows === 0, 'Anonymous caller can read no readiness audit-log rows');
  await simulateServiceRole();

  // 5l. service_role has no direct execute path to the client-facing wrappers' authorization bypass:
  // with no auth.uid() the canonical check fails, so even service_role cannot read the reports.
  const svcReport = await expectFail(() => db.query('select public.view_release_readiness_report_secure();'));
  const svcInner = await expectFail(() => db.query('select public.get_release_readiness_report_secure();'));
  assert(svcReport.failed && svcInner.failed, 'service_role (no auth.uid()) gets no bypass of the Super Admin authorization');

  // 5m. The authorization is entirely canonical: dropping the legacy
  // profiles.unified_role column (absent on the real staging baseline)
  // must not break either report for an active super_admin.
  await db.exec('reset role;');
  await db.exec('alter table public.profiles drop column if exists unified_role cascade;');
  const noColRes = await tryAccess(superAdminId);
  assert(noColRes.reportAllowed && noColRes.mappingAllowed && noColRes.auditVisible > 0, 'Readiness reports and audit log work for an active super_admin with profiles.unified_role absent');
  const noColDenied = await tryAccess(legacyAdminNoSuper);
  assert(!noColDenied.reportAllowed && !noColDenied.mappingAllowed, 'Legacy ADMIN remains denied with profiles.unified_role absent');

  console.log(`\nPhase 13 integration verification completed. Total failures: ${failures}`);

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
