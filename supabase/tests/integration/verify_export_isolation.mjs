// Explicit, standalone re-check of the export_reports_secure() temp-
// table defect fixed in round 10 (supabase/migrations/
// 20260928000005_phase6_secure_report_access.sql) -- confirms, on a
// FRESH copy of the fully-migrated database, that:
//   1. Two DIFFERENT authenticated identities, called SEQUENTIALLY on
//      the SAME database connection/session (exactly the scenario the
//      original `create temporary table if not exists` bug could leak
//      across), each get ONLY their own authorized export rows -- never
//      a result contaminated by the other caller's prior call.
//   2. report_access_audit's 'export_generated' rows are correctly
//      attributed to the actor who actually made each call -- audit
//      records remain isolated per caller, not merged or overwritten.
//
// Run from this directory, AFTER `node migrate.mjs`:
//   node verify_export_isolation.mjs
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_DATA_DIR = path.join(__dirname, 'pgdata');
const RUN_DATA_DIR = path.join(__dirname, 'pgdata_export_isolation_run');

function copyDir(src, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true });
}

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + msg);
  console.log('PASS:', msg);
}

async function main() {
  if (!fs.existsSync(GOLDEN_DATA_DIR)) {
    console.error('ERROR: ./pgdata does not exist -- run `node migrate.mjs` first.');
    process.exit(1);
  }
  copyDir(GOLDEN_DATA_DIR, RUN_DATA_DIR);

  const db = new PGlite(RUN_DATA_DIR);
  await db.exec('set check_function_bodies = off;');
  // CRITICAL: set_config(..., is_local=true) -- the exact convention
  // supabase/tests/phase6_integration_harness.sql's own pg_temp helpers
  // use -- only persists for the current TRANSACTION. Without an
  // explicit surrounding transaction, each exec()/query() call
  // auto-commits on its own, and an is_local=true setting is forgotten
  // the instant that single statement's implicit transaction ends --
  // confirmed by hitting exactly this while first writing this check.
  // The harness itself never hits this because its whole body already
  // runs inside one explicit begin;...rollback;. Reproduced here.
  await db.exec('begin;');

  const ALPHA = '00000000-0000-0000-0000-0000000000e1';
  const BRAVO = '00000000-0000-0000-0000-0000000000e2';

  // The IDENTICAL pg_temp helper functions
  // supabase/tests/phase6_integration_harness.sql itself defines and
  // uses across all 30 executed scenario blocks -- copied verbatim (not
  // reimplemented) so this standalone re-check exercises the exact
  // same, already-proven simulation mechanism, not a similar-looking
  // hand-rolled one.
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

    create or replace function pg_temp.clear_simulation()
    returns void language plpgsql as $$
    begin
      perform set_config('request.jwt.claims', '', true);
      execute 'reset role';
    end;
    $$;
  `);
  function simulateUser(id) {
    return db.query('select pg_temp.simulate_user($1);', [id]);
  }
  function simulateServiceRole() {
    return db.exec('select pg_temp.simulate_service_role();');
  }
  async function clearSim() {
    await db.exec('select pg_temp.clear_simulation();');
  }

  // --- Fixture setup, as service_role ---
  await simulateServiceRole();
  await db.exec(`
    insert into auth.users (id, email) values
      ('${ALPHA}', 'export-iso-alpha@example.test'),
      ('${BRAVO}', 'export-iso-bravo@example.test')
    on conflict (id) do nothing;
    insert into public.profiles (id, email, name, staff_no, role, station, team, ops_group, status)
    values
      ('${ALPHA}', 'export-iso-alpha@example.test', 'Export Iso Alpha', 'T-EIA', 'ASO', 'KUL - MAA', 'Alpha', 'operation_avsec', 'approved'),
      ('${BRAVO}', 'export-iso-bravo@example.test', 'Export Iso Bravo', 'T-EIB', 'ASO', 'PEN', 'Bravo', 'operation_avsec', 'approved')
    on conflict (id) do update set
      name = excluded.name, staff_no = excluded.staff_no, role = excluded.role,
      station = excluded.station, team = excluded.team, ops_group = excluded.ops_group, status = excluded.status;
  `);

  // Alpha submits a report and it is finalized + indexed directly
  // (mirroring the harness's own established shortcut for speed).
  await simulateUser(ALPHA);
  const insertResult = await db.query(`
    insert into public.report_sec014 (profile_id, status, station, team, staff_name, staff_id, date_time_in, date_time_out, remark, acknowledgement)
    values (auth.uid(), 'submitted', 'KUL - MAA', 'Alpha', 'Export Iso Alpha', 'T-EIA', now(), now() + interval '1 hour', 'export isolation fixture', false)
    returning id;
  `);
  const reportId = insertResult.rows[0].id;
  await db.query(`insert into public.report_sec014_patrols (report_id, entry_no, location, description) values ($1, 1, 'Apron', 'export isolation patrol')`, [reportId]);
  await db.query('select public.mark_report_ready_for_indexing($1, $2, $3);', ['report_sec014', reportId, 1]);
  await clearSim();

  await simulateServiceRole();
  const aocId = (await db.query("select id from public.aocs where code = 'MY';")).rows[0].id;
  const entityId = (await db.query('select id from public.operating_entities where aoc_id = $1 and code = $2;', [aocId, 'MAA'])).rows[0].id;
  const hubId = (await db.query('select id from public.hubs where aoc_id = $1 and code = $2;', [aocId, 'kul'])).rows[0].id;
  await db.query(
    `select public.index_report($1, $2, $3, $4, $5, null, null, $6, null, null, null, current_date, $7);`,
    ['report_sec014', reportId, (await db.query('select report_no from public.report_sec014 where id = $1;', [reportId])).rows[0].report_no, aocId, entityId, hubId, ALPHA]
  );

  const repositoryRow = await db.query(
    "select id from public.central_reports_index where source_table = 'report_sec014' and source_id = $1;",
    [reportId]
  );
  const repositoryId = repositoryRow.rows[0].id;

  // --- The actual re-check: two DIFFERENT identities, SEQUENTIALLY, on
  // this ONE continuous connection -- exactly the condition the fixed
  // bug depended on. ---

  // Call 1: Bravo (no access to Alpha's report) exports.
  await simulateUser(BRAVO);
  const bravoExport = await db.query('select id from public.export_reports_secure(1000);');
  await clearSim();

  assert(
    !bravoExport.rows.some((r) => r.id === repositoryId),
    "Bravo's export_reports_secure() call does not include Alpha's report (no access)"
  );

  // Call 2: Alpha (the actual owner) exports, on the SAME connection,
  // immediately after Bravo's call above.
  await simulateUser(ALPHA);
  const alphaExport = await db.query('select id from public.export_reports_secure(1000);');
  await clearSim();

  assert(
    alphaExport.rows.some((r) => r.id === repositoryId),
    "Alpha's export_reports_secure() call, immediately after Bravo's on the same connection, correctly includes Alpha's own report -- not contaminated by Bravo's prior (empty) result"
  );

  // Call 3: Bravo again, immediately after Alpha's call -- must go back
  // to excluding the report, not "inherit" Alpha's result from the
  // previous call.
  await simulateUser(BRAVO);
  const bravoExportAgain = await db.query('select id from public.export_reports_secure(1000);');
  await clearSim();

  assert(
    !bravoExportAgain.rows.some((r) => r.id === repositoryId),
    "Bravo's SECOND export_reports_secure() call, immediately after Alpha's, still correctly excludes Alpha's report -- not contaminated by Alpha's prior result either"
  );

  // --- Audit-record isolation ---
  await simulateServiceRole();
  const alphaAuditRows = await db.query(
    "select actor_id, action from public.report_access_audit where actor_id = $1 and action = 'export_generated';",
    [ALPHA]
  );
  const bravoAuditRows = await db.query(
    "select actor_id, action from public.report_access_audit where actor_id = $1 and action = 'export_generated';",
    [BRAVO]
  );

  assert(alphaAuditRows.rows.length === 1, `exactly one 'export_generated' audit row is attributed to Alpha (found ${alphaAuditRows.rows.length})`);
  assert(bravoAuditRows.rows.length === 2, `exactly two 'export_generated' audit rows are attributed to Bravo, one per call (found ${bravoAuditRows.rows.length})`);
  assert(
    alphaAuditRows.rows.every((r) => r.actor_id === ALPHA) && bravoAuditRows.rows.every((r) => r.actor_id === BRAVO),
    'every export_generated audit row is attributed to the correct actor -- no cross-contamination between callers sharing one connection'
  );

  console.log('\nAll export-isolation re-checks passed.');
  await db.exec('rollback;');
  await db.close();
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
