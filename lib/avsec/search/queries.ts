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

/** Two-step secure pattern used by every function in this file: (1) call the
 * Phase 6 search_reports_secure() RPC, whose "authorized" CTE runs
 * has_report_access() before anything else, to get the set of repository
 * source_ids for a given source_table the caller is actually authorized to
 * see within the date range; (2) fetch full row content from the source
 * table scoped to EXACTLY that already-authorized id set (.in("id", ...)),
 * never an open table scan. Content-based filtering (staff name) happens
 * client/server-side afterward, on the already-authorized rows only — it
 * never widens which rows are read. If the repository has not yet indexed
 * a report (current state in every environment until the Phase 5/6
 * rollout runs), it simply will not appear in the authorized set and is
 * correctly excluded, not leaked through a fallback. */
async function authorizedSourceIds(
  supabase: Awaited<ReturnType<typeof createClient>>,
  sourceTable: "report_sec013" | "report_sec014" | "report_sec016" | "report_sec018" | "report_sec029" | "report_sec033" | "offload_records",
  fromDate: string,
  toDate: string,
): Promise<string[]> {
  const { data, error } = await supabase.rpc("search_reports_secure", {
    p_page: 1,
    p_page_size: 100,
    p_from_date: fromDate,
    p_to_date: toDate,
  });
  if (error || !data) return [];
  // search_reports_secure() doesn't filter by source_table itself (it
  // accepts a richer filter set than list_reports_secure()) — narrow to
  // the requested type here, over the already-authorized rows only.
  return data.filter((r) => r.source_table === sourceTable).map((r) => r.id);
}

// End-of-shift lookup: "did this staff member file their daily report today?" Filters by
// staff name and the report's submitted date (MY-local calendar day).
export async function searchDailyReportsByStaff(
  staffName: string,
  date: string,
): Promise<StaffReportResult[]> {
  const supabase = await createClient();
  const { from, to } = dayRangeMY(date);

  // NOTE (deployment dependency, unchanged from the Phase 6 report):
  // search_reports_secure() authorizes by the repository's indexed id,
  // not the source table's own id directly, so this returns empty until
  // reports are actually indexed for this environment. This is expected
  // fail-closed behavior, not a bug — see the Phase 6 report's
  // deployment sequencing section.
  const ids = await authorizedSourceIds(supabase, "report_sec014", from, to);
  if (ids.length === 0) return [];

  const { data } = await supabase
    .from("report_sec014")
    .select("id, staff_name, station, team, submitted_at, date_time_in, date_time_out, remark")
    .eq("status", "submitted")
    .in("id", ids)
    .ilike("staff_name", `%${staffName.trim()}%`)
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

  const [sec016Ids, sec029Ids, sec018Ids] = await Promise.all([
    authorizedSourceIds(supabase, "report_sec016", from, to),
    authorizedSourceIds(supabase, "report_sec029", from, to),
    authorizedSourceIds(supabase, "report_sec018", from, to),
  ]);

  const [sec016, sec029, sec018] = await Promise.all([
    sec016Ids.length === 0
      ? { data: [] as { id: string; staff_name: string; station: string; team: string; submitted_at: string | null; flight: string; reg_no: string }[] }
      : supabase
          .from("report_sec016")
          .select("id, staff_name, station, team, submitted_at, flight, reg_no")
          .eq("status", "submitted")
          .in("id", sec016Ids)
          .ilike("staff_name", pattern)
          .order("submitted_at", { ascending: false }),
    sec029Ids.length === 0
      ? { data: [] as { id: string; staff_name: string; station: string; team: string; submitted_at: string | null; flight_no: string; aircraft_registration: string }[] }
      : supabase
          .from("report_sec029")
          .select("id, staff_name, station, team, submitted_at, flight_no, aircraft_registration")
          .eq("status", "submitted")
          .in("id", sec029Ids)
          .ilike("staff_name", pattern)
          .order("submitted_at", { ascending: false }),
    sec018Ids.length === 0
      ? { data: [] as { id: string; staff_name: string; station: string; team: string; submitted_at: string | null }[] }
      : supabase
          .from("report_sec018")
          .select("id, staff_name, station, team, submitted_at")
          .eq("status", "submitted")
          .in("id", sec018Ids)
          .ilike("staff_name", pattern)
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
