import { REQUESTABLE_ROLES, ORG_WIDE_ROLES, OPS_GROUPS, OPS_GROUP_REQUIRED_ROLES } from "../reference-data.ts";

/**
 * Validates a proposed final role/station/team/opsGroup assignment for
 * approval. This is the single source of truth for that rule, imported
 * by both the server action (authoritative — the requested values a
 * pending registrant typed into their own profile-setup form are NEVER
 * trusted as final) and the client-side approval form (UX convenience
 * only, so the Approve button can be disabled before a doomed submit).
 */
export function validateApprovalAssignment(input: {
  role: string;
  station: string;
  team: string;
  opsGroup: string;
}): { ok: true } | { ok: false; error: string } {
  const allRoles: readonly string[] = [...REQUESTABLE_ROLES, "MANAGEMENT"];
  if (!allRoles.includes(input.role)) {
    return { ok: false, error: "Select a valid role." };
  }
  if (!input.station) {
    return { ok: false, error: "Station is required." };
  }
  const isOrgWide = (ORG_WIDE_ROLES as readonly string[]).includes(input.role);
  const needsTeamAndOpsGroup = (OPS_GROUP_REQUIRED_ROLES as readonly string[]).includes(input.role);
  if (needsTeamAndOpsGroup) {
    if (!input.team) return { ok: false, error: "Team is required for this role." };
    if (!(OPS_GROUPS as readonly string[]).includes(input.opsGroup)) {
      return { ok: false, error: "Select an ops group (Operation AVSEC / IFC AVSEC / Hub AVSEC) for this role." };
    }
  } else if (!isOrgWide) {
    // Any future non-org-wide, non-OPS_GROUP_REQUIRED_ROLES role would
    // still need a team — fail closed rather than silently allow blank.
    if (!input.team) return { ok: false, error: "Team is required for this role." };
  }
  return { ok: true };
}
