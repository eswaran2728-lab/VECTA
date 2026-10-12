"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

/**
 * GHOD / AirAsia Management report-access requests. The requester searches report METADATA STUBS (type, entity, flight, date; never
 * content, staff, station or registration), asks for access with a business reason, and the Global Reporting Controller decides. An
 * approved grant is read-only, time-bounded and audited (request, grant, use, expiry, export). The database enforces all of it.
 */
export interface ReportStub {
  id: string;
  sourceTable: string;
  entityCode: string | null;
  flightNumber: string | null;
  reportDate: string | null;
  status: string;
  alreadyAccessible: boolean;
}
export interface MyRequest {
  id: string;
  sourceTable: string;
  entityCode: string | null;
  flightNumber: string | null;
  reportDate: string | null;
  businessReason: string;
  status: string;
  decisionReason: string | null;
  createdAt: string;
  grantState: string | null;
  grantExpiresAt: string | null;
  sourceId: string | null;
}

export async function searchReportStubs(input: { flight: string | null; from: string | null; to: string | null; type: string | null; page: number }): Promise<{ ok: boolean; rows: ReportStub[]; total: number; error: string | null }> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("search_report_stubs_for_request_secure", {
    p_flight: input.flight, p_from: input.from, p_to: input.to, p_source_table: input.type, p_page: input.page, p_page_size: 25,
  });
  if (error) return { ok: false, rows: [], total: 0, error: error.message.includes("Provide a flight") ? "Enter a flight number or a date range." : "The search could not be completed." };
  return {
    ok: true,
    error: null,
    total: data && data.length > 0 ? Number(data[0].total_count) : 0,
    rows: (data ?? []).map((r) => ({
      id: r.id, sourceTable: r.source_table, entityCode: r.operating_entity_code, flightNumber: r.flight_number, reportDate: r.report_date,
      status: r.status, alreadyAccessible: r.already_accessible,
    })),
  };
}

export async function listMyRequests(): Promise<{ ok: boolean; rows: MyRequest[]; error: string | null }> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("list_my_report_access_requests_secure");
  if (error) return { ok: false, rows: [], error: "Your requests could not be loaded." };
  return {
    ok: true,
    error: null,
    rows: (data ?? []).map((r) => ({
      id: r.id, sourceTable: r.source_table, entityCode: r.operating_entity_code, flightNumber: r.flight_number, reportDate: r.report_date,
      businessReason: r.business_reason, status: r.status, decisionReason: r.decision_reason, createdAt: r.created_at, grantState: r.grant_state,
      grantExpiresAt: r.grant_expires_at, sourceId: r.source_id,
    })),
  };
}

export async function requestReportAccess(reportId: string, reason: string, days: number): Promise<{ ok: boolean; error: string | null }> {
  const trimmed = reason.trim();
  if (trimmed.length < 10) return { ok: false, error: "Give a specific business reason (at least 10 characters)." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("request_report_access", {
    p_repository_report_id: reportId, p_business_reason: trimmed, p_requested_duration_days: Math.min(Math.max(Math.trunc(days) || 1, 1), 90),
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/avsec/reports/request-access");
  return { ok: true, error: null };
}
