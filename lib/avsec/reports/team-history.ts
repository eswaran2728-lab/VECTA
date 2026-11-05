import { createClient } from "@/lib/supabase/server";
import { TEAM_HISTORY_PAGE_SIZE, teamHistoryRpcArgs, type TeamHistoryFilters } from "./team-history-filters";

export interface TeamSubmissionRow {
  source_table: string;
  report_type: string;
  id: string;
  report_no: string | null;
  staff_name: string | null;
  staff_id: string | null;
  flight: string | null;
  entity: string | null;
  station: string;
  team: string;
  typed_station: string | null;
  submitted_at: string | null;
  status: string;
  acknowledged_at: string | null;
  acknowledged_by_name: string | null;
  can_acknowledge: boolean;
}

export type TeamHistoryResult = { ok: true; rows: TeamSubmissionRow[]; total: number; pageCount: number } | { ok: false; error: string };

/** Reports of the caller's own station and team, both entities. The database refuses anyone who is not a DSE or SO and never returns another team's report. */
export async function getTeamSubmissions(filters: TeamHistoryFilters): Promise<TeamHistoryResult> {
  const supabase = (await createClient()) as unknown as { rpc: (n: string, a: Record<string, unknown>) => Promise<{ data: unknown; error: { message?: string } | null }> };
  const { data, error } = await supabase.rpc("list_team_submissions_secure", teamHistoryRpcArgs(filters));
  if (error) return { ok: false, error: error.message?.trim() || "Team Submission History is unavailable." };
  const raw = (Array.isArray(data) ? data : []) as (TeamSubmissionRow & { total_count: number | string })[];
  const total = raw.length > 0 ? Number(raw[0].total_count) : 0;
  return { ok: true, rows: raw.map(({ total_count: _t, ...row }) => row), total, pageCount: Math.max(1, Math.ceil(total / TEAM_HISTORY_PAGE_SIZE)) };
}
