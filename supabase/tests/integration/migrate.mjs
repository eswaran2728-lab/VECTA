// Phase 6 database-integration validation: applies the REAL migration
// chain (avsec/0001-0026, structural undated migrations, every dated
// root migration through Phase 6) to a disposable PGlite instance and
// prints a manifest classifying every file as:
//   unchanged        -- applied byte-for-byte as written, no adaptation
//   adapted           -- applied with a documented platform-compatibility
//                        shim (see ADAPTATIONS below) -- the migration's
//                        OWN SQL is still unmodified; only prerequisite
//                        objects for an out-of-scope module were added
//                        immediately before it
//   partially-skipped -- one or more individual statements inside an
//                        otherwise-applied file were skipped (currently
//                        none -- kept for transparency if this ever
//                        recurs)
//   excluded          -- never attempted at all (see EXCLUDED below)
//
// Run from this directory:
//   npm install
//   node migrate.mjs
//
// See README.md for full setup/run instructions and the manifest
// legend.
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { assertDisposableLocalTarget } from './safeguards.mjs';

const { Client } = pg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');
const DATA_DIR = path.join(__dirname, 'pgdata');

// =========================================================================
// ORDERING
// =========================================================================
// avsec/0001-0026 (the full AVSEC baseline), then the two structural
// undated migrations at their correct chronological position (commit
// date 2026-08-19, confirmed via `git log`, before every dated 202609*
// file), then every dated 202609*.sql root migration in timestamp
// order through Phase 6.
const avsecDir = path.join(MIGRATIONS_DIR, 'avsec');
const avsecFiles = fs.readdirSync(avsecDir).filter((f) => f.endsWith('.sql')).sort().map((f) => path.join(avsecDir, f));

const structuralUndated = ['unified_role_model.sql', 'team_based_ops_groups.sql'].map((f) => path.join(MIGRATIONS_DIR, f));

const rootFiles = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));

// EXCLUDED: never attempted. Each entry names the file and the reason,
// grouped by category. Nothing here touches Phase 6's own dependency
// chain -- confirmed by inspection (grep for profiles/report_sec*/
// offload_records/central_reports_index/report_index_queue) before
// exclusion, not assumed.
const EXCLUDED = {
  'icms module (separate application, entire supabase/migrations/icms/ directory)': ['(all files under migrations/icms/, not iterated at all)'],
  'ICMS-only despite dated filename/range (confirmed by inspection: touches only part_a/b/c/d/redq/hub RLS, zero AVSEC report-schema objects)': [
    '20260922000003_unified_avsec_scanning_rls.sql',
  ],
  'one-off data/demo/backfill scripts against specific real accounts or ICMS legacy data -- not schema-dependency migrations, and unsafe/meaningless against synthetic fixtures': [
    'provision_hub_avsec_team.sql',
    'create_icms_duty_post_demo_accounts.sql',
    'seed_all_rosters_and_checkin_today.sql',
    'backfill_icms_shadow_users.sql',
    'migrate_icms_real_users.sql',
    'full_account_wipe_and_fresh_roster.sql',
    'consolidate_checkpoint_demos_and_give_ifc_hub_checkin.sql',
    'grant_icms_access_to_admin_enforcement.sql',
    'management_icms_parity.sql',
    'reset_roster_hierarchy.sql',
    'fix_demo_ifc_missing_ops_group.sql',
    'apply_all_pending_migrations.sql',
  ],
  'ICMS/duty-checkpoint RLS fixups and duty-checkin field additions -- Phase 6 schema and this harness\'s fixtures never reference any object these touch': [
    'fix_aso_so_dse_transactions_read_rls.sql',
    'fix_ops_staff_checkpoint_insert_rls.sql',
    'add_duty_early_checkin_late_checkout_fields.sql',
    'add_duty_manual_zone_selection_fields.sql',
  ],
};
const excludedBasenames = new Set(Object.values(EXCLUDED).flat().filter((f) => f.endsWith('.sql')));

const dated = rootFiles.filter((f) => /^\d{14}_/.test(f) && !excludedBasenames.has(f)).sort().map((f) => path.join(MIGRATIONS_DIR, f));

const ORDER = [...avsecFiles, ...structuralUndated, ...dated];

// =========================================================================
// ADAPTATIONS: every file applied with a documented platform-
// compatibility shim, or with an extension-availability line stripped.
// The migration's OWN SQL text is applied unmodified in every case --
// these only ADD prerequisite objects immediately before it, or remove
// a `create extension` line PGlite cannot satisfy (gen_random_uuid() is
// Postgres core since v13, so pgcrypto is not actually needed; cron./
// net. schema functions are stubbed in 00_platform_stubs.sql).
//
// IMPORTANT: no adaptation here stubs, replaces, or weakens any
// authorization or application function UNDER TEST. Every shim below is
// either (a) a placeholder for an out-of-scope ICMS table/function a
// handful of AVSEC-crossover migrations touch incidentally, (b) a
// reconstructed baseline table Phase 4 depends on but that no migration
// in this repository's history actually creates (evidence below), or
// (c) an unavailable-extension line strip. Phase 6's own functions,
// triggers, RLS policies, and grants are never adapted -- they run as
// the real, unmodified migration SQL, which is the entire point of this
// validation.
const ICMS_USERS_STUB = `
  -- ICMS out-of-scope placeholder: this AVSEC-crossover migration also
  -- touches ICMS's public.users table, which does not exist in this
  -- AVSEC/Phase-6-scoped database (the full ICMS schema is a separate
  -- application, intentionally excluded -- see EXCLUDED above). This
  -- minimal, empty stub -- with the specific columns/constraints these
  -- crossover migrations reference, documented in
  -- 20260924000001_pre_upgrade_remediation.sql's own comment
  -- (information_schema.columns, confirmed live 2026-09-24: id, name,
  -- staff_id, email, role, created_at, preferred_language, status,
  -- unified_role, duty_post, ops_group, org_id -- 12 total) -- lets each
  -- file's ICMS-side statements execute unmodified (affecting zero
  -- rows, since the stub starts empty) without pulling in ICMS's entire
  -- real schema.
  create table if not exists public.users (id uuid primary key default gen_random_uuid());
  alter table public.users add column if not exists role text;
  alter table public.users add column if not exists status text;
  do $$ begin
    alter table public.users add constraint users_status_check check (status = any (array['pending', 'active', 'rejected']));
  exception when duplicate_object then null;
  end $$;
  alter table public.users add column if not exists name text;
  alter table public.users add column if not exists staff_id text;
  alter table public.users add column if not exists email text;
  alter table public.users add column if not exists created_at timestamptz default now();
  alter table public.users add column if not exists preferred_language text;
  alter table public.users add column if not exists unified_role text;
  alter table public.users add column if not exists duty_post text;
  alter table public.users add column if not exists ops_group text;
  alter table public.users add column if not exists org_id uuid;
`;

// FINDING (baseline gap, not a Phase 6 defect, not fixed by editing
// Phase 4's migration): public.user_registration_requests is referenced
// throughout 20260928000003_phase4_registration_approval_admin.sql
// (insert/select/update, including a `select * into v_request from ...
// for update`, which needs a real table) but is never created by ANY
// `create table` statement anywhere in this repository's migration
// history -- confirmed by grepping every file, including every excluded
// one. Consistent with the same undocumented-schema-change pattern this
// repo's own unified_role_model.sql header comment discloses for a
// different object (applied directly against the production project via
// the Supabase dashboard/MCP tool, never captured in a versioned
// migration). Reconstructed here from every column Phase 4 itself
// reads/writes, as a baseline prerequisite table -- the same way
// organizations/aocs are themselves baseline tables seeded by Phase 2.
const USER_REGISTRATION_REQUESTS_STUB = `
  create table if not exists public.user_registration_requests (
    id uuid primary key default gen_random_uuid(),
    profile_id uuid not null,
    requested_aoc_id uuid,
    requested_operating_entity_id uuid,
    requested_department_id uuid,
    requested_unit_id uuid,
    requested_hub_id uuid,
    requested_station_id uuid,
    requested_team_id uuid,
    requested_role_code text,
    applicant_notes text,
    status text not null default 'pending',
    rejection_reason text,
    submitted_at timestamptz not null default now(),
    reviewed_at timestamptz,
    reviewer_id uuid,
    final_assignment_id uuid
  );
  alter table public.user_registration_requests enable row level security;
`;

// FINDING (round 10, unrelated to Phase 4): several ICMS-only trigger
// functions (incidents/vendor-transactions/seals) are REVOKEd/GRANTed
// by 20260924000001_pre_upgrade_remediation.sql's security-hardening
// pass but were never created in this AVSEC/Phase-6-scoped database.
// No-op stubs let those specific REVOKE/GRANT statements execute
// unmodified; none of these functions are ever called by anything
// Phase 6 exercises.
const PRE_UPGRADE_ICMS_FN_STUBS = `
  create or replace function public.escalate_timeouts() returns void language sql as $body$ select 1 $body$;
  create or replace function public.log_audit_admin() returns trigger language plpgsql as $body$ begin return new; end; $body$;
  create or replace function public.notify_supervisors_on_incident() returns trigger language plpgsql as $body$ begin return new; end; $body$;
  create or replace function public.next_vendor_transaction_number() returns text language sql as $body$ select ''::text $body$;
  create or replace function public.enforce_seal_color() returns trigger language plpgsql as $body$ begin return new; end; $body$;
  create or replace function public.guard_incident_update() returns trigger language plpgsql as $body$ begin return new; end; $body$;
  create or replace function public.guard_part_update() returns trigger language plpgsql as $body$ begin return new; end; $body$;
  create or replace function public.set_vendor_transaction_number() returns trigger language plpgsql as $body$ begin return new; end; $body$;
`;

const PRE_SHIMS = {
  'unified_role_model.sql': ICMS_USERS_STUB,
  'team_based_ops_groups.sql': ICMS_USERS_STUB,
  '20260911000002_merge_admin_into_management.sql': ICMS_USERS_STUB,
  '20260911000009_purge_legacy_admin_role.sql': ICMS_USERS_STUB,
  '20260923000003_super_admin_privilege_containment.sql': ICMS_USERS_STUB,
  '20260924000001_pre_upgrade_remediation.sql': ICMS_USERS_STUB + PRE_UPGRADE_ICMS_FN_STUBS,
  '20260928000001_phase2_org_foundation.sql': ICMS_USERS_STUB,
  // Note: 20260928000003_phase4_registration_approval_admin.sql no longer needs
  // USER_REGISTRATION_REQUESTS_STUB -- 20260928000000_user_registration_requests.sql
  // is now a real versioned forward migration applied earlier in the chain.
};
// Note: 20260911000001_multi_tenant_scaffolding.sql no longer needs a
// SUPER_ADMIN pre-shim -- the enum-comparison bug it depended on
// working around was FIXED IN THE MIGRATION ITSELF (round 11): `role =
// 'SUPER_ADMIN'` -> `role::text = 'SUPER_ADMIN'`, matching the safe
// pattern every other migration already uses. See the migration file's
// own CORRECTION comment for the full evidence trail. That file still
// needs the ICMS_USERS_STUB (it also touches public.users), so it is
// listed below.
PRE_SHIMS['20260911000001_multi_tenant_scaffolding.sql'] = ICMS_USERS_STUB;

// Lines referencing extensions unavailable in PGlite. gen_random_uuid()
// is Postgres core since v13 (pgcrypto not actually needed); cron./net.
// schema functions are stubbed in 00_platform_stubs.sql.
function stripUnsupportedExtensions(sql, fileLabel, log) {
  return sql
    .split('\n')
    .map((line) => {
      if (/^\s*create extension if not exists\s+"?(pgcrypto|pg_cron|pg_net)"?/i.test(line)) {
        log.push(`  [${fileLabel}] stripped line (extension unavailable in PGlite): ${line.trim()}`);
        return `-- STRIPPED (extension unavailable in PGlite): ${line.trim()}`;
      }
      return line;
    })
    .join('\n');
}

// SKIP_STATEMENTS: individual statements skipped inside an otherwise-
// applied file. Currently EMPTY -- the one statement that was ever
// skipped here (20260928000001_phase2_org_foundation.sql's
// v_phase2_backfill_coverage view, missing its FROM clause) was FIXED
// IN THE MIGRATION ITSELF in round 11 (see that file's own CORRECTION
// comment) and no longer needs skipping. This mechanism is kept, empty,
// for transparency in case a future migration ever needs it again.
const SKIP_STATEMENTS = {};

function applyStatementSkips(sql, fileLabel, log) {
  const skips = SKIP_STATEMENTS[fileLabel] || [];
  for (const stmt of skips) {
    if (sql.includes(stmt)) {
      log.push(`  [${fileLabel}] skipped statement: ${stmt.split('\n')[0]}...`);
      sql = sql.replace(stmt, `-- SKIPPED (see migrate.mjs SKIP_STATEMENTS): ${stmt.split('\n')[0]}...`);
    }
  }
  return sql;
}

async function main() {
  const isNative = process.argv.includes('--native') || process.env.PG_NATIVE === '1';
  const pgConfig = {
    host: process.env.PGHOST || '127.0.0.1',
    port: parseInt(process.env.PGPORT || '55433', 10),
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || undefined,
  };
  const targetDbName = process.env.PGDATABASE || 'vecta_phase6_test';

  let db;
  let progressFile;
  let fresh;

  if (isNative) {
    assertDisposableLocalTarget(pgConfig, targetDbName);
    console.log(`=== Target: Native PostgreSQL (${pgConfig.host}:${pgConfig.port}, database: ${targetDbName}) ===`);
    const adminClient = new Client({ ...pgConfig, database: 'postgres' });
    await adminClient.connect();
    await adminClient.query(`
      select pg_terminate_backend(pid) from pg_stat_activity
      where datname = '${targetDbName}' and pid <> pg_backend_pid();
    `);
    await adminClient.query(`drop database if exists ${targetDbName};`);
    await adminClient.query(`create database ${targetDbName};`);
    await adminClient.end();

    const client = new Client({ ...pgConfig, database: targetDbName });
    await client.connect();

    db = {
      exec: (sql) => client.query(sql),
      query: (sql, params) => client.query(sql, params),
      close: () => client.end(),
    };
    progressFile = path.join(__dirname, 'progress_native.json');
    if (fs.existsSync(progressFile)) fs.unlinkSync(progressFile);
    fresh = true;
  } else {
    console.log('=== Target: PGlite embedded engine ===');
    fresh = !fs.existsSync(DATA_DIR);
    const pgliteDb = new PGlite(DATA_DIR);
    db = {
      exec: (sql) => pgliteDb.exec(sql),
      query: (sql, params) => pgliteDb.query(sql, params),
      close: () => pgliteDb.close(),
    };
    progressFile = path.join(__dirname, 'progress.json');
  }

  const manifest = [];
  const adaptationLog = [];

  // 20260911000001_multi_tenant_scaffolding.sql defines a SQL-language
  // function (current_org_id()) referencing a column (org_id) added to
  // its target tables LATER in the same file, inside a subsequent DO
  // block. Postgres's default eager function-body validation
  // (check_function_bodies = on) rejects that at CREATE FUNCTION time
  // even though it is fully valid by the time the function is ever
  // CALLED. This is a standard, well-known migration-tooling
  // accommodation (not a relaxation of anything Phase 6 itself does) --
  // it changes nothing about runtime behavior, only when column
  // references inside a function body are checked.
  await db.exec('set check_function_bodies = off;');

  if (fresh) {
    console.log('=== Bootstrapping platform stubs (00_platform_stubs.sql) ===');
    await db.exec(fs.readFileSync(path.join(__dirname, '00_platform_stubs.sql'), 'utf8'));
    console.log('OK\n');
  } else {
    console.log('=== Reusing existing database (already bootstrapped) ===\n');
  }

  const done = fs.existsSync(progressFile) ? JSON.parse(fs.readFileSync(progressFile, 'utf8')) : [];
  const doneSet = new Set(done.map((d) => d.file));

  for (const file of ORDER) {
    const label = path.relative(MIGRATIONS_DIR, file).replace(/\\/g, '/');
    if (doneSet.has(label)) {
      manifest.push(done.find((d) => d.file === label));
      continue;
    }
    let sql = fs.readFileSync(file, 'utf8');
    const before = adaptationLog.length;
    sql = stripUnsupportedExtensions(sql, label, adaptationLog);
    sql = applyStatementSkips(sql, label, adaptationLog);
    const baseName = path.basename(file);
    const hadPreShim = Boolean(PRE_SHIMS[baseName]);
    const hadStrip = adaptationLog.length > before;

    try {
      if (hadPreShim) {
        await db.exec(PRE_SHIMS[baseName]);
        adaptationLog.push(`  [${label}] pre-shim applied (see migrate.mjs PRE_SHIMS)`);
      }
      await db.exec(sql);
      const category = hadPreShim || hadStrip ? 'adapted' : 'unchanged';
      const entry = { file: label, status: 'OK', category };
      manifest.push(entry);
      done.push(entry);
      fs.writeFileSync(progressFile, JSON.stringify(done, null, 2));
    } catch (e) {
      const entry = { file: label, status: 'FAILED', category: 'failed', error: e.message };
      manifest.push(entry);
      console.log(`\n=== STOPPING at ${label} ===`);
      console.log('ERROR:', e.message);
      break;
    }
  }

  console.log('\n=== MIGRATION MANIFEST ===');
  for (const m of manifest) {
    const tag = { unchanged: 'UNCHANGED', adapted: 'ADAPTED  ', failed: 'FAILED   ', 'already-applied': m.category === 'adapted' ? 'ADAPTED  ' : 'UNCHANGED' }[m.category] || m.category;
    console.log(`${tag}  ${m.file}${m.error ? '  -- ' + m.error : ''}`);
  }
  console.log(`\nApplied: ${manifest.filter((m) => m.status === 'OK').length}, Failed: ${manifest.filter((m) => m.status === 'FAILED').length}`);
  console.log(`Unchanged: ${manifest.filter((m) => m.category === 'unchanged').length}, Adapted: ${manifest.filter((m) => m.category === 'adapted').length}`);

  if (adaptationLog.length) {
    console.log('\n=== ADAPTATION DETAIL ===');
    adaptationLog.forEach((l) => console.log(l));
  }

  console.log('\n=== EXCLUDED (never attempted) ===');
  for (const [reason, files] of Object.entries(EXCLUDED)) {
    console.log(`  ${reason}:`);
    files.forEach((f) => console.log(`    - ${f}`));
  }

  await db.close();
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
