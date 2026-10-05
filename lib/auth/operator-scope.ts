import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { assignmentsFromRpcRows, deriveCanonicalAccess, deriveOperatorScope, type OperatorScope } from "@/lib/auth/canonical-access";

/**
 * Resolves the signed-in caller's operator scope for scanning surfaces from
 * their active Phase 3 assignments ONLY. No legacy profile column, ICMS users
 * row or ops_group is read.
 */
export async function resolveOperatorScope(supabase: SupabaseClient): Promise<OperatorScope> {
  const { data: rows } = await supabase.rpc("get_my_active_role_assignments");
  return deriveOperatorScope(deriveCanonicalAccess(assignmentsFromRpcRows(rows)));
}
