// Organisational team plan and exact test-account inventory (pure; no I/O).
//
// RULE: no team name is invented. A team exists in this plan only where the
// repository or live legacy data establishes it. Every other station that
// needs a team is reported as BLOCKED until the user decides.
import { APPROVED_TEAMS, ESTABLISHED_TEAMS, DEFAULT_TEAM_BY_STATION, TeamNotEstablishedError, teamNameForStation } from "./team-constants.mjs";
export { APPROVED_TEAMS, ESTABLISHED_TEAMS, DEFAULT_TEAM_BY_STATION, TeamNotEstablishedError, teamNameForStation };
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
// foreign_aoc is excluded by user decision (Malaysia AOC only).
export const NEGATIVE_STATES = ["pending", "rejected", "deactivated", "revoked", "expired", "future_dated"];

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

// status values: ready_now (no team needed) | needs_team_seed (team approved, row not yet seeded)
function statusFor(roleCode) {
  return needsTeam(roleCode)
    ? { status: "needs_team_seed", reason: "the approved org_teams row must be seeded first" }
    : { status: "ready_now", reason: null };
}

// Expected experience per canonical role. Workspace and feature lists mirror
// lib/dashboard/linkHubConfig.ts and the Phase 7 dashboards; denied lists are
// enforced by lib/auth/route-access.ts, the Phase 3-13 RPCs and RLS.
export const ROLE_EXPERIENCE = {
  airasia_management: { workspace: "/avsec/my-dashboard (Executive Dashboard)", allowed: ["international executive overview"], denied: ["operational pages", "report content write", "/super-admin"] },
  ghod: { workspace: "/avsec/my-dashboard (Executive Dashboard)", allowed: ["international executive overview"], denied: ["operational pages", "/super-admin"] },
  global_reporting_controller: { workspace: "/avsec/my-dashboard (Global Reporting Controller)", allowed: ["Report Search", "Export / Filters"], denied: ["Super Admin technical controls", "duty / roster"] },
  super_admin: { workspace: "/super-admin (portal) and /super-admin/readiness", allowed: ["organisation manager", "release readiness", "technical status"], denied: ["/avsec, /icms, /caterlink operational routes"] },
  maa_boss: { workspace: "/avsec/my-dashboard (Entity Dashboard, MAA)", allowed: ["MAA entity overview"], denied: ["AAX entity data", "operational pages"] },
  maa_admin: { workspace: "/avsec/my-dashboard (Entity Admin, MAA)", allowed: ["MAA registration approvals"], denied: ["AAX registrations", "protected-role grants"] },
  aax_boss: { workspace: "/avsec/my-dashboard (Entity Dashboard, AAX)", allowed: ["AAX entity overview"], denied: ["MAA entity data", "operational pages"] },
  aax_admin: { workspace: "/avsec/my-dashboard (Entity Admin, AAX)", allowed: ["AAX registration approvals"], denied: ["MAA registrations", "protected-role grants"] },
  operation_manager: { workspace: "/avsec/my-dashboard (Operation Manager) + legacy management pages", allowed: ["Operation department overview", "management pages (MANAGEMENT rank)", "/avsec/admin"], denied: ["Enforcement-only content", "/super-admin"] },
  main_enforcement: { workspace: "/avsec/my-dashboard (Main Enforcement)", allowed: ["Report Search", "Enforcement Search", "SEC013", "hub breakdown"], denied: ["/avsec/admin", "Operation-only management"] },
  compliance: { workspace: "/avsec/my-dashboard (Compliance, read-only)", allowed: ["Report Search"], denied: ["any write", "enforcement search", "duty"] },
  caterlink_management: { workspace: "/avsec/my-dashboard (CaterLink Management)", allowed: ["CaterLink overview, transactions, incidents, whitelist, archive (canonical ICMS identity adapter)"], denied: ["unrelated AVSEC report content"] },
  investigation_sso: { workspace: "/avsec/my-dashboard (Investigation SSO)", allowed: ["Report Search", "Enforcement Search"], denied: ["checkpoint scanner", "duty"] },
  investigation_so: { workspace: "/avsec/my-dashboard (Investigation SO)", allowed: ["Report Search", "Enforcement Search"], denied: ["checkpoint scanner", "duty"] },
  investigation_aso: { workspace: "/avsec/my-dashboard (Investigation ASO)", allowed: ["Report Search", "Enforcement Search"], denied: ["checkpoint scanner", "duty"] },
  sat_aso: { workspace: "/avsec/my-dashboard (SAT ASO, KUL)", allowed: ["Duty Terminal & Check-In", "Bay Board", "Report Search"], denied: ["other hubs", "enforcement search"] },
  profiling_so: { workspace: "/avsec/my-dashboard (Profiling SO)", allowed: ["SEC013", "Duty", "Report Search"], denied: ["CaterLink checkpoint scanner"] },
  profiling_aso: { workspace: "/avsec/my-dashboard (Profiling ASO)", allowed: ["SEC013", "Duty", "Report Search"], denied: ["CaterLink checkpoint scanner"] },
  hub_se: { workspace: "/avsec/my-dashboard (Hub SE)", allowed: ["Leave", "OT", "Bay Board", "Report Search", "hub breakdown"], denied: ["other hubs", "duty check-in (not shift staff)"] },
  dse: { workspace: "/avsec/my-dashboard (KUL DSE)", allowed: ["Roster", "Leave", "OT", "Bay Board", "Duty"], denied: ["other teams", "report search"] },
  sso: { workspace: "/avsec/my-dashboard (SSO)", allowed: ["Duty", "Bay Board", "Report Search", "scanner (CaterLink-capable station)"], denied: ["other stations/teams", "management pages"] },
  so: { workspace: "/avsec/my-dashboard (SO)", allowed: ["Duty", "Bay Board", "Report Search", "scanner (CaterLink-capable station)"], denied: ["other stations/teams", "management pages"] },
  aso: { workspace: "/avsec/my-dashboard (ASO)", allowed: ["Duty", "Bay Board", "scanner (CaterLink-capable station)"], denied: ["report search", "management pages", "other stations/teams"] },
};

const NEGATIVE_EXPERIENCE = {
  pending: { loginState: "signs in, profile status pending", workspace: "/avsec/pending-approval (Waiting for admin approval)" },
  rejected: { loginState: "signs in, profile status rejected", workspace: "/avsec/pending-approval (Access request declined)" },
  deactivated: { loginState: "signs in, profile status deactivated", workspace: "/avsec/pending-approval (Account deactivated)" },
  revoked: { loginState: "signs in, approved, assignment revoked", workspace: "/avsec/pending-approval (No workspace assigned yet)" },
  expired: { loginState: "signs in, approved, assignment expired", workspace: "/avsec/pending-approval (No workspace assigned yet)" },
  future_dated: { loginState: "signs in, approved, assignment not yet effective", workspace: "/avsec/pending-approval (No workspace assigned yet)" },
};

function experienceFor(roleCode, accountStatus) {
  if (accountStatus !== "approved") {
    const n = NEGATIVE_EXPERIENCE[accountStatus];
    return { loginState: n.loginState, workspace: n.workspace, allowed: [], denied: ["every operational route and server action"] };
  }
  const e = ROLE_EXPERIENCE[roleCode];
  return { loginState: "signs in, approved, active assignment", workspace: e.workspace, allowed: e.allowed, denied: e.denied };
}

// Legacy compatibility profile fields (display / legacy-RLS compat; never authority).
import { COMPAT_ROLE_BY_CANONICAL } from "../../../lib/auth/compat-role-map.mjs";
export function legacyProfileFor(roleCode, scope) {
  return { role: COMPAT_ROLE_BY_CANONICAL[roleCode] ?? "ASO", station: scope.station, team: scope.team };
}

// CaterLink capability for the account, per the approved station-capability model
// (can_user_scan_caterlink). No capability is invented here: scanning is decided at run time by the
// station row in caterlink_station_capabilities; BTU is the established no-CaterLink test station.
const SCAN_ROLES = ["aso", "so", "sso", "dse"];
export function caterlinkCapabilityFor(roleCode, accountStatus, scope) {
  if (accountStatus !== "approved") return "denied: account state fails closed";
  if (roleCode === "caterlink_management") return "administration dashboards and archive only; never scans";
  if (!SCAN_ROLES.includes(roleCode)) return "none (no CaterLink checkpoint authority)";
  if (scope.station === NO_CATERLINK_STATION) return "denied: station has no CaterLink capability";
  return "scan/movement allowed only where the station holds the capability (can_user_scan_caterlink)";
}

function entry(kind, label, roleCode, accountStatus, scope) {
  return {
    kind, label, roleCode, accountStatus, scope, membershipRequired: Boolean(scope.membership),
    positiveOrNegative: accountStatus === "approved" ? "positive" : "negative",
    caterlinkCapability: caterlinkCapabilityFor(roleCode, accountStatus, scope),
    legacyCompatRank: COMPAT_ROLE_BY_CANONICAL[roleCode] ?? null, // display / legacy-RLS compat only; never authority
    // The ICMS identity is an adapter over the same Auth UUID (profile + canonical assignments);
    // no public.users row is created or required for any of the 36 accounts.
    icmsBridgeRowRequired: false,
    ...statusFor(roleCode), ...experienceFor(roleCode, accountStatus),
  };
}

export function buildAccountPlan() {
  const plan = [];
  for (const roleCode of ALL_ROLE_CODES) plan.push(entry("base", roleCode, roleCode, "approved", describeRoleScope(roleCode)));
  for (const v of STATION_VARIANTS) {
    for (const roleCode of STATION_ROLES) plan.push(entry("station_variant", `${roleCode}-${v.label}`, roleCode, "approved", describeRoleScope(roleCode, { stationCode: v.stationCode })));
  }
  plan.push(entry("station_variant", "aso-no-caterlink", "aso", "approved", describeRoleScope("aso", { stationCode: NO_CATERLINK_STATION })));
  for (const state of NEGATIVE_STATES) {
    plan.push(entry("negative", `neg-${state.replace("_", "-")}`, "aso", state, describeRoleScope("aso", { stationCode: NEGATIVE_STATE_STATION })));
  }
  return plan;
}

export function summarizePlan(plan = buildAccountPlan()) {
  const count = (pred) => plan.filter(pred).length;
  return {
    base: count((a) => a.kind === "base"),
    stationVariants: count((a) => a.kind === "station_variant"),
    negative: count((a) => a.kind === "negative"),
    total: plan.length,
    readyNow: count((a) => a.status === "ready_now"),
    needsTeamSeed: count((a) => a.status === "needs_team_seed"),
    needTeamId: count((a) => needsTeam(a.roleCode)),
  };
}
