import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { assignmentsFromRpcRows, deriveCanonicalAccess, deriveOperatorScope, type OperatorScope } from "@/lib/auth/canonical-access";

/**
 * Resolves the signed-in caller's operator scope for scanning/ICMS surfaces.
 * Canonical Phase 3 assignments decide; the legacy rows are read only for
 * the non-authorising workflow attributes (ops_group, station) and for
 * ICMS-origin identities that hold no assignment.
 */
export async function resolveOperatorScope(supabase: SupabaseClient, userId: string): Promise<OperatorScope> {
  const [{ data: rows }, { data: avsec }, { data: icms }] = await Promise.all([
    supabase.rpc("get_my_active_role_assignments"),
    supabase.from("profiles").select("ops_group, station").eq("id", userId).maybeSingle(),
    supabase.from("users").select("role, ops_group").eq("id", userId).maybeSingle(),
  ]);
  const access = deriveCanonicalAccess(assignmentsFromRpcRows(rows));
  return deriveOperatorScope(access, avsec as { ops_group?: string | null; station?: string | null } | null, icms as { role?: string | null; ops_group?: string | null } | null);
}
