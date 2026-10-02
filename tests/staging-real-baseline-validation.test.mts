import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { PGlite } from "../supabase/tests/integration/node_modules/@electric-sql/pglite/dist/index.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const MIGRATIONS_DIR = path.join(REPO_ROOT, "supabase", "migrations");
const PLATFORM_STUBS = path.join(REPO_ROOT, "supabase", "tests", "integration", "00_platform_stubs.sql");

// The chain starting from Phase 1 through Phase 13, including the Phase 8 reconciliation
const FULL_CHAIN = [
  "20260928000000_user_registration_requests.sql",
  "20260928000001_phase2_org_foundation.sql",
  "20260928000002_phase3_role_permission_foundation.sql",
  "20260928000003_phase4_registration_approval_admin.sql",
  "20260928000004_phase5_report_classification_repository.sql",
  "20260928000005_phase6_secure_report_access.sql",
  "20260928000006_phase7_dashboard_aggregates.sql",
  "20260928000007_phase7_closure_dashboards.sql",
  "20260929000001_phase8_absence_prerequisites.sql",
  "20260930000001_phase8_operational_workflows.sql",
  "20261001000001_phase9_caterlink_station_access.sql",
  "20261005000001_phase10_anonymous_discussion_board.sql",
  "20261008000001_phase11_global_malaysia_announcements.sql",
  "20261010000001_phase12_wois_ai_2.sql",
  "20261015000001_phase13_integration_rollout_readiness.sql",
  "20261016000001_phase13_storage_and_admin_workflows.sql"
];

test("REAL-BASELINE-VALIDATION: Phase 1 through 13 with Phase 8 reconciliation applies over clean staging baseline", async () => {
  const tmpDir = path.join(os.tmpdir(), "vecta-real-baseline-" + Date.now());
  const db = new PGlite(tmpDir);

  try {
    await db.exec("set check_function_bodies = off;");
    await db.exec(fs.readFileSync(PLATFORM_STUBS, "utf8"));
    await db.exec(`
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
    `);

    // 1. Build legacy baseline ending strictly at 20260819133729 (matching real staging)
    const avsecDir = path.join(MIGRATIONS_DIR, "avsec");
    const avsecFiles = fs.readdirSync(avsecDir).filter((f) => f.endsWith(".sql")).sort().map((f) => path.join(avsecDir, f));
    const structuralUndated = ["unified_role_model.sql", "team_based_ops_groups.sql"].map((f) => path.join(MIGRATIONS_DIR, f));
    const rootFiles = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"));
    
    // Only migrations up to 20260819133729
    const prePhase2Dated = rootFiles
      .filter((f) => /^\d{14}_/.test(f) && f <= "20260819133729")
      .sort()
      .map((f) => path.join(MIGRATIONS_DIR, f));

    const baselineFiles = [...avsecFiles, ...structuralUndated, ...prePhase2Dated];
    for (const f of baselineFiles) {
      const sql = fs.readFileSync(f, "utf8")
        .replace(/^\s*create extension if not exists\s+"?(pgcrypto|pg_cron|pg_net)"?/gmi, "-- extension skipped");
      await db.exec(sql);
    }

    // Seed 16 legacy profiles (KUL - MAA and KUL - AAX)
    await db.exec(`alter table public.profiles disable trigger profiles_enforce_self_update;`);
    const stations = ["KUL - MAA", "KUL - AAX"];
    const roles = ["ASO", "SO", "DSE", "ENFORCEMENT", "MANAGEMENT", "ADMIN"];
    for (let i = 1; i <= 16; i++) {
      const station = stations[i % 2];
      const role = roles[(i - 1) % roles.length];
      const id = `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`;
      const email = `legacy.user${i}@airasia.com`;
      await db.query("insert into auth.users (id, email) values ($1, $2);", [id, email]);
      await db.query(
        `INSERT INTO public.profiles (id, email, name, staff_no, station, team, role, status)
         VALUES ($1, $2, $3, $4, $5, 'Alpha', $6, 'approved')
         ON CONFLICT (id) DO UPDATE SET
           email = excluded.email,
           name = excluded.name,
           staff_no = excluded.staff_no,
           station = excluded.station,
           team = excluded.team,
           role = excluded.role,
           status = excluded.status;`,
        [id, email, `Test User ${i}`, `STF${1000 + i}`, station, role]
      );
    }

    await db.exec(`alter table public.profiles enable trigger profiles_enforce_self_update;`);
    const preCount = await db.query("SELECT count(*) FROM public.profiles;");
    assert.equal(parseInt(preCount.rows[0].count, 10), 16);

    // 2. Apply all 16 migrations sequentially
    await db.exec(`set role postgres; set request.jwt.claims = '{"role": "service_role"}';`);
    for (const f of FULL_CHAIN) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf8")
        .replace(/^\s*create extension if not exists\s+"?(pgcrypto|pg_cron|pg_net)"?/gmi, "-- extension skipped");

      await db.exec("BEGIN;");
      try {
        await db.exec(sql);
        await db.exec("COMMIT;");
      } catch (err) {
        await db.exec("ROLLBACK;");
        throw new Error(`Migration ${f} failed: ${err.message}`);
      }
    }

    // 3. Post-application verifications
    // Check 16 profiles survived
    const postProfiles = await db.query("SELECT count(*) FROM public.profiles;");
    assert.equal(parseInt(postProfiles.rows[0].count, 10), 16);

    // Check absence_notices exists and has RLS
    const anTable = await db.query("SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'absence_notices';");
    assert.equal(anTable.rows.length, 1);
    assert.equal(anTable.rows[0].relrowsecurity, true);

    // Check Phase 8 tables exist
    for (const tbl of ["duty_draws", "duty_draw_assignments", "investigation_cases", "sat_combined_reports"]) {
      const check = await db.query("SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = $1;", [tbl]);
      assert.equal(check.rows.length, 1, `Expected ${tbl} to exist`);
    }

    // Check Phase 9 tables exist
    for (const tbl of ["caterlink_station_capabilities", "catering_companies", "caterlink_checkpoint_hub"]) {
      const check = await db.query("SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = $1;", [tbl]);
      assert.equal(check.rows.length, 1, `Expected ${tbl} to exist`);
    }

    // Check Phase 10 tables exist
    for (const tbl of ["discussion_threads", "discussion_replies", "discussion_author_mappings"]) {
      const check = await db.query("SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = $1;", [tbl]);
      assert.equal(check.rows.length, 1, `Expected ${tbl} to exist`);
    }

    // Check Phase 11 tables exist
    for (const tbl of ["announcements", "announcement_attachments", "announcement_audit_log"]) {
      const check = await db.query("SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = $1;", [tbl]);
      assert.equal(check.rows.length, 1, `Expected ${tbl} to exist`);
    }

    // Check Phase 12 tables exist
    for (const tbl of ["wois_conversations", "wois_messages", "wois_audit_log"]) {
      const check = await db.query("SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = $1;", [tbl]);
      assert.equal(check.rows.length, 1, `Expected ${tbl} to exist`);
    }

    // Check Phase 13 tables exist
    const p13Check = await db.query("SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'phase13_readiness_access_log';");
    assert.equal(p13Check.rows.length, 1);

    // Check active roles
    const rolesRes = await db.query("SELECT count(*) FROM public.role_definitions WHERE is_active = true;");
    assert.equal(parseInt(rolesRes.rows[0].count, 10), 23);

    // Check trigger profiles_enforce_self_update
    const trigCheck = await db.query("SELECT tgname, tgenabled FROM pg_trigger WHERE tgname = 'profiles_enforce_self_update' AND tgrelid = 'public.profiles'::regclass;");
    assert.equal(trigCheck.rows.length, 1);
    assert.equal(trigCheck.rows[0].tgenabled, "O");

    // Check Storage Buckets
    const bucketsRes = await db.query("SELECT id FROM storage.buckets;");
    const bucketIds = new Set(bucketsRes.rows.map(r => r.id));
    for (const b of ["sat-combined-reports", "caterlink-final-pdfs", "announcement-attachments"]) {
      assert.ok(bucketIds.has(b), `Expected bucket ${b} to exist`);
    }
    assert.ok(!bucketIds.has("announcement-photos"), "Forbidden bucket announcement-photos must not exist");
    assert.ok(!bucketIds.has("caterlink-documents"), "Forbidden bucket caterlink-documents must not exist");

    console.log("Real-baseline validation test passed: all 16 migrations applied cleanly from real baseline through Phase 13!");

  } finally {
    await db.close();
  }
});
