import { createClient } from "@/lib/supabase/server";
import { dayRangeMY } from "@/lib/avsec/datetime";

export interface StaffReportResult {
  reportType: "sec014" | "sec016" | "sec029" | "sec018";
  reportId: string;
  staffName: string;
  station: string;
  team: string;
  submittedAt: string | null;
  detail: string;
}

// End-of-shift lookup: "did this staff member file their daily report today?" Filters by
// staff name and the report's submitted date (MY-local calendar day). RLS already limits
// results to reports the viewer's rank is allowed to monitor.
export async function searchDailyReportsByStaff(
  staffName: string,
  date: string,
): Promise<StaffReportResult[]> {
  const supabase = await createClient();
  const { from, to } = dayRangeMY(date);

  const { data } = await supabase
    .from("report_sec014")
    .select("id, staff_name, station, team, submitted_at, date_time_in, date_time_out, remark")
    .eq("status", "submitted")
    .ilike("staff_name", `%${staffName.trim()}%`)
    .gte("submitted_at", from)
    .lte("submitted_at", to)
    .order("submitted_at", { ascending: false });

  return (data ?? []).map((row) => ({
    reportType: "sec014" as const,
    reportId: row.id,
    staffName: row.staff_name,
    station: row.station,
    team: row.team,
    submittedAt: row.submitted_at,
    detail: row.remark ? row.remark.slice(0, 80) : "No remarks",
  }));
}

// End-of-shift lookup: "what aircraft reports did this ASO file today?" Combines the three
// aircraft-related report types (SEC016, SEC029, SEC018) — SEC014 is the daily report, not
// an aircraft report, so it's excluded here.
export async function searchAircraftReportsByStaff(
  staffName: string,
  date: string,
): Promise<StaffReportResult[]> {
  const supabase = await createClient();
  const { from, to } = dayRangeMY(date);
  const pattern = `%${staffName.trim()}%`;

  const [sec016, sec029, sec018] = await Promise.all([
    supabase
      .from("report_sec016")
      .select("id, staff_name, station, team, submitted_at, flight, reg_no")
      .eq("status", "submitted")
      .ilike("staff_name", pattern)
      .gte("submitted_at", from)
      .lte("submitted_at", to)
      .order("submitted_at", { ascending: false }),
    supabase
      .from("report_sec029")
      .select("id, staff_name, station, team, submitted_at, flight_no, aircraft_registration")
      .eq("status", "submitted")
      .ilike("staff_name", pattern)
      .gte("submitted_at", from)
      .lte("submitted_at", to)
      .order("submitted_at", { ascending: false }),
    supabase
      .from("report_sec018")
      .select("id, staff_name, station, team, submitted_at")
      .eq("status", "submitted")
      .ilike("staff_name", pattern)
      .gte("submitted_at", from)
      .lte("submitted_at", to)
      .order("submitted_at", { ascending: false }),
  ]);

  const results: StaffReportResult[] = [];

  for (const row of sec016.data ?? []) {
    results.push({
      reportType: "sec016",
      reportId: row.id,
      staffName: row.staff_name,
      station: row.station,
      team: row.team,
      submittedAt: row.submitted_at,
      detail: `Flight ${row.flight} · Reg ${row.reg_no}`,
    });
  }

  for (const row of sec029.data ?? []) {
    results.push({
      reportType: "sec029",
      reportId: row.id,
      staffName: row.staff_name,
      station: row.station,
      team: row.team,
      submittedAt: row.submitted_at,
      detail: `Flight ${row.flight_no} · Reg ${row.aircraft_registration}`,
    });
  }

  for (const row of sec018.data ?? []) {
    results.push({
      reportType: "sec018",
      reportId: row.id,
      staffName: row.staff_name,
      station: row.station,
      team: row.team,
      submittedAt: row.submitted_at,
      detail: "Patrolling of aircraft at parking bay",
    });
  }

  return results.sort((a, b) => ((a.submittedAt ?? "") < (b.submittedAt ?? "") ? 1 : -1));
}
