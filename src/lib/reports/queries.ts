import { createClient } from "@/lib/supabase/server";
import { REPORT_META, REPORT_TYPES, type ReportType } from "@/lib/reference-data";
import type { ReportListItem, BayBoardRow } from "@/lib/types";
import { hoursSince } from "@/lib/datetime";

const FOUR_HOURS = 4;

/** Prefix search across all 6 report tables for the report-number reverse lookup —
 * "AASEC16-20260818" (no sequence yet) matches every SEC016 report filed that day.
 * RLS scopes results to whatever the caller can already see, same as any other query. */
export async function searchByReportNoPrefix(prefix: string): Promise<ReportListItem[]> {
  const supabase = createClient();
  const cleaned = prefix.trim().toUpperCase();
  if (!cleaned) return [];

  const results = await Promise.all(
    REPORT_TYPES.map(async (type) => {
      const { data } = await supabase
        .from(REPORT_META[type].table)
        .select("*")
        .ilike("report_no", `${cleaned}%`)
        .order("report_no", { ascending: false })
        .limit(50);
      return ((data ?? []) as Record<string, unknown>[]).map((row) => toListItem(type, row));
    }),
  );

  return results.flat().sort((a, b) => (a.report_no ?? "") < (b.report_no ?? "") ? 1 : -1);
}

export async function getOverdueAircraft(station: string): Promise<
  (BayBoardRow & { hoursOnGround: number })[]
> {
  const supabase = createClient();
  const { data } = await supabase
    .from("bay_board")
    .select("*")
    .eq("station", station)
    .is("cleared_at", null)
    .order("on_ground_since", { ascending: true });

  const rows = (data as BayBoardRow[]) ?? [];
  return rows
    .map((r) => ({ ...r, hoursOnGround: hoursSince(r.on_ground_since) }))
    .filter((r) => r.hoursOnGround >= FOUR_HOURS);
}

export async function getOpenBayBoard(station?: string): Promise<
  (BayBoardRow & { hoursOnGround: number })[]
> {
  const supabase = createClient();
  let query = supabase.from("bay_board").select("*").is("cleared_at", null);
  if (station) query = query.eq("station", station);
  const { data } = await query.order("on_ground_since", { ascending: true });
  const rows = (data as BayBoardRow[]) ?? [];
  return rows.map((r) => ({ ...r, hoursOnGround: hoursSince(r.on_ground_since) }));
}

interface MySubmissionsOptions {
  profileId: string;
  limit?: number;
}

export async function getMySubmissions({
  profileId,
  limit = 20,
}: MySubmissionsOptions): Promise<ReportListItem[]> {
  const supabase = createClient();
  const types: ReportType[] = ["sec016", "sec014", "sec029", "sec018", "sec033", "sec013"];

  const results = await Promise.all(
    types.map(async (type) => {
      const table = REPORT_META[type].table;
      const { data } = await supabase
        .from(table)
        .select("*")
        .eq("profile_id", profileId)
        .order("created_at", { ascending: false })
        .limit(limit);
      return ((data ?? []) as Record<string, unknown>[]).map((row) => toListItem(type, row));
    }),
  );

  return results
    .flat()
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    .slice(0, limit);
}

function toListItem(type: ReportType, row: Record<string, unknown>): ReportListItem {
  let summary = "";
  switch (type) {
    case "sec016":
      summary = `Flight ${row.flight} · Reg ${row.reg_no}`;
      break;
    case "sec014":
      summary = `Patrol duty · ${row.remark ? String(row.remark).slice(0, 60) : ""}`;
      break;
    case "sec029":
      summary = `${row.aircraft_registration} · Bay ${row.parking_bay}`;
      break;
    case "sec018":
      summary = "Night patrol";
      break;
    case "sec033":
      summary = "Aircraft hold checklist";
      break;
    case "sec013":
      summary = `Profiling duty · ${row.remark ? String(row.remark).slice(0, 60) : ""}`;
      break;
  }
  return {
    id: String(row.id),
    type,
    status: row.status as "draft" | "submitted",
    submitted_at: (row.submitted_at as string | null) ?? null,
    created_at: String(row.created_at),
    station: String(row.station),
    team: String(row.team),
    summary,
    report_no: (row.report_no as string | null) ?? null,
  };
}

export async function getReportById(type: ReportType, id: string) {
  const supabase = createClient();
  const table = REPORT_META[type].table;
  const { data } = await supabase.from(table).select("*").eq("id", id).single();
  if (!data) return null;

  if (type === "sec014") {
    const { data: patrols } = await supabase
      .from("report_sec014_patrols")
      .select("*")
      .eq("report_id", id)
      .order("entry_no");
    return { ...data, patrols: patrols ?? [] };
  }
  if (type === "sec018") {
    const { data: patrols } = await supabase
      .from("report_sec018_patrols")
      .select("*")
      .eq("report_id", id)
      .order("entry_no");
    return { ...data, patrols: patrols ?? [] };
  }
  if (type === "sec029") {
    const { data: items } = await supabase
      .from("report_sec029_items")
      .select("*")
      .eq("report_id", id);
    return { ...data, items: items ?? [] };
  }
  if (type === "sec033") {
    const { data: holdChecks } = await supabase
      .from("report_sec033_hold_checks")
      .select("*")
      .eq("report_id", id)
      .order("entry_no");
    return { ...data, hold_checks: holdChecks ?? [] };
  }
  if (type === "sec013") {
    const { data: profilingDuties } = await supabase
      .from("report_sec013_profiling_duties")
      .select("*")
      .eq("report_id", id)
      .order("entry_no");
    return { ...data, profiling_duties: profilingDuties ?? [] };
  }
  return data;
}
