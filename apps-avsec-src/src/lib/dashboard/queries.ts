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
  report_no: string | null;
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
    case "sec033":
      summary = `${row.staff_name} · Bay checklist`;
      break;
    case "sec013":
      summary = `${row.staff_name} · Profiling duty`;
      break;
    case "offload":
      summary = `Flight ${row.flight_no} → ${row.destination} · ${row.total_bags} bag(s)`;
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
    report_no: (row.report_no as string | null) ?? null,
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
    offload: 0,
  };
  for (const s of submissions) counts[s.type]++;
  return { counts, submissions };
}

export async function getStationOfficers(station: string, team?: string): Promise<Profile[]> {
  const supabase = createClient();
  let query = supabase.from("profiles").select("*").eq("station", station).eq("role", "ASO");
  if (team) query = query.eq("team", team);
  const { data } = await query;
  return (data as Profile[]) ?? [];
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

