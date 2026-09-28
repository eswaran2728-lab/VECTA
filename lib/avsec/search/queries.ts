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

/** Atomic secure fetch: search_reports_secure() (Phase 6) authorizes via
 * has_report_access() AND returns the full source row (as `content`) in
 * the SAME database call -- there is no follow-up query against any
 * report source table anywhere in this file. Direct SELECT on these
 * tables is closed at the RLS layer (Phase 6 Part O) for anyone other
 * than the row's own submitter, so a second query would not reliably
 * return authorized non-owner content even if one were attempted.
 * Content-based filtering (staff name) happens in JS over the already-
 * authorized, already-fetched rows only -- it can never widen which
 * rows were read. Returns empty until a report is indexed into the
 * repository -- expected fail-closed behavior until the Phase 5/6
 * rollout runs for this environment, not a bug. */
async function authorizedRows(
  supabase: Awaited<ReturnType<typeof createClient>>,
  sourceTable: "report_sec013" | "report_sec014" | "report_sec016" | "report_sec018" | "report_sec029" | "report_sec033" | "offload_records",
  fromDate: string,
  toDate: string,
): Promise<Record<string, unknown>[]> {
  const { data, error } = await supabase.rpc("search_reports_secure", {
    p_page: 1,
    p_page_size: 100,
    p_from_date: fromDate,
    p_to_date: toDate,
  });
  if (error || !data) return [];
  return data
    .filter((r) => r.source_table === sourceTable && r.content)
    .map((r) => r.content as Record<string, unknown>);
}

// End-of-shift lookup: "did this staff member file their daily report today?" Filters by
// staff name and the report's submitted date (MY-local calendar day).
export async function searchDailyReportsByStaff(
  staffName: string,
  date: string,
): Promise<StaffReportResult[]> {
  const supabase = await createClient();
  const { from, to } = dayRangeMY(date);
  const needle = staffName.trim().toLowerCase();

  const rows = await authorizedRows(supabase, "report_sec014", from, to);

  return rows
    .filter((row) => row.status === "submitted" && String(row.staff_name ?? "").toLowerCase().includes(needle))
    .map((row) => ({
      reportType: "sec014" as const,
      reportId: String(row.id),
      staffName: String(row.staff_name ?? ""),
      station: String(row.station ?? ""),
      team: String(row.team ?? ""),
      submittedAt: (row.submitted_at as string | null) ?? null,
      detail: row.remark ? String(row.remark).slice(0, 80) : "No remarks",
    }))
    .sort((a, b) => ((a.submittedAt ?? "") < (b.submittedAt ?? "") ? 1 : -1));
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
  const needle = staffName.trim().toLowerCase();

  const [sec016, sec029, sec018] = await Promise.all([
    authorizedRows(supabase, "report_sec016", from, to),
    authorizedRows(supabase, "report_sec029", from, to),
    authorizedRows(supabase, "report_sec018", from, to),
  ]);

  const matches = (row: Record<string, unknown>) =>
    row.status === "submitted" && String(row.staff_name ?? "").toLowerCase().includes(needle);

  const results: StaffReportResult[] = [];

  for (const row of sec016.filter(matches)) {
    results.push({
      reportType: "sec016",
      reportId: String(row.id),
      staffName: String(row.staff_name ?? ""),
      station: String(row.station ?? ""),
      team: String(row.team ?? ""),
      submittedAt: (row.submitted_at as string | null) ?? null,
      detail: `Flight ${row.flight} · Reg ${row.reg_no}`,
    });
  }

  for (const row of sec029.filter(matches)) {
    results.push({
      reportType: "sec029",
      reportId: String(row.id),
      staffName: String(row.staff_name ?? ""),
      station: String(row.station ?? ""),
      team: String(row.team ?? ""),
      submittedAt: (row.submitted_at as string | null) ?? null,
      detail: `Flight ${row.flight_no} · Reg ${row.aircraft_registration}`,
    });
  }

  for (const row of sec018.filter(matches)) {
    results.push({
      reportType: "sec018",
      reportId: String(row.id),
      staffName: String(row.staff_name ?? ""),
      station: String(row.station ?? ""),
      team: String(row.team ?? ""),
      submittedAt: (row.submitted_at as string | null) ?? null,
      detail: "Patrolling of aircraft at parking bay",
    });
  }

  return results.sort((a, b) => ((a.submittedAt ?? "") < (b.submittedAt ?? "") ? 1 : -1));
}
