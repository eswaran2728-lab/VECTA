"use server";

import { createClient } from "@/lib/supabase/server";

/**
 * Phase 13 correction: export_caterlink_data_secure() existed in the
 * database with zero application callers anywhere (confirmed by grep
 * across app/, lib/, components/ during this phase's exhaustive
 * export/audit inventory -- see docs/phase13/export-audit-inventory.md).
 * This is the first caller, wired for CaterLink Management's confirmed
 * export ownership. Authorization (CaterLink Management, own AOC) is
 * enforced entirely inside the RPC.
 */
export interface CaterlinkExportRow {
  transaction_id: string;
  transaction_number: string;
  aoc_code: string;
  status: string;
  [key: string]: unknown;
}

export async function exportCaterlinkData(targetAocId?: string | null): Promise<{ ok: boolean; error: string | null; data: CaterlinkExportRow[] }> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("export_caterlink_data_secure", {
    p_target_aoc_id: targetAocId ?? null,
  });
  if (error) return { ok: false, error: error.message, data: [] };
  return { ok: true, error: null, data: data ?? [] };
}
