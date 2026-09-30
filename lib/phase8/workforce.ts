import { createClient } from "@/lib/supabase/server";

/**
 * Thin, typed wrappers around the Phase 8 secure RPCs
 * (supabase/migrations/20260930000001_phase8_operational_workflows.sql).
 * No authorization logic lives here -- every function below simply calls
 * the corresponding SECURITY DEFINER RPC and returns its result or a
 * typed error. UI pages for these workflows are NOT built in this pass
 * (see the Phase 8 report's Known Limitations) -- this module is the
 * reusable foundation a later pass wires into pages, the same way
 * lib/dashboard/aggregates.ts was for Phase 7.
 */

export interface Phase8ActionResult<T = undefined> {
  ok: boolean;
  error: string | null;
  data: T | null;
}

async function callVoidRpc(name: Parameters<Awaited<ReturnType<typeof createClient>>["rpc"]>[0], args: Record<string, unknown>): Promise<Phase8ActionResult> {
  const supabase = await createClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabase.rpc as any)(name, args);
  if (error) return { ok: false, error: error.message, data: null };
  return { ok: true, error: null, data: undefined };
}

// --- Leave routing (Part D) ---

export async function reviewLeaveRequestSecure(noticeId: string, action: "approve" | "reject", reviewNotes?: string) {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("review_leave_request_secure", {
    p_notice_id: noticeId,
    p_action: action,
    p_review_notes: reviewNotes ?? null,
  });
  if (error) return { ok: false, error: error.message, data: null } satisfies Phase8ActionResult;
  const row = data?.[0];
  return { ok: true, error: null, data: row ? { id: row.row_id, status: row.result_status } : null } satisfies Phase8ActionResult<{
    id: string;
    status: string;
  }>;
}

// --- Roster ownership (Parts B/C) ---

export async function upsertRosterCellSecure(input: {
  station: string;
  team: string;
  rosterDate: string;
  shiftCode: string;
  startTime?: string | null;
  endTime?: string | null;
  notes?: string | null;
}) {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("upsert_roster_cell_secure", {
    p_station: input.station,
    p_team: input.team,
    p_roster_date: input.rosterDate,
    p_shift_code: input.shiftCode,
    p_start_time: input.startTime ?? null,
    p_end_time: input.endTime ?? null,
    p_notes: input.notes ?? null,
  });
  if (error) return { ok: false, error: error.message, data: null } satisfies Phase8ActionResult;
  return { ok: true, error: null, data: data?.[0]?.row_id ?? null } satisfies Phase8ActionResult<string>;
}

// --- Duty-zone draw (Part F) ---

export async function initiateDutyDrawSecure(station: string, drawDate: string) {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("initiate_duty_draw_secure", { p_station: station, p_draw_date: drawDate });
  if (error) return { ok: false, error: error.message, data: null } satisfies Phase8ActionResult;
  return { ok: true, error: null, data: data?.[0]?.row_id ?? null } satisfies Phase8ActionResult<string>;
}

export async function recordDutyDrawAssignmentSecure(drawId: string, profileId: string, zoneId: string | null) {
  return callVoidRpc("record_duty_draw_assignment_secure", { p_draw_id: drawId, p_profile_id: profileId, p_zone_id: zoneId });
}

export async function finalizeDutyDrawSecure(drawId: string) {
  return callVoidRpc("finalize_duty_draw_secure", { p_draw_id: drawId });
}

export async function getDutyDrawSecure(station: string, drawDate: string) {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_duty_draw_secure", { p_station: station, p_draw_date: drawDate });
  if (error) return { ok: false, error: error.message, data: null } satisfies Phase8ActionResult;
  return { ok: true, error: null, data: data ?? [] } satisfies Phase8ActionResult<NonNullable<typeof data>>;
}

// --- Investigation case workflow (Part G) ---

export async function openInvestigationCaseSecure(input: { title: string; classification?: string; description?: string; priority?: string }) {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("open_investigation_case_secure", {
    p_title: input.title,
    p_classification: input.classification ?? null,
    p_description: input.description ?? null,
    p_priority: input.priority ?? "normal",
  });
  if (error) return { ok: false, error: error.message, data: null } satisfies Phase8ActionResult;
  const row = data?.[0];
  return { ok: true, error: null, data: row ? { id: row.row_id, caseNo: row.case_no } : null } satisfies Phase8ActionResult<{
    id: string;
    caseNo: string;
  }>;
}

export async function linkReportToCaseSecure(caseId: string, repositoryReportId: string) {
  return callVoidRpc("link_report_to_case_secure", { p_case_id: caseId, p_repository_report_id: repositoryReportId });
}

export async function addInvestigationCaseNoteSecure(caseId: string, note: string) {
  return callVoidRpc("add_investigation_case_note_secure", { p_case_id: caseId, p_note: note });
}

export async function assignInvestigationCaseSecure(caseId: string, assigneeId: string) {
  return callVoidRpc("assign_investigation_case_secure", { p_case_id: caseId, p_assignee_id: assigneeId });
}

export async function resolveInvestigationCaseSecure(caseId: string, resolution: string) {
  return callVoidRpc("resolve_investigation_case_secure", { p_case_id: caseId, p_resolution: resolution });
}

export async function reopenInvestigationCaseSecure(caseId: string, reason: string) {
  return callVoidRpc("reopen_investigation_case_secure", { p_case_id: caseId, p_reason: reason });
}

export async function listInvestigationCasesSecure() {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("list_investigation_cases_secure");
  if (error) return { ok: false, error: error.message, data: null } satisfies Phase8ActionResult;
  return { ok: true, error: null, data: data ?? [] } satisfies Phase8ActionResult<NonNullable<typeof data>>;
}

// --- SAT combined-PDF workflow (Part H) ---
// Storage upload itself (writing the actual PDF bytes to the private
// 'sat-combined-reports' bucket at the storage_path this RPC expects) is
// NOT implemented in this pass -- see the Phase 8 report. These wrappers
// cover only the metadata-row RPCs.

export async function uploadSatCombinedReportSecure(input: {
  station: string;
  team: string;
  operationalDate: string;
  shiftCoverage: string;
  storagePath: string;
}) {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("upload_sat_combined_report_secure", {
    p_station: input.station,
    p_team: input.team,
    p_operational_date: input.operationalDate,
    p_shift_coverage: input.shiftCoverage,
    p_storage_path: input.storagePath,
  });
  if (error) return { ok: false, error: error.message, data: null } satisfies Phase8ActionResult;
  return { ok: true, error: null, data: data?.[0]?.row_id ?? null } satisfies Phase8ActionResult<string>;
}

export async function replaceSatCombinedReportSecure(oldReportId: string, shiftCoverage: string, storagePath: string, reason: string) {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("replace_sat_combined_report_secure", {
    p_old_report_id: oldReportId,
    p_shift_coverage: shiftCoverage,
    p_storage_path: storagePath,
    p_reason: reason,
  });
  if (error) return { ok: false, error: error.message, data: null } satisfies Phase8ActionResult;
  return { ok: true, error: null, data: data?.[0]?.row_id ?? null } satisfies Phase8ActionResult<string>;
}

export async function listSatCombinedReportsSecure(station?: string, team?: string) {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("list_sat_combined_reports_secure", {
    p_station: station ?? null,
    p_team: team ?? null,
  });
  if (error) return { ok: false, error: error.message, data: null } satisfies Phase8ActionResult;
  return { ok: true, error: null, data: data ?? [] } satisfies Phase8ActionResult<NonNullable<typeof data>>;
}

// --- Staff Profiling SEC013 acknowledgement (Part I) ---

export async function acknowledgeSec013ReportSecure(reportId: string) {
  return callVoidRpc("acknowledge_sec013_report_secure", { p_report_id: reportId });
}

// --- Main Enforcement workforce authority (Phase 8 Round 2, Slice 1) ---

export async function listEnforcementWorkforceSecure() {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("list_enforcement_workforce_secure");
  if (error) return { ok: false, error: error.message, data: null } satisfies Phase8ActionResult;
  return { ok: true, error: null, data: data ?? [] } satisfies Phase8ActionResult<NonNullable<typeof data>>;
}

export async function listEnforcementAttendanceExceptionsSecure(sinceDate?: string) {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("list_enforcement_attendance_exceptions_secure", {
    p_since: sinceDate ?? null,
  });
  if (error) return { ok: false, error: error.message, data: null } satisfies Phase8ActionResult;
  return { ok: true, error: null, data: data ?? [] } satisfies Phase8ActionResult<NonNullable<typeof data>>;
}

export async function listEnforcementPendingActionsSecure() {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("list_enforcement_pending_actions_secure");
  if (error) return { ok: false, error: error.message, data: null } satisfies Phase8ActionResult;
  return { ok: true, error: null, data: data ?? [] } satisfies Phase8ActionResult<NonNullable<typeof data>>;
}
