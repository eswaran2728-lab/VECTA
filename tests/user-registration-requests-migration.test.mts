import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { PGlite } from "../supabase/tests/integration/node_modules/@electric-sql/pglite/dist/index.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const MIGRATIONS_DIR = path.join(REPO_ROOT, "supabase", "migrations");
const MIGRATION_FILE = path.join(MIGRATIONS_DIR, "20260928000000_user_registration_requests.sql");
const PLATFORM_STUBS = path.join(REPO_ROOT, "supabase", "tests", "integration", "00_platform_stubs.sql");

const migrationSql = fs.readFileSync(MIGRATION_FILE, "utf8");

test("MIGRATION: 20260928000000_user_registration_requests applies cleanly to empty PostgreSQL", async () => {
  const tmpDir = path.join(os.tmpdir(), "vecta-test-empty-" + Date.now());
  const db = new PGlite(tmpDir);
  try {
    await db.exec(migrationSql);
    const tables = await db.query(
      "select table_name from information_schema.tables where table_schema = 'public' and table_name = 'user_registration_requests';"
    );
    assert.equal(tables.rows.length, 1);

    const cols = await db.query(
      "select column_name from information_schema.columns where table_schema = 'public' and table_name = 'user_registration_requests';"
    );
    const colNames = new Set(cols.rows.map((r: any) => r.column_name));
    for (const expected of [
      "id", "profile_id", "requested_aoc_id", "requested_operating_entity_id",
      "requested_department_id", "requested_unit_id", "requested_hub_id",
      "requested_station_id", "requested_team_id", "requested_role_code",
      "applicant_notes", "status", "reviewer_id", "reviewed_at",
      "rejection_reason", "final_assignment_id", "submitted_at", "updated_at"
    ]) {
      assert.ok(colNames.has(expected), `Missing column ${expected}`);
    }
  } finally {
    await db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("MIGRATION: retry and idempotency -- applying twice produces no error", async () => {
  const tmpDir = path.join(os.tmpdir(), "vecta-test-idempotent-" + Date.now());
  const db = new PGlite(tmpDir);
  try {
    await db.exec(migrationSql);
    await db.exec(migrationSql); // second execution must succeed identically
    const res = await db.query("select count(*) from public.user_registration_requests;");
    assert.equal(res.rows[0].count, 0);
  } finally {
    await db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("MIGRATION: applies over legacy staging-equivalent schema and creates profile FK", async () => {
  const tmpDir = path.join(os.tmpdir(), "vecta-test-legacy-" + Date.now());
  const db = new PGlite(tmpDir);
  try {
    // Bootstrap platform stubs + legacy profiles table
    await db.exec(fs.readFileSync(PLATFORM_STUBS, "utf8"));
    await db.exec(`
      create table public.profiles (
        id uuid primary key default gen_random_uuid(),
        email text not null unique,
        name text,
        role text not null default 'ASO',
        status text not null default 'approved',
        created_at timestamptz default now()
      );
    `);

    // Apply reconciliation migration
    await db.exec(migrationSql);

    // Verify profile FK constraint was established
    const fkCheck = await db.query(`
      select conname from pg_constraint
      where conname = 'user_registration_requests_profile_id_fkey'
        and conrelid = 'public.user_registration_requests'::regclass;
    `);
    assert.equal(fkCheck.rows.length, 1);

    // Insert profile and request to confirm relationship
    const profileId = "11111111-1111-1111-1111-111111111111";
    await db.query("insert into public.profiles (id, email, name) values ($1, 'test@example.com', 'Test User');", [profileId]);
    await db.query(
      "insert into public.user_registration_requests (profile_id, requested_role_code, status) values ($1, 'aso', 'pending');",
      [profileId]
    );

    const count = await db.query("select count(*) from public.user_registration_requests;");
    assert.equal(count.rows[0].count, 1);

    // Verify cascade delete
    await db.query("delete from public.profiles where id = $1;", [profileId]);
    const afterDelete = await db.query("select count(*) from public.user_registration_requests;");
    assert.equal(afterDelete.rows[0].count, 0);
  } finally {
    await db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("MIGRATION: Phase 2-3 applied state creates assignment FK and enforces self-write triggers", async () => {
  const tmpDir = path.join(os.tmpdir(), "vecta-test-phase23-" + Date.now());
  const db = new PGlite(tmpDir);
  try {
    await db.exec("set check_function_bodies = off;");
    await db.exec(fs.readFileSync(PLATFORM_STUBS, "utf8"));

    // Legacy profiles
    await db.exec(`
      create table public.profiles (
        id uuid primary key default gen_random_uuid(),
        email text not null unique,
        name text,
        staff_no text not null default '12345',
        station text not null default 'KUL',
        team text not null default 'Alpha',
        role text not null default 'ASO',
        status text not null default 'approved',
        created_at timestamptz default now()
      );
      create table if not exists public.users (id uuid primary key default gen_random_uuid());
    `);

    // Apply Phase 2 and Phase 3
    const phase2Sql = fs.readFileSync(path.join(MIGRATIONS_DIR, "20260928000001_phase2_org_foundation.sql"), "utf8");
    const phase3Sql = fs.readFileSync(path.join(MIGRATIONS_DIR, "20260928000002_phase3_role_permission_foundation.sql"), "utf8");
    await db.exec(phase2Sql);
    await db.exec(phase3Sql);

    // Now apply reconciliation migration
    await db.exec(migrationSql);

    // Verify both FKs exist
    const fks = await db.query(`
      select conname from pg_constraint
      where conrelid = 'public.user_registration_requests'::regclass
        and conname in ('user_registration_requests_profile_id_fkey', 'user_registration_requests_final_assignment_id_fkey');
    `);
    assert.equal(fks.rows.length, 2);

    // Test self-write trigger enforcement:
    const profileId = "22222222-2222-2222-2222-222222222222";
    await db.query("insert into public.profiles (id, email, name) values ($1, 'applicant@example.com', 'Applicant');", [profileId]);
    const reqRes = await db.query(
      "insert into public.user_registration_requests (profile_id, requested_role_code, applicant_notes) values ($1, 'aso', 'Initial notes') returning id;",
      [profileId]
    );
    const reqId = reqRes.rows[0].id;

    // Add policies allowing row selection and updates so the trigger enforcement is tested directly
    await db.exec('create policy "test_select" on public.user_registration_requests for select using (true);');
    await db.exec('create policy "test_update" on public.user_registration_requests for update using (true) with check (true);');

    // Simulate non-service-role caller
    await db.exec(`set role authenticated; set request.jwt.claims = '{"role": "authenticated"}';`);

    // Allowed: updating applicant_notes while pending
    await db.query("update public.user_registration_requests set applicant_notes = 'Updated notes' where id = $1;", [reqId]);
    await db.exec(`set role service_role; set request.jwt.claims = '{"role": "service_role"}';`);
    const updated = await db.query("select applicant_notes from public.user_registration_requests where id = $1;", [reqId]);
    assert.equal(updated.rows[0].applicant_notes, "Updated notes");

    // Blocked: unauthorized status transition from pending to approved
    await db.exec(`set role authenticated; set request.jwt.claims = '{"role": "authenticated"}';`);
    await assert.rejects(async () => {
      await db.query("update public.user_registration_requests set status = 'approved' where id = $1;", [reqId]);
    }, /Administrative and review fields on user_registration_requests can only be updated/);
  } finally {
    await db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("MIGRATION: documented rollback executes cleanly", async () => {
  const tmpDir = path.join(os.tmpdir(), "vecta-test-rollback-" + Date.now());
  const db = new PGlite(tmpDir);
  try {
    await db.exec(migrationSql);

    // Extract rollback statements from the bottom of the file
    const rollbackSection = migrationSql.match(/DOCUMENTED ROLLBACK[\s\S]*$/);
    assert.ok(rollbackSection);
    const rollbackStatements = rollbackSection[0]
      .split("\n")
      .map((l) => l.replace(/^--\s*/, "").trim())
      .filter((l) => l.startsWith("drop "));

    for (const stmt of rollbackStatements) {
      await db.exec(stmt);
    }

    const check = await db.query(
      "select table_name from information_schema.tables where table_schema = 'public' and table_name = 'user_registration_requests';"
    );
    assert.equal(check.rows.length, 0);
  } finally {
    await db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
