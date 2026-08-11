import { createClient } from "@/lib/supabase/server";
import type { ReportType } from "@/lib/reference-data";

export interface Acknowledgement {
  acknowledgedBy: string;
  acknowledgedByName: string;
  acknowledgedAt: string;
}

export async function getAcknowledgement(
  reportType: ReportType,
  reportId: string,
): Promise<Acknowledgement | null> {
  const supabase = createClient();
  const { data } = await supabase
    .from("report_acknowledgements")
    .select("acknowledged_by, acknowledged_at, profiles(name, email)")
    .eq("report_type", reportType)
    .eq("report_id", reportId)
    .maybeSingle();

  if (!data) return null;
  const acker = data.profiles as unknown as { name: string; email: string } | null;
  return {
    acknowledgedBy: data.acknowledged_by,
    acknowledgedByName: acker?.name || acker?.email || "—",
    acknowledgedAt: data.acknowledged_at,
  };
}
