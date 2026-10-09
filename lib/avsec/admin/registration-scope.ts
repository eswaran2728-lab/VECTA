/**
 * Which assignment scope fields a role needs, mirroring validate_user_role_assignment_scope() in the database. This only drives the
 * form (which selectors to show and mark required); the database trigger stays the authority and rejects anything else.
 * AOC and operating entity are never selectable: both are fixed from the registration request / the approving admin's own entity.
 */
export type ScopeField = "department" | "unit" | "hub" | "station" | "team";

const STATION_STAFF: ScopeField[] = ["department", "hub", "station", "team"];

export const REQUIRED_SCOPE_BY_ROLE: Readonly<Record<string, readonly ScopeField[]>> = {
  aso: STATION_STAFF,
  so: STATION_STAFF,
  sso: STATION_STAFF,
  dse: STATION_STAFF,
  hub_se: ["department", "hub"],
  investigation_sso: ["department", "unit"],
  investigation_so: ["department", "unit"],
  investigation_aso: ["department", "unit"],
  sat_aso: ["department", "unit", "hub", "station", "team"],
  profiling_so: ["department", "unit", "hub", "station", "team"],
  profiling_aso: ["department", "unit", "hub", "station", "team"],
};

/** Roles an entity admin may never assign (also excluded by the options RPC and refused again by approve_registration_request). */
export const PROTECTED_ROLE_CODES: readonly string[] = [
  "airasia_management",
  "ghod",
  "global_reporting_controller",
  "super_admin",
  "maa_boss",
  "aax_boss",
  "maa_admin",
  "aax_admin",
  "operation_manager",
  "main_enforcement",
  "compliance",
  "caterlink_management",
];

export function requiredScopeFields(roleCode: string): readonly ScopeField[] | null {
  return REQUIRED_SCOPE_BY_ROLE[roleCode] ?? null;
}

export interface ScopeSelection {
  departmentId?: string | null;
  unitId?: string | null;
  hubId?: string | null;
  stationId?: string | null;
  teamId?: string | null;
}

/** Client-side convenience check only; returns the first missing field label, or null when complete. */
export function firstMissingScopeField(roleCode: string, sel: ScopeSelection): ScopeField | null {
  const required = requiredScopeFields(roleCode);
  if (!required) return null;
  const present: Record<ScopeField, boolean> = {
    department: Boolean(sel.departmentId),
    unit: Boolean(sel.unitId),
    hub: Boolean(sel.hubId),
    station: Boolean(sel.stationId),
    team: Boolean(sel.teamId),
  };
  return required.find((f) => !present[f]) ?? null;
}
