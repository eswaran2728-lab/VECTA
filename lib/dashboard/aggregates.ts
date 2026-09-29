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

export interface EntityDashboardSummary {
  entityCode: string;
  checkedInCount: number;
  pendingCount: number;
  absentCount: number;
  totalStaff: number;
  isBayBoardScoped: boolean;
  overdueBayBoardCount: number;
  generatedAt: string;
}

export interface EntityDashboardSummaryResult {
  status: DashboardDataStatus;
  data: EntityDashboardSummary | null;
}

/** Staffing summary for MAA/AAX Boss, scoped via each staff member's own
 *  active user_entity_memberships row (see get_entity_dashboard_aggregate_
 *  secure() in the Phase 7 closure migration) -- never via station. A
 *  caller with no MAA/AAX Boss assignment gets "unauthorized". */
export async function getEntityDashboardSummary(dutyDate?: string): Promise<EntityDashboardSummaryResult> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_entity_dashboard_aggregate_secure", {
    p_duty_date: dutyDate ?? undefined,
  });
  if (error) return { status: "unauthorized", data: null };
  const row = (data as unknown as Array<Record<string, unknown>>)?.[0];
  if (!row) return { status: "ok", data: null };
  return {
    status: "ok",
    data: {
      entityCode: row.entity_code as string,
      checkedInCount: Number(row.checked_in_count),
      pendingCount: Number(row.pending_count),
      absentCount: Number(row.absent_count),
      totalStaff: Number(row.total_staff),
      isBayBoardScoped: Boolean(row.is_bay_board_scoped),
      overdueBayBoardCount: Number(row.overdue_bay_board_count),
      generatedAt: row.generated_at as string,
    },
  };
}

export interface EntityAdminSummary {
  entityCode: string;
  activeStaffCount: number;
  malaysiaWidePendingRegistrationCount: number;
  generatedAt: string;
}

export interface EntityAdminSummaryResult {
  status: DashboardDataStatus;
  data: EntityAdminSummary | null;
}

/** Directory/registration-queue summary for MAA/AAX Admin. See
 *  get_entity_admin_summary_secure() -- entity-scoped via active
 *  membership; the pending-registration figure is Malaysia-wide and
 *  labeled as such (registration requests carry no entity linkage in this
 *  schema). */
export async function getEntityAdminSummary(): Promise<EntityAdminSummaryResult> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_entity_admin_summary_secure");
  if (error) return { status: "unauthorized", data: null };
  const row = (data as unknown as Array<Record<string, unknown>>)?.[0];
  if (!row) return { status: "ok", data: null };
  return {
    status: "ok",
    data: {
      entityCode: row.entity_code as string,
      activeStaffCount: Number(row.active_staff_count),
      malaysiaWidePendingRegistrationCount: Number(row.malaysia_wide_pending_registration_count),
      generatedAt: row.generated_at as string,
    },
  };
}

export interface SuperAdminTechnicalStatus {
  queuePending: number;
  queueProcessing: number;
  queueCompleted: number;
  queueFailed: number;
  queuePermanentlyFailed: number;
  pendingRegistrationCount: number;
  pendingProfileApprovalCount: number;
  generatedAt: string;
}

export interface SuperAdminTechnicalStatusResult {
  status: DashboardDataStatus;
  data: SuperAdminTechnicalStatus | null;
}

/** Queue/indexing health counts only -- no report content, no secrets. See
 *  get_super_admin_technical_status_secure(); denied to every caller
 *  without an active super_admin assignment. */
export async function getSuperAdminTechnicalStatus(): Promise<SuperAdminTechnicalStatusResult> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_super_admin_technical_status_secure");
  if (error) return { status: "unauthorized", data: null };
  const row = (data as unknown as Array<Record<string, unknown>>)?.[0];
  if (!row) return { status: "ok", data: null };
  return {
    status: "ok",
    data: {
      queuePending: Number(row.queue_pending),
      queueProcessing: Number(row.queue_processing),
      queueCompleted: Number(row.queue_completed),
      queueFailed: Number(row.queue_failed),
      queuePermanentlyFailed: Number(row.queue_permanently_failed),
      pendingRegistrationCount: Number(row.pending_registration_count),
      pendingProfileApprovalCount: Number(row.pending_profile_approval_count),
      generatedAt: row.generated_at as string,
    },
  };
}

export interface FlaggedReportRow {
  id: string;
  sourceTable: string;
  reportType: string | null;
  operatingEntityCode: string | null;
  flightNumber: string | null;
  reportDate: string | null;
  status: string;
  severity: string | null;
  flaggedReason: string | null;
  flaggedAt: string | null;
}

export interface FlaggedReportsResult {
  status: DashboardDataStatus;
  rows: FlaggedReportRow[];
  totalCount: number;
}

/** Reuses Phase 6's flagged_reports_secure() -- the existing, audited,
 *  has_report_access()-gated flagged-report listing. GHOD's access to
 *  flagged reports is already granted inside has_report_access() (Phase 6:
 *  "GHOD: only while the report is actively flagged") -- this wrapper adds
 *  no new authorization. */
export async function getFlaggedReportsSecure(page = 1, pageSize = 25): Promise<FlaggedReportsResult> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("flagged_reports_secure", { p_page: page, p_page_size: pageSize });
  if (error) return { status: "error", rows: [], totalCount: 0 };
  const raw = (data as unknown as Array<Record<string, unknown>>) ?? [];
  return {
    status: "ok",
    rows: raw.map((r) => ({
      id: r.id as string,
      sourceTable: r.source_table as string,
      reportType: (r.report_type as string) ?? null,
      operatingEntityCode: (r.operating_entity_code as string) ?? null,
      flightNumber: (r.flight_number as string) ?? null,
      reportDate: (r.report_date as string) ?? null,
      status: r.status as string,
      severity: (r.severity as string) ?? null,
      flaggedReason: (r.flagged_reason as string) ?? null,
      flaggedAt: (r.flagged_at as string) ?? null,
    })),
    totalCount: raw.length > 0 ? Number(raw[0].total_count) : 0,
  };
}
