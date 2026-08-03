import { createClient } from "@/lib/supabase/server";
import { dayRangeMY } from "@/lib/datetime";

export interface AircraftSearchResult {
  reportType: "sec016" | "sec029" | "sec018";
  reportId: string;
  regNo: string;
  staffName: string;
  station: string;
  team: string;
  submittedAt: string | null;
  detail: string;
}

// Aircraft registration number appears under a different column on each report type;
// SEC 014 has no aircraft field, so it's excluded. Only submitted reports are searched.
export async function searchByAircraftReg(regNo: string): Promise<AircraftSearchResult[]> {
  const supabase = createClient();
  const pattern = `%${regNo.trim()}%`;

  const [sec016, sec029, sec018Patrols] = await Promise.all([
    supabase
      .from("report_sec016")
      .select("id, reg_no, staff_name, station, team, submitted_at, flight, bay_no")
      .eq("status", "submitted")
      .ilike("reg_no", pattern)
      .order("submitted_at", { ascending: false }),
    supabase
      .from("report_sec029")
      .select("id, aircraft_registration, staff_name, station, team, submitted_at, flight_no, parking_bay")
      .eq("status", "submitted")
      .ilike("aircraft_registration", pattern)
      .order("submitted_at", { ascending: false }),
    supabase
      .from("report_sec018_patrols")
      .select(
        "reg_no, description, parking_bay, report_sec018!inner(id, staff_name, station, team, submitted_at, status)",
      )
      .eq("report_sec018.status", "submitted")
      .ilike("reg_no", pattern),
  ]);

  const results: AircraftSearchResult[] = [];

  for (const row of sec016.data ?? []) {
    results.push({
      reportType: "sec016",
      reportId: row.id,
      regNo: row.reg_no,
      staffName: row.staff_name,
      station: row.station,
      team: row.team,
      submittedAt: row.submitted_at,
      detail: `Flight ${row.flight} · Bay ${row.bay_no}`,
    });
  }

  for (const row of sec029.data ?? []) {
    results.push({
      reportType: "sec029",
      reportId: row.id,
      regNo: row.aircraft_registration,
      staffName: row.staff_name,
      station: row.station,
      team: row.team,
      submittedAt: row.submitted_at,
      detail: `Flight ${row.flight_no} · Bay ${row.parking_bay}`,
    });
  }

  for (const row of (sec018Patrols.data ?? []) as unknown as Array<{
    reg_no: string | null;
    description: string;
    parking_bay: string | null;
    report_sec018: {
      id: string;
      staff_name: string;
      station: string;
      team: string;
      submitted_at: string | null;
    };
  }>) {
    const parent = row.report_sec018;
    results.push({
      reportType: "sec018",
      reportId: parent.id,
      regNo: row.reg_no ?? "",
      staffName: parent.staff_name,
      station: parent.station,
      team: parent.team,
      submittedAt: parent.submitted_at,
      detail: `Patrol · Bay ${row.parking_bay ?? "—"}`,
    });
  }

  return results.sort((a, b) => ((a.submittedAt ?? "") < (b.submittedAt ?? "") ? 1 : -1));
}

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
  const supabase = createClient();
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
  const supabase = createClient();
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
