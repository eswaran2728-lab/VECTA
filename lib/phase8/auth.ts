import { redirect } from "next/navigation";
import { requireProfile } from "@/lib/avsec/auth";
import { createClient } from "@/lib/supabase/server";

/**
 * Phase 8 page-level authorization: every scoped-workforce page must
 * independently verify the caller holds an ACTIVE Phase 3 role assignment
 * for one of the given role codes -- never trust that a page is reachable
 * only via a hidden nav link. Delegates the actual truth check to the
 * database (has_active_role()), the same function every Phase 8 RPC uses,
 * so a page and its server actions can never disagree about authorization.
 */
export async function requirePhase8Role(roleCodes: string[]) {
  const profile = await requireProfile();
  const supabase = await createClient();

  for (const roleCode of roleCodes) {
    const { data, error } = await supabase.rpc("has_active_role", { p_role_code: roleCode });
    if (!error && data === true) {
      return { profile, activeRole: roleCode };
    }
  }

  redirect("/avsec/dashboard");
}
