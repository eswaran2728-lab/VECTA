import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { Profile } from "./types";
import { ORG_WIDE_ROLES, type UserRole } from "./reference-data";

export async function getCurrentUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}

export async function getCurrentProfile(): Promise<Profile | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data } = await supabase.from("profiles").select("*").eq("id", user.id).single();
  return (data as unknown as Profile) ?? null;
}

export function landingPathForRole(role: UserRole): string {
  return role === "ASO" ? "/avsec/home" : "/avsec/dashboard";
}

export async function requireProfile(): Promise<Profile> {
  const profile = await getCurrentProfile();
  if (!profile) redirect("/login");
  // Org-wide roles (Enforcement/Management/Admin) aren't tied to a station or team, so
  // both are expected blank for them — only the team-scoped roles (ASO/SO/DSE) must
  // have station+team set.
  const isOrgWide = (ORG_WIDE_ROLES as readonly string[]).includes(profile.role);
  if (!profile.name || (!isOrgWide && (!profile.station || !profile.team))) {
    redirect("/avsec/profile-setup");
  }
  if (profile.status !== "approved") {
    redirect("/avsec/pending-approval");
  }
  return profile;
}

export async function requireRole(roles: UserRole[]): Promise<Profile> {
  const profile = await requireProfile();
  if (!roles.includes(profile.role)) {
    redirect(landingPathForRole(profile.role));
  }
  return profile;
}

// Rank hierarchy: ASO < SO < DSE < ENFORCEMENT < MANAGEMENT < ADMIN. Each role monitors
// every report submitted by a strictly lower-ranked role (enforced identically in RLS via
// role_rank()) — SO/DSE are further limited to their own station+team, while
// ENFORCEMENT/MANAGEMENT/ADMIN see every team. ASO submits all 6 report types; SO/DSE
// additionally submit the SEC014 daily report. ENFORCEMENT, MANAGEMENT, and ADMIN only
// monitor — Enforcement doesn't file any reports; ADMIN additionally gets an email copy
// of every submission and approves users.
export const MONITOR_ROLES: UserRole[] = ["SO", "DSE", "ENFORCEMENT", "MANAGEMENT", "ADMIN"];
export const DAILY_REPORT_ROLES: UserRole[] = ["ASO", "SO", "DSE"];
export const ADMIN_ROLES: UserRole[] = ["ADMIN"];
// Only the team-scoped roles actually work a shift, so only they check in/out at /duty —
// Enforcement/Management/Admin are org-wide monitors and never roster onto a shift.
export const DUTY_ROLES: UserRole[] = ["ASO", "SO", "DSE"];
// Flight-attendance search is Enforcement + Management only — Admin is deliberately
// excluded even though Admin's rank already grants broad visibility everywhere else;
// the exclusion is enforced again at the DB layer in search_flight_attendance() since
// rank-based RLS alone would otherwise let Admin through.
export const ENFORCEMENT_SEARCH_ROLES: UserRole[] = ["ENFORCEMENT", "MANAGEMENT"];
