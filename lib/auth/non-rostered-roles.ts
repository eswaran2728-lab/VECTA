/**
 * Roles that have NO roster: they never work the Duty Terminal, Check In/Out, personal Leave, personal Overtime, Timesheet, handover or
 * any other attendance mutation. The decision comes from the single capability table (lib/auth/role-capabilities.ts) so navigation,
 * the server guards and the tests share ONE definition. Unknown roles are denied too (fail closed).
 *
 * Oversight roles (operation_manager, main_enforcement) are NOT blocked: they use the shared approval queues. hub_se keeps Duty.
 */
import { mayUseAttendanceSurface, ROLE_CAPABILITIES } from "./role-capabilities.ts";

/** Explicit, documented list of the roles that are non-rostered (derived: not rostered and not an attendance-oversight role). */
export const NON_ROSTERED_LEADERSHIP_ROLES: readonly string[] = Object.keys(ROLE_CAPABILITIES).filter((c) => !mayUseAttendanceSurface([c]) && c !== "caterlink_management");

/** True when the caller holds at least one role and NONE of them may use the attendance surface. A mixed profile keeps its roster role. */
export function isNonRosteredLeadership(roleCodes: readonly string[]): boolean {
  return roleCodes.length > 0 && !mayUseAttendanceSurface(roleCodes);
}
