// Phase 13 correction: CaterLink final-PDF storage, announcement
// attachment storage, and MAA/AAX entity-admin registration workflows.
//
// Run from this directory, AFTER `node migrate.mjs`:
//   node verify_phase13_storage_and_admin.mjs [--native]
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { assertDisposableLocalTarget } from './safeguards.mjs';

const { Client } = pg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_DATA_DIR = path.join(__dirname, 'pgdata');
const RUN_DATA_DIR = path.join(__dirname, 'pgdata_phase13_storage_run');

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
  const runDb = 'vecta_phase13_storage_run';

  let db;
  if (isNative) {
    assertDisposableLocalTarget(pgConfig, goldenDb, runDb);
    console.log(`=== Phase 13 storage/admin verification against Native PostgreSQL (${pgConfig.host}:${pgConfig.port}) ===`);
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
    console.log('=== Phase 13 storage/admin verification against PGlite embedded engine ===');
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

  let seq = 0x200;
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
    "insert into public.aocs (id, code, name, is_active) values ($1, 'P13ZZ', 'P13 Foreign AOC', true) on conflict (code) do update set is_active = true returning id;",
    [nextId()],
  );
  const zzAocId = zzAocRes.rows[0].id;
  const myEntityId = (await db.query("select id from public.operating_entities where aoc_id = $1 and code = 'MAA';", [myAocId])).rows[0].id;
  const aaxEntityId = (await db.query("select id from public.operating_entities where aoc_id = $1 and code = 'AAX';", [myAocId])).rows[0].id;

  const roleRows = (await db.query("select id, code from public.role_definitions;")).rows;
  const roleMap = new Map(roleRows.map((r) => [r.code, r.id]));

  async function createUser(id, email, name, staffNo, legacyRole = 'ASO', status = 'approved') {
    await db.query("insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing;", [id, email]);
    await db.query(
      "insert into public.profiles (id, email, name, staff_no, role, status) values ($1, $2, $3, $4, $5, $6) on conflict (id) do update set email = excluded.email, name = excluded.name, staff_no = excluded.staff_no, role = excluded.role, status = excluded.status;",
      [id, email, name, staffNo, legacyRole, status],
    );
  }
  async function grantMembership(profileId, aocId, entityId) {
    const row = await db.query(
      `insert into public.user_entity_memberships (profile_id, aoc_id, operating_entity_id, status, is_primary) values ($1, $2, $3, 'active', true) returning id;`,
      [profileId, aocId, entityId],
    );
    return row.rows[0].id;
  }

  console.log('\n--- SECTION 1: CaterLink Final PDF Storage ---');

  const myCaterlinkDeptId = (await db.query("select id from public.departments where aoc_id = $1 and code = 'caterlink';", [myAocId])).rows[0].id;
  const zzCaterlinkDeptId = nextId();
  await db.query("insert into public.departments (id, aoc_id, code, name) values ($1, $2, 'caterlink', 'P13 ZZ CaterLink') on conflict do nothing;", [zzCaterlinkDeptId, zzAocId]);

  const caterlinkMgmtId = nextId();
  await createUser(caterlinkMgmtId, 'p13-clmgmt@example.test', 'Chong CaterLink', 'P13-CL');
  await db.query(
    "insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, starts_at) values ($1, $2, $3, $4, now() - interval '1 day');",
    [caterlinkMgmtId, roleMap.get('caterlink_management'), myAocId, myCaterlinkDeptId],
  );

  const ordinaryStaffId = nextId();
  await createUser(ordinaryStaffId, 'p13-ord@example.test', 'Olivia Ordinary', 'P13-OR');

  const zzCaterlinkMgmtId = nextId();
  await createUser(zzCaterlinkMgmtId, 'p13-zzclmgmt@example.test', 'Zed CaterLink', 'P13-ZCL');
  await db.query(
    "insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, starts_at) values ($1, $2, $3, $4, now() - interval '1 day');",
    [zzCaterlinkMgmtId, roleMap.get('caterlink_management'), zzAocId, zzCaterlinkDeptId],
  );

  await simulateUser(caterlinkMgmtId);
  async function registerUsableVehicle(identifier) {
    const res = await db.query(`select id from public.create_caterlink_whitelist_entry_secure(p_entry_type => 'vehicle', p_aoc_id => $1, p_identifier => $2);`, [myAocId, identifier]);
    await db.query("select * from public.approve_caterlink_whitelist_entry_secure('vehicle', $1);", [res.rows[0].id]);
    return res.rows[0].id;
  }
  async function registerUsableDriver(identifier, name = 'Fixture Driver') {
    const res = await db.query(`select id from public.create_caterlink_whitelist_entry_secure(p_entry_type => 'driver', p_aoc_id => $1, p_name => $2, p_identifier => $3);`, [myAocId, name, identifier]);
    await db.query("select * from public.approve_caterlink_whitelist_entry_secure('driver', $1);", [res.rows[0].id]);
    return res.rows[0].id;
  }
  const vehicleId = await registerUsableVehicle('P13-V001');
  const driverId = await registerUsableDriver('P13-D001');

  await simulateServiceRole();
  const txId = nextId();
  await db.query(`
    insert into public.transactions (
      id, transaction_number, aoc_id, direction, vehicle_number, driver_name, driver_id,
      vehicle_id, driver_id_ref, status, created_by
    ) values ($1, 'P13-CL-TX-001', $2, 'OUTBOUND', 'P13-V001', 'Fixture Driver', 'P13-D001', $3, $4, 'COMPLETED', $5);
  `, [txId, myAocId, vehicleId, driverId, caterlinkMgmtId]);

  const incompleteTxId = nextId();
  await db.query(`
    insert into public.transactions (
      id, transaction_number, aoc_id, direction, vehicle_number, driver_name, driver_id,
      vehicle_id, driver_id_ref, status, created_by
    ) values ($1, 'P13-CL-TX-002', $2, 'OUTBOUND', 'P13-V001', 'Fixture Driver', 'P13-D001', $3, $4, 'CREATED', $5);
  `, [incompleteTxId, myAocId, vehicleId, driverId, caterlinkMgmtId]);

  // Ordinary staff cannot generate a PDF.
  await simulateUser(ordinaryStaffId);
  const staffGenerateDenied = await expectFail(() => db.query(
    "select * from public.record_caterlink_transaction_pdf_secure($1, 'fake/path.pdf', 'hash1', 1000, 'application/pdf');",
    [txId],
  ));
  assert(staffGenerateDenied.failed, 'Ordinary staff cannot generate a CaterLink final PDF (CaterLink Management only)');

  // Incomplete transaction cannot get a PDF generated.
  await simulateUser(caterlinkMgmtId);
  const incompleteGenerateDenied = await expectFail(() => db.query(
    "select * from public.record_caterlink_transaction_pdf_secure($1, 'fake/path.pdf', 'hash1', 1000, 'application/pdf');",
    [incompleteTxId],
  ));
  assert(incompleteGenerateDenied.failed, 'A final PDF cannot be generated for a non-COMPLETED transaction');

  // CaterLink Management generates version 1.
  const gen1 = (await db.query(
    "select * from public.record_caterlink_transaction_pdf_secure($1, $2, 'hash-v1', 50000, 'application/pdf');",
    [txId, `${txId}/hash-v1.pdf`],
  )).rows[0];
  assert(gen1.version === 1 && gen1.is_new === true, 'First PDF generation creates version 1');

  // Idempotent: identical content hash returns the SAME row, not a new version.
  const gen1Again = (await db.query(
    "select * from public.record_caterlink_transaction_pdf_secure($1, $2, 'hash-v1', 50000, 'application/pdf');",
    [txId, `${txId}/hash-v1.pdf`],
  )).rows[0];
  assert(gen1Again.is_new === false && gen1Again.id === gen1.id, 'Identical-content regeneration is idempotent -- no duplicate version created');

  // New content supersedes, never overwrites, the prior version.
  const gen2 = (await db.query(
    "select * from public.record_caterlink_transaction_pdf_secure($1, $2, 'hash-v2', 51000, 'application/pdf');",
    [txId, `${txId}/hash-v2.pdf`],
  )).rows[0];
  assert(gen2.version === 2 && gen2.is_new === true, 'New content creates version 2, superseding version 1');

  await simulateServiceRole();
  const historyRows = (await db.query('select version, is_current from public.caterlink_transaction_pdfs where transaction_id = $1 order by version;', [txId])).rows;
  await simulateUser(caterlinkMgmtId);
  assert(historyRows.length === 2, 'Both versions remain in history -- nothing was deleted');
  assert(historyRows[0].is_current === false && historyRows[1].is_current === true, 'Only the newest version is marked current; the prior version is preserved but superseded');

  // Download authorization: CaterLink Management, submitter, destination
  // officer, Operation Manager all authorized; foreign AOC and ordinary
  // staff denied.
  await simulateUser(caterlinkMgmtId);
  const mgmtDownload = (await db.query('select * from public.get_caterlink_transaction_pdf_secure($1);', [txId])).rows[0];
  assert(mgmtDownload.storage_path === `${txId}/hash-v2.pdf` && mgmtDownload.version === 2, 'CaterLink Management downloads the CURRENT version, not a stale one');

  await simulateUser(ordinaryStaffId);
  const staffDownloadDenied = await expectFail(() => db.query('select * from public.get_caterlink_transaction_pdf_secure($1);', [txId]));
  assert(staffDownloadDenied.failed, 'An unrelated ordinary staff member cannot download the final PDF');

  await simulateUser(zzCaterlinkMgmtId);
  const foreignDownloadDenied = await expectFail(() => db.query('select * from public.get_caterlink_transaction_pdf_secure($1);', [txId]));
  assert(foreignDownloadDenied.failed, 'Foreign-AOC CaterLink Management cannot download a Malaysia transaction\'s final PDF');

  // The historical fabricated-path bug is fixed: authorize_caterlink_pdf_secure
  // now returns the REAL recorded path, not a coalesce-to-fake-string.
  await simulateUser(caterlinkMgmtId);
  const authRow = (await db.query('select * from public.authorize_caterlink_pdf_secure($1);', [txId])).rows[0];
  assert(authRow.pdf_storage_path === `${txId}/hash-v2.pdf`, 'authorize_caterlink_pdf_secure returns the REAL current storage path, never a fabricated default');

  // No real PDF yet for a different COMPLETED transaction -> null, not a fake path.
  await simulateServiceRole();
  const noPdfTxId = nextId();
  await db.query(`
    insert into public.transactions (
      id, transaction_number, aoc_id, direction, vehicle_number, driver_name, driver_id,
      vehicle_id, driver_id_ref, status, created_by
    ) values ($1, 'P13-CL-TX-003', $2, 'OUTBOUND', 'P13-V001', 'Fixture Driver', 'P13-D001', $3, $4, 'COMPLETED', $5);
  `, [noPdfTxId, myAocId, vehicleId, driverId, caterlinkMgmtId]);
  await simulateUser(caterlinkMgmtId);
  const noPdfAuthRow = (await db.query('select * from public.authorize_caterlink_pdf_secure($1);', [noPdfTxId])).rows[0];
  assert(noPdfAuthRow.pdf_storage_path === null, 'A COMPLETED transaction with no PDF generated yet returns null, never an invented path');

  console.log('\n--- SECTION 2: Announcement Attachment Storage ---');

  await simulateServiceRole();
  const ghodId = nextId();
  await createUser(ghodId, 'p13-ghod@example.test', 'Grace GHOD', 'P13-GH');
  await db.query("insert into public.user_role_assignments (profile_id, role_definition_id, starts_at) values ($1, $2, now() - interval '1 day');", [ghodId, roleMap.get('ghod')]);

  const maaBossId = nextId();
  await createUser(maaBossId, 'p13-maaboss@example.test', 'Badrul MAABoss', 'P13-MB');
  await db.query(
    "insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, operating_entity_id, starts_at) values ($1, $2, $3, $4, now() - interval '1 day');",
    [maaBossId, roleMap.get('maa_boss'), myAocId, myEntityId],
  );

  const myStaffId = nextId();
  await createUser(myStaffId, 'p13-mystaff@example.test', 'Siti Staff', 'P13-S1');
  const myStaffMem = await grantMembership(myStaffId, myAocId, myEntityId);
  const myDeptId = (await db.query("select id from public.departments where aoc_id = $1 and code = 'operation';", [myAocId])).rows[0].id;
  const kulStationId = (await db.query("select id from public.org_stations where code = 'KUL - MAA';")).rows[0].id;
  const kulHubId = (await db.query('select hub_id from public.org_stations where id = $1;', [kulStationId])).rows[0].hub_id;
  const kulTeamId = (await db.query(`insert into public.org_teams (station_id, name) values ($1, 'P13Team') on conflict (station_id, name) do update set name = excluded.name returning id;`, [kulStationId])).rows[0].id;
  await db.query(
    "insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, department_id, hub_id, station_id, team_id, entity_membership_id, starts_at) values ($1, $2, $3, $4, $5, $6, $7, $8, now() - interval '1 day');",
    [myStaffId, roleMap.get('aso'), myAocId, myDeptId, kulHubId, kulStationId, kulTeamId, myStaffMem],
  );

  await simulateUser(maaBossId);
  const draftAnnId = (await db.query("select public.create_announcement_secure('Draft Ann', 'Body', 'aoc', $1, 'operational', 'normal', 'draft') as id;", [myAocId])).rows[0].id;
  const attRes = await db.query(
    "select public.add_announcement_attachment_secure($1, $2, 'file.pdf', 1000, 'application/pdf') as id;",
    [draftAnnId, `${draftAnnId}/abc-file.pdf`],
  );
  const attId = attRes.rows[0].id;
  assert(Boolean(attId), 'Authorized draft owner can attach a file to a draft announcement');

  // Ordinary recipient cannot download a draft attachment.
  await simulateUser(myStaffId);
  const draftDownloadDenied = await expectFail(() => db.query('select * from public.get_announcement_attachment_download_secure($1);', [attId]));
  assert(draftDownloadDenied.failed, 'Draft attachment download is denied to an ordinary recipient before publication');

  // Publish it, then the recipient CAN download.
  await simulateUser(maaBossId);
  await db.query('select public.publish_announcement_secure($1);', [draftAnnId]);
  await simulateUser(myStaffId);
  const publishedDownload = (await db.query('select * from public.get_announcement_attachment_download_secure($1);', [attId])).rows[0];
  assert(publishedDownload.storage_path === `${draftAnnId}/abc-file.pdf`, 'After publication, an eligible Malaysia recipient can resolve the real attachment path for signing');

  // GHOD (no Malaysia AOC assignment in this fixture) cannot see a Malaysia AOC attachment.
  await simulateUser(ghodId);
  const ghodCrossScopeDenied = await expectFail(() => db.query('select * from public.get_announcement_attachment_download_secure($1);', [attId]));
  assert(ghodCrossScopeDenied.failed, 'GHOD (Global-only) cannot download a Malaysia AOC announcement\'s attachment');

  // Archive it; attachment removal becomes immutable.
  await simulateUser(maaBossId);
  await db.query("select public.archive_announcement_secure($1, 'retention');", [draftAnnId]);
  const archivedRemoveDenied = await expectFail(() => db.query('select public.remove_announcement_attachment_secure($1);', [attId]));
  assert(archivedRemoveDenied.failed, 'Attachment removal is denied once the announcement is archived (immutability)');

  // Attachment remains downloadable from the archive.
  const archivedDownload = (await db.query('select * from public.get_announcement_attachment_download_secure($1);', [attId])).rows[0];
  assert(Boolean(archivedDownload), 'An archived announcement\'s attachment remains downloadable (archive-read, not delete)');

  // Draft removal still works while still a draft.
  const draftAnnId2 = (await db.query("select public.create_announcement_secure('Draft Ann 2', 'Body', 'aoc', $1, 'operational', 'normal', 'draft') as id;", [myAocId])).rows[0].id;
  const attRes2 = await db.query(
    "select public.add_announcement_attachment_secure($1, $2, 'file2.pdf', 1000, 'application/pdf') as id;",
    [draftAnnId2, `${draftAnnId2}/xyz-file2.pdf`],
  );
  const removedPath = (await db.query('select public.remove_announcement_attachment_secure($1) as path;', [attRes2.rows[0].id])).rows[0].path;
  assert(removedPath === `${draftAnnId2}/xyz-file2.pdf`, 'Removing a draft attachment succeeds and returns its real storage path for the caller to delete the object');

  console.log('\n--- SECTION 3: MAA/AAX Entity-Admin Registration ---');

  await simulateServiceRole();
  const maaAdminId = nextId();
  await createUser(maaAdminId, 'p13-maaadmin@example.test', 'Aisha MAAAdmin', 'P13-MA');
  await db.query(
    "insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, operating_entity_id, starts_at) values ($1, $2, $3, $4, now() - interval '1 day');",
    [maaAdminId, roleMap.get('maa_admin'), myAocId, myEntityId],
  );

  const aaxAdminId = nextId();
  await createUser(aaxAdminId, 'p13-aaxadmin@example.test', 'Chong AAXAdmin', 'P13-XA');
  await db.query(
    "insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, operating_entity_id, starts_at) values ($1, $2, $3, $4, now() - interval '1 day');",
    [aaxAdminId, roleMap.get('aax_admin'), myAocId, aaxEntityId],
  );

  const pendingMaaId = nextId();
  await createUser(pendingMaaId, 'p13-pendmaa@example.test', 'Pending MAA Applicant', 'P13-PM', 'ASO', 'pending');
  await db.query(
    "insert into public.user_registration_requests (id, profile_id, requested_aoc_id, requested_operating_entity_id, requested_role_code, status) values ($1, $2, $3, $4, 'aso', 'pending');",
    [nextId(), pendingMaaId, myAocId, myEntityId],
  );

  const pendingAaxId = nextId();
  await createUser(pendingAaxId, 'p13-pendaax@example.test', 'Pending AAX Applicant', 'P13-PA', 'ASO', 'pending');
  const pendingAaxReqId = nextId();
  await db.query(
    "insert into public.user_registration_requests (id, profile_id, requested_aoc_id, requested_operating_entity_id, requested_role_code, status) values ($1, $2, $3, $4, 'aso', 'pending');",
    [pendingAaxReqId, pendingAaxId, myAocId, aaxEntityId],
  );

  // Ordinary staff cannot list any entity registration requests at all.
  await simulateUser(myStaffId);
  const staffListDenied = await expectFail(() => db.query('select * from public.list_entity_registration_requests_secure();'));
  assert(staffListDenied.failed, 'An ordinary staff member cannot list entity registration requests');

  // MAA Admin sees only the MAA-requested registration.
  await simulateUser(maaAdminId);
  const maaList = (await db.query('select * from public.list_entity_registration_requests_secure();')).rows;
  assert(maaList.some((r) => r.profile_id === pendingMaaId), 'MAA Admin sees the MAA-requested registration');
  assert(!maaList.some((r) => r.profile_id === pendingAaxId), 'MAA Admin does NOT see the AAX-requested registration (cross-entity isolation)');

  // AAX Admin sees only the AAX-requested registration.
  await simulateUser(aaxAdminId);
  const aaxList = (await db.query('select * from public.list_entity_registration_requests_secure();')).rows;
  assert(aaxList.some((r) => r.profile_id === pendingAaxId), 'AAX Admin sees the AAX-requested registration');
  assert(!aaxList.some((r) => r.profile_id === pendingMaaId), 'AAX Admin does NOT see the MAA-requested registration (cross-entity isolation)');

  // Cross-entity approval attempt fails: MAA Admin cannot approve the AAX request.
  await simulateUser(maaAdminId);
  const crossEntityApproveDenied = await expectFail(() => db.query(
    "select public.approve_registration_request($1, 'aso', $2, $3, null, null, null, $4, $5);",
    [pendingAaxReqId, myAocId, aaxEntityId, kulStationId, kulTeamId],
  ));
  assert(crossEntityApproveDenied.failed, 'MAA Admin cannot approve an AAX-entity registration request (cross-entity denial)');

  // Cross-AOC approval attempt fails: MAA Admin cannot approve into a foreign AOC.
  const crossAocApproveDenied = await expectFail(() => db.query(
    "select public.approve_registration_request($1, 'aso', $2, $3, null, null, null, $4, $5);",
    [pendingMaaId, zzAocId, myEntityId, kulStationId, kulTeamId],
  ));
  assert(crossAocApproveDenied.failed, 'An entity Admin cannot approve a registration into a foreign AOC');

  // Protected role cannot be granted through this path.
  const protectedRoleDenied = await expectFail(() => db.query(
    "select public.approve_registration_request($1, 'caterlink_management', $2, $3, null, null, null, $4, $5);",
    [pendingMaaId, myAocId, myEntityId, kulStationId, kulTeamId],
  ));
  assert(protectedRoleDenied.failed, 'A protected role (e.g. caterlink_management) cannot be granted through entity-admin approval');

  // Resolver RPC used by the UI action: resolves a code to the real id.
  const resolvedId = (await db.query("select public.resolve_operating_entity_id_secure('MAA') as id;")).rows[0].id;
  assert(resolvedId === myEntityId, 'resolve_operating_entity_id_secure resolves the MAA code to the real entity id');

  console.log('\n--- SECTION 4: Readiness Report Truthfulness ---');

  await simulateServiceRole();
  const superAdminId = nextId();
  await createUser(superAdminId, 'p13b-super@example.test', 'Sam SuperAdmin2', 'P13B-SA');
  // Canonical Super Admin: an active Phase 3 super_admin role assignment
  // (no scope, no entity membership), never a legacy profile column.
  await db.query(
    "insert into public.user_role_assignments (profile_id, role_definition_id, starts_at) values ($1, (select id from public.role_definitions where code = 'super_admin'), now() - interval '1 day');",
    [superAdminId],
  );

  await simulateUser(superAdminId);
  const readiness = (await db.query('select public.view_release_readiness_report_secure() as report;')).rows[0].report;
  assert(readiness.caterlink_final_pdf_storage_implemented === true, 'Readiness report truthfully reports the CaterLink PDF storage path as implemented (it now is)');
  assert(readiness.announcement_attachment_storage_implemented === true, 'Readiness report truthfully reports the announcement attachment storage path as implemented (it now is)');
  assert(readiness.maa_aax_entity_admin_registration_route_implemented === true, 'Readiness report truthfully reports the MAA/AAX entity-admin route as implemented');
  assert(readiness.real_managed_storage_certified === false, 'Readiness report never claims real managed Storage is certified from a local report');
  // The specific true/false value of the gate depends on fixtures created
  // by OTHER test files sharing this golden database snapshot (see
  // verify_phase13_integration.mjs, which deliberately creates an
  // unreplaced legacy profile and asserts this field is true there) --
  // this file only proves the field is present and boolean-typed.
  assert(typeof readiness.legacy_retirement_gate_blocked === 'boolean', 'Readiness report includes the legacy-retirement gate boolean');

  console.log(`\nPhase 13 storage/admin verification completed. Total failures: ${failures}`);

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
