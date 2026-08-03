import { createClient } from "@/lib/supabase/server";

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
