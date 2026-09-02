import "server-only";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { Role, UserProfile } from "@/lib/icms/database.types";
import { opsGroupForCheckpointRole } from "@/lib/icms/ops-group";

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
  if (!roles.includes(profile.role)) redirect("/icms/dashboard?error=forbidden");
  return profile;
}

/**
 * Requires access to complete a specific checkpoint (post2_avsec/
 * post6_avsec/hub_avsec/redq_avsec/receiver) — either the exact ICMS role
 * (existing single-purpose demo/checkpoint accounts), or any AVSEC team
 * member whose ops_group covers that checkpoint (supabase/migrations/
 * team_based_ops_groups.sql's mapping, same one opsGroupForCheckpointRole
 * already uses for the Scan feature's read-side ops_group check).
 *
 * Without this, every ordinary ASO/SO/DSE account — which gets the
 * deliberately generic 'ops_staff' ICMS role (see
 * backfill_icms_shadow_users.sql), not a checkpoint-specific one — could
 * see a transaction via Scan but never actually complete any part of it:
 * requireRole([checkpointRole]) rejects 'ops_staff' outright. This is the
 * write-side counterpart to that read-side ops_group access, restoring
 * "every team member scans and does their part" for the actual checkpoint
 * actions, not just visibility.
 */
export async function requireCheckpointRole(role: Role): Promise<UserProfile> {
  const profile = await requireProfile();
  if (profile.role === role) return profile;
  const checkpointOpsGroup = opsGroupForCheckpointRole(role);
  if (checkpointOpsGroup && profile.ops_group === checkpointOpsGroup) return profile;
  redirect("/icms/dashboard?error=forbidden");
}
