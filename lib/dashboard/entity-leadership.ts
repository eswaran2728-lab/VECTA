import { createClient } from "@/lib/supabase/server";
import type { DashboardDataStatus } from "@/lib/dashboard/aggregates";
import type { EntityReportFilters } from "@/lib/dashboard/entity-report-filters";

/**
 * Typed wrappers for the MAA/AAX leadership RPCs (migrations 20261101000001-5). Authorization is decided entirely inside the
 * database; these wrappers add none. A failed or refused call is returned as an explicit status, never as a silent zero.
 */

const REFUSED = /Only an approved|Must be signed in|approved account/i;

export interface ReportTypeCount {
  sourceTable: string;
  label: string;
  total: number;
}
export async function getEntityReportCounts(
  from?: string | null,
  to?: string | null,
): Promise<{ status: DashboardDataStatus; rows: ReportTypeCount[]; entityTotal: number }> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_entity_report_counts_secure", { p_from_date: from ?? null, p_to_date: to ?? null });
  if (error) return { status: REFUSED.test(error.message) ? "unauthorized" : "error", rows: [], entityTotal: 0 };
  const rows = (data ?? []).map((r) => ({ sourceTable: r.source_table, label: r.report_label, total: Number(r.total) }));
  return { status: "ok", rows, entityTotal: rows.reduce((n, r) => n + r.total, 0) };
}

export interface ReportSummaryRow {
  id: string;
  sourceTable: string;
  sourceId: string;
  reportType: string;
  entityCode: string | null;
  flightNumber: string | null;
  reportDate: string | null;
  status: string;
  flagState: string;
  staffName: string | null;
  station: string | null;
  team: string | null;
  regNo: string | null;
}
export async function searchEntityReports(f: EntityReportFilters): Promise<{ status: DashboardDataStatus; rows: ReportSummaryRow[]; total: number }> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("search_reports_filtered_secure", {
    p_page: f.page,
    p_page_size: f.pageSize,
    p_registration: f.registration,
    p_flight_number: f.flight,
    p_from_date: f.from,
    p_to_date: f.to,
    p_source_table: f.sourceTable,
    p_status: f.status,
  });
  if (error) return { status: REFUSED.test(error.message) ? "unauthorized" : "error", rows: [], total: 0 };
  const rows = (data ?? []).map((r) => ({
    id: r.id,
    sourceTable: r.source_table,
    sourceId: r.source_id,
    reportType: r.report_type,
    entityCode: r.operating_entity_code,
    flightNumber: r.flight_number,
    reportDate: r.report_date,
    status: r.status,
    flagState: r.flag_state,
    staffName: r.staff_name,
    station: r.station,
    team: r.team,
    regNo: r.reg_no,
  }));
  return { status: "ok", rows, total: data && data.length > 0 ? Number(data[0].total_count) : 0 };
}

export interface DirectoryRow {
  staffNo: string;
  staffName: string;
  entityCode: string;
  roleCode: string | null;
  departmentCode: string | null;
  unitCode: string | null;
  hubCode: string | null;
  stationCode: string | null;
  teamName: string | null;
  accountState: string;
}
export async function getStaffDirectory(
  search: string | null,
  entity: string | null,
  page: number,
  pageSize = 50,
): Promise<{ status: DashboardDataStatus; rows: DirectoryRow[]; total: number }> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("list_malaysia_staff_directory_secure", {
    p_search: search,
    p_entity_code: entity,
    p_page: page,
    p_page_size: pageSize,
  });
  if (error) return { status: REFUSED.test(error.message) ? "unauthorized" : "error", rows: [], total: 0 };
  const rows = (data ?? []).map((r) => ({
    staffNo: r.staff_no,
    staffName: r.staff_name,
    entityCode: r.entity_code,
    roleCode: r.role_code,
    departmentCode: r.department_code,
    unitCode: r.unit_code,
    hubCode: r.hub_code,
    stationCode: r.station_code,
    teamName: r.team_name,
    accountState: r.account_state,
  }));
  return { status: "ok", rows, total: data && data.length > 0 ? Number(data[0].total_count) : 0 };
}

export interface WorkforceRow {
  entityCode: string;
  activeStaff: number;
  checkedIn: number;
  pending: number;
  absent: number;
  generatedAt: string;
}
export async function getWorkforceSummary(): Promise<{ status: DashboardDataStatus; rows: WorkforceRow[] }> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_malaysia_workforce_summary_secure", {});
  if (error) return { status: REFUSED.test(error.message) ? "unauthorized" : "error", rows: [] };
  return {
    status: "ok",
    rows: (data ?? []).map((r) => ({
      entityCode: r.entity_code,
      activeStaff: Number(r.active_staff),
      checkedIn: Number(r.checked_in),
      pending: Number(r.pending),
      absent: Number(r.absent),
      generatedAt: r.generated_at,
    })),
  };
}

export async function getEntityAdminOverview(): Promise<{
  status: DashboardDataStatus;
  entityCode: string | null;
  entityActiveStaff: number;
  malaysiaPendingRegistrations: number;
}> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_entity_admin_overview_secure");
  const row = data?.[0];
  if (error || !row) {
    return { status: error && REFUSED.test(error.message) ? "unauthorized" : "error", entityCode: null, entityActiveStaff: 0, malaysiaPendingRegistrations: 0 };
  }
  return {
    status: "ok",
    entityCode: row.entity_code,
    entityActiveStaff: Number(row.entity_active_staff),
    malaysiaPendingRegistrations: Number(row.malaysia_pending_registrations),
  };
}

export interface BayBoardScope {
  hubCode: string;
  hubName: string;
  stationCode: string;
  stationName: string;
}
export async function getBayBoardScopes(): Promise<{ status: DashboardDataStatus; scopes: BayBoardScope[] }> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("list_bay_board_scopes_secure");
  if (error) return { status: REFUSED.test(error.message) ? "unauthorized" : "error", scopes: [] };
  return {
    status: "ok",
    scopes: (data ?? []).map((r) => ({ hubCode: r.hub_code, hubName: r.hub_name, stationCode: r.station_code, stationName: r.station_name })),
  };
}

export interface BayBoardRow {
  id: string;
  station: string;
  regNo: string | null;
  aircraftType: string | null;
  bay: string | null;
  flight: string | null;
  onGroundSince: string | null;
}
export async function getBayBoard(hubCode: string | null, stationCode: string | null): Promise<{ status: DashboardDataStatus; rows: BayBoardRow[] }> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_bay_board_secure", { p_hub_code: hubCode, p_station_code: stationCode });
  if (error) return { status: REFUSED.test(error.message) ? "unauthorized" : "error", rows: [] };
  return {
    status: "ok",
    rows: (data ?? []).map((r) => ({
      id: r.id,
      station: r.station,
      regNo: r.reg_no,
      aircraftType: r.aircraft_type,
      bay: r.bay,
      flight: r.flight,
      onGroundSince: r.on_ground_since,
    })),
  };
}
