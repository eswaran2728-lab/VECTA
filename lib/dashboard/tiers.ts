/**
 * Pure, server-free helpers for Phase 7 dashboard-context resolution --
 * split out from context.ts (which imports the Supabase server client) so
 * this logic can be unit-tested directly under plain Node, the same way
 * lib/icms/ops-group.ts is.
 */
export interface RoleAssignmentContext {
  roleCode: string;
  roleCategory: string;
  aocCode: string | null;
  operatingEntityCode: string | null;
  departmentCode: string | null;
  unitCode: string | null;
  hubCode: string | null;
  stationCode: string | null;
  teamName: string | null;
  startsAt: string;
  endsAt: string | null;
}

/** A stable identity for one assignment, for context-selection UI/URLs. Not
 *  a database id (get_my_active_role_assignments deliberately doesn't
 *  expose row ids -- self-read-only, see Phase 3 migration) -- built from
 *  the tuple of scope fields, which is unique per active assignment because
 *  the Phase 3 scope-shape trigger allows only one active assignment per
 *  (profile, role, scope). */
export function assignmentKey(a: RoleAssignmentContext): string {
  return [
    a.roleCode,
    a.aocCode,
    a.operatingEntityCode,
    a.departmentCode,
    a.unitCode,
    a.hubCode,
    a.stationCode,
    a.teamName,
  ].join("|");
}

const INTERNATIONAL_ROLES = new Set(["airasia_management", "ghod", "global_reporting_controller", "super_admin"]);
const MALAYSIA_LEADERSHIP_ROLES = new Set([
  "maa_boss",
  "aax_boss",
  "maa_admin",
  "aax_admin",
  "operation_manager",
  "main_enforcement",
  "compliance",
  "caterlink_management",
]);
const ENFORCEMENT_ROLES = new Set([
  "investigation_sso",
  "investigation_so",
  "investigation_aso",
  "sat_aso",
  "profiling_so",
  "profiling_aso",
]);
const OPERATION_ROLES = new Set(["hub_se", "dse", "sso", "so", "aso"]);

export type DashboardTier = "international" | "malaysia_leadership" | "enforcement" | "operation" | "unknown";

export function tierForRoleCode(roleCode: string): DashboardTier {
  if (INTERNATIONAL_ROLES.has(roleCode)) return "international";
  if (MALAYSIA_LEADERSHIP_ROLES.has(roleCode)) return "malaysia_leadership";
  if (ENFORCEMENT_ROLES.has(roleCode)) return "enforcement";
  if (OPERATION_ROLES.has(roleCode)) return "operation";
  return "unknown";
}
