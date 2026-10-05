import "server-only";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { Role, UserProfile } from "@/lib/icms/database.types";
import { getActiveRoleAssignments } from "@/lib/dashboard/context";
import { deriveCanonicalAccess, type CanonicalAccess } from "@/lib/auth/canonical-access";
import { decideCheckpointAccess, icmsDisplayRole, isExternalIcmsRole, isExternalOnlyRoleList, satisfiesIcmsRoles } from "@/lib/icms/canonical";
import { ensureOnDutyForCheckpoint } from "@/lib/icms/checkpoint-duty";

/**
 * ICMS/CaterLink identity and authorization (merged operations model).
 *
 * Internal staff are identified by their Supabase Auth user and authorised
 * ONLY by their active Phase 3 assignments (lib/icms/canonical.ts). The
 * ICMS profile returned here is an ADAPTER built from public.profiles plus
 * those assignments -- the same Auth user UUID, no second identity, no
 * password material, and no public.users row is read or required. Its `role`
 * is a display value derived from the canonical roles; it never grants
 * anything. ops_group is not populated and decides nothing.
 *
 * The only legacy-row path left is for EXTERNAL CaterLink parties (vendor,
 * warehouse_pic), who have no canonical role: they are recognised from the
 * legacy ICMS users table only when the caller holds no canonical
 * assignment, and only for the external-role gates.
 */
export type IcmsProfile = UserProfile & {
  identity: "canonical" | "external";
  canonical?: CanonicalAccess;
};

export async function requireProfile(): Promise<IcmsProfile> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const access = deriveCanonicalAccess(await getActiveRoleAssignments());
  if (access.isSuperAdmin) redirect("/super-admin");

  if (access.hasAssignment) {
    const { data: base } = await supabase
      .from("profiles")
      .select("id, name, staff_no, email, status, created_at")
      .eq("id", user.id)
      .maybeSingle();
    if (!base) redirect("/login?error=no-profile");
    if (base.status !== "approved") {
      await supabase.auth.signOut();
      redirect(`/login?error=${base.status}`);
    }
    return {
      id: base.id as string,
      name: (base.name as string) ?? "",
      staff_id: (base.staff_no as string) ?? "",
      email: (base.email as string) ?? user.email ?? "",
      role: icmsDisplayRole(access),
      preferred_language: "en",
      status: "active",
      duty_post: null,
      ops_group: null,
      created_at: (base.created_at as string) ?? new Date().toISOString(),
      identity: "canonical",
      canonical: access,
    } as IcmsProfile;
  }

  // No canonical assignment: only an external CaterLink party may continue.
  const { data: legacy } = await supabase.from("users").select("*").eq("id", user.id).maybeSingle();
  if (!legacy || !isExternalIcmsRole((legacy as { role?: string }).role)) {
    redirect("/login?error=no-profile");
  }
  if ((legacy as { status?: string }).status !== "active") {
    await supabase.auth.signOut();
    redirect(`/login?error=${(legacy as { status?: string }).status}`);
  }
  return { ...(legacy as UserProfile), identity: "external" };
}

/**
 * Requires one of the given (legacy-named) ICMS roles. Internal staff are
 * decided canonically (lib/icms/canonical.ts); external parties (vendor,
 * warehouse_pic) use the external identity path.
 */
export async function requireRole(roles: Role[]): Promise<IcmsProfile> {
  const profile = await requireProfile();
  if (profile.identity === "external") {
    if (!isExternalOnlyRoleList(roles) || !roles.includes(profile.role)) redirect("/icms/dashboard?error=forbidden");
    return profile;
  }
  if (!satisfiesIcmsRoles(profile.canonical as CanonicalAccess, roles)) redirect("/icms/dashboard?error=forbidden");
  return profile;
}

/**
 * Requires access to complete a CaterLink checkpoint (post2_avsec/post6_avsec/
 * hub_avsec/redq_avsec/receiver). Authority is canonical:
 *   - an active station-scoped operational assignment (aso/so/sso/dse) with a
 *     single assigned station;
 *   - that station must hold the approved CaterLink SCAN capability
 *     (can_user_scan_caterlink -- stations without it, e.g. BTU, are denied);
 *   - Staff Profiling is always excluded;
 *   - the caller must be checked in for duty.
 * The checkpoint role argument names the step being completed; it is not an
 * identity and nothing about ops_group or a legacy users.role is consulted.
 */
export async function requireCheckpointRole(_role: Role): Promise<IcmsProfile> {
  void _role;
  const profile = await requireProfile();
  if (profile.identity !== "canonical") redirect("/icms/dashboard?error=forbidden");
  const access = profile.canonical as CanonicalAccess;

  let stationCanScan: boolean | null = null;
  if (access.stationCode) {
    const supabase = await createClient();
    const { data } = await supabase.rpc("can_user_scan_caterlink", { p_station_code: access.stationCode });
    stationCanScan = data === true;
  }
  const decision = decideCheckpointAccess(access, stationCanScan);
  if (!decision.allowed) redirect("/icms/dashboard?error=forbidden");

  const dutyError = await ensureOnDutyForCheckpoint(profile.id);
  if (dutyError) redirect("/icms/dashboard?error=not-on-duty");
  return profile;
}
