import { redirect } from "next/navigation";
import { createClient } from "./supabase/server";
import type { Profile } from "./types";
import type { UserRole } from "./reference-data";

export async function getCurrentUser() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}

export async function getCurrentProfile(): Promise<Profile | null> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data } = await supabase.from("profiles").select("*").eq("id", user.id).single();
  return (data as unknown as Profile) ?? null;
}

export function landingPathForRole(role: UserRole): string {
  return role === "ASO" ? "/home" : "/dashboard";
}

export async function requireProfile(): Promise<Profile> {
  const profile = await getCurrentProfile();
  if (!profile) redirect("/login");
  if (!profile.name || !profile.station || !profile.team) {
    redirect("/profile-setup");
  }
  if (profile.status !== "approved") {
    redirect("/pending-approval");
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

// Rank hierarchy: ASO < SO < DSE < ENFORCEMENT < ADMIN. Each role monitors every report
// submitted by a strictly lower-ranked role (enforced identically in RLS via role_rank()).
// ASO submits all 4 report types; SO/DSE/ENFORCEMENT additionally submit the SEC014 daily
// report; ADMIN only monitors (plus gets an email copy of every submission) and approves users.
export const MONITOR_ROLES: UserRole[] = ["SO", "DSE", "ENFORCEMENT", "ADMIN"];
export const DAILY_REPORT_ROLES: UserRole[] = ["ASO", "SO", "DSE", "ENFORCEMENT"];
export const ENFORCEMENT_ROLES: UserRole[] = ["ENFORCEMENT", "ADMIN"];
export const ADMIN_ROLES: UserRole[] = ["ADMIN"];
