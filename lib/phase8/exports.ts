"use server";

import { createClient } from "@/lib/supabase/server";

export interface Phase8ActionResult<T = undefined> {
  ok: boolean;
  error: string | null;
  data: T | null;
}

/**
 * Both exports below are RPC-only, capped (1000 rows), authorized
 * (operation_manager / main_enforcement, checked at the database layer),
 * and self-audited (each RPC writes its own 'export_generated' audit row
 * before returning data). Only workforce-directory fields already
 * exposed elsewhere in Phase 8 (name/staff_no/role/scope) -- never
 * credentials, tokens, or personal data outside that set.
 */
export async function exportOperationWorkforce() {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("export_operation_workforce_secure");
  if (error) return { ok: false, error: error.message, data: null } satisfies Phase8ActionResult;
  return { ok: true, error: null, data: data ?? [] } satisfies Phase8ActionResult<NonNullable<typeof data>>;
}

export async function exportEnforcementWorkforce() {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("export_enforcement_workforce_secure");
  if (error) return { ok: false, error: error.message, data: null } satisfies Phase8ActionResult;
  return { ok: true, error: null, data: data ?? [] } satisfies Phase8ActionResult<NonNullable<typeof data>>;
}
