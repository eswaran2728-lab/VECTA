import { createClient } from "@/lib/supabase/server";

/**
 * Thin, typed wrappers around the secure, server-side-scoped dashboard
 * aggregate RPCs (Phase 6's get_report_dashboard_aggregate_secure, Phase
 * 7's get_ops_dashboard_aggregate_secure / get_ops_dashboard_hub_breakdown_
 * secure). Every function here can fail with a thrown/returned error for a
 * caller with no usable scope (e.g. Super Admin, or no active assignment at
 * all) -- callers must render that as an explicit "unauthorized for this
 * card" state, never as a silent zero.
 */

export type DashboardDataStatus = "ok" | "unauthorized" | "error";

export interface ReportCountRow {
  groupValue: string;
  reportCount: number;
}

export interface ReportCountResult {
  status: DashboardDataStatus;
  rows: ReportCountRow[];
}

/** Reuses Phase 6's get_report_dashboard_aggregate_secure -- global totals
 *  for international roles, has_report_access()-filtered per-row totals
 *  for everyone else. No new authorization logic introduced here. */
export async function getReportCountsSecure(
  groupBy: "source_table" | "flag_state" | "status" | "severity" | "operating_entity_code" = "source_table",
): Promise<ReportCountResult> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_report_dashboard_aggregate_secure", { p_group_by: groupBy });
  if (error) return { status: "error", rows: [] };
  const rows = ((data as unknown as Array<{ group_value: string; report_count: number }>) ?? []).map((r) => ({
    groupValue: r.group_value,
    reportCount: r.report_count,
  }));
  return { status: "ok", rows };
}

export interface OpsDashboardSummary {
  scopeKind: "unrestricted" | "station_scoped";
  checkedInCount: number;
  pendingCount: number;
  absentCount: number;
  totalStaff: number;
  overdueBayBoardCount: number;
  generatedAt: string;
}

export interface OpsDashboardSummaryResult {
  status: DashboardDataStatus;
  data: OpsDashboardSummary | null;
}

/** Staffing + Bay Board summary, scoped server-side to the caller's own
 *  active Phase 3 assignment (see resolve_ops_dashboard_station_scope() in
 *  the Phase 7 migration). `status: "unauthorized"` (e.g. Super Admin, or
 *  no active assignment) must be rendered as an explicit unauthorized/empty
 *  state -- never treated as "zero staff". */
export async function getOpsDashboardSummary(dutyDate?: string): Promise<OpsDashboardSummaryResult> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_ops_dashboard_aggregate_secure", {
    p_duty_date: dutyDate ?? undefined,
  });
  if (error) return { status: "unauthorized", data: null };
  const row = (data as unknown as Array<Record<string, unknown>>)?.[0];
  if (!row) return { status: "ok", data: null };
  return {
    status: "ok",
    data: {
      scopeKind: row.scope_kind as "unrestricted" | "station_scoped",
      checkedInCount: Number(row.checked_in_count),
      pendingCount: Number(row.pending_count),
      absentCount: Number(row.absent_count),
      totalStaff: Number(row.total_staff),
      overdueBayBoardCount: Number(row.overdue_bay_board_count),
      generatedAt: row.generated_at as string,
    },
  };
}

export interface HubBreakdownRow {
  hubCode: string;
  checkedInCount: number;
  totalStaff: number;
}

export interface HubBreakdownResult {
  status: DashboardDataStatus;
  rows: HubBreakdownRow[];
}

/** Hub-level staffing breakdown, same scope + small-group suppression as
 *  get_ops_dashboard_hub_breakdown_secure(). */
export async function getOpsDashboardHubBreakdown(dutyDate?: string): Promise<HubBreakdownResult> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_ops_dashboard_hub_breakdown_secure", {
    p_duty_date: dutyDate ?? undefined,
  });
  if (error) return { status: "unauthorized", rows: [] };
  const rows = ((data as unknown as Array<Record<string, unknown>>) ?? []).map((r) => ({
    hubCode: r.hub_code as string,
    checkedInCount: Number(r.checked_in_count),
    totalStaff: Number(r.total_staff),
  }));
  return { status: "ok", rows };
}
