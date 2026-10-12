"use server";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Investigation case links, evidence, timeline and closure. Every function is a thin wrapper over a scoped RPC that re-authorizes the
 * caller (Investigation / Main Enforcement), refuses writes on a closed case and audits the action. Evidence bytes live in the PRIVATE
 * `investigation-evidence` bucket: the browser never supplies a path -- the RPC generates it after authorizing, the server uploads with
 * the service role, the RPC registers it, and a download is a short-lived signed URL issued only after an authorizing, audited RPC call.
 */
const BUCKET = "investigation-evidence";
const SIGNED_URL_TTL_SECONDS = 60;
const ALLOWED_MIME = ["application/pdf", "image/png", "image/jpeg", "image/webp", "text/plain", "video/mp4", "audio/mpeg"];

export interface ExtraResult<T = undefined> {
  ok: boolean;
  error: string | null;
  data: T | null;
}
const fail = <T>(error: string): ExtraResult<T> => ({ ok: false, error, data: null });

export interface CaseLink {
  id: string;
  linkType: string;
  flightNumber: string | null;
  flightDate: string | null;
  staffNo: string | null;
  staffName: string | null;
  note: string | null;
  linkedByName: string;
  linkedAt: string;
}
export interface CaseEvidence {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  description: string | null;
  uploadedByName: string;
  uploadedAt: string;
}
export interface CaseTimelineEvent {
  at: string;
  type: string;
  actor: string | null;
  summary: string;
}
export interface CaseAuditRow {
  id: string;
  at: string;
  action: string;
  actor: string | null;
}

export async function listCaseLinks(caseId: string): Promise<ExtraResult<CaseLink[]>> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("list_investigation_case_links_secure", { p_case_id: caseId });
  if (error) return fail(error.message);
  return {
    ok: true,
    error: null,
    data: (data ?? []).map((l) => ({
      id: l.id, linkType: l.link_type, flightNumber: l.flight_number, flightDate: l.flight_date, staffNo: l.staff_no,
      staffName: l.staff_name, note: l.note, linkedByName: l.linked_by_name, linkedAt: l.linked_at,
    })),
  };
}

export async function listCaseEvidence(caseId: string): Promise<ExtraResult<CaseEvidence[]>> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("list_investigation_case_evidence_secure", { p_case_id: caseId });
  if (error) return fail(error.message);
  return {
    ok: true,
    error: null,
    data: (data ?? []).map((e) => ({
      id: e.id, fileName: e.file_name, mimeType: e.mime_type, sizeBytes: Number(e.size_bytes), description: e.description,
      uploadedByName: e.uploaded_by_name, uploadedAt: e.uploaded_at,
    })),
  };
}

export async function getCaseTimeline(caseId: string): Promise<ExtraResult<CaseTimelineEvent[]>> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_investigation_case_timeline_secure", { p_case_id: caseId });
  if (error) return fail(error.message);
  return { ok: true, error: null, data: (data ?? []).map((t) => ({ at: t.event_at, type: t.event_type, actor: t.actor_name, summary: t.summary })) };
}

export async function getCaseAudit(caseId: string): Promise<ExtraResult<CaseAuditRow[]>> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("list_investigation_case_audit_secure", { p_case_id: caseId });
  if (error) return fail(error.message);
  return { ok: true, error: null, data: (data ?? []).map((a) => ({ id: a.id, at: a.created_at, action: a.action, actor: a.actor_name })) };
}

export async function linkFlightToCase(caseId: string, flight: string, flightDate: string | null, note: string): Promise<ExtraResult> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("link_flight_to_case_secure", {
    p_case_id: caseId, p_flight: flight, p_flight_date: flightDate || null, p_note: note || null,
  });
  return error ? fail(error.message) : { ok: true, error: null, data: null };
}

export async function linkStaffToCase(caseId: string, staffNo: string, note: string): Promise<ExtraResult<{ staffName: string }>> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("link_staff_to_case_secure", { p_case_id: caseId, p_staff_no: staffNo, p_note: note || null });
  if (error) return fail(error.message);
  return { ok: true, error: null, data: { staffName: data?.[0]?.staff_name ?? "" } };
}

export async function closeInvestigationCase(caseId: string, reason: string): Promise<ExtraResult> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("close_investigation_case_secure", { p_case_id: caseId, p_reason: reason });
  return error ? fail(error.message) : { ok: true, error: null, data: null };
}

/** Authorize (RPC) -> upload with the service role -> register (RPC). A failed registration removes only the object this call wrote. */
export async function uploadCaseEvidence(formData: FormData): Promise<ExtraResult<{ id: string }>> {
  const caseId = String(formData.get("caseId") || "");
  const description = String(formData.get("description") || "").trim();
  const file = formData.get("file");
  if (!caseId || !(file instanceof File) || file.size === 0) return fail("Choose a case and a non-empty file.");
  if (!ALLOWED_MIME.includes(file.type)) return fail("This file type is not accepted as evidence.");

  const supabase = await createClient();
  const { data: path, error: prepError } = await supabase.rpc("prepare_case_evidence_secure", {
    p_case_id: caseId, p_file_name: file.name, p_mime_type: file.type, p_size_bytes: file.size,
  });
  if (prepError || !path) return fail(prepError?.message ?? "Not authorized to attach evidence.");

  const admin = createAdminClient();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const { error: uploadError } = await admin.storage.from(BUCKET).upload(path, bytes, { contentType: file.type, upsert: false });
  if (uploadError) return fail(`Upload failed: ${uploadError.message}`);

  const { data: id, error: regError } = await supabase.rpc("register_case_evidence_secure", {
    p_case_id: caseId, p_storage_path: path, p_file_name: file.name, p_mime_type: file.type, p_size_bytes: file.size, p_description: description || null,
  });
  if (regError || !id) {
    await admin.storage.from(BUCKET).remove([path]);
    return fail(regError?.message ?? "The evidence could not be registered.");
  }
  return { ok: true, error: null, data: { id } };
}

/** Download: an authorizing, audited RPC first; only then a short-lived signed URL (private bucket, no public URL is ever stored). */
export async function getCaseEvidenceUrl(evidenceId: string): Promise<ExtraResult<{ url: string; fileName: string }>> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("authorize_case_evidence_download_secure", { p_evidence_id: evidenceId });
  const row = data?.[0];
  if (error || !row) return fail("Evidence not found or not authorized.");
  const admin = createAdminClient();
  const { data: signed, error: signError } = await admin.storage.from(BUCKET).createSignedUrl(row.storage_path, SIGNED_URL_TTL_SECONDS, { download: row.file_name });
  if (signError || !signed?.signedUrl) return fail("The evidence file could not be opened.");
  return { ok: true, error: null, data: { url: signed.signedUrl, fileName: row.file_name } };
}
