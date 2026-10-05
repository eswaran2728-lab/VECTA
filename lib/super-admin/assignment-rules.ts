// Pure mirror of the database rule behind has_active_role('super_admin')
// (Phase 3 has_role_in_scope): used wherever the app must evaluate a
// DIFFERENT profile's assignment (e.g. protecting a Super Admin target in
// user-management actions) where the caller-only RPC cannot be used. The
// database function remains the authority for the caller's own access.
export interface SuperAdminAssignmentFacts {
  roleCode: string | null | undefined;
  roleIsActive: boolean | null | undefined;
  profileStatus: string | null | undefined;
  revokedAt: string | null | undefined;
  startsAt: string | null | undefined;
  endsAt: string | null | undefined;
}

export function isEffectiveSuperAdminAssignment(a: SuperAdminAssignmentFacts, now: Date = new Date()): boolean {
  if (a.roleCode !== "super_admin") return false;
  if (a.roleIsActive !== true) return false;
  if (a.profileStatus !== "approved") return false;
  if (a.revokedAt) return false;
  if (!a.startsAt || new Date(a.startsAt).getTime() > now.getTime()) return false;
  if (a.endsAt && new Date(a.endsAt).getTime() <= now.getTime()) return false;
  return true;
}
