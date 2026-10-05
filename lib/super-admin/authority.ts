import "server-only";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isEffectiveSuperAdminAssignment } from "./assignment-rules";

// Canonical Super Admin authority: an active, non-revoked, currently
// effective Phase 3 super_admin role assignment on an approved profile,
// decided by the database from auth.uid() (has_active_role). Never reads
// profiles.role, profiles.unified_role, users.*, or user metadata.
export async function hasActiveSuperAdminRole(): Promise<boolean> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return false;
  const { data, error } = await supabase.rpc("has_active_role", { p_role_code: "super_admin" });
  return !error && data === true;
}

// Server-side check of another profile (used only to PROTECT a Super Admin
// target from management actions). Service-key read; evaluates the same
// rule as has_active_role via isEffectiveSuperAdminAssignment.
export async function isProfileActiveSuperAdmin(profileId: string): Promise<boolean> {
  const ids = await getActiveSuperAdminProfileIds([profileId]);
  return ids.has(profileId);
}

export async function getActiveSuperAdminProfileIds(profileIds: string[]): Promise<Set<string>> {
  const result = new Set<string>();
  if (profileIds.length === 0) return result;
  const admin = createAdminClient();
  const { data: assignments, error } = await admin
    .from("user_role_assignments")
    .select("profile_id, revoked_at, starts_at, ends_at, role_definitions!inner(code, is_active)")
    .in("profile_id", profileIds)
    .eq("role_definitions.code", "super_admin");
  if (error || !assignments) return result;

  const candidateIds = [...new Set(assignments.map((a) => a.profile_id as string))];
  if (candidateIds.length === 0) return result;
  const { data: profiles } = await admin.from("profiles").select("id, status").in("id", candidateIds);
  const statusById = new Map((profiles ?? []).map((p) => [p.id as string, p.status as string]));

  for (const a of assignments as unknown as Array<{
    profile_id: string;
    revoked_at: string | null;
    starts_at: string | null;
    ends_at: string | null;
    role_definitions: { code: string; is_active: boolean } | { code: string; is_active: boolean }[];
  }>) {
    const rd = Array.isArray(a.role_definitions) ? a.role_definitions[0] : a.role_definitions;
    if (
      isEffectiveSuperAdminAssignment({
        roleCode: rd?.code,
        roleIsActive: rd?.is_active,
        profileStatus: statusById.get(a.profile_id),
        revokedAt: a.revoked_at,
        startsAt: a.starts_at,
        endsAt: a.ends_at,
      })
    ) {
      result.add(a.profile_id);
    }
  }
  return result;
}
