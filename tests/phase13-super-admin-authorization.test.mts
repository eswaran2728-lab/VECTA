import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { isReadinessPath, isSuperAdminPathForbidden } from "../lib/supabase/middleware-gate-logic.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");

const PHASE13_MIGRATIONS = [
  "supabase/migrations/20261015000001_phase13_integration_rollout_readiness.sql",
  "supabase/migrations/20261016000001_phase13_storage_and_admin_workflows.sql",
];

// Strip SQL line comments so prose in comments never counts as a dependency.
const stripSqlComments = (sql: string) => sql.replace(/--[^\n]*/g, "");

test("phase13 super-admin: Phase 13 has no unguarded runtime dependency on profiles.unified_role", () => {
  const m1 = stripSqlComments(read(PHASE13_MIGRATIONS[0]));
  assert.ok(!/unified_role/i.test(m1), "readiness migration must not reference unified_role at all");

  // Migration 2 may mention it ONLY inside the corrected compatibility helper,
  // and only behind an information_schema existence check.
  const m2 = stripSqlComments(read(PHASE13_MIGRATIONS[1]));
  const fnStart = m2.indexOf("create or replace function public.apply_compatibility_profile_fields(");
  const fnEnd = m2.indexOf("$function$;", m2.indexOf("as $function$", fnStart));
  assert.ok(fnStart > 0 && fnEnd > fnStart, "corrected compatibility helper must be present");
  const outside = m2.slice(0, fnStart) + m2.slice(fnEnd);
  assert.ok(!/unified_role/i.test(outside), "unified_role may appear only inside the guarded compatibility helper");

  const helper = m2.slice(fnStart, fnEnd);
  const guardIdx = helper.indexOf("column_name = 'unified_role'");
  const writeIdx = helper.indexOf("update public.profiles set unified_role");
  assert.ok(guardIdx > 0 && writeIdx > guardIdx, "the unified_role write must sit behind the information_schema existence check");
  assert.ok(!/set role = v_legacy_role::user_role,\s*unified_role/.test(helper), "the main profile update must not set unified_role directly");
});

test("phase13 super-admin: neither Phase 13 migration assumes a legacy SUPER_ADMIN profile role", () => {
  for (const file of PHASE13_MIGRATIONS) {
    const sql = stripSqlComments(read(file));
    assert.ok(!/'SUPER_ADMIN'/.test(sql), `${file} must not compare against a legacy 'SUPER_ADMIN' profile role`);
    assert.ok(!/p\.role::text\s*=\s*'(ADMIN|MANAGEMENT)'[^\n]*super/i.test(sql), `${file} must not derive Super Admin from legacy ADMIN/MANAGEMENT`);
  }
});

test("phase13 super-admin: every readiness gate uses the canonical has_active_role('super_admin') helper", () => {
  const m1 = stripSqlComments(read(PHASE13_MIGRATIONS[0]));
  const m2 = stripSqlComments(read(PHASE13_MIGRATIONS[1]));
  const count = (s: string) => (s.match(/public\.has_active_role\('super_admin'\)/g) ?? []).length;
  // legacy-mapping report + readiness report + audit-log RLS policy
  assert.equal(count(m1), 3, "migration 1 must gate the mapping report, readiness report and audit-log RLS on has_active_role('super_admin')");
  // redefined readiness report
  assert.equal(count(m2), 1, "migration 2 must gate the redefined readiness report on has_active_role('super_admin')");
});

test("phase13 super-admin: no postgres/service-role/anon bypass inside the readiness authorization", () => {
  const m1 = stripSqlComments(read(PHASE13_MIGRATIONS[0]));
  const m2Full = stripSqlComments(read(PHASE13_MIGRATIONS[1]));
  const start = m2Full.indexOf("create or replace function public.get_release_readiness_report_secure()");
  const end = m2Full.indexOf("$function$;", m2Full.indexOf("as $function$", start));
  assert.ok(start > 0 && end > start, "redefined readiness report must be locatable");
  const readinessBodies = [m1, m2Full.slice(start, end)];
  for (const sql of readinessBodies) {
    assert.ok(!/current_user\s*(=|in)\s*\(?\s*'(postgres|service_role|supabase_admin)'/i.test(sql), "readiness authorization must not special-case postgres/service_role");
    assert.ok(!/auth\.role\(\)\s*=\s*'service_role'/i.test(sql), "readiness authorization must not special-case the service_role JWT claim");
    assert.ok(!/session_user/i.test(sql), "readiness authorization must not special-case session_user");
  }
});

test("phase13 super-admin: client-facing readiness functions keep the audited-wrapper-only grant model", () => {
  const m1 = read(PHASE13_MIGRATIONS[0]);
  assert.match(m1, /revoke execute on function public\.get_release_readiness_report_secure\(\) from public, anon, authenticated;/);
  assert.match(m1, /revoke execute on function public\.get_legacy_role_mapping_report_secure\(\) from public, anon, authenticated;/);
  assert.match(m1, /revoke execute on function public\.view_release_readiness_report_secure\(\) from public, anon;/);
  const m2 = read(PHASE13_MIGRATIONS[1]);
  assert.match(m2, /revoke execute on function public\.get_release_readiness_report_secure\(\) from public, anon, authenticated;/);
});

test("phase13 super-admin: readiness page and server helper use the canonical role-assignment check", () => {
  const page = read("app/super-admin/readiness/page.tsx");
  assert.match(page, /hasActiveSuperAdminRole/);
  assert.ok(!/isSuperAdmin/.test(page), "readiness page must not use the legacy isSuperAdmin() name");

  const authority = read("lib/super-admin/authority.ts");
  const fn = authority.slice(authority.indexOf("export async function hasActiveSuperAdminRole"), authority.indexOf("export async function isProfileActiveSuperAdmin"));
  assert.match(fn, /rpc\("has_active_role", \{ p_role_code: "super_admin" \}\)/);
  assert.ok(!/unified_role|SUPER_ADMIN|from\("profiles"\)/.test(fn), "canonical helper must not read legacy profile columns");
});

test("phase13 super-admin: middleware gates /super-admin/readiness on the canonical RPC before any legacy table lookup", () => {
  const mw = read("lib/supabase/middleware.ts");
  const readinessIdx = mw.indexOf("isReadinessPath(path)");
  const legacyLookupIdx = mw.indexOf('.from("profiles").select("status")');
  assert.ok(readinessIdx > 0 && legacyLookupIdx > 0 && readinessIdx < legacyLookupIdx, "canonical readiness gate must run before the legacy status lookup");
  assert.match(mw, /rpc\("has_active_role", \{ p_role_code: "super_admin" \}\)/);
});

test("phase13 super-admin: isReadinessPath matches only the readiness portal", () => {
  assert.equal(isReadinessPath("/super-admin/readiness"), true);
  assert.equal(isReadinessPath("/super-admin/readiness/"), true);
  assert.equal(isReadinessPath("/super-admin/readiness/detail"), true);
  assert.equal(isReadinessPath("/super-admin"), false);
  assert.equal(isReadinessPath("/super-admin/readiness-other"), false);
  assert.equal(isReadinessPath("/avsec/readiness"), false);
});

test("phase13 super-admin: the legacy path gate is unchanged for other /super-admin routes", () => {
  assert.equal(isSuperAdminPathForbidden("/super-admin", "management"), true);
  assert.equal(isSuperAdminPathForbidden("/super-admin", "super_admin"), false);
});
