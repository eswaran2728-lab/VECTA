"use server";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireProfile } from "@/lib/avsec/auth";

/**
 * Real SAT combined-PDF storage lifecycle. Mirrors the established
 * lib/avsec/attachments/actions.ts pattern exactly:
 *   - the client NEVER supplies a storage path; the server generates it
 *     after validating the file, uploads the bytes with the service-role
 *     client (storage.objects has no permissive INSERT policy for
 *     `authenticated` -- see the Phase 8 migration's Part G comment),
 *     and only then calls the metadata RPC with that trusted path.
 *   - downloads re-check can_view_sat_combined_report() immediately
 *     before signing a short-lived URL, using the caller's own session
 *     client (never the admin client) so the storage SELECT policy and
 *     this app-layer check agree.
 *   - a failed upload removes only the object THIS call just wrote,
 *     never a previously accepted version.
 */

const BUCKET = "sat-combined-reports";
const MAX_BYTES = 20 * 1024 * 1024;
const SIGNED_URL_TTL_SECONDS = 5 * 60;

export interface SatActionResult<T = undefined> {
  ok: boolean;
  error: string | null;
  data: T | null;
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 60) || "x";
}

function validatePdf(file: unknown): { ok: true; file: File } | { ok: false; error: string } {
  if (!(file instanceof File)) return { ok: false, error: "Missing PDF file." };
  if (file.size === 0) return { ok: false, error: "File is empty." };
  if (file.size > MAX_BYTES) return { ok: false, error: "File exceeds the 20MB limit for a combined SAT report." };
  const nameLower = file.name.toLowerCase();
  if (file.type !== "application/pdf" || !nameLower.endsWith(".pdf")) {
    return { ok: false, error: "Only a .pdf file may be uploaded as a combined SAT report." };
  }
  return { ok: true, file };
}

export async function uploadSatCombinedReportFile(formData: FormData): Promise<SatActionResult<{ id: string }>> {
  await requireProfile();
  const station = String(formData.get("station") || "").trim();
  const team = String(formData.get("team") || "").trim();
  const operationalDate = String(formData.get("operationalDate") || "").trim();
  const shiftCoverage = String(formData.get("shiftCoverage") || "").trim();

  if (!station || !team || !operationalDate || !shiftCoverage) {
    return { ok: false, error: "Station, team, operational date and shift coverage are all required.", data: null };
  }

  const validated = validatePdf(formData.get("file"));
  if (!validated.ok) return { ok: false, error: validated.error, data: null };
  const { file } = validated;

  const storagePath = `${sanitizeSegment(station)}/${sanitizeSegment(team)}/${operationalDate}/${crypto.randomUUID()}.pdf`;

  const admin = createAdminClient();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const { error: uploadError } = await admin.storage.from(BUCKET).upload(storagePath, bytes, {
    contentType: "application/pdf",
    upsert: false,
  });
  if (uploadError) return { ok: false, error: `Upload failed: ${uploadError.message}`, data: null };

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("upload_sat_combined_report_secure", {
    p_station: station,
    p_team: team,
    p_operational_date: operationalDate,
    p_shift_coverage: shiftCoverage,
    p_storage_path: storagePath,
  });

  if (error) {
    // Clean up only the object THIS call just wrote -- never an
    // already-accepted prior version, which lives at a different path.
    await admin.storage.from(BUCKET).remove([storagePath]);
    return { ok: false, error: error.message, data: null };
  }

  return { ok: true, error: null, data: { id: data?.[0]?.row_id ?? "" } };
}

export async function replaceSatCombinedReportFile(formData: FormData): Promise<SatActionResult<{ id: string }>> {
  await requireProfile();
  const oldReportId = String(formData.get("oldReportId") || "").trim();
  const shiftCoverage = String(formData.get("shiftCoverage") || "").trim();
  const reason = String(formData.get("reason") || "").trim();

  if (!oldReportId || !shiftCoverage || !reason) {
    return { ok: false, error: "The original report, shift coverage and a reason are all required to replace a report.", data: null };
  }

  const validated = validatePdf(formData.get("file"));
  if (!validated.ok) return { ok: false, error: validated.error, data: null };
  const { file } = validated;

  const storagePath = `replacements/${oldReportId}/${crypto.randomUUID()}.pdf`;

  const admin = createAdminClient();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const { error: uploadError } = await admin.storage.from(BUCKET).upload(storagePath, bytes, {
    contentType: "application/pdf",
    upsert: false,
  });
  if (uploadError) return { ok: false, error: `Upload failed: ${uploadError.message}`, data: null };

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("replace_sat_combined_report_secure", {
    p_old_report_id: oldReportId,
    p_shift_coverage: shiftCoverage,
    p_storage_path: storagePath,
    p_reason: reason,
  });

  if (error) {
    await admin.storage.from(BUCKET).remove([storagePath]);
    return { ok: false, error: error.message, data: null };
  }

  return { ok: true, error: null, data: { id: data?.[0]?.row_id ?? "" } };
}

export interface SatCombinedReportView {
  id: string;
  station_id: string;
  team_id: string;
  operational_date: string;
  shift_coverage: string;
  status: string;
  version: number;
  uploaded_at: string;
  url: string | null;
  deniedReason?: string;
}

export async function listSatCombinedReportsForViewer(station?: string, team?: string): Promise<SatActionResult<SatCombinedReportView[]>> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("list_sat_combined_reports_secure", {
    p_station: station ?? null,
    p_team: team ?? null,
  });
  if (error) return { ok: false, error: error.message, data: null };

  const rows = await Promise.all(
    (data ?? []).map(async (r) => {
      // Re-authorized immediately before signing, on the caller's OWN
      // session client -- never trust the row's mere presence in the
      // (already-scoped) list above as sufficient for a signed link.
      const { data: authorized } = await supabase.rpc("can_view_sat_combined_report", { p_report_id: r.id });
      if (!authorized) {
        return { ...r, url: null, deniedReason: "Not authorized to download this report." } satisfies SatCombinedReportView;
      }
      const { data: signed } = await supabase.storage.from(BUCKET).createSignedUrl(r.storage_path, SIGNED_URL_TTL_SECONDS);
      return { ...r, url: signed?.signedUrl ?? null } satisfies SatCombinedReportView;
    }),
  );

  return { ok: true, error: null, data: rows };
}
