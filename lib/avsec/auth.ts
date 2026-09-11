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
  if (role === "SUPER_ADMIN") return "/super-admin";
  return role === "ASO" ? "/avsec/home" : "/avsec/dashboard";
}

export async function requireProfile(): Promise<Profile> {
  const profile = await getCurrentProfile();
  if (!profile) redirect("/login");
  if (profile.role === "SUPER_ADMIN") redirect("/super-admin");
  // Org-wide roles (Enforcement/Management) aren't tied to a station or team, so
  // both are expected blank for them — only the team-scoped roles (ASO/SO/DSE) must
  // have station+team set.
  const isOrgWide = (ORG_WIDE_ROLES as readonly string[]).includes(profile.role) || profile.role === "ADMIN";
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
  if (!roles.includes(profile.role) && !(roles.includes("MANAGEMENT") && profile.role === "ADMIN")) {
    redirect(landingPathForRole(profile.role));
  }
  return profile;
}

export type ProfileRole = "ASO" | "SO" | "DSE" | "ADMIN" | "ENFORCEMENT" | "MANAGEMENT";

// Rank hierarchy: ASO < SO < DSE < ENFORCEMENT < MANAGEMENT.
export const MONITOR_ROLES: ProfileRole[] = ["SO", "DSE", "ENFORCEMENT", "MANAGEMENT", "ADMIN"];
export const DAILY_REPORT_ROLES: ProfileRole[] = ["ASO", "SO", "DSE"];
export const MANAGEMENT_ROLES: ProfileRole[] = ["MANAGEMENT", "ADMIN"];
export const ADMIN_ROLES: ProfileRole[] = MANAGEMENT_ROLES;
// Only the team-scoped roles actually work a shift, so only they check in/out at /duty.
export const DUTY_ROLES: ProfileRole[] = ["ASO", "SO", "DSE"];
export const ENFORCEMENT_SEARCH_ROLES: ProfileRole[] = ["ENFORCEMENT", "MANAGEMENT", "ADMIN"];
