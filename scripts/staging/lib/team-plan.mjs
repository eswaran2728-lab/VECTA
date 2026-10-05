// Organisational team plan and exact test-account inventory (pure; no I/O).
//
// RULE: no team name is invented. A team exists in this plan only where the
// repository or live legacy data establishes it. Every other station that
// needs a team is reported as BLOCKED until the user decides.
import { ESTABLISHED_TEAMS, DEFAULT_TEAM_BY_STATION, TeamNotEstablishedError, teamNameForStation } from "./team-constants.mjs";
export { ESTABLISHED_TEAMS, DEFAULT_TEAM_BY_STATION, TeamNotEstablishedError, teamNameForStation };
import { ALL_ROLE_CODES, INTERNATIONAL_ROLES, ENTITY_LEADERSHIP_ROLES, DEPARTMENT_LEADERSHIP_ROLES, INVESTIGATION_ROLES, SAT_ROLES, PROFILING_ROLES, HUB_SE_ROLES, DSE_ROLES, STATION_ROLES } from "./role-matrix.mjs";

// Station -> hub (live staging org_stations / Phase 2 seed).
export const STATION_HUB = {
  "KUL - MAA": "kul",
  PEN: "northern",
  JHB: "southern_east_coast",
  BTU: "sarawak",
};

// Deterministic "station with no CaterLink scanning": the alphabetically
// first of the 11 org_stations with no caterlink_station_capabilities row
// (live: BTU, KBR, KUA, LBU, MKZ, MYY, SBW, SDK, SZB, TGG, TWU).
export const NO_CATERLINK_STATION = "BTU";

// Default station for station-scoped roles when none is specified
// (mirrors resolveRoleScope in role-matrix.mjs).
export const DEFAULT_STATION = { sat_aso: "KUL - MAA", dse: "KUL - MAA" };
export const FALLBACK_STATION = "PEN";
// Negative-state accounts test authorization state, not geography, so they
// use the one station whose team is established.
export const NEGATIVE_STATE_STATION = "KUL - MAA";

export const STATION_VARIANTS = [
  { label: "kul", stationCode: "KUL - MAA" },
  { label: "jhb", stationCode: "JHB" },
];
export const NEGATIVE_STATES = ["pending", "rejected", "deactivated", "revoked", "expired", "future_dated", "foreign_aoc"];

export function needsTeam(roleCode) {
  return [...SAT_ROLES, ...PROFILING_ROLES, ...DSE_ROLES, ...STATION_ROLES].includes(roleCode);
}

// Pure description of one account's scope, by CODE.
export function describeRoleScope(roleCode, { stationCode, entityCode = "MAA" } = {}) {
  const base = { aoc: "MY", entity: null, department: null, unit: null, hub: null, station: null, team: null, membership: null };
  if (INTERNATIONAL_ROLES.includes(roleCode)) return { ...base, aoc: null };
  if (ENTITY_LEADERSHIP_ROLES.includes(roleCode)) return { ...base, entity: roleCode.startsWith("maa_") ? "MAA" : "AAX" };
  if (DEPARTMENT_LEADERSHIP_ROLES.includes(roleCode)) {
    return { ...base, department: { operation_manager: "operation", main_enforcement: "enforcement", compliance: "compliance", caterlink_management: "caterlink" }[roleCode] };
  }
  const enforcement = [...INVESTIGATION_ROLES, ...SAT_ROLES, ...PROFILING_ROLES].includes(roleCode);
  const scope = { ...base, department: enforcement ? "enforcement" : "operation", membership: entityCode };
  if (INVESTIGATION_ROLES.includes(roleCode)) return { ...scope, unit: "investigation" };
  if (SAT_ROLES.includes(roleCode)) scope.unit = "sat";
  if (PROFILING_ROLES.includes(roleCode)) scope.unit = "profiling";
  const station = stationCode ?? DEFAULT_STATION[roleCode] ?? FALLBACK_STATION;
  scope.hub = STATION_HUB[station] ?? null;
  if (HUB_SE_ROLES.includes(roleCode)) return scope;
  scope.station = station;
  scope.team = teamNameForStation(station);
  return scope;
}

// status values: ready_now | needs_kul_team_seed | blocked_team_not_established | impossible_no_second_aoc
function statusFor(roleCode, scope, isForeignAoc) {
  if (isForeignAoc) return { status: "impossible_no_second_aoc", reason: "only one AOC (MY) exists; a foreign-AOC account needs a second active AOC" };
  if (!needsTeam(roleCode)) return { status: "ready_now", reason: null };
  if (scope.team) return { status: "needs_kul_team_seed", reason: `org_teams row '${scope.team}' at '${scope.station}' must be seeded first` };
  return { status: "blocked_team_not_established", reason: `no team is established for station '${scope.station}'` };
}

export function buildAccountPlan() {
  const plan = [];
  for (const roleCode of ALL_ROLE_CODES) {
    const scope = describeRoleScope(roleCode);
    plan.push({ kind: "base", label: roleCode, roleCode, accountStatus: "approved", scope, ...statusFor(roleCode, scope, false) });
  }
  for (const v of STATION_VARIANTS) {
    for (const roleCode of STATION_ROLES) {
      const scope = describeRoleScope(roleCode, { stationCode: v.stationCode });
      plan.push({ kind: "station_variant", label: `${roleCode}-${v.label}`, roleCode, accountStatus: "approved", scope, ...statusFor(roleCode, scope, false) });
    }
  }
  const ncScope = describeRoleScope("aso", { stationCode: NO_CATERLINK_STATION });
  plan.push({ kind: "station_variant", label: "aso-no-caterlink", roleCode: "aso", accountStatus: "approved", scope: ncScope, ...statusFor("aso", ncScope, false) });
  for (const state of NEGATIVE_STATES) {
    const scope = describeRoleScope("aso", { stationCode: NEGATIVE_STATE_STATION });
    plan.push({ kind: "negative", label: `neg-${state.replace("_", "-")}`, roleCode: "aso", accountStatus: state, scope, ...statusFor("aso", scope, state === "foreign_aoc") });
  }
  return plan;
}

export function summarizePlan(plan = buildAccountPlan()) {
  const count = (pred) => plan.filter(pred).length;
  return {
    base: count((a) => a.kind === "base"),
    stationVariants: count((a) => a.kind === "station_variant"),
    negative: count((a) => a.kind === "negative"),
    totalPlanned: plan.length,
    readyNow: count((a) => a.status === "ready_now"),
    needsKulTeamSeed: count((a) => a.status === "needs_kul_team_seed"),
    blockedTeamNotEstablished: count((a) => a.status === "blocked_team_not_established"),
    impossibleNoSecondAoc: count((a) => a.status === "impossible_no_second_aoc"),
    creatableWithCurrentData: plan.length - count((a) => a.status === "impossible_no_second_aoc"),
    needTeamId: count((a) => needsTeam(a.roleCode)),
  };
}
