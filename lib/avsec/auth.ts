import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { Profile } from "./types";
import type { UserRole } from "./reference-data";
import { getActiveRoleAssignments } from "@/lib/dashboard/context";
import { deriveCanonicalAccess, accessSatisfiesRoles, type CanonicalAccess } from "@/lib/auth/canonical-access";
import { routeAllows } from "@/lib/auth/route-access";
import { classifyPortalAccess, isCaterLinkOnly, type PortalIdentity } from "@/lib/auth/caterlink-access";

export async function getCurrentUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}

/** The caller's own canonical operational access, from their active Phase 3
 *  assignments (identity from auth.uid() inside the RPC). */
export async function getCanonicalAccess(): Promise<CanonicalAccess> {
  return deriveCanonicalAccess(await getActiveRoleAssignments());
}

/** Identity/status row for the signed-in user, INCLUDING unapproved and
 *  unassigned accounts. For setup / awaiting-approval / chrome-display pages
 *  only: the legacy role/ops_group values here are display data and must
 *  never decide access. Station/team are filled from the canonical
 *  assignment scope when the legacy text fields are blank. */
export async function getRawProfile(): Promise<Profile | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data } = await supabase.from("profiles").select("*").eq("id", user.id).single();
  const profile = (data as unknown as Profile) ?? null;
  if (!profile) return null;
  if (!profile.station || !profile.team) {
    const access = await getCanonicalAccess();
    return {
      ...profile,
      station: profile.station ?? ((access.stationCode as Profile["station"]) ?? null),
      team: profile.team ?? access.teamName,
    };
  }
  return profile;
}

/** The signed-in user's profile for ANY decision or data-stamping use. Returns
 *  null unless the profile is approved AND holds an active canonical
 *  assignment (so a server action reached directly is denied exactly like a
 *  page is). `role` is the canonical-derived compatibility rank, never the
 *  legacy column. */
export async function getCurrentProfile(): Promise<Profile | null> {
  const raw = await getRawProfile();
  if (!raw || raw.status !== "approved") return null;
  const access = await getCanonicalAccess();
  if (!access.hasAssignment || access.isSuperAdmin) return null;
  // A CaterLink-only (or conflicting) identity is never a VECTA actor, even if it reaches an action directly.
  const identity = await getPortalIdentity(access);
  if (isCaterLinkOnly(identity.kind) || identity.kind === "conflict" || identity.kind === "blocked") return null;
  return { ...raw, role: access.primaryCompatRole ?? "ASO", canonical: access };
}

/** Canonical CaterLink scan capability for display (nav/tiles): a station operator whose
 *  single assigned station holds the approved SCAN capability. Enforcement happens in the
 *  scan action and ICMS checkpoint gates; this only decides what to SHOW. */
export async function getCanScanCaterLink(access: CanonicalAccess): Promise<boolean> {
  if (!access.hasAssignment || access.isSuperAdmin || !access.stationCode) return false;
  if (!access.roleCodes.some((c) => c === "aso" || c === "so" || c === "sso" || c === "dse")) return false;
  const supabase = await createClient();
  const { data } = await supabase.rpc("can_user_scan_caterlink", { p_station_code: access.stationCode });
  return data === true;
}

/** Where a user with this canonical access should land. */
export function landingPathForAccess(access: CanonicalAccess): string {
  if (!access.hasAssignment) return "/avsec/pending-approval";
  if (access.primaryCompatRole) return landingPathForRole(access.primaryCompatRole);
  return "/avsec/my-dashboard";
}

export function landingPathForRole(role: UserRole): string {
  if (role === "SUPER_ADMIN") return "/super-admin";
  return role === "ASO" ? "/avsec/home" : "/avsec/dashboard";
}

/** The caller's portal identity (canonical assignments + the trusted users-table account row). Never email/metadata. */
export async function getPortalIdentity(access?: CanonicalAccess): Promise<PortalIdentity> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { kind: "none" };
  const resolved = access ?? (await getCanonicalAccess());
  const { data } = await supabase.from("users").select("role, status").eq("id", user.id).maybeSingle();
  return classifyPortalAccess(resolved, data);
}

/** CaterLink-only identities never work a VECTA / AVSEC page or action: send them to CaterLink; mixed or non-active identities fail closed. */
function redirectIfNotVecta(identity: PortalIdentity): void {
  if (isCaterLinkOnly(identity.kind)) redirect("/caterlink/dashboard");
  if (identity.kind === "conflict") redirect("/login?error=conflicting-access");
  if (identity.kind === "blocked") redirect(`/login?error=${encodeURIComponent(identity.status ?? "pending")}`);
}

export async function requireProfile(): Promise<Profile> {
  const profile = await getRawProfile();
  if (!profile) redirect("/login");
  const access = await getCanonicalAccess();
  redirectIfNotVecta(await getPortalIdentity(access));
  // Canonical Super Admin (active Phase 3 assignment) never works operational routes.
  if (access.isSuperAdmin) redirect("/super-admin");
  if (!profile.name) redirect("/avsec/profile-setup");
  if (profile.status !== "approved") redirect("/avsec/pending-approval");
  // Approved but holding no active assignment: no operational access at all.
  if (!access.hasAssignment) redirect("/avsec/pending-approval");
  // The legacy `role` is replaced by the canonical-derived compatibility rank
  // (least-privilege ASO when the canonical role has no legacy-page equivalent),
  // so no code reading profile.role can be granted anything by a legacy column.
  return { ...profile, role: access.primaryCompatRole ?? "ASO", canonical: access };
}

export async function requireRole(roles: UserRole[]): Promise<Profile> {
  const profile = await requireProfile();
  const access = profile.canonical as CanonicalAccess;
  if (!accessSatisfiesRoles(access, roles)) {
    redirect(landingPathForAccess(access));
  }
  return profile;
}

/** Gate for a route the Phase 7 dashboards link to: the canonical role codes linking to it, or its legacy rank list via the compat mapping. */
export async function requireRouteAccess(href: string, legacyRoles: UserRole[]): Promise<Profile> {
  const profile = await requireProfile();
  const access = profile.canonical as CanonicalAccess;
  if (!routeAllows(href, access, legacyRoles)) redirect(landingPathForAccess(access));
  return profile;
}

export type ProfileRole = "ASO" | "SO" | "DSE" | "ADMIN" | "ENFORCEMENT" | "MANAGEMENT";

// Rank hierarchy: ASO < SO < DSE < ENFORCEMENT < MANAGEMENT.
export const MONITOR_ROLES: ProfileRole[] = ["SO", "DSE", "ENFORCEMENT", "MANAGEMENT", "ADMIN"];

/** Central rule for who is required to file the SEC 014 Daily Report. SO and
 *  DSE are supervisory roles — they review/acknowledge an ASO's Daily Report
 *  instead of submitting one. Case-insensitive so it also works against the
 *  lowercase unified_role vocabulary used on the root dashboard. Use this
 *  (or DAILY_REPORT_ROLES, derived from it) everywhere Daily Report
 *  requirement/compliance is evaluated, rather than re-deriving the rule. */
export function requiresDailyReport(role: string | null | undefined): boolean {
  return (role ?? "").toUpperCase() === "ASO";
}
export const DAILY_REPORT_ROLES: ProfileRole[] = (["ASO", "SO", "DSE", "ENFORCEMENT", "MANAGEMENT", "ADMIN"] as ProfileRole[]).filter(
  requiresDailyReport,
);
export const MANAGEMENT_ROLES: ProfileRole[] = ["MANAGEMENT", "ADMIN"];
export const ADMIN_ROLES: ProfileRole[] = MANAGEMENT_ROLES;
// Only the team-scoped roles actually work a shift, so only they check in/out at /duty.
export const DUTY_ROLES: ProfileRole[] = ["ASO", "SO", "DSE"];
export const ENFORCEMENT_SEARCH_ROLES: ProfileRole[] = ["ENFORCEMENT", "MANAGEMENT", "ADMIN"];
