import "server-only";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { Role, UserProfile } from "@/lib/database.types";

/** Returns the signed-in user's profile or redirects to /login. */
export async function requireProfile(): Promise<UserProfile> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("users")
    .select("*")
    .eq("id", user.id)
    .single();

  if (!profile) {
    // Authenticated in Supabase but no ICMS profile: force sign-out path.
    redirect("/login?error=no-profile");
  }

  if (profile.status !== "active") {
    // Defense in depth: signIn() already blocks pending/rejected accounts,
    // this catches a status change during an already-open session.
    await supabase.auth.signOut();
    redirect(`/login?error=${profile.status}`);
  }

  return profile as UserProfile;
}

/** Requires one of the given roles; otherwise sends the user to the dashboard. */
export async function requireRole(roles: Role[]): Promise<UserProfile> {
  const profile = await requireProfile();
  if (!roles.includes(profile.role)) redirect("/dashboard?error=forbidden");
  return profile;
}
