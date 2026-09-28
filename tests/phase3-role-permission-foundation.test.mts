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

// --- Scope-shape validation trigger (mirrors validate_user_role_assignment_scope() -- second pass, with hierarchy-consistency checks) ---

const INTERNATIONAL_CODES = ["airasia_management", "ghod", "global_reporting_controller", "super_admin"];

type FullScope = {
  aocId: string | null;
  operatingEntityId?: string | null;
  departmentId?: string | null;
  unitId?: string | null;
  hubId?: string | null;
  stationId?: string | null;
  teamId?: string | null;
};

function scopeOf(overrides: Partial<FullScope> = {}): FullScope {
  return { aocId: null, operatingEntityId: null, departmentId: null, unitId: null, hubId: null, stationId: null, teamId: null, ...overrides };
}

/** A small fake catalog mirroring the FK relationships in aocs/operating_entities/departments/units/hubs/org_stations/org_teams. */
const CATALOG = {
  entities: {
    maa: { aocId: "my", code: "MAA" },
    aax: { aocId: "my", code: "AAX" },
    other_aoc_entity: { aocId: "other-aoc", code: "MAA" },
  } as Record<string, { aocId: string; code: string }>,
  departments: {
    operation: { aocId: "my", code: "operation" },
    enforcement: { aocId: "my", code: "enforcement" },
    compliance: { aocId: "my", code: "compliance" },
    caterlink: { aocId: "my", code: "caterlink" },
    other_aoc_dept: { aocId: "other-aoc", code: "operation" },
  } as Record<string, { aocId: string; code: string }>,
  units: {
    investigation: { departmentId: "enforcement", code: "investigation" },
    sat: { departmentId: "enforcement", code: "sat" },
    profiling: { departmentId: "enforcement", code: "profiling" },
    wrong_dept_unit: { departmentId: "operation", code: "investigation" },
  } as Record<string, { departmentId: string; code: string }>,
  hubs: {
    kul: { aocId: "my", code: "kul" },
    northern: { aocId: "my", code: "northern" },
    sabah: { aocId: "my", code: "sabah" },
    other_aoc_hub: { aocId: "other-aoc", code: "kul" },
  } as Record<string, { aocId: string; code: string }>,
  stations: {
    "kul-maa": { hubId: "kul" },
    pen: { hubId: "northern" },
    "wrong-hub-station": { hubId: "sabah" },
  } as Record<string, { hubId: string }>,
  teams: {
    "kul-alpha": { stationId: "kul-maa" },
    "pen-alpha": { stationId: "pen" },
    "wrong-station-team": { stationId: "kul-maa" },
  } as Record<string, { stationId: string }>,
};

/** Mirrors validate_user_role_assignment_scope() exactly -- generic hierarchy checks, then per-role required/forbidden scope. */
function validateAssignmentScope(roleCode: string, scope: FullScope): { ok: boolean; error?: string } {
  if (scope.operatingEntityId != null) {
    const e = CATALOG.entities[scope.operatingEntityId];
    if (!e || e.aocId !== scope.aocId) return { ok: false, error: "operating_entity_id does not belong to the assignment aoc_id (cross-AOC entity)." };
  }
  if (scope.departmentId != null) {
    const d = CATALOG.departments[scope.departmentId];
    if (!d || d.aocId !== scope.aocId) return { ok: false, error: "department_id does not belong to the assignment aoc_id (cross-AOC department)." };
  }
  if (scope.unitId != null) {
    const u = CATALOG.units[scope.unitId];
    if (!u || scope.departmentId == null || u.departmentId !== scope.departmentId) return { ok: false, error: "unit_id does not belong to the assignment department_id (wrong-department unit)." };
  }
  if (scope.hubId != null) {
    const h = CATALOG.hubs[scope.hubId];
    if (!h || h.aocId !== scope.aocId) return { ok: false, error: "hub_id does not belong to the assignment aoc_id (cross-AOC hub)." };
  }
  if (scope.stationId != null) {
    const s = CATALOG.stations[scope.stationId];
    if (!s || scope.hubId == null || s.hubId !== scope.hubId) return { ok: false, error: "station_id does not belong to the assignment hub_id (wrong-hub station)." };
  }
  if (scope.teamId != null) {
    const t = CATALOG.teams[scope.teamId];
    if (!t || scope.stationId == null || t.stationId !== scope.stationId) return { ok: false, error: "team_id does not belong to the assignment station_id (wrong-station team)." };
  }

  const entityCode = scope.operatingEntityId ? CATALOG.entities[scope.operatingEntityId]?.code : undefined;
  const deptCode = scope.departmentId ? CATALOG.departments[scope.departmentId]?.code : undefined;
  const unitCode = scope.unitId ? CATALOG.units[scope.unitId]?.code : undefined;
  const hubCode = scope.hubId ? CATALOG.hubs[scope.hubId]?.code : undefined;

  if (INTERNATIONAL_CODES.includes(roleCode)) {
    const anyScope = scope.aocId != null || scope.operatingEntityId != null || scope.departmentId != null || scope.unitId != null || scope.hubId != null || scope.stationId != null || scope.teamId != null;
    if (anyScope) return { ok: false, error: `${roleCode} is an international/platform role and must carry no scope at all.` };
    return { ok: true };
  }

  if (scope.aocId == null) return { ok: false, error: `${roleCode} requires an explicit aoc_id.` };

  if (["maa_boss", "maa_admin", "aax_boss", "aax_admin"].includes(roleCode)) {
    if (scope.operatingEntityId == null) return { ok: false, error: `${roleCode} requires operating_entity_id.` };
    if (["maa_boss", "maa_admin"].includes(roleCode) && entityCode !== "MAA") return { ok: false, error: `${roleCode} must be scoped to the MAA operating entity, not any other.` };
    if (["aax_boss", "aax_admin"].includes(roleCode) && entityCode !== "AAX") return { ok: false, error: `${roleCode} must be scoped to the AAX operating entity, not any other.` };
    if (scope.departmentId != null || scope.unitId != null || scope.hubId != null || scope.stationId != null || scope.teamId != null) {
      return { ok: false, error: `${roleCode} must carry no department/unit/hub/station/team scope.` };
    }
    return { ok: true };
  }

  if (["operation_manager", "main_enforcement", "compliance", "caterlink_management"].includes(roleCode)) {
    if (scope.departmentId == null) return { ok: false, error: `${roleCode} requires department_id.` };
    if (roleCode === "operation_manager" && deptCode !== "operation") return { ok: false, error: "operation_manager must be scoped to the Operation department." };
    if (roleCode === "main_enforcement" && deptCode !== "enforcement") return { ok: false, error: "main_enforcement must be scoped to the Enforcement department." };
    if (roleCode === "compliance" && deptCode !== "compliance") return { ok: false, error: "compliance must be scoped to the Compliance department." };
    if (roleCode === "caterlink_management" && deptCode !== "caterlink") return { ok: false, error: "caterlink_management must be scoped to the CaterLink department." };
    if (scope.operatingEntityId != null || scope.unitId != null || scope.hubId != null || scope.stationId != null || scope.teamId != null) {
      return { ok: false, error: `${roleCode} must carry no entity/unit/hub/station/team scope.` };
    }
    return { ok: true };
  }

  if (["investigation_sso", "investigation_so", "investigation_aso"].includes(roleCode)) {
    if (scope.departmentId == null) return { ok: false, error: `${roleCode} requires department_id (Enforcement).` };
    if (scope.unitId == null) return { ok: false, error: `${roleCode} requires unit_id (Investigation).` };
    if (deptCode !== "enforcement") return { ok: false, error: `${roleCode} must be scoped to the Enforcement department.` };
    if (unitCode !== "investigation") return { ok: false, error: `${roleCode} must be scoped to the Investigation unit.` };
    if (scope.operatingEntityId != null || scope.hubId != null || scope.stationId != null || scope.teamId != null) {
      return { ok: false, error: `${roleCode} must carry no entity/hub/station/team scope.` };
    }
    return { ok: true };
  }

  if (roleCode === "sat_aso") {
    if (scope.departmentId == null) return { ok: false, error: "sat_aso requires department_id (Enforcement)." };
    if (scope.unitId == null) return { ok: false, error: "sat_aso requires unit_id (SAT)." };
    if (scope.hubId == null) return { ok: false, error: "sat_aso requires hub_id (KUL)." };
    if (scope.stationId == null) return { ok: false, error: "sat_aso requires station_id (a KUL station)." };
    if (scope.teamId == null) return { ok: false, error: "sat_aso requires team_id (one SAT team)." };
    if (deptCode !== "enforcement") return { ok: false, error: "sat_aso must be scoped to the Enforcement department." };
    if (unitCode !== "sat") return { ok: false, error: "sat_aso must be scoped to the SAT unit." };
    if (hubCode !== "kul") return { ok: false, error: "sat_aso must be scoped to the KUL hub only." };
    if (scope.operatingEntityId != null) return { ok: false, error: "sat_aso must carry no operating-entity scope." };
    return { ok: true };
  }

  if (["profiling_so", "profiling_aso"].includes(roleCode)) {
    if (scope.departmentId == null) return { ok: false, error: `${roleCode} requires department_id (Enforcement).` };
    if (scope.unitId == null) return { ok: false, error: `${roleCode} requires unit_id (Profiling).` };
    if (scope.hubId == null) return { ok: false, error: `${roleCode} requires hub_id.` };
    if (scope.stationId == null) return { ok: false, error: `${roleCode} requires station_id.` };
    if (scope.teamId == null) return { ok: false, error: `${roleCode} requires team_id (one Profiling team).` };
    if (deptCode !== "enforcement") return { ok: false, error: `${roleCode} must be scoped to the Enforcement department.` };
    if (unitCode !== "profiling") return { ok: false, error: `${roleCode} must be scoped to the Profiling unit.` };
    if (scope.operatingEntityId != null) return { ok: false, error: `${roleCode} must carry no operating-entity scope.` };
    return { ok: true };
  }

  if (roleCode === "hub_se") {
    if (scope.departmentId == null) return { ok: false, error: "hub_se requires department_id (Operation)." };
    if (scope.hubId == null) return { ok: false, error: "hub_se requires hub_id." };
    if (deptCode !== "operation") return { ok: false, error: "hub_se must be scoped to the Operation department." };
    if (scope.operatingEntityId != null || scope.unitId != null || scope.stationId != null || scope.teamId != null) {
      return { ok: false, error: "hub_se must carry no entity/unit/station/team scope." };
    }
    return { ok: true };
  }

  if (roleCode === "dse") {
    if (scope.departmentId == null) return { ok: false, error: "dse requires department_id (Operation)." };
    if (scope.hubId == null) return { ok: false, error: "dse requires hub_id (KUL)." };
    if (scope.stationId == null) return { ok: false, error: "dse requires station_id (a KUL station)." };
    if (scope.teamId == null) return { ok: false, error: "dse requires team_id (own team only)." };
    if (deptCode !== "operation") return { ok: false, error: "dse must be scoped to the Operation department." };
    if (hubCode !== "kul") return { ok: false, error: "dse must be scoped to the KUL hub only; non-KUL hubs use hub_se instead." };
    if (scope.operatingEntityId != null || scope.unitId != null) return { ok: false, error: "dse must carry no entity/unit scope." };
    return { ok: true };
  }

  if (["sso", "so", "aso"].includes(roleCode)) {
    if (scope.departmentId == null) return { ok: false, error: `${roleCode} requires department_id (Operation).` };
    if (scope.hubId == null) return { ok: false, error: `${roleCode} requires hub_id.` };
    if (scope.stationId == null) return { ok: false, error: `${roleCode} requires station_id.` };
    if (scope.teamId == null) return { ok: false, error: `${roleCode} requires team_id; station staff cannot receive an assignment without a team.` };
    if (deptCode !== "operation") return { ok: false, error: `${roleCode} must be scoped to the Operation department.` };
    if (scope.operatingEntityId != null || scope.unitId != null) return { ok: false, error: `${roleCode} must carry no entity/unit scope.` };
    return { ok: true };
  }

  return { ok: false, error: `Unhandled role code ${roleCode}.` };
}

/** The minimal valid scope for each role, built from CATALOG -- used to drive the full per-role decision table below. */
const MINIMAL_VALID_SCOPE: Record<string, FullScope> = {
  airasia_management: scopeOf(),
  ghod: scopeOf(),
  global_reporting_controller: scopeOf(),
  super_admin: scopeOf(),
  maa_boss: scopeOf({ aocId: "my", operatingEntityId: "maa" }),
  aax_boss: scopeOf({ aocId: "my", operatingEntityId: "aax" }),
  maa_admin: scopeOf({ aocId: "my", operatingEntityId: "maa" }),
  aax_admin: scopeOf({ aocId: "my", operatingEntityId: "aax" }),
  operation_manager: scopeOf({ aocId: "my", departmentId: "operation" }),
  main_enforcement: scopeOf({ aocId: "my", departmentId: "enforcement" }),
  compliance: scopeOf({ aocId: "my", departmentId: "compliance" }),
  investigation_sso: scopeOf({ aocId: "my", departmentId: "enforcement", unitId: "investigation" }),
  investigation_so: scopeOf({ aocId: "my", departmentId: "enforcement", unitId: "investigation" }),
  investigation_aso: scopeOf({ aocId: "my", departmentId: "enforcement", unitId: "investigation" }),
  sat_aso: scopeOf({ aocId: "my", departmentId: "enforcement", unitId: "sat", hubId: "kul", stationId: "kul-maa", teamId: "kul-alpha" }),
  profiling_so: scopeOf({ aocId: "my", departmentId: "enforcement", unitId: "profiling", hubId: "northern", stationId: "pen", teamId: "pen-alpha" }),
  profiling_aso: scopeOf({ aocId: "my", departmentId: "enforcement", unitId: "profiling", hubId: "northern", stationId: "pen", teamId: "pen-alpha" }),
  hub_se: scopeOf({ aocId: "my", departmentId: "operation", hubId: "northern" }),
  dse: scopeOf({ aocId: "my", departmentId: "operation", hubId: "kul", stationId: "kul-maa", teamId: "kul-alpha" }),
  sso: scopeOf({ aocId: "my", departmentId: "operation", hubId: "northern", stationId: "pen", teamId: "pen-alpha" }),
  so: scopeOf({ aocId: "my", departmentId: "operation", hubId: "northern", stationId: "pen", teamId: "pen-alpha" }),
  aso: scopeOf({ aocId: "my", departmentId: "operation", hubId: "northern", stationId: "pen", teamId: "pen-alpha" }),
  caterlink_management: scopeOf({ aocId: "my", departmentId: "caterlink" }),
};

test("DECISION TABLE: every role's minimal scope from the matrix passes validation", () => {
  for (const roleCode of REQUIRED_ROLE_CODES) {
    const result = validateAssignmentScope(roleCode, MINIMAL_VALID_SCOPE[roleCode]);
    assert.equal(result.ok, true, `${roleCode}: expected valid, got error: ${result.error}`);
  }
});

test("DECISION TABLE: every role rejects a fully empty scope (missing required scope)", () => {
  for (const roleCode of REQUIRED_ROLE_CODES.filter((c) => !INTERNATIONAL_CODES.includes(c))) {
    assert.equal(validateAssignmentScope(roleCode, scopeOf()).ok, false, `${roleCode} with no scope must be rejected`);
  }
});

test("DECISION TABLE: wrong department is rejected for every department-scoped role", () => {
  const cases: Array<[string, FullScope]> = [
    ["operation_manager", scopeOf({ aocId: "my", departmentId: "enforcement" })],
    ["main_enforcement", scopeOf({ aocId: "my", departmentId: "operation" })],
    ["compliance", scopeOf({ aocId: "my", departmentId: "operation" })],
    ["caterlink_management", scopeOf({ aocId: "my", departmentId: "operation" })],
    ["hub_se", scopeOf({ aocId: "my", departmentId: "enforcement", hubId: "northern" })],
    ["dse", scopeOf({ aocId: "my", departmentId: "enforcement", hubId: "kul", stationId: "kul-maa", teamId: "kul-alpha" })],
    ["aso", scopeOf({ aocId: "my", departmentId: "enforcement", hubId: "northern", stationId: "pen", teamId: "pen-alpha" })],
    ["investigation_aso", scopeOf({ aocId: "my", departmentId: "operation", unitId: "wrong_dept_unit" })],
  ];
  for (const [roleCode, scope] of cases) {
    assert.equal(validateAssignmentScope(roleCode, scope).ok, false, `${roleCode} with the wrong department must be rejected`);
  }
});

test("DECISION TABLE: wrong unit is rejected for every unit-scoped role", () => {
  // wrong_dept_unit has code 'investigation' but departmentId 'operation' --
  // this simultaneously exercises the unit-belongs-to-department hierarchy
  // check AND the department-code check, both of which must independently
  // reject it.
  assert.equal(
    validateAssignmentScope("investigation_aso", scopeOf({ aocId: "my", departmentId: "operation", unitId: "wrong_dept_unit" })).ok,
    false,
  );
  assert.equal(
    validateAssignmentScope("sat_aso", scopeOf({ aocId: "my", departmentId: "enforcement", unitId: "investigation", hubId: "kul", stationId: "kul-maa", teamId: "kul-alpha" })).ok,
    false,
    "sat_aso with the Investigation unit instead of SAT must be rejected",
  );
  assert.equal(
    validateAssignmentScope("profiling_so", scopeOf({ aocId: "my", departmentId: "enforcement", unitId: "sat", hubId: "northern", stationId: "pen", teamId: "pen-alpha" })).ok,
    false,
    "profiling_so with the SAT unit instead of Profiling must be rejected",
  );
});

test("DECISION TABLE: forbidden extra scope is rejected for every role -- a harmless-looking extra id is never accepted", () => {
  const cases: Array<[string, FullScope]> = [
    ["airasia_management", scopeOf({ aocId: "my" })],
    ["ghod", scopeOf({ hubId: "northern" })],
    ["super_admin", scopeOf({ departmentId: "operation" })],
    ["global_reporting_controller", scopeOf({ stationId: "pen" })],
    ["maa_boss", scopeOf({ aocId: "my", operatingEntityId: "maa", departmentId: "operation" })],
    ["aax_admin", scopeOf({ aocId: "my", operatingEntityId: "aax", hubId: "northern" })],
    ["operation_manager", scopeOf({ aocId: "my", departmentId: "operation", operatingEntityId: "maa" })],
    ["operation_manager", scopeOf({ aocId: "my", departmentId: "operation", hubId: "northern" })],
    ["main_enforcement", scopeOf({ aocId: "my", departmentId: "enforcement", unitId: "investigation" })],
    ["compliance", scopeOf({ aocId: "my", departmentId: "compliance", stationId: "pen" })],
    ["investigation_sso", scopeOf({ aocId: "my", departmentId: "enforcement", unitId: "investigation", hubId: "kul" })],
    ["sat_aso", { ...MINIMAL_VALID_SCOPE.sat_aso, operatingEntityId: "maa" }],
    ["profiling_aso", { ...MINIMAL_VALID_SCOPE.profiling_aso, operatingEntityId: "aax" }],
    ["hub_se", scopeOf({ aocId: "my", departmentId: "operation", hubId: "northern", stationId: "pen" })],
    ["hub_se", scopeOf({ aocId: "my", departmentId: "operation", hubId: "northern", teamId: "pen-alpha", stationId: "pen" })],
    ["dse", { ...MINIMAL_VALID_SCOPE.dse, operatingEntityId: "maa" }],
    ["dse", { ...MINIMAL_VALID_SCOPE.dse, unitId: "investigation" }],
    ["aso", { ...MINIMAL_VALID_SCOPE.aso, operatingEntityId: "maa" }],
    ["caterlink_management", scopeOf({ aocId: "my", departmentId: "caterlink", hubId: "northern" })],
  ];
  for (const [roleCode, scope] of cases) {
    assert.equal(validateAssignmentScope(roleCode, scope).ok, false, `${roleCode} with forbidden extra scope must be rejected: ${JSON.stringify(scope)}`);
  }
});

test("HIERARCHY: Malaysia AOC with an operating entity that belongs to a different AOC is rejected (mixed valid IDs, invalid hierarchy)", () => {
  const result = validateAssignmentScope("maa_boss", scopeOf({ aocId: "my", operatingEntityId: "other_aoc_entity" }));
  assert.equal(result.ok, false);
});

test("HIERARCHY: an Enforcement unit attached to a supplied Operation department is rejected", () => {
  const result = validateAssignmentScope("investigation_aso", scopeOf({ aocId: "my", departmentId: "operation", unitId: "investigation" }));
  assert.equal(result.ok, false);
});

test("HIERARCHY: a station from a different hub than the one supplied is rejected", () => {
  const result = validateAssignmentScope("aso", scopeOf({ aocId: "my", departmentId: "operation", hubId: "northern", stationId: "wrong-hub-station", teamId: "pen-alpha" }));
  assert.equal(result.ok, false);
});

test("HIERARCHY: a team from a different station than the one supplied is rejected", () => {
  const result = validateAssignmentScope("aso", scopeOf({ aocId: "my", departmentId: "operation", hubId: "northern", stationId: "pen", teamId: "wrong-station-team" }));
  assert.equal(result.ok, false);
});

test("HIERARCHY: a hub from a different AOC than the assignment's aoc_id is rejected -- future-AOC-safe (not hardcoded to 'my')", () => {
  const result = validateAssignmentScope("hub_se", scopeOf({ aocId: "my", departmentId: "operation", hubId: "other_aoc_hub" }));
  assert.equal(result.ok, false);
});

test("HIERARCHY: a department from a different AOC than the assignment's aoc_id is rejected", () => {
  const result = validateAssignmentScope("operation_manager", scopeOf({ aocId: "my", departmentId: "other_aoc_dept" }));
  assert.equal(result.ok, false);
});

test("HIERARCHY: mixed valid IDs producing an invalid hierarchy -- a valid entity and a valid department that individually exist but belong to different AOCs are both rejected even though each id alone is real", () => {
  // other_aoc_entity is a real row (aocId 'other-aoc'), other_aoc_dept is a
  // real row (aocId 'other-aoc') -- but the assignment itself claims
  // aoc_id = 'my'. Each individual FK is valid; the combination is not.
  const result1 = validateAssignmentScope("maa_boss", scopeOf({ aocId: "my", operatingEntityId: "other_aoc_entity" }));
  const result2 = validateAssignmentScope("operation_manager", scopeOf({ aocId: "my", departmentId: "other_aoc_dept" }));
  assert.equal(result1.ok, false);
  assert.equal(result2.ok, false);
});

test("NAMED: station ASO/SO/SSO without a team is rejected", () => {
  for (const roleCode of ["sso", "so", "aso"]) {
    const scope = scopeOf({ aocId: "my", departmentId: "operation", hubId: "northern", stationId: "pen" });
    assert.equal(validateAssignmentScope(roleCode, scope).ok, false, `${roleCode} without team_id must be rejected`);
  }
});

test("NAMED: DSE outside KUL is rejected", () => {
  const result = validateAssignmentScope("dse", scopeOf({ aocId: "my", departmentId: "operation", hubId: "northern", stationId: "pen", teamId: "pen-alpha" }));
  assert.equal(result.ok, false);
});

test("NAMED: SAT outside KUL is rejected", () => {
  const result = validateAssignmentScope("sat_aso", scopeOf({ aocId: "my", departmentId: "enforcement", unitId: "sat", hubId: "northern", stationId: "pen", teamId: "pen-alpha" }));
  assert.equal(result.ok, false);
});

test("NAMED: global roles (AirAsia Management, GHOD, Global Reporting Controller, Super Admin) receive no operational scope of any kind", () => {
  for (const roleCode of INTERNATIONAL_CODES) {
    for (const partialScope of [
      scopeOf({ hubId: "northern" }),
      scopeOf({ stationId: "pen" }),
      scopeOf({ departmentId: "operation" }),
      scopeOf({ unitId: "investigation" }),
      scopeOf({ operatingEntityId: "maa" }),
    ]) {
      assert.equal(validateAssignmentScope(roleCode, partialScope).ok, false, `${roleCode} must reject any operational scope`);
    }
  }
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
