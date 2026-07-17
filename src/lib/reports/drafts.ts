"use server";

import { createClient } from "@/lib/supabase/server";
import { getCurrentProfile } from "@/lib/auth";
import type { ReportType } from "@/lib/reference-data";

export async function saveDraft(reportType: ReportType, data: unknown): Promise<{ ok: boolean; error?: string }> {
  const profile = await getCurrentProfile();
  if (!profile) return { ok: false, error: "Not authenticated" };

  const supabase = createClient();
  const { error } = await supabase
    .from("report_drafts")
    .upsert(
      { profile_id: profile.id, report_type: reportType, data: data as never },
      { onConflict: "profile_id,report_type" },
    );

  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export async function loadDraft(reportType: ReportType): Promise<unknown | null> {
  const profile = await getCurrentProfile();
  if (!profile) return null;

  const supabase = createClient();
  const { data } = await supabase
    .from("report_drafts")
    .select("data")
    .eq("profile_id", profile.id)
    .eq("report_type", reportType)
    .maybeSingle();

  return (data?.data as unknown) ?? null;
}

export async function clearDraft(reportType: ReportType): Promise<void> {
  const profile = await getCurrentProfile();
  if (!profile) return;

  const supabase = createClient();
  await supabase
    .from("report_drafts")
    .delete()
    .eq("profile_id", profile.id)
    .eq("report_type", reportType);
}
