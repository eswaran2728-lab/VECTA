"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

/**
 * Global Reporting Controller workspace: report-request queue, grants with expiry, access/export audit. Every RPC re-checks that
 * the caller holds an active global_reporting_controller assignment; these wrappers add no authorization of their own and never
 * return report content (identifiers and summaries only).
 */
export interface GrcRequestRow {
  id: string;
  requesterProfileId: string;
  requesterName: string;
  requesterStaffNo: string;
  sourceTable: string;
  entityCode: string | null;
  flightNumber: string | null;
  reportDate: string | null;
  businessReason: string;
  requestedDurationDays: number | null;
  status: string;
  decisionReason: string | null;
  createdAt: string;
}
export interface GrcGrantRow {
  id: string;
  granteeName: string;
  granteeStaffNo: string;
  grantedByName: string;
  sourceTable: string;
  entityCode: string | null;
  reason: string;
  startsAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  state: string;
}
export interface GrcAuditRow {
  id: string;
  actorName: string | null;
  actorStaffNo: string | null;
  action: string;
  sourceTable: string | null;
  entityCode: string | null;
  reason: string | null;
  createdAt: string;
}

type Listing<T> = { ok: boolean; rows: T[]; total: number; error: string | null };

export async function listReportRequests(status: string | null, page: number): Promise<Listing<GrcRequestRow>> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("list_report_access_requests_secure", { p_status: status, p_page: page, p_page_size: 25 });
  if (error) return { ok: false, rows: [], total: 0, error: "The request queue could not be loaded." };
  return {
    ok: true,
    error: null,
    total: data && data.length > 0 ? Number(data[0].total_count) : 0,
    rows: (data ?? []).map((r) => ({
      id: r.id,
      requesterProfileId: r.requester_profile_id,
      requesterName: r.requester_name,
      requesterStaffNo: r.requester_staff_no,
      sourceTable: r.source_table,
      entityCode: r.operating_entity_code,
      flightNumber: r.flight_number,
      reportDate: r.report_date,
      businessReason: r.business_reason,
      requestedDurationDays: r.requested_duration_days,
      status: r.status,
      decisionReason: r.decision_reason,
      createdAt: r.created_at,
    })),
  };
}

export async function listReportGrants(state: string | null, page: number): Promise<Listing<GrcGrantRow>> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("list_report_access_grants_secure", { p_state: state, p_page: page, p_page_size: 25 });
  if (error) return { ok: false, rows: [], total: 0, error: "The grant history could not be loaded." };
  return {
    ok: true,
    error: null,
    total: data && data.length > 0 ? Number(data[0].total_count) : 0,
    rows: (data ?? []).map((r) => ({
      id: r.id,
      granteeName: r.grantee_name,
      granteeStaffNo: r.grantee_staff_no,
      grantedByName: r.granted_by_name,
      sourceTable: r.source_table,
      entityCode: r.operating_entity_code,
      reason: r.reason,
      startsAt: r.starts_at,
      expiresAt: r.expires_at,
      revokedAt: r.revoked_at,
      state: r.state,
    })),
  };
}

export async function listReportAudit(scope: string, page: number): Promise<Listing<GrcAuditRow>> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("list_report_access_audit_secure", { p_scope: scope, p_page: page, p_page_size: 25 });
  if (error) return { ok: false, rows: [], total: 0, error: "The audit could not be loaded." };
  return {
    ok: true,
    error: null,
    total: data && data.length > 0 ? Number(data[0].total_count) : 0,
    rows: (data ?? []).map((r) => ({
      id: r.id,
      actorName: r.actor_name,
      actorStaffNo: r.actor_staff_no,
      action: r.action,
      sourceTable: r.source_table,
      entityCode: r.operating_entity_code,
      reason: r.reason,
      createdAt: r.created_at,
    })),
  };
}

export interface GrcActionResult {
  ok: boolean;
  error: string | null;
}

/** Approve = a read-only, time-limited grant to the requester (grant_report_access re-checks GRC, no self-grant, approved grantee). */
export async function approveReportRequest(requestId: string, requesterProfileId: string, reason: string, days: number): Promise<GrcActionResult> {
  const trimmed = reason.trim();
  if (trimmed.length < 3) return { ok: false, error: "A reason is required." };
  const bounded = Math.min(Math.max(Math.trunc(days) || 1, 1), 90);
  const supabase = await createClient();
  const { error } = await supabase.rpc("grant_report_access", {
    p_request_id: requestId,
    p_grantee_profile_id: requesterProfileId,
    p_reason: trimmed,
    p_expires_at: new Date(Date.now() + bounded * 86_400_000).toISOString(),
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/avsec/reports/requests");
  return { ok: true, error: null };
}

export async function rejectReportRequest(requestId: string, reason: string): Promise<GrcActionResult> {
  const trimmed = reason.trim();
  if (trimmed.length < 3) return { ok: false, error: "A rejection reason is required." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("reject_report_access_request", { p_request_id: requestId, p_reason: trimmed });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/avsec/reports/requests");
  return { ok: true, error: null };
}

export async function revokeReportGrant(grantId: string, reason: string): Promise<GrcActionResult> {
  const trimmed = reason.trim();
  if (trimmed.length < 3) return { ok: false, error: "A revocation reason is required." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("revoke_report_access", { p_grant_id: grantId, p_reason: trimmed });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/avsec/reports/requests");
  return { ok: true, error: null };
}
