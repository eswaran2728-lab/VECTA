"use server";

import { createClient } from "@/lib/supabase/server";
import { getCurrentProfile } from "@/lib/auth";
import { REPORT_TYPES, type ReportType } from "@/lib/reference-data";

const MAX_ATTACHMENTS = 5;
const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIME = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
const SIGNED_URL_TTL_SECONDS = 60 * 60;

export interface AttachmentResult {
  ok: boolean;
  error?: string;
  attachment?: { id: string; file_name: string; mime_type: string; size_bytes: number };
}

export interface ReportAttachment {
  id: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  created_at: string;
  url: string | null;
}

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-120) || "file";
}

/** Uploads one attachment for an already-submitted report. Called directly after a report
 * insert succeeds (online path), or from the offline sync provider once a queued report's
 * own insert has synced — attachments are never uploaded before the report row exists. */
export async function uploadReportAttachment(formData: FormData): Promise<AttachmentResult> {
  const profile = await getCurrentProfile();
  if (!profile) return { ok: false, error: "Not authenticated" };

  const reportType = String(formData.get("reportType") || "");
  const reportId = String(formData.get("reportId") || "");
  const file = formData.get("file");

  if (!REPORT_TYPES.includes(reportType as ReportType)) return { ok: false, error: "Invalid report type" };
  if (!reportId) return { ok: false, error: "Missing report id" };
  if (!(file instanceof File)) return { ok: false, error: "Missing file" };
  if (file.size === 0) return { ok: false, error: `${file.name} is empty` };
  if (file.size > MAX_BYTES) return { ok: false, error: `${file.name} exceeds 10MB` };
  if (!ALLOWED_MIME.includes(file.type)) return { ok: false, error: `${file.name}: unsupported file type` };

  const supabase = createClient();

  const { count } = await supabase
    .from("report_attachments")
    .select("id", { count: "exact", head: true })
    .eq("report_type", reportType)
    .eq("report_id", reportId);
  if ((count ?? 0) >= MAX_ATTACHMENTS) return { ok: false, error: "Maximum 5 attachments per report" };

  const path = `${reportType}/${reportId}/${crypto.randomUUID()}-${sanitizeFileName(file.name)}`;
  const { error: uploadError } = await supabase.storage
    .from("report-attachments")
    .upload(path, file, { contentType: file.type, upsert: false });
  if (uploadError) return { ok: false, error: uploadError.message };

  const { data, error } = await supabase
    .from("report_attachments")
    .insert({
      report_type: reportType,
      report_id: reportId,
      storage_path: path,
      file_name: file.name.slice(0, 200),
      mime_type: file.type,
      size_bytes: file.size,
      uploaded_by: profile.id,
    })
    .select("id, file_name, mime_type, size_bytes")
    .single();

  if (error) {
    await supabase.storage.from("report-attachments").remove([path]);
    return { ok: false, error: error.message };
  }
  return { ok: true, attachment: data };
}

/** Gallery data for a report's view page — RLS scopes visibility the same as the report
 * itself, so this never leaks an attachment the caller couldn't already see the report of. */
export async function getReportAttachments(reportType: ReportType, reportId: string): Promise<ReportAttachment[]> {
  const supabase = createClient();
  const { data } = await supabase
    .from("report_attachments")
    .select("id, file_name, mime_type, size_bytes, storage_path, created_at")
    .eq("report_type", reportType)
    .eq("report_id", reportId)
    .order("created_at", { ascending: true });

  const rows = (data ?? []) as { id: string; file_name: string; mime_type: string; size_bytes: number; storage_path: string; created_at: string }[];
  return Promise.all(
    rows.map(async (r) => {
      const { data: signed } = await supabase.storage
        .from("report-attachments")
        .createSignedUrl(r.storage_path, SIGNED_URL_TTL_SECONDS);
      return {
        id: r.id,
        file_name: r.file_name,
        mime_type: r.mime_type,
        size_bytes: r.size_bytes,
        created_at: r.created_at,
        url: signed?.signedUrl ?? null,
      };
    }),
  );
}

/** Attachment counts for a batch of report ids, for a list-view count badge. Grouped by
 * id alone (not id+type) — one query for the whole page regardless of how many rows/types
 * are shown; UUID collision across tables is not a practical concern. */
export async function getAttachmentCounts(reportIds: string[]): Promise<Record<string, number>> {
  if (reportIds.length === 0) return {};
  const supabase = createClient();
  const { data } = await supabase.from("report_attachments").select("report_id").in("report_id", reportIds);

  const counts: Record<string, number> = {};
  for (const row of (data ?? []) as { report_id: string }[]) {
    counts[row.report_id] = (counts[row.report_id] ?? 0) + 1;
  }
  return counts;
}
