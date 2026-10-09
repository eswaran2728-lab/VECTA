/**
 * Roles that have NO roster: they never work the Duty Terminal, Check In/Out, Leave, Overtime, Timesheet, handover or any other
 * attendance mutation. Pure (no framework imports) so navigation, the server guards and the tests share ONE definition.
 *
 * Deliberately not listed: hub_se (keeps Duty), operation_manager (keeps its user-administration authority and its attendance
 * monitoring), main_enforcement and the unit roles -- this phase does not change what those roles may do.
 */
export const NON_ROSTERED_LEADERSHIP_ROLES: readonly string[] = [
  "maa_boss",
  "maa_admin",
  "aax_boss",
  "aax_admin",
  "airasia_management",
  "ghod",
  "global_reporting_controller",
  "super_admin",
];

const SET = new Set(NON_ROSTERED_LEADERSHIP_ROLES);

/** True when the caller holds at least one role and EVERY role is non-rostered leadership. A mixed profile (e.g. also an ASO) keeps its roster role. */
export function isNonRosteredLeadership(roleCodes: readonly string[]): boolean {
  return roleCodes.length > 0 && roleCodes.every((c) => SET.has(c));
}
