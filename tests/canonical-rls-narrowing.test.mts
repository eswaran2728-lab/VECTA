import test, { mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { isModuleMissing } from "../lib/icms/module-state.ts";
import { assignmentsFromRpcRows, deriveCanonicalAccess, NO_CANONICAL_ACCESS } from "../lib/auth/canonical-access.ts";
import { buildAccountPlan } from "../scripts/staging/lib/team-plan.mjs";

const REPO = path.resolve(import.meta.dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");
const MIG = read("supabase/migrations/20261020000001_canonical_operations_compatibility.sql");
const strip = (s: string) => s.replace(/--[^\n]*/g, "");

mock.module("server-only", { namedExports: {} });
mock.module("next/navigation", { namedExports: { redirect: (u: string) => { throw new Error(`REDIRECT:${u}`); } } });
mock.module("@/lib/supabase/server", { namedExports: { createClient: async () => ({}) } });
const authMod = await import("../lib/avsec/auth.ts");

// ---------------- absent ICMS data modules ----------------
test("missing ICMS tables are recognised and rendered as 'not activated', never as an error or a redirect", () => {
  assert.equal(isModuleMissing({ code: "PGRST205", message: "Could not find the table 'public.incidents' in the schema cache" }), true);
  assert.equal(isModuleMissing({ code: "42P01", message: 'relation "public.users" does not exist' }), true);
  assert.equal(isModuleMissing({ code: "PGRST200", message: "Could not find a relationship between 'incidents' and 'transactions'" }), true);
  assert.equal(isModuleMissing({ code: "42501", message: "permission denied for table incidents" }), false, "a permission error is NOT a missing module");
  assert.equal(isModuleMissing(null), false);
  for (const f of [
    "app/(icms)/icms/incidents/page.tsx", "app/(icms)/icms/vendor-transactions/page.tsx",
    "app/(icms)/icms/admin/audit/page.tsx", "app/(icms)/icms/admin/users/page.tsx",
  ]) {
    const src = read(f);
    assert.match(src, /isModuleMissing\(/, f);
    assert.match(src, /<ModuleNotActivated/, f);
    assert.ok(!/isModuleMissing\([^)]*\)\)\s*\{\s*redirect/.test(src), `${f}: a missing module must not redirect`);
  }
});

// ---------------- migration posture (static) ----------------
test("migration: no blanket policy, no FOR ALL creation, no PUBLIC-role policy created", () => {
  const sql = strip(MIG);
  assert.ok(!/using\s*\(\s*true\s*\)/i.test(sql), "no using (true)");
  assert.ok(!/with\s+check\s*\(\s*true\s*\)/i.test(sql), "no with check (true)");
  assert.ok(!/_authenticated_read/.test(sql), "the blanket safety-net read is gone");
  assert.ok(!/create policy [^;]*\bfor all\b/i.test(sql), "no FOR ALL policy is created");
  assert.ok(!/create policy [^;]* to public\b/i.test(sql), "no policy is created for PUBLIC");
});

test("migration: every client-facing policy it creates is scoped through canonical helpers", () => {
  const sql = strip(MIG);
  const creates = [...sql.matchAll(/create policy (\w+) on (public\.\w+)[\s\S]*?;\n/g)].map((m) => m[0]);
  assert.ok(creates.length > 40);
  for (const c of creates) {
    if (/sec013_profiling_canonical_insert|roster_canonical_scope_select|duty_audit_insert_own|ack_insert_canonical/.test(c)) continue;
    assert.match(c, /canon_|has_active_role|has_role_in_scope|has_any_active|can_manage_roster_secure|can_acknowledge/, `unscoped policy: ${c.slice(0, 90)}`);
  }
  for (const c of creates.filter((x) => /for update/i.test(x))) {
    assert.match(c, /using/i, "UPDATE needs USING");
    assert.match(c, /with check/i, "UPDATE needs WITH CHECK");
  }
});

test("migration: legacy ADMIN / compatibility-rank policies are removed and never re-created", () => {
  const sql = strip(MIG);
  for (const n of ["reference aircraft_types admin write", "duty_zones admin write", "profiles admin manage", "sheet sync config admin all", "roster admin all", "shifts admin write"]) {
    assert.ok(sql.includes(`'${n}'`), `${n} is dropped`);
  }
  const creates = [...sql.matchAll(/create policy [\s\S]*?;\n/g)].map((m) => m[0]);
  for (const c of creates) assert.ok(!/current_role_name|current_role_rank|is_monitor_or_above|is_approved_management|submitter_role_rank|ops_group|'ADMIN'|'MANAGEMENT'/.test(c), `compat dependence in: ${c.slice(0, 80)}`);
  assert.match(sql, /revoke execute on function %s from public, anon, authenticated/);
  assert.match(sql, /revoke select on public\.drivers from authenticated/);
  assert.ok(!/grant select \([^)]*(staff_ic_number|swap_to_staff_ic|airport_pass_number|approved_by)/.test(sql), "no sensitive column is granted");
});

test("migration: security-definer helpers pin search_path, check identity internally and are never granted to anon/PUBLIC", () => {
  const sql = strip(MIG);
  const canon = [...sql.matchAll(/create or replace function public\.(canon_\w+)\([\s\S]*?\$function\$;/g)];
  assert.ok(canon.length >= 12);
  for (const m of canon) {
    if (m[1] === "canon_role_level") continue;
    assert.match(m[0], /security definer/, m[1]);
    assert.match(m[0], /set search_path to 'public'/, m[1]);
    assert.match(m[0], /auth\.uid\(\)|canon_assignments\(\)|canon_my_level\(\)|canon_team_visible|p_profile_id/, `${m[1]} must derive from the caller or an explicit profile`);
  }
  assert.match(sql, /canon_profile_level\(uuid\) from public, anon, authenticated/, "the other-profile level lookup is internal only");
});

test("migration: write grants and anon grants are aligned with policies", () => {
  const sql = strip(MIG);
  assert.match(sql, /revoke all on all tables in schema public from anon/);
  assert.match(sql, /alter default privileges in schema public revoke execute on functions from public/);
  assert.match(sql, /revoke %s on %s from authenticated/);
});

// ---------------- 36 accounts resolve their intended initial workspace ----------------
const row = (code: string, station: string | null) => ({
  role_code: code, role_category: "x", aoc_code: null, operating_entity_code: null, department_code: null,
  unit_code: null, hub_code: null, station_code: station, team_name: station ? "ALPHA" : null,
  starts_at: "2026-01-01T00:00:00Z", ends_at: null,
});

test("all 36 planned accounts resolve their intended initial workspace", () => {
  const plan = buildAccountPlan();
  assert.equal(plan.length, 36);
  for (const a of plan) {
    if (a.positiveOrNegative === "negative") {
      // pending/rejected/deactivated/revoked/expired/future: no active assignment is returned by the RPC
      const access = deriveCanonicalAccess(assignmentsFromRpcRows([]));
      assert.equal(authMod.landingPathForAccess(access), "/avsec/pending-approval", a.label);
      assert.match(a.workspace, /pending-approval/, a.label);
      continue;
    }
    const access = deriveCanonicalAccess(assignmentsFromRpcRows([row(a.roleCode, a.scope.station ?? null)]));
    const landing = authMod.landingPathForAccess(access);
    assert.ok(landing, a.label);
    if (a.roleCode === "super_admin") {
      assert.equal(access.isSuperAdmin, true);
      assert.match(a.workspace, /super-admin/);
    } else {
      const expectedRoot = a.workspace.split(" ")[0];
      assert.equal(landing, expectedRoot, `${a.label}: landing ${landing} vs plan ${a.workspace}`);
    }
  }
});

test("forged compatibility rank / legacy values cannot grant access: access is derived from assignments only", () => {
  assert.equal(deriveCanonicalAccess(assignmentsFromRpcRows([])).hasAssignment, false);
  assert.equal(authMod.landingPathForAccess(NO_CANONICAL_ACCESS), "/avsec/pending-approval");
});
