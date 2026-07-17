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

export async function requireProfile(): Promise<Profile> {
  const profile = await getCurrentProfile();
  if (!profile) redirect("/login");
  if (!profile.name || !profile.station || !profile.team) {
    redirect("/profile-setup");
  }
  return profile;
}

export async function requireRole(roles: UserRole[]): Promise<Profile> {
  const profile = await requireProfile();
  if (!roles.includes(profile.role)) {
    redirect("/home");
  }
  return profile;
}

export const SUPERVISOR_ROLES: UserRole[] = ["SUPERVISOR", "MANAGER", "ADMIN"];
export const MANAGER_ROLES: UserRole[] = ["MANAGER", "ADMIN"];
