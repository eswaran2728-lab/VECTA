import { createClient } from "@/lib/supabase/server";
import { REPORT_META, REPORT_TYPES, type ReportType } from "@/lib/reference-data";
import type { Profile } from "@/lib/types";
import { todayISODateMY } from "@/lib/datetime";

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
}

export async function getFilteredSubmissions(filters: DashboardFilters): Promise<FilteredSubmission[]> {
  const supabase = createClient();
  const { from, to } = rangeToTimestamps(filters);
  const types: ReportType[] = filters.reportType ? [filters.reportType] : [...REPORT_TYPES];

  const results = await Promise.all(
    types.map(async (type) => {
      let query = supabase
        .from(REPORT_META[type].table)
        .select("*")
        .eq("status", "submitted")
        .gte("submitted_at", from)
        .lte("submitted_at", to);

      if (filters.station) query = query.eq("station", filters.station);
      if (filters.team) query = query.eq("team", filters.team);
      if (filters.officerId) query = query.eq("profile_id", filters.officerId);

      const { data } = await query.order("submitted_at", { ascending: false });
      return ((data ?? []) as Record<string, unknown>[]).map((row) => summarize(type, row));
    }),
  );

  return results.flat().sort((a, b) => ((a.submitted_at ?? "") < (b.submitted_at ?? "") ? 1 : -1));
}

function summarize(type: ReportType, row: Record<string, unknown>): FilteredSubmission {
  let summary = "";
  switch (type) {
    case "sec016":
      summary = `Flight ${row.flight} · ${row.reg_no}`;
      break;
    case "sec014":
      summary = `${row.staff_name}`;
      break;
    case "sec029":
      summary = `${row.aircraft_registration} · Bay ${row.parking_bay}`;
      break;
    case "sec018":
      summary = `${row.staff_name}`;
      break;
  }
  return {
    id: String(row.id),
    type,
    station: String(row.station),
    team: String(row.team),
    submitted_at: (row.submitted_at as string | null) ?? null,
    profile_id: String(row.profile_id),
    summary,
  };
}

export async function getTodayCounts(filters: DashboardFilters) {
  const submissions = await getFilteredSubmissions({ ...filters, reportType: undefined });
  const counts: Record<ReportType, number> = { sec016: 0, sec014: 0, sec029: 0, sec018: 0 };
  for (const s of submissions) counts[s.type]++;
  return { counts, submissions };
}

export async function getStationOfficers(station: string): Promise<Profile[]> {
  const supabase = createClient();
  const { data } = await supabase
    .from("profiles")
    .select("*")
    .eq("station", station)
    .eq("role", "OFFICER");
  return (data as Profile[]) ?? [];
}

export interface ShiftComplianceRow {
  profile: Profile;
  submitted: boolean;
  submittedAt: string | null;
}

export async function getShiftCompliance(
  station: string,
  date: string,
): Promise<ShiftComplianceRow[]> {
  const officers = await getStationOfficers(station);
  const filters: DashboardFilters = { dateFrom: date, dateTo: date, station, reportType: "sec014" };
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

export async function getFlightCoverage(filters: DashboardFilters) {
  const supabase = createClient();
  const { from, to } = rangeToTimestamps(filters);
  let query = supabase
    .from("report_sec016")
    .select("id, flight, reg_no, station, team, submitted_at, bay_no, sta_std")
    .eq("status", "submitted")
    .gte("submitted_at", from)
    .lte("submitted_at", to);
  if (filters.station) query = query.eq("station", filters.station);
  if (filters.team) query = query.eq("team", filters.team);
  const { data } = await query.order("submitted_at", { ascending: false });
  return data ?? [];
}

export async function getDiscrepancyCount(filters: DashboardFilters): Promise<number> {
  const supabase = createClient();
  const { from, to } = rangeToTimestamps(filters);

  let sec016Query = supabase
    .from("report_sec016")
    .select("id, discrepancies", { count: "exact" })
    .eq("status", "submitted")
    .gte("submitted_at", from)
    .lte("submitted_at", to)
    .not("discrepancies", "in", '("N/A","","Nil","NIL","nil")');
  if (filters.station) sec016Query = sec016Query.eq("station", filters.station);
  if (filters.team) sec016Query = sec016Query.eq("team", filters.team);

  let sec029Query = supabase
    .from("report_sec029")
    .select("id", { count: "exact" })
    .eq("status", "submitted")
    .eq("declaration", "DISCREPANCIES FOUND AND DUTY OFFICER IS NOTIFIED (PROVIDE DETAILS BELOW)")
    .gte("submitted_at", from)
    .lte("submitted_at", to);
  if (filters.station) sec029Query = sec029Query.eq("station", filters.station);
  if (filters.team) sec029Query = sec029Query.eq("team", filters.team);

  const [a, b] = await Promise.all([sec016Query, sec029Query]);
  return (a.count ?? 0) + (b.count ?? 0);
}

export function buildShiftSummary(
  team: string,
  date: string,
  counts: Record<ReportType, number>,
  discrepancyCount: number,
) {
  const parts = REPORT_TYPES.map(
    (t) => `${counts[t]} × ${t.toUpperCase().replace("SEC", "SEC ")}`,
  ).join(", ");
  const discrepancyLine =
    discrepancyCount > 0
      ? `Discrepancies reported: ${discrepancyCount}.`
      : "Discrepancies reported: 0.";
  return `Team ${team}, ${date}: ${parts}. ${discrepancyLine}`;
}
