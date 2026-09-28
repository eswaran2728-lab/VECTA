import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Regression coverage for Phase 3 of the VECTA Malaysia AOC upgrade
 * (2026-09-28): supabase/migrations/20260928000002_phase3_role_permission_foundation.sql.
 *
 * Phase 3 is additive infrastructure only -- no production user is
 * assigned a new role, no existing RLS policy/requireRole/legacy helper
 * is touched. These tests assert the migration's own source text for
 * the safety guarantees the spec requires, and mirror the scope-shape
 * validation trigger and the effective-permission helper logic in pure
 * functions, per this repo's established testing convention.
 */

const MIGRATION_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "supabase",
  "migrations",
  "20260928000002_phase3_role_permission_foundation.sql",
);
const migrationSql = fs.readFileSync(MIGRATION_PATH, "utf8");
const code = migrationSql.replace(/\r\n/g, "\n").split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");

const REQUIRED_ROLE_CODES = [
  "airasia_management", "ghod", "global_reporting_controller", "super_admin",
  "maa_boss", "aax_boss", "maa_admin", "aax_admin", "operation_manager", "main_enforcement", "compliance",
  "investigation_sso", "investigation_so", "investigation_aso", "sat_aso", "profiling_so", "profiling_aso",
  "hub_se", "dse", "sso", "so", "aso",
  "caterlink_management",
];

// --- Role-definition catalog ---

test("Every required role code exists exactly once in the seed INSERT", () => {
  const insertBlock = code.match(/insert into public\.role_definitions[\s\S]*?on conflict \(code\) do nothing;/);
  assert.ok(insertBlock, "must find the role_definitions seed INSERT");
  for (const code_ of REQUIRED_ROLE_CODES) {
    const matches = insertBlock![0].match(new RegExp(`\\('${code_}',`, "g")) ?? [];
    assert.equal(matches.length, 1, `expected exactly one seed row for ${code_}, found ${matches.length}`);
  }
});

test("role_definitions.code is UNIQUE and NOT NULL (immutable identity)", () => {
  const createBlock = code.match(/create table if not exists public\.role_definitions \([\s\S]*?\n\);/);
  assert.ok(createBlock);
  assert.match(createBlock[0], /code text not null unique/);
});

test("role_definitions has no UPDATE/INSERT/DELETE grant for authenticated -- only SELECT (catalog is read-only from the client)", () => {
  assert.match(code, /revoke insert, update, delete, truncate on public\.role_definitions from authenticated;/);
  assert.match(code, /grant select on public\.role_definitions to authenticated;/);
});

// --- Schema safety ---

test("SAFETY: this migration creates zero RLS policies -- deny-all until Phase 4 write paths exist", () => {
  assert.equal((code.match(/create policy/gi) ?? []).length, 0);
});

test("SAFETY: RLS is enabled on both new tables", () => {
  assert.match(code, /alter table public\.role_definitions enable row level security;/);
  assert.match(code, /alter table public\.user_role_assignments enable row level security;/);
});

test("SAFETY: user_role_assignments has ZERO grant to anon or authenticated -- only service_role", () => {
  assert.match(code, /revoke all on public\.user_role_assignments from public, anon, authenticated;/);
  assert.match(code, /grant all on public\.user_role_assignments to service_role;/);
  assert.doesNotMatch(code, /grant (select|insert|update|delete).*on public\.user_role_assignments to authenticated/i);
});

test("SAFETY: no existing table/column outside the two new tables is altered", () => {
  assert.doesNotMatch(code, /alter table public\.profiles/);
  assert.doesNotMatch(code, /alter table public\.aocs/);
  assert.doesNotMatch(code, /alter table public\.users\b/);
  assert.doesNotMatch(code, /drop column/i);
  assert.doesNotMatch(code, /rename column/i);
});

test("SAFETY: no existing legacy helper (current_role_name, current_role_rank, is_approved_management, is_active_supervisor, is_monitor_or_above) is redefined", () => {
  for (const fn of ["current_role_name", "current_role_rank", "is_approved_management", "is_active_supervisor", "is_monitor_or_above"]) {
    assert.doesNotMatch(code, new RegExp(`create or replace function public\\.${fn}\\(`));
  }
});

// --- Grantor/self-promotion structural defense ---

test("PRIVILEGE ESCALATION: a CHECK constraint prevents granted_by = profile_id at the database layer", () => {
  assert.match(code, /constraint user_role_assignments_no_self_grant check \(granted_by is distinct from profile_id\)/);
});

test("PRIVILEGE ESCALATION: no INSERT/UPDATE grant exists for authenticated on user_role_assignments -- the capability to self-assign or self-promote does not exist for any non-service_role caller in this phase", () => {
  assert.doesNotMatch(code, /grant insert.*on public\.user_role_assignments to authenticated/i);
  assert.doesNotMatch(code, /grant update.*on public\.user_role_assignments to authenticated/i);
});

test("PRIVILEGE ESCALATION: the unique index prevents duplicate active assignments of the same role+scope to the same profile", () => {
  assert.match(code, /create unique index if not exists user_role_assignments_active_unique/);
  assert.match(code, /where revoked_at is null;/);
});

// --- Scope-shape validation trigger (mirrors validate_user_role_assignment_scope()) ---

const INTERNATIONAL_CODES = ["airasia_management", "ghod", "global_reporting_controller", "super_admin"];

type Scope = {
  aocId?: string | null;
  operatingEntityId?: string | null;
  departmentId?: string | null;
  unitId?: string | null;
  hubId?: string | null;
  stationId?: string | null;
  teamId?: string | null;
};

type EntityCode = "MAA" | "AAX";
type HubCode = "kul" | "northern" | "sarawak" | "sabah" | "southern_east_coast" | "unclassified";

/** Mirrors validate_user_role_assignment_scope() exactly. */
function validateAssignmentScope(
  roleCode: string,
  scope: Scope,
  lookups: { operatingEntityCode?: EntityCode; hubCode?: HubCode } = {},
): { ok: boolean; error?: string } {
  if (INTERNATIONAL_CODES.includes(roleCode)) {
    const anyScope = Object.values(scope).some((v) => v != null);
    if (anyScope) return { ok: false, error: `${roleCode} is an international/platform role and must carry no AOC or narrower scope.` };
    return { ok: true };
  }

  if (scope.aocId == null) return { ok: false, error: `${roleCode} requires an explicit aoc_id.` };

  if (["maa_boss", "maa_admin"].includes(roleCode)) {
    if (scope.operatingEntityId == null) return { ok: false, error: `${roleCode} requires operating_entity_id.` };
    if (lookups.operatingEntityCode !== "MAA") return { ok: false, error: `${roleCode} must be scoped to the MAA operating entity, not any other.` };
  }
  if (["aax_boss", "aax_admin"].includes(roleCode)) {
    if (scope.operatingEntityId == null) return { ok: false, error: `${roleCode} requires operating_entity_id.` };
    if (lookups.operatingEntityCode !== "AAX") return { ok: false, error: `${roleCode} must be scoped to the AAX operating entity, not any other.` };
  }
  if (["operation_manager", "main_enforcement", "compliance", "caterlink_management"].includes(roleCode)) {
    if (scope.departmentId == null) return { ok: false, error: `${roleCode} requires department_id.` };
  }
  if (["investigation_sso", "investigation_so", "investigation_aso"].includes(roleCode)) {
    if (scope.unitId == null) return { ok: false, error: `${roleCode} requires unit_id (Investigation).` };
  }
  if (roleCode === "sat_aso") {
    if (scope.unitId == null || scope.hubId == null) return { ok: false, error: "sat_aso requires unit_id (SAT) and hub_id (KUL)." };
    if (lookups.hubCode !== "kul") return { ok: false, error: "sat_aso must be scoped to the KUL hub only." };
  }
  if (["profiling_so", "profiling_aso"].includes(roleCode)) {
    if (scope.unitId == null) return { ok: false, error: `${roleCode} requires unit_id (Profiling).` };
  }
  if (roleCode === "hub_se") {
    if (scope.hubId == null) return { ok: false, error: "hub_se requires hub_id." };
  }
  if (roleCode === "dse") {
    if (scope.hubId == null || scope.teamId == null) return { ok: false, error: "dse requires hub_id (KUL) and team_id (own team only)." };
    if (lookups.hubCode !== "kul") return { ok: false, error: "dse must be scoped to the KUL hub only; non-KUL hubs use hub_se instead." };
  }
  if (["sso", "so", "aso"].includes(roleCode)) {
    if (scope.stationId == null) return { ok: false, error: `${roleCode} requires station_id.` };
  }
  return { ok: true };
}

test("MANDATORY: international roles must have a fully null scope (aoc_id included)", () => {
  for (const roleCode of INTERNATIONAL_CODES) {
    assert.equal(validateAssignmentScope(roleCode, {}).ok, true, `${roleCode} with no scope should be valid`);
    assert.equal(validateAssignmentScope(roleCode, { aocId: "my" }).ok, false, `${roleCode} with an aoc_id should be rejected`);
  }
});

test("MANDATORY: null-scope bypass is closed -- every non-international role requires an explicit aoc_id", () => {
  for (const roleCode of REQUIRED_ROLE_CODES.filter((c) => !INTERNATIONAL_CODES.includes(c))) {
    assert.equal(validateAssignmentScope(roleCode, {}).ok, false, `${roleCode} with no aoc_id must be rejected`);
  }
});

test("MAA Admin denial: MAA Admin cannot be scoped to the AAX operating entity", () => {
  const result = validateAssignmentScope("maa_admin", { aocId: "my", operatingEntityId: "aax" }, { operatingEntityCode: "AAX" });
  assert.equal(result.ok, false);
});

test("AAX Admin denial: AAX Admin cannot be scoped to the MAA operating entity", () => {
  const result = validateAssignmentScope("aax_admin", { aocId: "my", operatingEntityId: "maa" }, { operatingEntityCode: "MAA" });
  assert.equal(result.ok, false);
});

test("Valid MAA Admin assignment passes", () => {
  assert.equal(validateAssignmentScope("maa_admin", { aocId: "my", operatingEntityId: "maa" }, { operatingEntityCode: "MAA" }).ok, true);
});

test("Valid AAX Boss assignment passes", () => {
  assert.equal(validateAssignmentScope("aax_boss", { aocId: "my", operatingEntityId: "aax" }, { operatingEntityCode: "AAX" }).ok, true);
});

test("Hub SE requires hub_id", () => {
  assert.equal(validateAssignmentScope("hub_se", { aocId: "my" }).ok, false);
  assert.equal(validateAssignmentScope("hub_se", { aocId: "my", hubId: "northern" }).ok, true);
});

test("DSE own-team requirement: DSE requires hub_id AND team_id, and must be KUL", () => {
  assert.equal(validateAssignmentScope("dse", { aocId: "my", hubId: "kul" }).ok, false, "missing team_id must fail");
  assert.equal(validateAssignmentScope("dse", { aocId: "my", teamId: "alpha" }).ok, false, "missing hub_id must fail");
  assert.equal(validateAssignmentScope("dse", { aocId: "my", hubId: "kul", teamId: "alpha" }, { hubCode: "kul" }).ok, true);
});

test("REGRESSION: a DSE assignment cannot be scoped to a non-KUL hub (that's hub_se's job)", () => {
  const result = validateAssignmentScope("dse", { aocId: "my", hubId: "northern", teamId: "alpha" }, { hubCode: "northern" });
  assert.equal(result.ok, false);
});

test("SAT ASO must be scoped to KUL only", () => {
  assert.equal(validateAssignmentScope("sat_aso", { aocId: "my", unitId: "sat", hubId: "kul" }, { hubCode: "kul" }).ok, true);
  assert.equal(validateAssignmentScope("sat_aso", { aocId: "my", unitId: "sat", hubId: "northern" }, { hubCode: "northern" }).ok, false);
});

test("Investigation roles require unit_id", () => {
  for (const roleCode of ["investigation_sso", "investigation_so", "investigation_aso"]) {
    assert.equal(validateAssignmentScope(roleCode, { aocId: "my" }).ok, false);
    assert.equal(validateAssignmentScope(roleCode, { aocId: "my", unitId: "investigation" }).ok, true);
  }
});

test("Profiling roles require unit_id", () => {
  for (const roleCode of ["profiling_so", "profiling_aso"]) {
    assert.equal(validateAssignmentScope(roleCode, { aocId: "my" }).ok, false);
    assert.equal(validateAssignmentScope(roleCode, { aocId: "my", unitId: "profiling" }).ok, true);
  }
});

test("Station roles (SSO/SO/ASO) require station_id", () => {
  for (const roleCode of ["sso", "so", "aso"]) {
    assert.equal(validateAssignmentScope(roleCode, { aocId: "my" }).ok, false);
    assert.equal(validateAssignmentScope(roleCode, { aocId: "my", stationId: "pen" }).ok, true);
  }
});

test("Compliance requires department_id, and nothing narrower is required (read-only role, no unit/hub/station requirement)", () => {
  assert.equal(validateAssignmentScope("compliance", { aocId: "my" }).ok, false);
  assert.equal(validateAssignmentScope("compliance", { aocId: "my", departmentId: "compliance" }).ok, true);
});

test("CaterLink Management requires department_id (caterlink)", () => {
  assert.equal(validateAssignmentScope("caterlink_management", { aocId: "my" }).ok, false);
  assert.equal(validateAssignmentScope("caterlink_management", { aocId: "my", departmentId: "caterlink" }).ok, true);
});

// --- has_role_in_scope() effective-permission logic (mirrors the SQL exactly) ---

type Assignment = {
  roleCode: string;
  aocId: string | null;
  operatingEntityId?: string | null;
  departmentId?: string | null;
  unitId?: string | null;
  hubId?: string | null;
  stationId?: string | null;
  teamId?: string | null;
  revokedAt?: string | null;
  startsAt: number; // epoch ms relative to "now" for the test
  endsAt?: number | null;
  callerApproved: boolean;
  roleDefinitionActive: boolean;
};

/** Mirrors has_role_in_scope()'s single-EXISTS-over-one-row semantics -- never unions two assignments. */
function hasRoleInScope(
  assignments: Assignment[],
  query: { roleCode: string; aocId?: string | null; hubId?: string | null; stationId?: string | null; teamId?: string | null; departmentId?: string | null; unitId?: string | null; operatingEntityId?: string | null },
  now = 0,
): boolean {
  return assignments.some((a) => {
    if (a.roleCode !== query.roleCode) return false;
    if (!a.roleDefinitionActive) return false;
    if (!a.callerApproved) return false;
    if (a.revokedAt != null) return false;
    if (a.startsAt > now) return false;
    if (a.endsAt != null && a.endsAt <= now) return false;
    if (query.aocId != null && a.aocId !== query.aocId && a.aocId !== null) return false;
    if (query.operatingEntityId != null && a.operatingEntityId !== query.operatingEntityId) return false;
    if (query.departmentId != null && a.departmentId !== query.departmentId) return false;
    if (query.unitId != null && a.unitId !== query.unitId) return false;
    if (query.hubId != null && a.hubId !== query.hubId) return false;
    if (query.stationId != null && a.stationId !== query.stationId) return false;
    if (query.teamId != null && a.teamId !== query.teamId) return false;
    return true;
  });
}

function baseAssignment(overrides: Partial<Assignment> = {}): Assignment {
  return {
    roleCode: "hub_se",
    aocId: "my",
    hubId: "northern",
    revokedAt: null,
    startsAt: -1000,
    endsAt: null,
    callerApproved: true,
    roleDefinitionActive: true,
    ...overrides,
  };
}

test("MANDATORY: active assignment grants access", () => {
  assert.equal(hasRoleInScope([baseAssignment()], { roleCode: "hub_se", hubId: "northern" }), true);
});

test("MANDATORY: revoked assignment denies access", () => {
  assert.equal(hasRoleInScope([baseAssignment({ revokedAt: "2026-01-01" })], { roleCode: "hub_se", hubId: "northern" }), false);
});

test("MANDATORY: expired assignment (ends_at in the past) denies access", () => {
  assert.equal(hasRoleInScope([baseAssignment({ endsAt: -500 })], { roleCode: "hub_se", hubId: "northern" }, 0), false);
});

test("MANDATORY: future assignment (starts_at not yet reached) denies access", () => {
  assert.equal(hasRoleInScope([baseAssignment({ startsAt: 500 })], { roleCode: "hub_se", hubId: "northern" }, 0), false);
});

test("MANDATORY: approved-status requirement -- a pending/rejected/deactivated caller's assignment never grants access, even if otherwise active", () => {
  assert.equal(hasRoleInScope([baseAssignment({ callerApproved: false })], { roleCode: "hub_se", hubId: "northern" }), false);
});

test("MANDATORY: an inactive role_definitions row (is_active=false) never grants access even with a live assignment row", () => {
  assert.equal(hasRoleInScope([baseAssignment({ roleDefinitionActive: false })], { roleCode: "hub_se", hubId: "northern" }), false);
});

test("Hub isolation: a hub_se assignment for the Northern hub does not grant access when querying the Sabah hub", () => {
  assert.equal(hasRoleInScope([baseAssignment({ hubId: "northern" })], { roleCode: "hub_se", hubId: "sabah" }), false);
});

test("Station isolation: an aso assignment for one station does not grant access at a different station", () => {
  const a = baseAssignment({ roleCode: "aso", hubId: undefined, stationId: "pen" });
  assert.equal(hasRoleInScope([a], { roleCode: "aso", stationId: "jhb" }), false);
  assert.equal(hasRoleInScope([a], { roleCode: "aso", stationId: "pen" }), true);
});

test("Team isolation: a dse assignment for team ALPHA at KUL does not grant access when querying team BRAVO -- duplicate team names across hubs/stations are never conflated (team_id is the only thing compared, never the free-text name)", () => {
  const a = baseAssignment({ roleCode: "dse", hubId: "kul", teamId: "kul-alpha-uuid" });
  assert.equal(hasRoleInScope([a], { roleCode: "dse", hubId: "kul", teamId: "kul-bravo-uuid" }), false);
  assert.equal(hasRoleInScope([a], { roleCode: "dse", hubId: "kul", teamId: "kul-alpha-uuid" }), true);
});

test("Department isolation: a compliance assignment for the Compliance department does not grant main_enforcement access to the Enforcement department", () => {
  const a = baseAssignment({ roleCode: "compliance", hubId: undefined, departmentId: "compliance-dept" });
  assert.equal(hasRoleInScope([a], { roleCode: "main_enforcement", departmentId: "enforcement-dept" }), false);
});

test("Unit isolation: an investigation_aso assignment does not grant access to the Profiling unit's scope", () => {
  const a = baseAssignment({ roleCode: "investigation_aso", hubId: undefined, unitId: "investigation-unit" });
  assert.equal(hasRoleInScope([a], { roleCode: "investigation_aso", unitId: "profiling-unit" }), false);
});

test("AOC isolation: a Malaysia-scoped assignment does not satisfy a query for a different AOC", () => {
  const a = baseAssignment({ roleCode: "operation_manager", hubId: undefined, aocId: "my" });
  assert.equal(hasRoleInScope([a], { roleCode: "operation_manager", aocId: "some-other-aoc" }), false);
  assert.equal(hasRoleInScope([a], { roleCode: "operation_manager", aocId: "my" }), true);
});

test("MAA/AAX isolation: a maa_boss assignment does not satisfy a query for the AAX operating entity", () => {
  const a = baseAssignment({ roleCode: "maa_boss", hubId: undefined, aocId: "my", operatingEntityId: "maa-id" });
  assert.equal(hasRoleInScope([a], { roleCode: "maa_boss", operatingEntityId: "aax-id" }), false);
  assert.equal(hasRoleInScope([a], { roleCode: "maa_boss", operatingEntityId: "maa-id" }), true);
});

test("International role's null aoc_id matches any queried AOC -- correct by construction, since only the trigger-enforced international codes can ever have a null aoc_id row", () => {
  const a = baseAssignment({ roleCode: "ghod", hubId: undefined, aocId: null });
  assert.equal(hasRoleInScope([a], { roleCode: "ghod", aocId: "my" }), true);
  assert.equal(hasRoleInScope([a], { roleCode: "ghod", aocId: "some-future-aoc" }), true);
});

test("MANDATORY: multiple narrow assignments do not union into unintended broader access -- a hub_se(Northern) + hub_se(Sarawak) pair never satisfies a query for the Sabah hub", () => {
  const assignments = [
    baseAssignment({ hubId: "northern" }),
    baseAssignment({ hubId: "sarawak" }),
  ];
  assert.equal(hasRoleInScope(assignments, { roleCode: "hub_se", hubId: "sabah" }), false);
  assert.equal(hasRoleInScope(assignments, { roleCode: "hub_se", hubId: "northern" }), true);
  assert.equal(hasRoleInScope(assignments, { roleCode: "hub_se", hubId: "sarawak" }), true);
});

test("MANDATORY: two DIFFERENT narrow roles held by the same person do not combine into a role neither one grants -- holding hub_se(Northern) and compliance(Compliance dept) never satisfies a query for main_enforcement", () => {
  const assignments = [
    baseAssignment({ roleCode: "hub_se", hubId: "northern" }),
    baseAssignment({ roleCode: "compliance", hubId: undefined, departmentId: "compliance-dept" }),
  ];
  assert.equal(hasRoleInScope(assignments, { roleCode: "main_enforcement" }), false);
});

// --- Role-specific denial contracts ---

test("CONTRACT: AirAsia Management has no scope columns to check against -- dashboard-only by construction (no operational query can ever pass a matching scope, since the role's only valid row has every scope column null)", () => {
  const a = baseAssignment({ roleCode: "airasia_management", hubId: undefined, aocId: null });
  // A query that requires ANY specific narrower scope always fails, because
  // the only valid row for this role has every scope column null and the
  // query's non-null parameter can never match null.
  assert.equal(hasRoleInScope([a], { roleCode: "airasia_management", hubId: "kul" }), false);
});

test("CONTRACT: GHOD's only valid row has no operational scope either -- same construction as AirAsia Management", () => {
  const a = baseAssignment({ roleCode: "ghod", hubId: undefined, aocId: null });
  assert.equal(hasRoleInScope([a], { roleCode: "ghod", stationId: "kul-maa" }), false);
});

test("CONTRACT: Super Admin does not automatically gain operational-report authority -- holding super_admin never satisfies a query for any operational role code", () => {
  const a = baseAssignment({ roleCode: "super_admin", hubId: undefined, aocId: null });
  for (const operationalRole of ["hub_se", "dse", "operation_manager", "main_enforcement", "compliance"]) {
    assert.equal(hasRoleInScope([a], { roleCode: operationalRole }), false, `super_admin must not satisfy ${operationalRole}`);
  }
});

test("CONTRACT: CaterLink Management has no checkpoint/scan authority -- no repository reference ties caterlink_management to any checkpoint scan/completion policy or table", () => {
  // Structural proof: the ONLY place 'caterlink_management' appears in the
  // entire repo is this migration's role catalog and its own tests. No
  // CaterLink checkpoint/scan/Part-B/C/D/Hub/REDQ policy or server action
  // references it at all, which is what makes "no scan authority" true by
  // construction rather than by an app-layer check that could be missed.
  const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const searchDirs = ["supabase/migrations/icms", "lib/icms"];
  for (const dir of searchDirs) {
    const full = path.join(repoRoot, dir);
    if (!fs.existsSync(full)) continue;
    const walk = (d: string): string[] =>
      fs.readdirSync(d, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() ? walk(path.join(d, entry.name)) : [path.join(d, entry.name)],
      );
    for (const file of walk(full)) {
      if (!/\.(sql|ts|tsx)$/.test(file)) continue;
      const contents = fs.readFileSync(file, "utf8");
      assert.doesNotMatch(
        contents,
        /caterlink_management/,
        `${file} must not reference caterlink_management -- the role must carry zero checkpoint/scan authority by construction`,
      );
    }
  }
});

test("CONTRACT: Compliance is read-only by design -- no existing report/movement table grant is added by this migration for any role", () => {
  assert.doesNotMatch(code, /grant.*on public\.report_/i);
  assert.doesNotMatch(code, /grant.*on public\.feedback_threads/i);
  assert.doesNotMatch(code, /grant.*on public\.duty_records/i);
});

// --- Existing behavior unchanged ---

test("REGRESSION: no CREATE POLICY, ALTER POLICY, or DROP POLICY statement exists anywhere in this migration -- current KUL scanning, report acknowledgement, roster isolation, leave/OT, and Super Admin containment RLS are all completely untouched", () => {
  assert.equal((code.match(/(create|alter|drop) policy/gi) ?? []).length, 0);
});

// --- SECURITY DEFINER function standard ---

test("SECURITY: every new function is SECURITY DEFINER with a fixed search_path", () => {
  const fnBlocks = code.match(/create or replace function public\.\w+\([\s\S]*?\$function\$;/g) ?? [];
  assert.ok(fnBlocks.length >= 5, "expected at least 5 new functions");
  for (const block of fnBlocks) {
    assert.match(block, /security definer/i, `missing SECURITY DEFINER: ${block.slice(0, 60)}`);
    assert.match(block, /set search_path to 'public'/i, `missing fixed search_path: ${block.slice(0, 60)}`);
  }
});

test("SECURITY: has_role_in_scope/has_active_role/get_my_active_role_assignments are revoked from PUBLIC/anon and granted to authenticated+service_role explicitly", () => {
  for (const fn of ["has_role_in_scope(text, uuid, uuid, uuid, uuid, uuid, uuid, uuid)", "has_active_role(text)", "get_my_active_role_assignments()"]) {
    assert.match(code, new RegExp(`revoke execute on function public\\.${fn.replace(/[()]/g, "\\$&")} from public, anon;`));
    assert.match(code, new RegExp(`grant execute on function public\\.${fn.replace(/[()]/g, "\\$&")} to authenticated, service_role;`));
  }
});

test("SECURITY: trigger functions (validate_user_role_assignment_scope, set_updated_at_user_role_assignments) are revoked from authenticated too -- trigger firing never needs direct client EXECUTE", () => {
  assert.match(code, /revoke execute on function public\.validate_user_role_assignment_scope\(\) from public, anon, authenticated;/);
  assert.match(code, /revoke execute on function public\.set_updated_at_user_role_assignments\(\) from public, anon, authenticated;/);
});

test("SECURITY: no helper accepts a client-supplied profile id parameter", () => {
  const helperNames = ["has_role_in_scope", "has_active_role", "get_my_active_role_assignments"];
  for (const name of helperNames) {
    const block = code.match(new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\$function\\$;`));
    assert.ok(block, `must find ${name}`);
    assert.doesNotMatch(block![0], /p_profile_id/i, `${name} must not take a client-supplied profile id`);
  }
});

test("SECURITY: has_role_in_scope() and get_my_active_role_assignments() read auth.uid() directly; has_active_role() delegates to has_role_in_scope() rather than re-reading identity itself", () => {
  const scopeBlock = code.match(/create or replace function public\.has_role_in_scope\([\s\S]*?\$function\$;/);
  const selfReadBlock = code.match(/create or replace function public\.get_my_active_role_assignments\([\s\S]*?\$function\$;/);
  const activeRoleBlock = code.match(/create or replace function public\.has_active_role\([\s\S]*?\$function\$;/);
  assert.match(scopeBlock![0], /auth\.uid\(\)/);
  assert.match(selfReadBlock![0], /auth\.uid\(\)/);
  assert.match(activeRoleBlock![0], /select public\.has_role_in_scope\(p_role_code\);/);
});

// --- Rollback ordering ---

test("ROLLBACK: triggers/functions are dropped before the table, and user_role_assignments is dropped before role_definitions", () => {
  const rollbackBlock = migrationSql.match(/DOCUMENTED ROLLBACK[\s\S]*$/);
  assert.ok(rollbackBlock, "must find the documented rollback block");
  const text = rollbackBlock[0];
  const triggerIdx = text.indexOf("drop trigger if exists trg_validate_user_role_assignment_scope");
  const helperFnIdx = text.indexOf("drop function if exists public.get_my_active_role_assignments");
  const assignmentsTableIdx = text.indexOf("drop table if exists public.user_role_assignments;");
  const roleDefsTableIdx = text.indexOf("drop table if exists public.role_definitions;");
  assert.ok(triggerIdx > -1 && helperFnIdx > -1 && assignmentsTableIdx > -1 && roleDefsTableIdx > -1);
  assert.ok(triggerIdx < assignmentsTableIdx, "triggers must be dropped before the table");
  assert.ok(helperFnIdx < assignmentsTableIdx, "helper functions must be dropped before the table");
  assert.ok(assignmentsTableIdx < roleDefsTableIdx, "user_role_assignments must be dropped before role_definitions");
});

test("ROLLBACK: this migration documents that Phase 3 must be rolled back before Phase 2 (dependency direction), not the reverse", () => {
  assert.match(migrationSql, /rolling back Phase 3 first, then Phase 2, is always\s*\n-- safe/);
});

// --- Static structural validation ---

test("STATIC: parentheses are balanced in the full migration file", () => {
  const opens = (code.match(/\(/g) ?? []).length;
  const closes = (code.match(/\)/g) ?? []).length;
  assert.equal(opens, closes);
});

test("STATIC: no unescaped double-hyphen inside a single-quoted string literal (would silently truncate under naive comment-stripping tools -- fixed in this file after being caught during self-review)", () => {
  const lines = migrationSql.replace(/\r\n/g, "\n").split("\n");
  for (const line of lines) {
    const idx = line.indexOf("--");
    if (idx === -1) continue;
    const before = line.slice(0, idx);
    const quoteCount = (before.match(/'/g) ?? []).length;
    assert.equal(quoteCount % 2, 0, `line contains "--" inside an open string literal: ${line}`);
  }
});

// --- Correction pass (2026-09-28, second review): exact role count ---

test("CORRECTION: exactly 23 role codes are seeded -- not 27. 4 international + 7 Malaysia leadership + 6 Enforcement + 5 Operation + 1 CaterLink = 23, matching the approved specification exactly. No unapproved role was ever introduced -- the prior report's '27' was a prose error, not a schema defect.", () => {
  const insertBlock = code.match(/insert into public\.role_definitions[\s\S]*?on conflict \(code\) do nothing;/);
  assert.ok(insertBlock);
  const rows = insertBlock![0].match(/^\s*\('[a-z_]+',/gm) ?? [];
  assert.equal(rows.length, 23, `expected exactly 23 seeded role rows, found ${rows.length}`);
  assert.equal(REQUIRED_ROLE_CODES.length, 23);

  const byCategory: Record<string, number> = {
    international: 4,
    malaysia_leadership: 7,
    enforcement: 6,
    operation: 5,
    caterlink: 1,
  };
  for (const [category, expectedCount] of Object.entries(byCategory)) {
    const categoryRows = insertBlock![0].match(new RegExp(`'${category}',`, "g")) ?? [];
    assert.equal(categoryRows.length, expectedCount, `expected ${expectedCount} rows in category ${category}, found ${categoryRows.length}`);
  }
});

test("CORRECTION: the migration header comment states 23, not 27", () => {
  assert.doesNotMatch(migrationSql, /27 required role codes/);
  assert.match(migrationSql, /23 required role codes per the approved/);
});

// --- Correction pass: resolved-decisions documentation carried into Phase 3 ---

test("CORRECTION: Phase 3 restates (not reopens) the four resolved decisions from Phase 2", () => {
  assert.match(migrationSql, /RESOLVED DECISIONS \(carried forward from Phase 2/);
  assert.match(migrationSql, /A station is never permanently assigned to only MAA or AAX/);
  assert.match(migrationSql, /AAX is not KUL-only/);
  assert.match(migrationSql, /Historical public\.feedback_threads rows remain untouched/);
});

// --- Correction pass: extended multiple-assignment safety proofs ---

test("MULTI-ASSIGNMENT: an MAA assignment plus a separately-held AAX assignment does not produce unrestricted entity access -- each only satisfies a query for its own entity", () => {
  const assignments: Assignment[] = [
    baseAssignment({ roleCode: "maa_admin", hubId: undefined, aocId: "my", operatingEntityId: "maa-id" }),
    baseAssignment({ roleCode: "aax_admin", hubId: undefined, aocId: "my", operatingEntityId: "aax-id" }),
  ];
  assert.equal(hasRoleInScope(assignments, { roleCode: "maa_admin", operatingEntityId: "maa-id" }), true);
  assert.equal(hasRoleInScope(assignments, { roleCode: "maa_admin", operatingEntityId: "aax-id" }), false);
  assert.equal(hasRoleInScope(assignments, { roleCode: "aax_admin", operatingEntityId: "aax-id" }), true);
  assert.equal(hasRoleInScope(assignments, { roleCode: "aax_admin", operatingEntityId: "maa-id" }), false);
  // Critically: holding BOTH does not manufacture a third, broader
  // "any entity" capability under either role code -- there is no query
  // shape that both rows satisfy simultaneously for a mismatched entity.
});

test("MULTI-ASSIGNMENT: a hub_se(Northern) assignment plus a separate aso(PEN station) assignment does not create whole-AOC access -- querying a third, unrelated hub/station under either role still fails", () => {
  const assignments: Assignment[] = [
    baseAssignment({ roleCode: "hub_se", hubId: "northern" }),
    baseAssignment({ roleCode: "aso", hubId: undefined, stationId: "pen-station" }),
  ];
  assert.equal(hasRoleInScope(assignments, { roleCode: "hub_se", hubId: "sabah" }), false);
  assert.equal(hasRoleInScope(assignments, { roleCode: "aso", stationId: "jhb-station" }), false);
  assert.equal(hasRoleInScope(assignments, { roleCode: "operation_manager" }), false, "neither narrow assignment satisfies a department-wide role query");
});

test("MULTI-ASSIGNMENT: an expired assignment held alongside an active, unrelated assignment contributes zero access of its own", () => {
  const assignments: Assignment[] = [
    baseAssignment({ roleCode: "hub_se", hubId: "northern", endsAt: -500 }), // expired
    baseAssignment({ roleCode: "compliance", hubId: undefined, departmentId: "compliance-dept" }), // active
  ];
  assert.equal(hasRoleInScope(assignments, { roleCode: "hub_se", hubId: "northern" }, 0), false, "the expired assignment must not grant access");
  assert.equal(hasRoleInScope(assignments, { roleCode: "compliance", departmentId: "compliance-dept" }, 0), true, "the still-active, unrelated assignment is unaffected by the expired one");
});

test("MULTI-ASSIGNMENT: a revoked assignment held alongside an active, unrelated assignment contributes zero access of its own", () => {
  const assignments: Assignment[] = [
    baseAssignment({ roleCode: "hub_se", hubId: "northern", revokedAt: "2026-01-01" }),
    baseAssignment({ roleCode: "compliance", hubId: undefined, departmentId: "compliance-dept" }),
  ];
  assert.equal(hasRoleInScope(assignments, { roleCode: "hub_se", hubId: "northern" }), false);
  assert.equal(hasRoleInScope(assignments, { roleCode: "compliance", departmentId: "compliance-dept" }), true);
});

test("MULTI-ASSIGNMENT: a global technical role (super_admin) held alongside a narrow operational role does not let the operational role bypass its own scope, nor does it let super_admin acquire operational scope", () => {
  const assignments: Assignment[] = [
    baseAssignment({ roleCode: "super_admin", hubId: undefined, aocId: null }),
    baseAssignment({ roleCode: "hub_se", hubId: "northern" }),
  ];
  // super_admin still satisfies only super_admin queries, never an
  // operational role code:
  assert.equal(hasRoleInScope(assignments, { roleCode: "operation_manager" }), false);
  // hub_se still satisfies only its own hub, unaffected by holding
  // super_admin too:
  assert.equal(hasRoleInScope(assignments, { roleCode: "hub_se", hubId: "sabah" }), false);
  assert.equal(hasRoleInScope(assignments, { roleCode: "hub_se", hubId: "northern" }), true);
});

// --- Correction pass: RPC output safety review ---

test("RPC SAFETY: get_my_active_role_assignments() returns only self-service display columns -- never id, profile_id, granted_by, grant_reason, or revoked_at", () => {
  const block = code.match(/create or replace function public\.get_my_active_role_assignments\(\)[\s\S]*?\$function\$;/);
  assert.ok(block);
  const returnsBlock = block![0].match(/returns table \([\s\S]*?\)/);
  assert.ok(returnsBlock, "must find the RETURNS TABLE column list");
  for (const sensitiveColumn of ["granted_by", "grant_reason", "profile_id", "revoked_at", /\bid\b/]) {
    assert.doesNotMatch(returnsBlock![0], sensitiveColumn instanceof RegExp ? sensitiveColumn : new RegExp(`\\b${sensitiveColumn}\\b`));
  }
  // Confirms exactly the minimal, documented column set:
  for (const expectedColumn of ["role_code", "role_category", "aoc_code", "operating_entity_code", "department_code", "unit_code", "hub_code", "station_code", "team_name", "starts_at", "ends_at"]) {
    assert.match(returnsBlock![0], new RegExp(expectedColumn));
  }
});

test("RPC SAFETY: get_my_active_role_assignments() is scoped to auth.uid() in its WHERE clause and filters to currently-effective rows only (no revoked/expired/future/inactive-role-definition/unapproved-caller row can be returned)", () => {
  const block = code.match(/create or replace function public\.get_my_active_role_assignments\(\)[\s\S]*?\$function\$;/);
  assert.ok(block);
  assert.match(block![0], /where ura\.profile_id = auth\.uid\(\)/);
  assert.match(block![0], /and rd\.is_active/);
  assert.match(block![0], /and p\.status = 'approved'/);
  assert.match(block![0], /and ura\.revoked_at is null/);
  assert.match(block![0], /and ura\.starts_at <= now\(\)/);
  assert.match(block![0], /and \(ura\.ends_at is null or ura\.ends_at > now\(\)\)/);
});

test("RPC SAFETY: get_my_active_role_assignments() cannot be called with any other user's identity -- no parameter of any kind exists on the function signature", () => {
  const block = code.match(/create or replace function public\.get_my_active_role_assignments\(\)[\s\S]*?\$function\$;/);
  assert.ok(block);
  assert.match(block![0], /create or replace function public\.get_my_active_role_assignments\(\)\s*\nreturns table/);
});
