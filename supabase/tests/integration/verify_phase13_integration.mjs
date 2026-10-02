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
  // profiles.role is a Postgres enum that never gained a 'SUPER_ADMIN'
  // value -- real Super Admin accounts are 'ADMIN' (a valid enum value)
  // plus unified_role = 'super_admin' (lib/super-admin/actions.ts:isSuperAdmin
  // checks exactly this OR), so the test fixture must match that, not an
  // enum value that was never actually added.
  await createUser(superAdminId, 'p13-super@example.test', 'Sam SuperAdmin', 'P13-SA', 'ADMIN');
  await db.query("update public.profiles set unified_role = 'super_admin' where id = $1;", [superAdminId]);

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
