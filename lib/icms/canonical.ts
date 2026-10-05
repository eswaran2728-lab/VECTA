// Pure canonical ICMS/CaterLink authorization (no framework imports).
//
// Merged operations model: there is ONE operational structure. ops_group
// (operation_avsec / ifc_avsec / hub_avsec) and the legacy public.users.role
// decide nothing. Authority is the caller's active Phase 3 assignments
// (role code + AOC/department/unit/hub/station/team scope), and CaterLink
// scanning/movement additionally requires the approved station-capability
// model (can_user_scan_caterlink / caterlink_station_capabilities).
import type { CanonicalAccess } from "../auth/canonical-access.ts";
import type { Role } from "./database.types";
import { isExternalCaterLinkRole } from "../auth/caterlink-access.ts";
import { ICMS_ADMIN_CODES, ICMS_REVIEW_CODES, ICMS_ARCHIVE_CODES } from "../auth/icms-admin-access.ts";

/** Canonical station-scoped operational roles that may scan / complete checkpoints. */
export const STATION_OPERATOR_CODES = ["aso", "so", "sso", "dse"] as const;

export { ICMS_ADMIN_CODES, ICMS_REVIEW_CODES, ICMS_ARCHIVE_CODES };

/** Legacy ICMS role names that have NO canonical equivalent: external CaterLink parties. */
export const EXTERNAL_ICMS_ROLES: readonly Role[] = ["vendor", "warehouse_pic"];
/** Legacy checkpoint role names; completing them is a station-operator capability, not a role. */
export const CHECKPOINT_ROLES: readonly Role[] = ["post2_avsec", "post6_avsec", "redq_avsec", "receiver", "hub_avsec"];

export function isExternalIcmsRole(role: string | null | undefined): boolean {
  // single definition shared with the middleware and every other gate (lib/auth/caterlink-access.ts)
  return isExternalCaterLinkRole(role);
}

function has(access: CanonicalAccess, codes: readonly string[]): boolean {
  return access.hasAssignment && !access.isSuperAdmin && access.roleCodes.some((c) => codes.includes(c));
}

export function isStationOperator(access: CanonicalAccess): boolean {
  return has(access, STATION_OPERATOR_CODES);
}

/**
 * Canonical decision for a legacy ICMS role list used by a page/action gate.
 * External roles (vendor, warehouse_pic) are never satisfied canonically.
 * Checkpoint roles are satisfied by any station operator; the station
 * capability and on-duty requirements are enforced separately by the caller.
 */
export function satisfiesIcmsRoles(access: CanonicalAccess, roles: readonly Role[]): boolean {
  for (const role of roles) {
    if (role === "supervisor" && has(access, ICMS_ADMIN_CODES)) return true;
    if (role === "enforcement" && has(access, ["main_enforcement"])) return true;
    if (role === "management" && has(access, ["operation_manager"])) return true;
    if ((CHECKPOINT_ROLES as readonly string[]).includes(role) && isStationOperator(access)) return true;
    if (role === "ops_staff" && isStationOperator(access)) return true;
  }
  return false;
}

/** Whether `roles` is entirely external-party roles (handled by the external identity path). */
export function isExternalOnlyRoleList(roles: readonly Role[]): boolean {
  return roles.length > 0 && roles.every((r) => (EXTERNAL_ICMS_ROLES as readonly string[]).includes(r));
}

/** Display-only ICMS role string for a canonical account. Never used to authorise. */
export function icmsDisplayRole(access: CanonicalAccess): Role {
  if (has(access, ICMS_ADMIN_CODES)) return "supervisor";
  if (has(access, ["operation_manager"])) return "management";
  if (has(access, ["main_enforcement"])) return "enforcement";
  return "ops_staff";
}

/**
 * Hub-destination rule: at the Part Hub step only the destination hub station
 * may proceed. Station codes, not any group, decide this.
 */
export function hubDestinationError(args: {
  nextStepPart: string | null | undefined;
  route: string;
  hubDestination: string | null | undefined;
  userStation: string | null | undefined;
}): string | null {
  if (args.route !== "HUB" || args.nextStepPart !== "part_hub" || !args.hubDestination) return null;
  if (args.userStation === args.hubDestination) return null;
  return `This Hub transaction is destined for ${args.hubDestination}, not your station (${args.userStation ?? "none"}).`;
}

export interface CheckpointDecision {
  allowed: boolean;
  reason: "ok" | "not_station_operator" | "no_station" | "station_cannot_scan" | "profiling_excluded";
}

/** Pure checkpoint decision once the station capability result is known. */
export function decideCheckpointAccess(access: CanonicalAccess, stationCanScan: boolean | null | undefined): CheckpointDecision {
  if (has(access, ["profiling_so", "profiling_aso"])) return { allowed: false, reason: "profiling_excluded" };
  if (!isStationOperator(access)) return { allowed: false, reason: "not_station_operator" };
  if (!access.stationCode) return { allowed: false, reason: "no_station" };
  if (stationCanScan !== true) return { allowed: false, reason: "station_cannot_scan" };
  return { allowed: true, reason: "ok" };
}
