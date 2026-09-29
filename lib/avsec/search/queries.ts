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

type SearchRow = {
  id: string;
  source_table: string;
  status: string;
  submitted_at: string | null;
  staff_name: string | null;
  station: string | null;
  team: string | null;
  remark_excerpt: string | null;
  secondary_identifier: string | null;
};

/** Atomic secure fetch: search_reports_secure() (Phase 6, round 4)
 * authorizes via has_report_access() AND returns only CARD-appropriate
 * display fields (staff_name, station, team, an 80-char remark excerpt,
 * a per-type secondary identifier such as "Flight AK123 · Reg 9M-ABC")
 * in the SAME database call, via report_source_summary() -- never the
 * complete report body. There is no follow-up query against any report
 * source table anywhere in this file, and no full-content field is ever
 * requested or exposed through this unaudited search path (complete
 * content is available only through the audited get_report_secure()
 * detail read, PDF, export, or version-content RPCs). Content-based
 * filtering (staff name) happens in JS over the already-authorized,
 * already-fetched rows only -- it can never widen which rows were read.
 * Returns empty until a report is indexed into the repository --
 * expected fail-closed behavior until the Phase 5/6 rollout runs. */
async function authorizedRows(
  supabase: Awaited<ReturnType<typeof createClient>>,
  sourceTable: "report_sec013" | "report_sec014" | "report_sec016" | "report_sec018" | "report_sec029" | "report_sec033" | "offload_records",
  fromDate: string,
  toDate: string,
): Promise<SearchRow[]> {
  const { data, error } = await supabase.rpc("search_reports_secure", {
    p_page: 1,
    p_page_size: 100,
    p_from_date: fromDate,
    p_to_date: toDate,
  });
  if (error || !data) return [];
  return data.filter((r) => r.source_table === sourceTable).map((r) => ({
    id: r.id,
    source_table: r.source_table,
    status: r.status,
    submitted_at: r.indexed_at ?? null,
    staff_name: r.staff_name,
    station: r.station,
    team: r.team,
    remark_excerpt: r.remark_excerpt,
    secondary_identifier: r.secondary_identifier,
  }));
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
    .filter((row) => row.status === "submitted" && (row.staff_name ?? "").toLowerCase().includes(needle))
    .map((row) => ({
      reportType: "sec014" as const,
      reportId: row.id,
      staffName: row.staff_name ?? "",
      station: row.station ?? "",
      team: row.team ?? "",
      submittedAt: row.submitted_at,
      detail: row.remark_excerpt ? row.remark_excerpt : "No remarks",
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

  const matches = (row: SearchRow) =>
    row.status === "submitted" && (row.staff_name ?? "").toLowerCase().includes(needle);

  const results: StaffReportResult[] = [];

  for (const row of sec016.filter(matches)) {
    results.push({
      reportType: "sec016",
      reportId: row.id,
      staffName: row.staff_name ?? "",
      station: row.station ?? "",
      team: row.team ?? "",
      submittedAt: row.submitted_at,
      detail: row.secondary_identifier ?? "",
    });
  }

  for (const row of sec029.filter(matches)) {
    results.push({
      reportType: "sec029",
      reportId: row.id,
      staffName: row.staff_name ?? "",
      station: row.station ?? "",
      team: row.team ?? "",
      submittedAt: row.submitted_at,
      detail: row.secondary_identifier ?? "",
    });
  }

  for (const row of sec018.filter(matches)) {
    results.push({
      reportType: "sec018",
      reportId: row.id,
      staffName: row.staff_name ?? "",
      station: row.station ?? "",
      team: row.team ?? "",
      submittedAt: row.submitted_at,
      detail: "Patrolling of aircraft at parking bay",
    });
  }

  return results.sort((a, b) => ((a.submittedAt ?? "") < (b.submittedAt ?? "") ? 1 : -1));
}
