import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { PGlite } from "../supabase/tests/integration/node_modules/@electric-sql/pglite/dist/index.js";
import { MIGRATIONS, verifyFrozenFiles } from "../scripts/staging/apply-role-workspace-migrations.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const MIGRATIONS_DIR = path.join(REPO_ROOT, "supabase", "migrations");
const PLATFORM_STUBS = path.join(REPO_ROOT, "supabase", "tests", "integration", "00_platform_stubs.sql");

// Migrations from Phase 1 through Phase 13 to build the exact staging baseline
const BASELINE_CHAIN = [
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
  "20261016000001_phase13_storage_and_admin_workflows.sql",
  "20261020000001_canonical_operations_compatibility.sql",
  "20261021000001_phase9_caterlink_scan_authorization_correction.sql",
  "20261022000001_phase9_caterlink_kch_bki_final_receipt.sql",
  "20261023000001_caterlink_external_account_table.sql",
  "20261024000001_canon_is_active_excludes_caterlink_only.sql",
  "20261025000001_caterlink_external_workflows.sql",
  "20261026000001_storage_upload_policy_repair.sql",
  "20261026000002_signature_read_scoping.sql",
  "20261027000001_station_visibility_requires_approved_profile.sql",
];

test("LOCAL REPRODUCTION: Corrected 12 migrations apply cleanly over exact staging baseline", async () => {
  const tmpDir = path.join(os.tmpdir(), "vecta-recovery-test-" + Date.now());
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

    // Apply baseline migrations up to 20261027000001
    await db.exec(`set role postgres; set request.jwt.claims = '{"role": "service_role"}';`);
    for (const f of BASELINE_CHAIN) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf8")
        .replace(/^\s*create extension if not exists\s+"?(pgcrypto|pg_cron|pg_net)"?/gmi, "-- extension skipped");
      await db.exec(sql);
    }

    // Verify baseline reproduces staging exactly:
    // a. shift_handovers is absent
    const handoversCheck = await db.query("select to_regclass('public.shift_handovers') as r;");
    assert.equal(handoversCheck.rows[0].r, null, "shift_handovers must be absent initially on staging");

    // b. caterlink_station_capabilities has station_id and NOT station_code
    const colCheck = await db.query(`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'caterlink_station_capabilities'
      and column_name in ('station_id', 'station_code');
    `);
    const cols = colCheck.rows.map((r: any) => r.column_name);
    assert.ok(cols.includes("station_id"), "station_id must exist");
    assert.ok(!cols.includes("station_code"), "station_code must not exist on caterlink_station_capabilities");

    // 2. Now apply the 12 frozen migrations
    await db.exec(`
      create schema if not exists supabase_migrations;
      create table if not exists supabase_migrations.schema_migrations (
        version text primary key,
        name text,
        statements text[]
      );
    `);
    const files = verifyFrozenFiles(REPO_ROOT);
    assert.equal(files.length, 12, "exact 12 frozen migrations verified");

    for (const f of files) {
      await db.exec(f.sql);
      await db.exec(`insert into supabase_migrations.schema_migrations (version, name, statements) values ('${f.version}', '${f.name}', array['${f.name}']);`);
    }

    // 3. Post-application verifications:
    // a. shift_handovers exists
    const postHandovers = await db.query("select to_regclass('public.shift_handovers') as r;");
    assert.notEqual(postHandovers.rows[0].r, null, "shift_handovers must exist after 20261102000003");

    // b. trigger enforce_rostered_actor on shift_handovers exists
    const trigCheck = await db.query(`
      select tgname from pg_trigger
      where tgrelid = 'public.shift_handovers'::regclass and tgname = 'trg_enforce_rostered_actor';
    `);
    assert.equal(trigCheck.rows.length, 1, "trg_enforce_rostered_actor must exist on shift_handovers");

    // c. Station capabilities queries joining org_stations work correctly
    const allCaps = (await db.query(`
      select c.id, c.station_id, s.code, c.can_scan, c.can_confirm_hub_receipt, c.can_check_vendor_delivery
      from public.caterlink_station_capabilities c
      left join public.org_stations s on s.id = c.station_id;
    `)).rows as Array<{ code: string; can_scan: boolean; can_confirm_hub_receipt: boolean; can_check_vendor_delivery: boolean }>;

    assert.ok(allCaps.every((c) => c.code !== null), "no orphan capabilities");
    const scanners = allCaps.filter((c) => c.can_scan).map((c) => c.code).sort().join(",");
    assert.equal(scanners, "JHB,PEN", "only JHB and PEN have scanner capability");

    const kch = allCaps.find((c) => c.code === "KCH");
    assert.ok(kch && kch.can_confirm_hub_receipt && !kch.can_scan, "KCH is receipt only");

    const bki = allCaps.find((c) => c.code === "BKI");
    assert.ok(bki && bki.can_confirm_hub_receipt && !bki.can_scan, "BKI is receipt only");

    const btu = allCaps.find((c) => c.code === "BTU");
    assert.equal(btu, undefined, "BTU has no CaterLink capability");

    // d. Hub destinations constraint admitted KCH and BKI
    const defs = ((await db.query(`
      select pg_get_constraintdef(oid) d from pg_constraint
      where conname in ('transactions_hub_destination_check','part_hub_confirmed_destination_check');
    `)).rows as Array<{ d: string }>).map((r) => r.d).join(" ");

    for (const d of ["PEN", "JHB", "NILAI", "KCH", "BKI"]) {
      assert.ok(defs.includes(`'${d}'`), `constraint includes ${d}`);
    }

  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});
