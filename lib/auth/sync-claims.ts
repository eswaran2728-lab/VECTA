import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { getFirebaseAdminAuth } from "./providers/firebase-admin";

/**
 * The one place that sets Firebase custom claims. Reads public.user_claims
 * (supabase/migrations/claims_contract.sql) with the Supabase service-role
 * key — the same authoritative source lib/auth/claims.ts reads for a
 * Supabase-session caller — and mirrors it onto the Firebase user record
 * via setCustomUserClaims(). role is hardcoded to "authenticated": Supabase
 * RLS rejects any Firebase-issued JWT that doesn't carry it (see
 * AUTH-CONTRACT.md).
 *
 * Called from two places: POST /api/auth/sync-claims (self-service, after
 * first Google sign-in — the caller's own verified uid) and the admin
 * claims-resync action (lib/avsec/admin/actions.ts's resyncFirebaseClaims,
 * admin-triggered for another user after changing their role).
 *
 * Returns the claims that were set, or null if the uid has no
 * public.user_claims row (no profiles/users account — e.g. before an
 * admin has provisioned one).
 */
export async function syncClaimsForUser(uid: string): Promise<Record<string, unknown> | null> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("user_claims" as never)
    .select("*")
    .eq("id", uid)
    .maybeSingle();

  if (!data) return null;

  const row = data as {
    email: string | null;
    app_role: string | null;
    team: string | null;
    station: string | null;
    staff_id: string | null;
    vendor_id: string | null;
  };

  const claims = {
    role: "authenticated",
    app_role: row.app_role,
    team: row.team,
    station: row.station,
    staff_id: row.staff_id,
    vendor_id: row.vendor_id,
  };

  await getFirebaseAdminAuth().setCustomUserClaims(uid, claims);
  return claims;
}

/**
 * Fire-and-forget wrapper for admin actions that change a role
 * (lib/icms/actions/users.ts, lib/avsec/admin/actions.ts) — called after
 * every such change so an already-migrated user's Firebase claims never
 * go stale. Never throws: most environments still run AUTH_PROVIDER=
 * supabase (no FIREBASE_SERVICE_ACCOUNT_BASE64 set at all until Phase 4),
 * where this is expected to no-op, not break the role edit that triggered
 * it.
 */
export async function bestEffortSyncClaims(uid: string): Promise<void> {
  try {
    await syncClaimsForUser(uid);
  } catch {
    // Firebase not configured yet, or the user has no Firebase account
    // (hasn't signed in with Google yet) — both expected pre-Phase-4.
  }
}
