// Phase "dashboard/role-workspaces-adjustment": the authoritative role
// scope matrix, transcribed EXACTLY from
// public.validate_user_role_assignment_scope() and
// public.validate_assignment_entity_membership()
// (supabase/migrations/20260928000002_phase3_role_permission_foundation.sql,
// 20260928000003_phase4_registration_approval_admin.sql) -- never
// independently guessed. If either trigger function is ever changed, this
// file must be updated to match, and verify-phase13 (or a future phase's)
// test suite is the thing that would actually catch a drift, not this
// file's own comments.
//
// Each entry describes WHAT scope columns a role needs and how to
// resolve them by CODE (never a hardcoded id) against whatever Malaysia
// AOC data already exists in the target project.

import { TeamNotEstablishedError, teamNameForStation } from "./team-constants.mjs";

export const INTERNATIONAL_ROLES = ["airasia_management", "ghod", "global_reporting_controller", "super_admin"];
export const ENTITY_LEADERSHIP_ROLES = ["maa_boss", "maa_admin", "aax_boss", "aax_admin"];
export const DEPARTMENT_LEADERSHIP_ROLES = ["operation_manager", "main_enforcement", "compliance", "caterlink_management"];
export const INVESTIGATION_ROLES = ["investigation_sso", "investigation_so", "investigation_aso"];
export const SAT_ROLES = ["sat_aso"];
export const PROFILING_ROLES = ["profiling_so", "profiling_aso"];
export const HUB_SE_ROLES = ["hub_se"];
export const DSE_ROLES = ["dse"];
export const STATION_ROLES = ["sso", "so", "aso"];

export const ALL_ROLE_CODES = [
  ...INTERNATIONAL_ROLES,
  ...ENTITY_LEADERSHIP_ROLES,
  ...DEPARTMENT_LEADERSHIP_ROLES,
  ...INVESTIGATION_ROLES,
  ...SAT_ROLES,
  ...PROFILING_ROLES,
  ...HUB_SE_ROLES,
  ...DSE_ROLES,
  ...STATION_ROLES,
];

// Roles that MUST carry entity_membership_id = NULL
// (validate_assignment_entity_membership).
export const PROTECTED_ROLES_NO_MEMBERSHIP = new Set([...INTERNATIONAL_ROLES, ...ENTITY_LEADERSHIP_ROLES, ...DEPARTMENT_LEADERSHIP_ROLES]);

// Roles that MUST carry a non-null, active entity_membership_id.
export const ORDINARY_ROLES_REQUIRE_MEMBERSHIP = new Set([...INVESTIGATION_ROLES, ...SAT_ROLES, ...PROFILING_ROLES, ...HUB_SE_ROLES, ...DSE_ROLES, ...STATION_ROLES]);

/**
 * Resolves the scope columns for one role code against a given admin
 * client. `opts.entityCode` picks MAA/AAX for maa_-prefixed/aax_-prefixed roles and for
 * the entity membership every ordinary role needs. `opts.stationCode`
 * overrides the default station for station-scoped roles (used to
 * generate the KUL/PEN/JHB/no-CaterLink variants). Returns a plain object
 * matching user_role_assignments' own scope columns, plus a resolved
 * `entityMembershipNeeded` boolean the caller uses to create the
 * membership row first.
 *
 * Every lookup is BY CODE, never a hardcoded id -- this function throws a
 * clear error naming the missing code rather than silently skipping a
 * role if the target project's seed data doesn't have what's expected.
 */
export async function resolveRoleScope(client, roleCode, opts = {}) {
  const entityCode = opts.entityCode ?? "MAA";
  const stationCode = opts.stationCode ?? null;

  const { data: myAoc, error: aocError } = await client.from("aocs").select("id, code").eq("code", "MY").single();
  if (aocError || !myAoc) throw new Error(`Could not resolve the Malaysia AOC (code='MY'): ${aocError?.message}`);

  if (INTERNATIONAL_ROLES.includes(roleCode)) {
    return { aoc_id: null, operating_entity_id: null, department_id: null, unit_id: null, hub_id: null, station_id: null, team_id: null, entityMembershipNeeded: false };
  }

  if (ENTITY_LEADERSHIP_ROLES.includes(roleCode)) {
    const wantEntity = roleCode.startsWith("maa_") ? "MAA" : "AAX";
    const { data: entity, error } = await client.from("operating_entities").select("id").eq("aoc_id", myAoc.id).eq("code", wantEntity).single();
    if (error || !entity) throw new Error(`Could not resolve operating entity '${wantEntity}' for role ${roleCode}: ${error?.message}`);
    return { aoc_id: myAoc.id, operating_entity_id: entity.id, department_id: null, unit_id: null, hub_id: null, station_id: null, team_id: null, entityMembershipNeeded: false };
  }

  if (DEPARTMENT_LEADERSHIP_ROLES.includes(roleCode)) {
    const deptCode = { operation_manager: "operation", main_enforcement: "enforcement", compliance: "compliance", caterlink_management: "caterlink" }[roleCode];
    const { data: dept, error } = await client.from("departments").select("id").eq("aoc_id", myAoc.id).eq("code", deptCode).single();
    if (error || !dept) throw new Error(`Could not resolve department '${deptCode}' for role ${roleCode}: ${error?.message}`);
    return { aoc_id: myAoc.id, operating_entity_id: null, department_id: dept.id, unit_id: null, hub_id: null, station_id: null, team_id: null, entityMembershipNeeded: false };
  }

  // Everything below requires an entity membership and department=enforcement/operation.
  const needsEnforcementUnit = [...INVESTIGATION_ROLES, ...SAT_ROLES, ...PROFILING_ROLES].includes(roleCode);
  const deptCode = needsEnforcementUnit ? "enforcement" : "operation";
  const { data: dept, error: deptError } = await client.from("departments").select("id").eq("aoc_id", myAoc.id).eq("code", deptCode).single();
  if (deptError || !dept) throw new Error(`Could not resolve department '${deptCode}' for role ${roleCode}: ${deptError?.message}`);

  let unitId = null;
  if (INVESTIGATION_ROLES.includes(roleCode) || SAT_ROLES.includes(roleCode) || PROFILING_ROLES.includes(roleCode)) {
    const unitCode = INVESTIGATION_ROLES.includes(roleCode) ? "investigation" : SAT_ROLES.includes(roleCode) ? "sat" : "profiling";
    const { data: unit, error } = await client.from("units").select("id").eq("department_id", dept.id).eq("code", unitCode).single();
    if (error || !unit) throw new Error(`Could not resolve unit '${unitCode}' for role ${roleCode}: ${error?.message}`);
    unitId = unit.id;
  }

  if (INVESTIGATION_ROLES.includes(roleCode)) {
    return { aoc_id: myAoc.id, operating_entity_id: null, department_id: dept.id, unit_id: unitId, hub_id: null, station_id: null, team_id: null, entityMembershipNeeded: true, membershipEntityCode: entityCode };
  }

  // SAT, Profiling, Hub SE, DSE, and station SSO/SO/ASO all need a
  // resolved hub/station/team. SAT and DSE are KUL-hub-only by trigger
  // rule; Profiling and station roles accept any hub/station (the
  // station's own hub is looked up, not independently chosen).
  let station;
  if (stationCode) {
    const { data, error } = await client.from("org_stations").select("id, code, hub_id, hubs:hub_id(code)").eq("code", stationCode).single();
    if (error || !data) throw new Error(`Could not resolve station '${stationCode}': ${error?.message}`);
    station = data;
  } else if (SAT_ROLES.includes(roleCode) || DSE_ROLES.includes(roleCode)) {
    const { data, error } = await client.from("org_stations").select("id, code, hub_id, hubs:hub_id(code)").eq("code", "KUL - MAA").single();
    if (error || !data) throw new Error(`Could not resolve the default KUL station for role ${roleCode}: ${error?.message}`);
    station = data;
  } else {
    const { data, error } = await client.from("org_stations").select("id, code, hub_id, hubs:hub_id(code)").eq("code", "PEN").single();
    if (error || !data) throw new Error(`Could not resolve the default PEN station for role ${roleCode}: ${error?.message}`);
    station = data;
  }

  if (SAT_ROLES.includes(roleCode) || DSE_ROLES.includes(roleCode)) {
    if (station.hubs?.code !== "kul") {
      throw new Error(`${roleCode} requires a KUL-hub station; resolved station '${station.code}' is on hub '${station.hubs?.code}'.`);
    }
  }

  if (HUB_SE_ROLES.includes(roleCode)) {
    return { aoc_id: myAoc.id, operating_entity_id: null, department_id: dept.id, unit_id: null, hub_id: station.hub_id, station_id: null, team_id: null, entityMembershipNeeded: true, membershipEntityCode: entityCode };
  }

  // Teams are NEVER created or invented here. The team must already exist in
  // org_teams (seeded from the established plan by seed-org-teams.mjs).
  const teamName = opts.teamName ?? teamNameForStation(station.code);
  if (!teamName) throw new TeamNotEstablishedError(roleCode, station.code, null);
  const { data: team, error: teamError } = await client
    .from("org_teams")
    .select("id")
    .eq("station_id", station.id)
    .eq("name", teamName)
    .maybeSingle();
  if (teamError) throw new Error(`Could not look up team '${teamName}' at station '${station.code}' for role ${roleCode}: ${teamError.message}`);
  if (!team) throw new TeamNotEstablishedError(roleCode, station.code, teamName);
  return {
    aoc_id: myAoc.id,
    operating_entity_id: null,
    department_id: dept.id,
    unit_id: unitId,
    hub_id: station.hub_id,
    station_id: station.id,
    team_id: team.id,
    entityMembershipNeeded: true,
    membershipEntityCode: entityCode,
  };
}
