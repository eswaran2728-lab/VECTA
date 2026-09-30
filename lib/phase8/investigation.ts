"use server";

import { createClient } from "@/lib/supabase/server";
import { dayRangeMY } from "@/lib/avsec/datetime";

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

export async function openInvestigationCase(input: { title: string; classification?: string; description?: string; priority?: string }) {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("open_investigation_case_secure", {
    p_title: input.title,
    p_classification: input.classification ?? null,
    p_description: input.description ?? null,
    p_priority: input.priority ?? "normal",
  });
  if (error) return { ok: false, error: error.message, data: null } satisfies Phase8ActionResult;
  const row = data?.[0];
  return { ok: true, error: null, data: row ? { id: row.row_id, caseNo: row.case_no } : null } satisfies Phase8ActionResult<{ id: string; caseNo: string }>;
}

export async function linkReportToCase(caseId: string, repositoryReportId: string) {
  return callVoidRpc("link_report_to_case_secure", { p_case_id: caseId, p_repository_report_id: repositoryReportId });
}

export async function addInvestigationCaseNote(caseId: string, note: string) {
  return callVoidRpc("add_investigation_case_note_secure", { p_case_id: caseId, p_note: note });
}

export async function assignInvestigationCase(caseId: string, assigneeId: string) {
  return callVoidRpc("assign_investigation_case_secure", { p_case_id: caseId, p_assignee_id: assigneeId });
}

export async function resolveInvestigationCase(caseId: string, resolution: string) {
  return callVoidRpc("resolve_investigation_case_secure", { p_case_id: caseId, p_resolution: resolution });
}

export async function reopenInvestigationCase(caseId: string, reason: string) {
  return callVoidRpc("reopen_investigation_case_secure", { p_case_id: caseId, p_reason: reason });
}

export async function listInvestigationCases() {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("list_investigation_cases_secure");
  if (error) return { ok: false, error: error.message, data: null } satisfies Phase8ActionResult;
  return { ok: true, error: null, data: data ?? [] } satisfies Phase8ActionResult<NonNullable<typeof data>>;
}

export async function getInvestigationCase(caseId: string) {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_investigation_case_secure", { p_case_id: caseId });
  if (error) return { ok: false, error: error.message, data: null } satisfies Phase8ActionResult;
  return { ok: true, error: null, data: data?.[0] ?? null } satisfies Phase8ActionResult<NonNullable<typeof data>[number] | null>;
}

export async function listInvestigationCaseNotes(caseId: string) {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("list_investigation_case_notes_secure", { p_case_id: caseId });
  if (error) return { ok: false, error: error.message, data: null } satisfies Phase8ActionResult;
  return { ok: true, error: null, data: data ?? [] } satisfies Phase8ActionResult<NonNullable<typeof data>>;
}

export async function listInvestigationCaseReports(caseId: string) {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("list_investigation_case_reports_secure", { p_case_id: caseId });
  if (error) return { ok: false, error: error.message, data: null } satisfies Phase8ActionResult;
  return { ok: true, error: null, data: data ?? [] } satisfies Phase8ActionResult<NonNullable<typeof data>>;
}

export async function listInvestigationStaff() {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("list_investigation_staff_secure");
  if (error) return { ok: false, error: error.message, data: null } satisfies Phase8ActionResult;
  return { ok: true, error: null, data: data ?? [] } satisfies Phase8ActionResult<NonNullable<typeof data>>;
}

export interface InvestigationSearchResult {
  id: string;
  sourceTable: string;
  reportType: string;
  staffName: string | null;
  station: string | null;
  team: string | null;
  secondaryIdentifier: string | null;
  submittedAt: string | null;
}

/**
 * Report search for the Investigation "link report" flow. Reuses Phase
 * 6's search_reports_secure() exactly like lib/avsec/search/queries.ts
 * does -- has_report_access() authorization and card-safe field
 * selection happen INSIDE that one RPC call, never via a follow-up
 * source-table read here. An unauthorized report simply does not appear
 * in the result set (search_reports_secure()'s own scoping), so a caller
 * cannot distinguish "exists but I can't see it" from "does not exist"
 * through this search -- no differential error, count, or id ever
 * surfaces for a report outside their authorized scope.
 */
export async function searchReportsForInvestigation(fromDate: string, toDate: string): Promise<Phase8ActionResult<InvestigationSearchResult[]>> {
  const supabase = await createClient();
  const { from } = dayRangeMY(fromDate);
  const { to: toEnd } = dayRangeMY(toDate);
  const { data, error } = await supabase.rpc("search_reports_secure", {
    p_page: 1,
    p_page_size: 100,
    p_from_date: from,
    p_to_date: toEnd,
  });
  if (error) return { ok: false, error: error.message, data: null };
  const rows = (data ?? []).map((r) => ({
    id: r.id,
    sourceTable: r.source_table,
    reportType: r.source_table.replace("report_", "").replace("_records", ""),
    staffName: r.staff_name,
    station: r.station,
    team: r.team,
    secondaryIdentifier: r.secondary_identifier,
    submittedAt: r.indexed_at ?? null,
  }));
  return { ok: true, error: null, data: rows };
}
