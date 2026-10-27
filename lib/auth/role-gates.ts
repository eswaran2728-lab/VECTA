/**
 * Canonical role-code gates for the few actions whose authority is a specific canonical role, not a legacy rank. Pure (no framework imports).
 * The legacy compat rank maps hub_se onto "DSE" and operation_manager onto "MANAGEMENT", so a rank list cannot say "Hub SE" or "Operation Manager
 * only" on its own; these gates read the caller's ACTIVE canonical assignments instead. They decide what an action attempts; the database
 * (can_manage_roster_secure, the duty_zones and absence_notices policies, the secure review RPCs) re-checks the exact station / team / hub every time.
 */
import type { CanonicalAccess } from "./canonical-access";

/** Roster cell / team schedule writes: Operation Manager (any station), Hub SE (stations of the assigned hub), DSE (own station AND team). */
export const ROSTER_MANAGER_ROLE_CODES: readonly string[] = ["operation_manager", "hub_se", "dse"];

/** Duty geofence zone creation, editing and activation/deactivation: Operation Manager only. */
export const ZONE_ADMIN_ROLE_CODES: readonly string[] = ["operation_manager"];

export function accessHasAnyRoleCode(access: Pick<CanonicalAccess, "hasAssignment" | "isSuperAdmin" | "roleCodes">, codes: readonly string[]): boolean {
  if (!access.hasAssignment || access.isSuperAdmin) return false;
  return access.roleCodes.some((c) => codes.includes(c));
}
