import { REQUESTABLE_ROLES, ORG_WIDE_ROLES } from "../reference-data.ts";

/**
 * Validates a proposed final role/station/team assignment for approval. Single
 * source of truth for the rule, imported by the server action (authoritative:
 * the requested values a pending registrant typed into their own profile-setup
 * form are NEVER trusted as final) and the client-side approval form (UX only).
 * ops_group is deprecated and neither requested nor validated.
 */
export function validateApprovalAssignment(input: {
  role: string;
  station: string;
  team: string;
}): { ok: true } | { ok: false; error: string } {
  const allRoles: readonly string[] = [...REQUESTABLE_ROLES, "MANAGEMENT"];
  if (!allRoles.includes(input.role)) {
    return { ok: false, error: "Select a valid role." };
  }
  if (!input.station) {
    return { ok: false, error: "Station is required." };
  }
  const isOrgWide = (ORG_WIDE_ROLES as readonly string[]).includes(input.role);
  if (!isOrgWide && !input.team) {
    return { ok: false, error: "Team is required for this role." };
  }
  return { ok: true };
}
