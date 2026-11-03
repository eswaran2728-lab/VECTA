"use server";

import { createClient } from "@/lib/supabase/server";
import { getCurrentProfile } from "@/lib/avsec/auth";

export async function saveDraft(reportType: string, data: unknown): Promise<{ ok: boolean; error?: string; savedAt?: string }> {
  const profile = await getCurrentProfile();
  if (!profile) return { ok: false, error: "Not authenticated" };

  const supabase = await createClient();
  const savedAt = new Date().toISOString();
  const { error } = await supabase
    .from("report_drafts")
    .upsert(
      { profile_id: profile.id, report_type: reportType, data: data as never, updated_at: savedAt },
      { onConflict: "profile_id,report_type" },
    );

  if (error) return { ok: false, error: error.message };
  return { ok: true, savedAt };
}

/** The server draft with the time it was saved, so a form can tell a stale draft from a newer one. */
export async function loadDraftWithTime(reportType: string): Promise<{ data: unknown; savedAt: string } | null> {
  const profile = await getCurrentProfile();
  if (!profile) return null;
  const supabase = await createClient();
  const { data } = await supabase.from("report_drafts").select("data, updated_at").eq("profile_id", profile.id).eq("report_type", reportType).maybeSingle();
  return data ? { data: data.data as unknown, savedAt: String(data.updated_at ?? "") } : null;
}

export async function loadDraft(reportType: string): Promise<unknown | null> {
  const profile = await getCurrentProfile();
  if (!profile) return null;

  const supabase = await createClient();
  const { data } = await supabase
    .from("report_drafts")
    .select("data")
    .eq("profile_id", profile.id)
    .eq("report_type", reportType)
    .maybeSingle();

  return (data?.data as unknown) ?? null;
}

export async function clearDraft(reportType: string): Promise<void> {
  const profile = await getCurrentProfile();
  if (!profile) return;

  const supabase = await createClient();
  await supabase
    .from("report_drafts")
    .delete()
    .eq("profile_id", profile.id)
    .eq("report_type", reportType);
}
