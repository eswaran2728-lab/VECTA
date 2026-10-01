import { createClient } from "@/lib/supabase/server";
import type { WoisEligibility } from "@/lib/avsec/types";

/**
 * Phase 12 WOIS AI 2.0 eligibility: approved, active-Malaysia-AOC staff only.
 * Delegates entirely to the server-side is_wois_eligible_secure() RPC --
 * the authoritative decision lives in the database (reusing the Phase 8/9
 * active-assignment primitives), never re-derived or cached client-side.
 */
export async function getWoisEligibility(): Promise<WoisEligibility> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { eligible: false, reason: "unauthenticated" };
  }

  const { data, error } = await supabase.rpc("is_wois_eligible_secure");

  if (error) {
    return { eligible: false, reason: "authorization_check_failed" };
  }

  return data === true ? { eligible: true } : { eligible: false, reason: "not_eligible" };
}
