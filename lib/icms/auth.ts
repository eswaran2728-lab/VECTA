import "server-only";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { Role, UserProfile, OpsGroup } from "@/lib/icms/database.types";
import { opsGroupForCheckpointRole, opsGroupCanAccessCheckpoint, isAvsecScanGroup } from "@/lib/icms/ops-group";
import { ensureOnDutyForCheckpoint } from "@/lib/icms/checkpoint-duty";

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
 *
 * On-duty gate (2026-09-23): "Approved ASO/SO/DSE users from both AVSEC
 * groups may complete non-Hub checkpoints only while checked in." Applies
 * ONLY when access is granted via the unified operation_avsec/ifc_avsec
 * scanning union (isAvsecScanGroup) — i.e. exactly the ASO/SO/DSE grant
 * this task scopes the requirement to. It does NOT apply to: the literal
 * single-purpose checkpoint-role accounts (`profile.role === role` above,
 * no duty/roster concept of their own), or Hub AVSEC's own exact-match
 * grant (out of scope here — task explicitly says "non-Hub checkpoints";
 * Hub AVSEC's access is untouched, preserving Hub separation as-is).
 * Reuses ensureOnDutyForCheckpoint / hasOpenDutyCheckIn — the SAME source
 * of truth report submission already uses (lib/avsec/reports/actions.ts's
 * ensureCheckedIn) — no new duty/attendance table or schema.
 */
export async function requireCheckpointRole(role: Role): Promise<UserProfile> {
  const profile = await requireProfile();
  if (profile.role === role) return profile;
  const checkpointOpsGroup = opsGroupForCheckpointRole(role);
  const viewerOpsGroup = profile.ops_group as OpsGroup | null;
  // Unified AVSEC scanning model: Operation and IFC ops_groups are
  // interchangeable for any non-Hub checkpoint (opsGroupCanAccessCheckpoint
  // enforces the exact-match rule for Hub either way).
  if (opsGroupCanAccessCheckpoint(viewerOpsGroup, checkpointOpsGroup)) {
    if (isAvsecScanGroup(viewerOpsGroup)) {
      const dutyError = await ensureOnDutyForCheckpoint(profile.id);
      if (dutyError) redirect("/icms/dashboard?error=not-on-duty");
    }
    return profile;
  }
  redirect("/icms/dashboard?error=forbidden");
}
