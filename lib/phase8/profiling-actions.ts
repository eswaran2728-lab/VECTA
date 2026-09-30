"use server";

import { createClient } from "@/lib/supabase/server";

export interface ProfilingActionResult {
  ok: boolean;
  error: string | null;
}

/** Client-callable server action wrapper -- lib/phase8/workforce.ts's
 * acknowledgeSec013ReportSecure() isn't itself a "use server" module (it
 * also exports plain types, which "use server" disallows), so it can only
 * be called from Server Components. This thin action is what the client
 * ProfilingAcknowledgeControl actually invokes. */
export async function acknowledgeSec013Report(reportId: string): Promise<ProfilingActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("acknowledge_sec013_report_secure", { p_report_id: reportId });
  if (error) return { ok: false, error: error.message };
  return { ok: true, error: null };
}
