"use server";

import { createClient } from "@/lib/supabase/server";
import { requireProfile } from "@/lib/avsec/auth";
import { SupabaseStorageAdapter, type StorageAdapter } from "@/lib/storage/adapter";

/**
 * Real CaterLink final-transaction-PDF storage workflow (Phase 13
 * correction). Mirrors the established lib/phase8/sat.ts pattern: the
 * server validates and uploads PDF bytes with the service-role adapter
 * to a private bucket at a server-generated path, then calls the
 * metadata RPC -- which re-authorizes (CaterLink Management only, and
 * only for a COMPLETED transaction), enforces idempotency by content
 * hash, and supersedes rather than overwrites a prior version. A failed
 * RPC call removes only the object THIS call just uploaded.
 *
 * `adapter` is injectable so tests can pass a FakeStorageAdapter --
 * production code never does (see getDefaultAdapter below).
 */

const BUCKET = "caterlink-final-pdfs";
const MAX_BYTES = 20 * 1024 * 1024;
const SIGNED_URL_TTL_SECONDS = 5 * 60;

export interface CaterlinkPdfResult<T = undefined> {
  ok: boolean;
  error: string | null;
  data: T | null;
}

function getDefaultAdapter(): StorageAdapter {
  return new SupabaseStorageAdapter();
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function validatePdf(file: unknown): { ok: true; file: File } | { ok: false; error: string } {
  if (!(file instanceof File)) return { ok: false, error: "Missing PDF file." };
  if (file.size === 0) return { ok: false, error: "File is empty." };
  if (file.size > MAX_BYTES) return { ok: false, error: "File exceeds the 20MB limit for a final transaction PDF." };
  const nameLower = file.name.toLowerCase();
  if (file.type !== "application/pdf" || !nameLower.endsWith(".pdf")) {
    return { ok: false, error: "Only a .pdf file may be uploaded as a final transaction PDF." };
  }
  return { ok: true, file };
}

/**
 * Generates (or, if identical content was already recorded, returns the
 * existing) final transaction PDF. Only CaterLink Management may call
 * this, and only for a COMPLETED transaction -- both re-checked inside
 * record_caterlink_transaction_pdf_secure(), never trusted from the
 * caller.
 */
export async function generateCaterlinkTransactionPdf(
  transactionId: string,
  formData: FormData,
  adapter: StorageAdapter = getDefaultAdapter()
): Promise<CaterlinkPdfResult<{ id: string; version: number; isNew: boolean }>> {
  await requireProfile();

  const validated = validatePdf(formData.get("file"));
  if (!validated.ok) return { ok: false, error: validated.error, data: null };
  const { file } = validated;

  const bytes = new Uint8Array(await file.arrayBuffer());
  const contentHash = await sha256Hex(bytes);

  // Deterministic, AOC-safe object path -- never derived from any
  // client-supplied path, and namespaced by transaction id (itself
  // already AOC-scoped at the database layer) plus content hash, so a
  // retried upload for identical content lands at the same path instead
  // of accumulating duplicates.
  const storagePath = `${transactionId}/${contentHash}.pdf`;

  const supabase = await createClient();

  const uploadResult = await adapter.upload(BUCKET, storagePath, bytes, "application/pdf");
  if (!uploadResult.ok) {
    return { ok: false, error: `Upload failed: ${uploadResult.error}`, data: null };
  }

  const { data, error } = await supabase.rpc("record_caterlink_transaction_pdf_secure", {
    p_transaction_id: transactionId,
    p_storage_path: storagePath,
    p_content_hash: contentHash,
    p_size_bytes: bytes.length,
    p_mime_type: "application/pdf",
  });

  if (error) {
    // Clean up only the object THIS call just wrote.
    await adapter.remove(BUCKET, storagePath);
    return { ok: false, error: error.message, data: null };
  }

  const row = data?.[0];
  return {
    ok: true,
    error: null,
    data: { id: row?.id ?? "", version: row?.version ?? 0, isNew: row?.is_new ?? false },
  };
}

/**
 * Returns a short-lived signed download URL for a transaction's current
 * final PDF, re-authorizing immediately before signing via
 * get_caterlink_transaction_pdf_secure() -- which itself re-derives the
 * caller from the session and never trusts a client-supplied path or a
 * prior authorization decision.
 */
export async function getCaterlinkTransactionPdfDownloadUrl(
  transactionId: string,
  adapter: StorageAdapter = getDefaultAdapter()
): Promise<CaterlinkPdfResult<{ url: string; version: number }>> {
  await requireProfile();
  const supabase = await createClient();

  const { data, error } = await supabase.rpc("get_caterlink_transaction_pdf_secure", {
    p_transaction_id: transactionId,
  });

  if (error) return { ok: false, error: error.message, data: null };
  const row = data?.[0];
  if (!row) return { ok: false, error: "No final PDF has been generated for this transaction yet.", data: null };

  const signed = await adapter.createSignedUrl(BUCKET, row.storage_path, SIGNED_URL_TTL_SECONDS);
  if (!signed.url) return { ok: false, error: signed.error ?? "Could not sign the download URL.", data: null };

  return { ok: true, error: null, data: { url: signed.url, version: row.version } };
}
