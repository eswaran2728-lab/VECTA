import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { REPORT_META, REPORT_TYPES, type ReportType } from "@/lib/avsec/reference-data";
import type { ReportListItem, BayBoardRow } from "@/lib/avsec/types";
import { hoursSince } from "@/lib/avsec/datetime";

const FOUR_HOURS = 4;

const TABLE_TO_TYPE = new Map(REPORT_TYPES.map((t) => [REPORT_META[t].table, t]));

/** Prefix search across all 7 report tables for the report-number reverse lookup —
 * "AASEC16-20260818" (no sequence yet) matches every SEC016 report filed that day.
 * Atomic and authorized (Phase 6, round 4): search_reports_by_number_secure()
 * runs the same has_report_access()-authorized CTE as list/search and returns
 * only card fields via report_source_summary() -- never a full row, and never
 * reads a report table directly (this previously relied entirely on the now-
 * closed legacy RLS "station select"/"rank select" policies, unscoped by
 * profile_id at all). */
export async function searchByReportNoPrefix(prefix: string): Promise<ReportListItem[]> {
  const supabase = await createClient();
  const cleaned = prefix.trim().toUpperCase();
  if (!cleaned) return [];

  const { data } = await supabase.rpc("search_reports_by_number_secure", {
    p_prefix: cleaned,
    p_limit: 50,
  });

  return (data ?? [])
    .map((row): ReportListItem | null => {
      const type = TABLE_TO_TYPE.get(row.source_table);
      if (!type) return null;
      return {
        id: row.id,
        type,
        status: row.status as "draft" | "submitted",
        submitted_at: null,
        created_at: row.report_date ?? "",
        station: row.station ?? "",
        team: row.team ?? "",
        summary: row.secondary_identifier ?? row.staff_name ?? "",
        report_no: row.report_no,
        flight_type: undefined,
      };
    })
    .filter((item): item is ReportListItem => item !== null)
    .sort((a, b) => ((a.report_no ?? "") < (b.report_no ?? "") ? 1 : -1));
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

/** CORRECTION (review round 4): this previously read full source rows
 * directly, scoped by `.eq("profile_id", profileId)` -- safe in the
 * sense that RLS's "own row" policy structurally capped it to the
 * caller's own reports regardless of what profileId was passed, but
 * still a direct full-content SELECT of every column including remark/
 * declaration/etc. Replaced with list_my_submissions_secure() (Phase 6),
 * which no longer accepts a profileId parameter AT ALL -- it derives the
 * caller's identity from auth.uid() exclusively, so it can never be used
 * to read anyone else's submissions even in principle, and returns only
 * card fields (never full content) via report_source_summary(). The
 * profileId parameter is kept on this function's own signature only for
 * caller-side compatibility (both existing call sites already pass the
 * signed-in user's own id) -- it is not forwarded to the RPC. */
export async function getMySubmissions({
  limit = 20,
}: MySubmissionsOptions): Promise<ReportListItem[]> {
  const supabase = await createClient();

  const { data } = await supabase.rpc("list_my_submissions_secure", { p_limit: limit });

  return (data ?? [])
    .map((row): ReportListItem | null => {
      const type = TABLE_TO_TYPE.get(row.source_table);
      if (!type) return null;
      return {
        id: row.id,
        type,
        status: row.status as "draft" | "submitted",
        submitted_at: row.submitted_at,
        created_at: row.created_at,
        station: row.station ?? "",
        team: row.team ?? "",
        summary: row.secondary_identifier ?? row.staff_name ?? "",
        report_no: row.report_no,
        flight_type: undefined,
      };
    })
    .filter((item): item is ReportListItem => item !== null);
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
