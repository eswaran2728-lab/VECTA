import { createClient } from "@/lib/supabase/server";
import { REPORT_META, REPORT_TYPES, type ReportType } from "@/lib/avsec/reference-data";
import type { Profile } from "@/lib/avsec/types";
import { todayISODateMY } from "@/lib/avsec/datetime";

export interface DashboardFilters {
  dateFrom: string; // YYYY-MM-DD (MY local)
  dateTo: string;
  station?: string;
  team?: string;
  reportType?: ReportType;
  officerId?: string;
}

export function defaultFilters(): DashboardFilters {
  const today = todayISODateMY();
  return { dateFrom: today, dateTo: today };
}

function rangeToTimestamps(filters: DashboardFilters) {
  // MY is UTC+8; treat the picked calendar days as MY-local day boundaries.
  const from = `${filters.dateFrom}T00:00:00+08:00`;
  const to = `${filters.dateTo}T23:59:59.999+08:00`;
  return { from, to };
}

export interface FilteredSubmission {
  id: string;
  type: ReportType;
  station: string;
  team: string;
  submitted_at: string | null;
  profile_id: string;
  summary: string;
  report_no: string | null;
}

type ListRow = {
  id: string;
  report_type: string; // NOTE: central_reports_index.report_type actually stores the report's report_no value (index_report()'s p_report_type parameter is populated from the source row's report_no column) -- not a type label.
  status: string;
  indexed_at: string;
  station: string | null;
  team: string | null;
  staff_name: string | null;
  secondary_identifier: string | null;
  submitter_profile_id: string | null;
};

/** Atomic secure fetch (see lib/avsec/search/queries.ts for the same
 * approach): list_reports_secure() authorizes via has_report_access()
 * AND returns only CARD-appropriate display fields (never a full report
 * body) in the SAME database call for the requested source_table/date
 * range -- no follow-up query against any report source table, and no
 * unaudited exposure of remark/evidence/child-record content. Station/
 * team/officer filtering happens in JS over the already-authorized,
 * already-fetched rows. Returns empty per type until reports are
 * indexed into the repository -- expected fail-closed behavior until
 * the Phase 5/6 rollout runs. */
async function authorizedRowsForType(
  supabase: Awaited<ReturnType<typeof createClient>>,
  table: string,
  fromDate: string,
  toDate: string,
): Promise<ListRow[]> {
  const { data } = await supabase.rpc("list_reports_secure", {
    p_page: 1,
    p_page_size: 100,
    p_source_table: table,
    p_from_date: fromDate,
    p_to_date: toDate,
  });
  return (data ?? []).map((r) => ({
    id: r.id,
    report_type: r.report_type,
    status: r.status,
    indexed_at: r.indexed_at,
    station: r.station,
    team: r.team,
    staff_name: r.staff_name,
    secondary_identifier: r.secondary_identifier,
    submitter_profile_id: r.submitter_profile_id,
  }));
}

export async function getFilteredSubmissions(filters: DashboardFilters): Promise<FilteredSubmission[]> {
  const supabase = await createClient();
  const { from, to } = rangeToTimestamps(filters);
  const types: ReportType[] = filters.reportType ? [filters.reportType] : [...REPORT_TYPES];

  const results = await Promise.all(
    types.map(async (type) => {
      const table = REPORT_META[type].table;
      const rows = await authorizedRowsForType(supabase, table, filters.dateFrom, filters.dateTo);

      return rows
        .filter((row) => {
          if (row.status !== "submitted") return false;
          if (row.indexed_at < from || row.indexed_at > to) return false;
          if (filters.station && row.station !== filters.station) return false;
          if (filters.team && row.team !== filters.team) return false;
          if (filters.officerId && row.submitter_profile_id !== filters.officerId) return false;
          return true;
        })
        .map((row) => summarize(type, row));
    }),
  );

  return results.flat().sort((a, b) => ((a.submitted_at ?? "") < (b.submitted_at ?? "") ? 1 : -1));
}

function summarize(type: ReportType, row: ListRow): FilteredSubmission {
  const summary = row.secondary_identifier ?? row.staff_name ?? "";
  return {
    id: row.id,
    type,
    station: row.station ?? "",
    team: row.team ?? "",
    submitted_at: row.indexed_at,
    profile_id: row.submitter_profile_id ?? "",
    summary,
    report_no: row.report_type,
  };
}

export async function getTodayCounts(filters: DashboardFilters) {
  const submissions = await getFilteredSubmissions({ ...filters, reportType: undefined });
  const counts: Record<ReportType, number> = {
    sec016: 0,
    sec014: 0,
    sec029: 0,
    sec018: 0,
    sec033: 0,
    sec013: 0,
  };
  for (const s of submissions) counts[s.type]++;
  return { counts, submissions };
}

export async function getStationOfficers(station: string, team?: string): Promise<Profile[]> {
  const supabase = await createClient();
  let query = supabase.from("profiles").select("*").eq("station", station).eq("role", "ASO");
  if (team) query = query.eq("team", team);
  const { data } = await query;
  return (data as unknown as Profile[]) ?? [];
}

export interface ShiftComplianceRow {
  profile: Profile;
  submitted: boolean;
  submittedAt: string | null;
}

// team should be the viewing SO/DSE's own team, since RLS already hides other teams'
// submissions from them — without it, another team's ASOs would wrongly show as MISSING.
// Org-wide viewers (Enforcement/Management/Admin) pass undefined to see every team.
export async function getShiftCompliance(
  station: string,
  date: string,
  team?: string,
): Promise<ShiftComplianceRow[]> {
  const officers = await getStationOfficers(station, team);
  const filters: DashboardFilters = { dateFrom: date, dateTo: date, station, team, reportType: "sec014" };
  const submissions = await getFilteredSubmissions(filters);
  const submittedByOfficer = new Map(submissions.map((s) => [s.profile_id, s.submitted_at]));

  return officers
    .map((o) => ({
      profile: o,
      submitted: submittedByOfficer.has(o.id),
      submittedAt: submittedByOfficer.get(o.id) ?? null,
    }))
    .sort((a, b) => a.profile.name.localeCompare(b.profile.name));
}

/** Secure two-step pattern (matches lib/avsec/search/queries.ts): first
 * get the set of repository source_ids for report_sec016 the caller is
 * authorized to see in this date range via search_reports_secure()
 * (has_report_access() enforced inside that RPC), then scope the source-
 * table read to exactly that id set. Station/team filtering happens on
 * the already-authorized rows. Returns empty until the report is
 * indexed into the repository — expected fail-closed behavior until the
 * Phase 5/6 rollout runs for this environment. */
export async function getFlightCoverage(filters: DashboardFilters) {
  const supabase = await createClient();
  const { from, to } = rangeToTimestamps(filters);

  const { data: authorized } = await supabase.rpc("search_reports_secure", {
    p_page: 1,
    p_page_size: 100,
    p_from_date: from.slice(0, 10),
    p_to_date: to.slice(0, 10),
  });

  return (authorized ?? [])
    .filter((r) => r.source_table === "report_sec016")
    .filter((row) => {
      if (row.status !== "submitted") return false;
      if (row.indexed_at < from || row.indexed_at > to) return false;
      if (filters.station && row.station !== filters.station) return false;
      if (filters.team && row.team !== filters.team) return false;
      return true;
    })
    .map((row) => ({
      id: row.id,
      flight: row.flight_number,
      reg_no: row.reg_no,
      station: row.station ?? "",
      team: row.team ?? "",
      submitted_at: row.indexed_at,
      bay_no: row.bay_no,
      sta_std: row.sta_std,
    }))
    .sort((a, b) => ((a.submitted_at ?? "") < (b.submitted_at ?? "") ? 1 : -1));
}

