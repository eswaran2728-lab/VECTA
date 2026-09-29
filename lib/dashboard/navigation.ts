import { tierForRoleCode } from "./tiers.ts";

/**
 * Shared Phase 7 navigation-capability model. The single source AppSidebar,
 * TeamBottomNav, and any future nav surface consult for Phase-3-assignment-
 * aware navigation, instead of each hardcoding its own copy.
 *
 * IMPORTANT: nothing here is authorization. Every function is pure UI
 * display logic -- it decides whether a LINK is shown, never whether the
 * destination route allows the request. The destination route/RPC always
 * re-verifies the caller's own active assignment server-side (see
 * lib/dashboard/context.ts, the Phase 6/7 RPCs) regardless of what this
 * module returns. Hiding a link is a convenience, not a security boundary;
 * showing a link that later 403s/redirects is intentional and safe.
 */

export interface Phase7NavEntry {
  href: string;
  label: string;
}

const DASHBOARD_LABEL_BY_TIER: Record<string, string> = {
  international: "Executive Dashboard",
  malaysia_leadership: "My Dashboard",
  enforcement: "My Dashboard",
  operation: "My Dashboard",
  unknown: "My Dashboard",
};

/**
 * The single Phase 7 "My Dashboard" entry point, or null when the profile
 * has no active Phase 3 assignment at all (LEGACY UI COMPATIBILITY: those
 * profiles keep using only the pre-Phase-7 navigation, unchanged -- this
 * function is what draws that line, not the caller). `activeRoleCode` is
 * optional -- pass it (e.g. from a single-assignment profile) to get a
 * role-flavored label; omit it (multi-assignment, or label doesn't matter
 * yet) to get the generic label. The link always points at the same
 * context-resolving route regardless of label -- /avsec/my-dashboard does
 * its own server-side assignment lookup and, for multiple assignments,
 * its own explicit context selection.
 */
export function phase7DashboardNavEntry(hasActiveAssignment: boolean, activeRoleCode?: string | null): Phase7NavEntry | null {
  if (!hasActiveAssignment) return null;
  const label = activeRoleCode ? (DASHBOARD_LABEL_BY_TIER[tierForRoleCode(activeRoleCode)] ?? "My Dashboard") : "My Dashboard";
  return { href: "/avsec/my-dashboard", label };
}

/**
 * Whether a Phase 3 role should ever see CaterLink navigation from Phase-7-
 * aware nav surfaces. Only caterlink_management does. This is a UI-layer
 * belt-and-suspenders check on TOP OF, never instead of, the existing
 * ops_group-based checkpoint authorization in lib/icms/ops-group.ts (which
 * this module does not modify) -- it exists so a Phase 7 nav entry never
 * shows CaterLink to an unrelated AVSEC operational or enforcement role
 * merely because of that role, independent of whatever ops_group value
 * happens to be on their legacy profile row.
 */
export function caterlinkNavAllowedForRole(roleCode: string | null): boolean {
  return roleCode === "caterlink_management";
}

/**
 * Whether a Phase 3 role should ever see a checkpoint-scanner nav entry
 * from Phase-7-aware nav surfaces. Profiling and Investigation never do
 * (Phase 7 spec: "Profiling has NO checkpoint scanner/navigation"). Same
 * belt-and-suspenders relationship to lib/icms/ops-group.ts as above.
 */
export function scannerNavAllowedForRole(roleCode: string | null): boolean {
  if (roleCode === null) return true; // legacy accounts: unaffected, existing ops_group gate still applies.
  const denied = ["profiling_so", "profiling_aso", "investigation_sso", "investigation_so", "investigation_aso"];
  return !denied.includes(roleCode);
}
