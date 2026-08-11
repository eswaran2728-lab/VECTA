"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireProfile } from "@/lib/auth";
import { REPORT_TYPES, type ReportType } from "@/lib/reference-data";

export async function acknowledgeReport(formData: FormData) {
  const profile = await requireProfile();
  const reportType = String(formData.get("reportType") || "") as ReportType;
  const reportId = String(formData.get("reportId") || "");
  if (!REPORT_TYPES.includes(reportType) || !reportId) return;

  const supabase = createClient();
  const { error } = await supabase.from("report_acknowledgements").insert({
    report_type: reportType,
    report_id: reportId,
    acknowledged_by: profile.id,
  });

  revalidatePath(`/reports/view/${reportType}/${reportId}`);

  if (error) {
    redirect(`/reports/view/${reportType}/${reportId}?error=${encodeURIComponent(error.message)}`);
  }
}
