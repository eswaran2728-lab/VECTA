import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { PGlite } from "../supabase/tests/integration/node_modules/@electric-sql/pglite/dist/index.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const MIGRATIONS_DIR = path.join(REPO_ROOT, "supabase", "migrations");
const PLATFORM_STUBS = path.join(REPO_ROOT, "supabase", "tests", "integration", "00_platform_stubs.sql");

const PHASE2_13_CHAIN = [
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
];

const LEGACY_ROLES = ["ASO", "SO", "DSE", "ENFORCEMENT", "MANAGEMENT", "ADMIN"];

const ICMS_USERS_STUB = `
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

const BASELINE_SHIMS: Record<string, string> = {
  "unified_role_model.sql": ICMS_USERS_STUB,
  "team_based_ops_groups.sql": ICMS_USERS_STUB,
  "20260911000001_multi_tenant_scaffolding.sql": ICMS_USERS_STUB,
  "20260911000002_merge_admin_into_management.sql": ICMS_USERS_STUB,
  "20260911000009_purge_legacy_admin_role.sql": ICMS_USERS_STUB,
  "20260923000003_super_admin_privilege_containment.sql": ICMS_USERS_STUB,
  "20260924000001_pre_upgrade_remediation.sql": ICMS_USERS_STUB + PRE_UPGRADE_ICMS_FN_STUBS,
};

test("STAGING-SCHEMA-CLONE: complete validation from legacy staging baseline through Phase 2-13", async (t) => {
  const tmpDir = path.join(os.tmpdir(), "vecta-staging-clone-" + Date.now());
  const db = new PGlite(tmpDir);

  try {
    await db.exec("set check_function_bodies = off;");
    await db.exec(fs.readFileSync(PLATFORM_STUBS, "utf8"));

    // 1. Build legacy staging baseline (all historical migrations applied before Phase 2)
    const avsecDir = path.join(MIGRATIONS_DIR, "avsec");
    const avsecFiles = fs.readdirSync(avsecDir).filter((f) => f.endsWith(".sql")).sort().map((f) => path.join(avsecDir, f));
    const structuralUndated = ["unified_role_model.sql", "team_based_ops_groups.sql"].map((f) => path.join(MIGRATIONS_DIR, f));
    const rootFiles = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"));
    const prePhase2Dated = rootFiles
      .filter((f) => /^\d{14}_/.test(f) && f < "20260928000000" && f !== "20260922000003_unified_avsec_scanning_rls.sql")
      .sort()
      .map((f) => path.join(MIGRATIONS_DIR, f));

    const baselineFiles = [...avsecFiles, ...structuralUndated, ...prePhase2Dated];
    for (const f of baselineFiles) {
      const baseName = path.basename(f);
      if (BASELINE_SHIMS[baseName]) {
        await db.exec(BASELINE_SHIMS[baseName]);
      }
      const sql = fs.readFileSync(f, "utf8")
        .replace(/^\s*create extension if not exists\s+"?(pgcrypto|pg_cron|pg_net)"?/gmi, "-- extension skipped");
      await db.exec(sql);
    }

    // Seed 16 legacy staging profiles and reference stations/teams
    await db.exec(`set role service_role; set request.jwt.claims = '{"role": "service_role"}';`);
    const legacyProfileIds: string[] = [];
    for (let i = 1; i <= 16; i++) {
      const role = LEGACY_ROLES[(i - 1) % LEGACY_ROLES.length];
      const email = `legacy.user${i}@airasia.com`;
      const id = `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`;
      const station = i % 2 === 0 ? "KUL - AAX" : "KUL - MAA";
      legacyProfileIds.push(id);
      await db.query("insert into auth.users (id, email) values ($1, $2);", [id, email]);
      await db.query(
        `insert into public.profiles (id, email, name, staff_no, role, status, station, team)
         values ($1, $2, $3, $4, $5, 'approved', $6, 'Alpha')
         on conflict (id) do update set
           email = excluded.email,
           name = excluded.name,
           staff_no = excluded.staff_no,
           role = excluded.role,
           status = excluded.status,
           station = excluded.station,
           team = excluded.team;`,
        [id, email, `Legacy User ${i}`, `STF${1000 + i}`, role, station]
      );
    }

    // Verify exactly 16 legacy profiles exist before Phase 2-13
    const preCount = await db.query("select count(*) from public.profiles;");
    assert.equal(parseInt(preCount.rows[0].count, 10), 16, "Must start with exactly 16 legacy profiles");

    // 2. Apply proposed Phase 2-13 chain with NO platform stubs concealing migration defects
    await db.exec(`set role postgres; set request.jwt.claims = '{"role": "service_role"}';`);
    for (const migrationFile of PHASE2_13_CHAIN) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, migrationFile), "utf8")
        .replace(/^\s*create extension if not exists\s+"?(pgcrypto|pg_cron|pg_net)"?/gmi, "-- extension skipped");
      try {
        await db.exec(sql);
      } catch (err: any) {
        throw new Error(`Failed applying migration ${migrationFile}: ${err.message}`);
      }
    }

    // 3. Confirm all 16 legacy profiles survive intact with approved status
    const postCount = await db.query("select count(*) from public.profiles;");
    assert.equal(parseInt(postCount.rows[0].count, 10), 16, "All 16 legacy profiles must survive");

    const statusCheck = await db.query("select count(*) from public.profiles where status = 'approved';");
    assert.equal(parseInt(statusCheck.rows[0].count, 10), 16, "All 16 legacy profiles must remain approved");

    for (const id of legacyProfileIds) {
      const p = await db.query("select email, role, status from public.profiles where id = $1;", [id]);
      assert.equal(p.rows.length, 1);
      assert.equal(p.rows[0].status, "approved");
      assert.ok(LEGACY_ROLES.includes(p.rows[0].role));
    }

    // 4. Backfill preflights: verify Phase 2 & Phase 3 seed counts
    const aocsCount = await db.query("select count(*) from public.aocs where code = 'MY';");
    assert.equal(parseInt(aocsCount.rows[0].count, 10), 1, "Malaysia AOC must exist");

    const rolesCount = await db.query("select count(*) from public.role_definitions where is_active = true;");
    assert.equal(parseInt(rolesCount.rows[0].count, 10), 23, "Active role definitions must be exactly 23");

    const deptsCount = await db.query("select count(*) from public.departments;");
    assert.ok(parseInt(deptsCount.rows[0].count, 10) >= 4, "Must have at least 4 departments seeded");

    // 5. Prove Account Provisioning becomes possible
    // A: Look up required foreign IDs
    const myAocId = (await db.query("select id from public.aocs where code = 'MY';")).rows[0].id;
    const maaEntityId = (await db.query("select id from public.operating_entities where code = 'MAA';")).rows[0].id;
    const opDeptId = (await db.query("select id from public.departments where aoc_id = $1 and code = 'operation';", [myAocId])).rows[0].id;
    const kulHubId = (await db.query("select id from public.hubs where aoc_id = $1 and code = 'kul';", [myAocId])).rows[0].id;
    const kulStationId = (await db.query("select id from public.org_stations where hub_id = $1 and code = 'KUL - MAA' limit 1;", [kulHubId])).rows[0].id;
    await db.query("insert into public.org_teams (station_id, name) values ($1, 'Alpha') on conflict (station_id, name) do nothing;", [kulStationId]);
    const kulTeamId = (await db.query("select id from public.org_teams where station_id = $1 and name = 'Alpha';", [kulStationId])).rows[0].id;

    // B: Create an admin profile and assign MAA Admin role
    const adminId = "99999999-9999-9999-9999-999999999999";
    await db.exec(`set role service_role; set request.jwt.claims = '{"role": "service_role"}';`);
    await db.query("insert into auth.users (id, email) values ($1, 'maa.admin@airasia.com');", [adminId]);
    await db.query(
      `insert into public.profiles (id, email, name, staff_no, role, status, station, team)
       values ($1, 'maa.admin@airasia.com', 'MAA Admin', 'ADM001', 'ADMIN', 'approved', 'KUL - MAA', 'Alpha')
       on conflict (id) do update set role = 'ADMIN', status = 'approved';`,
      [adminId]
    );

    const adminMembId = (await db.query(
      "insert into public.user_entity_memberships (profile_id, aoc_id, operating_entity_id, status, is_primary) values ($1, $2, $3, 'active', true) returning id;",
      [adminId, myAocId, maaEntityId]
    )).rows[0].id;

    const maaAdminRoleId = (await db.query("select id from public.role_definitions where code = 'maa_admin';")).rows[0].id;
    await db.query(
      "insert into public.user_role_assignments (profile_id, role_definition_id, aoc_id, operating_entity_id, entity_membership_id) values ($1, $2, $3, $4, null);",
      [adminId, maaAdminRoleId, myAocId, maaEntityId]
    );

    // C: Create an applicant and submit a registration request
    const applicantId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    await db.exec(`set role service_role; set request.jwt.claims = '{"role": "service_role"}';`);
    await db.query("insert into auth.users (id, email) values ($1, 'new.applicant@airasia.com');", [applicantId]);
    await db.query(
      `insert into public.profiles (id, email, name, staff_no, role, status, station, team)
       values ($1, 'new.applicant@airasia.com', 'New Applicant', 'NEW001', 'ASO', 'pending', 'KUL - MAA', 'Alpha')
       on conflict (id) do update set role = 'ASO', status = 'pending';`,
      [applicantId]
    );

    // Simulate applicant session to call submit_registration_request
    await db.exec(`
      set role authenticated;
      set request.jwt.claims = '{"sub": "${applicantId}", "role": "authenticated"}';
    `);

    const submitRes = await db.query(
      "select public.submit_registration_request($1, $2, $3, null, $4, $5, $6, 'aso', 'Seeking ASO position') as req_id;",
      [myAocId, maaEntityId, opDeptId, kulHubId, kulStationId, kulTeamId]
    );
    const requestId = submitRes.rows[0].req_id;
    assert.ok(requestId, "Registration request must return an ID");

    // Verify request in table
    const reqRow = await db.query("select status, requested_role_code from public.user_registration_requests where id = $1;", [requestId]);
    assert.equal(reqRow.rows[0].status, "pending");
    assert.equal(reqRow.rows[0].requested_role_code, "aso");

    // D: Admin approves the request
    await db.exec(`
      set role authenticated;
      set request.jwt.claims = '{"sub": "${adminId}", "role": "authenticated"}';
    `);

    const approveRes = await db.query(
      "select public.approve_registration_request($1, 'aso', $2, $3, $4, null, $5, $6, $7, 'operation_avsec') as assignment_id;",
      [requestId, myAocId, maaEntityId, opDeptId, kulHubId, kulStationId, kulTeamId]
    );
    const assignmentId = approveRes.rows[0].assignment_id;
    assert.ok(assignmentId, "Approval must return an assignment ID");

    // E: Verify approved state across tables (using service_role for full visibility)
    await db.exec(`set role service_role; set request.jwt.claims = '{"role": "service_role"}';`);
    const reqApproved = await db.query("select status, reviewer_id, final_assignment_id from public.user_registration_requests where id = $1;", [requestId]);
    assert.equal(reqApproved.rows[0].status, "approved");
    assert.equal(reqApproved.rows[0].reviewer_id, adminId);
    assert.equal(reqApproved.rows[0].final_assignment_id, assignmentId);

    const assignmentRow = await db.query("select profile_id, aoc_id, operating_entity_id, entity_membership_id from public.user_role_assignments where id = $1;", [assignmentId]);
    assert.equal(assignmentRow.rows[0].profile_id, applicantId);
    assert.equal(assignmentRow.rows[0].aoc_id, myAocId);
    assert.equal(assignmentRow.rows[0].operating_entity_id, null); // ASO is station/team scoped, not airline entity scoped
    assert.ok(assignmentRow.rows[0].entity_membership_id, "Assignment must link to entity membership");

    const membRow = await db.query("select status, is_primary from public.user_entity_memberships where profile_id = $1;", [applicantId]);
    assert.equal(membRow.rows[0].status, "active");
    assert.equal(membRow.rows[0].is_primary, true);

    const applicantProfile = await db.query("select status, role from public.profiles where id = $1;", [applicantId]);
    assert.equal(applicantProfile.rows[0].status, "approved");
    assert.equal(applicantProfile.rows[0].role, "ASO");

    console.log("Staging schema clone validation: complete migration chain, backfill preflight, legacy profile survival, and account provisioning all succeeded!");
  } finally {
    await db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
