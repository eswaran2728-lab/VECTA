import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { REPORT_META, REPORT_TYPES, type ReportType } from "@/lib/avsec/reference-data";
import type { ReportListItem, BayBoardRow } from "@/lib/avsec/types";
import { hoursSince } from "@/lib/avsec/datetime";

const FOUR_HOURS = 4;

/** Prefix search across all 6 report tables for the report-number reverse lookup —
 * "AASEC16-20260818" (no sequence yet) matches every SEC016 report filed that day.
 * RLS scopes results to whatever the caller can already see, same as any other query. */
export async function searchByReportNoPrefix(prefix: string): Promise<ReportListItem[]> {
  const supabase = await createClient();
  const cleaned = prefix.trim().toUpperCase();
  if (!cleaned) return [];

  const results = await Promise.all(
    REPORT_TYPES.map(async (type) => {
      const { data } = await supabase
        .from(REPORT_META[type].table as never)
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
  const supabase = await createClient();
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
  const supabase = await createClient();
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
  const supabase = await createClient();
  const types: ReportType[] = [...REPORT_TYPES];

  const results = await Promise.all(
    types.map(async (type) => {
      const table = REPORT_META[type].table;
      const { data } = await supabase
        .from(table as never)
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
    case "sec016": {
      const dirTag = row.flight_type === "departure" ? "[DEP]" : "[ARR]";
      summary = `${dirTag} Flight ${row.flight} · Reg ${row.reg_no}`;
      break;
    }
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
    flight_type: (row.flight_type as "arrival" | "departure" | undefined) ?? undefined,
  };
}

/** Thrown when a report exists but has not yet been indexed into the
 * Phase 5 Central Reporting Repository -- authorization cannot be
 * verified through the secure path yet, so this fails closed rather
 * than falling back to an unauthorized direct read. This is expected
 * for every report until the Phase 2-6 migrations are applied and the
 * indexing queue/backfill has run (see the Phase 6 report's deployment
 * sequencing section) -- it is not a bug. */
export class ReportNotIndexedError extends Error {
  constructor(type: ReportType, id: string) {
    super(`Report ${type}/${id} has not yet been indexed into the secure repository. It cannot be opened until the Phase 5/6 rollout (migration, role-assignment activation, and backfill/indexing) has run for this environment.`);
    this.name = "ReportNotIndexedError";
  }
}

/** Atomic: get_report_secure() (Phase 6) authorizes AND returns the full
 * source row (as `content`, including child patrol/item/hold-check/
 * profiling-duty arrays -- see report_source_content() in the migration)
 * in the SAME database call. There is no second, follow-up query against
 * any report source table here at all -- direct SELECT on these tables
 * has been closed at the RLS layer (Phase 6 Part O) for anyone other
 * than the row's own submitter, so a second query wouldn't reliably
 * return authorized non-owner content anyway even if attempted. */
export async function getReportById(type: ReportType, id: string) {
  const supabase = await createClient();
  const table = REPORT_META[type].table;

  const { data: indexRow } = await supabase
    .from("central_reports_index")
    .select("id")
    .eq("source_table", table)
    .eq("source_id", id)
    .maybeSingle();
  if (!indexRow) {
    throw new ReportNotIndexedError(type, id);
  }

  const { data, error } = await supabase
    .rpc("get_report_secure", { p_repository_report_id: indexRow.id })
    .single();
  if (error) {
    throw new Error(error.message);
  }
  if (!data?.content) return null;

  return data.content as Record<string, unknown>;
}

export interface EligibleOfficer {
  id: string;
  name: string;
  staff_no: string;
}

/** SEC029's Supervising Officer dropdown: only SO/DSE profiles on the *same* team,
 *  station, and ops_group as the signed-in ASO — an Alpha (Operation AVSEC) officer
 *  must never see Bravo's or IFC AVSEC's SO/DSE names, even if a team of the same
 *  name exists in another branch. Also used server-side to re-verify the selected
 *  officer on submit, since the client-side dropdown is not itself a security
 *  boundary. */
export async function getEligibleSupervisingOfficers(
  station: string,
  team: string,
  opsGroup: string | null,
): Promise<EligibleOfficer[]> {
  // profiles' own RLS ("profiles self select") only lets an ASO read their own row —
  // by design, not a bug to work around loosely. This lookup needs the admin client
  // specifically because the query itself is already tightly scoped (own station +
  // own team + own ops_group + SO/DSE role only), so it can never surface anyone
  // outside the caller's own team regardless of the elevated client.
  const supabase = createAdminClient();
  let query = supabase
    .from("profiles")
    .select("id, name, staff_no")
    .eq("station", station)
    .eq("team", team)
    .eq("status", "approved")
    .in("role", ["SO", "DSE"])
    .order("name");
  if (opsGroup) query = query.eq("ops_group", opsGroup);
  const { data } = await query;
  return (data ?? []) as EligibleOfficer[];
}
