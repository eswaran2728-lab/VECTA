"use server";

import { createClient } from "@/lib/supabase/server";
import { SupabaseStorageAdapter, type StorageAdapter } from "@/lib/storage/adapter";

/**
 * Real, private-Storage-backed announcement attachment workflow (Phase 13
 * correction). Replaces inline base64 persistence entirely -- no
 * attachment content is ever written to a database row.
 *
 * Authorization is unchanged from Phase 11 (already correct, already
 * tested): can_user_manage_announcement() gates upload/removal (draft
 * owner/publisher only -- GHOD for Global, MAA/AAX Boss/Admin for
 * Malaysia AOC, enforced inside the RPCs themselves), and
 * is_announcement_visible_to_caller()/can_user_manage_announcement()
 * together gate download (published-visibility or manager access;
 * drafts stay invisible to recipients; cross-AOC fails closed; archived
 * announcements remain readable per Phase 11's existing archive-read
 * rule, but never editable). This file only adds the real Storage round
 * trip on top of that existing, tested authorization boundary.
 */

const BUCKET = "announcement-attachments";
const MAX_BYTES = 25 * 1024 * 1024;
const SIGNED_URL_TTL_SECONDS = 5 * 60;

const ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);

export interface AnnouncementAttachmentResult<T = undefined> {
  ok: boolean;
  error: string | null;
  data: T | null;
}

function getDefaultAdapter(): StorageAdapter {
  return new SupabaseStorageAdapter();
}

/** Strips anything but alphanumerics/dot/dash/underscore, and caps
 * length -- the stored file_name is for display only and is never used
 * to construct the storage path itself (that uses a random id). */
function sanitizeFileName(name: string): string {
  const trimmed = name.trim().slice(0, 150);
  return trimmed.replace(/[^a-zA-Z0-9.\-_ ]/g, "_") || "attachment";
}

function validateFile(file: unknown): { ok: true; file: File } | { ok: false; error: string } {
  if (!(file instanceof File)) return { ok: false, error: "No file provided." };
  if (file.size === 0) return { ok: false, error: "File is empty." };
  if (file.size > MAX_BYTES) return { ok: false, error: "File exceeds the 25MB limit." };
  if (!ALLOWED_MIME_TYPES.has(file.type)) {
    return { ok: false, error: "Only JPEG, PNG, WEBP images or a PDF may be attached to an announcement." };
  }
  return { ok: true, file };
}

/**
 * Uploads a new attachment to a draft/editable announcement. Fails if the
 * caller is not the announcement's authorized manager (checked inside
 * add_announcement_attachment_secure) -- an ordinary recipient, a
 * different AOC's publisher, or AirAsia Management can never reach the
 * upload path.
 */
export async function uploadAnnouncementAttachment(
  announcementId: string,
  formData: FormData,
  adapter: StorageAdapter = getDefaultAdapter()
): Promise<AnnouncementAttachmentResult<{ id: string }>> {
  const validated = validateFile(formData.get("file"));
  if (!validated.ok) return { ok: false, error: validated.error, data: null };
  const { file } = validated;

  const bytes = new Uint8Array(await file.arrayBuffer());
  const safeName = sanitizeFileName(file.name);
  const storagePath = `${announcementId}/${crypto.randomUUID()}-${safeName}`;

  const supabase = await createClient();

  const uploadResult = await adapter.upload(BUCKET, storagePath, bytes, file.type);
  if (!uploadResult.ok) {
    return { ok: false, error: `Upload failed: ${uploadResult.error}`, data: null };
  }

  const { data, error } = await supabase.rpc("add_announcement_attachment_secure", {
    p_announcement_id: announcementId,
    p_storage_path: storagePath,
    p_file_name: safeName,
    p_file_size: bytes.length,
    p_content_type: file.type,
  });

  if (error) {
    // Clean up only the object THIS call just wrote.
    await adapter.remove(BUCKET, storagePath);
    return { ok: false, error: error.message, data: null };
  }

  return { ok: true, error: null, data: { id: data as unknown as string } };
}

/**
 * Removes an attachment. Fails for a published/archived announcement
 * (immutability) or an unauthorized caller -- both enforced inside
 * remove_announcement_attachment_secure(). Removes the real Storage
 * object only after the metadata row is confirmed gone.
 */
export async function removeAnnouncementAttachment(
  attachmentId: string,
  adapter: StorageAdapter = getDefaultAdapter()
): Promise<AnnouncementAttachmentResult> {
  const supabase = await createClient();

  const { data: storagePath, error } = await supabase.rpc("remove_announcement_attachment_secure", {
    p_attachment_id: attachmentId,
  });

  if (error) return { ok: false, error: error.message, data: null };
  if (storagePath) {
    await adapter.remove(BUCKET, storagePath);
  }
  return { ok: true, error: null, data: null };
}

/**
 * Returns a short-lived signed download URL, re-authorizing immediately
 * before signing via get_announcement_attachment_download_secure() --
 * never trusting the attachment's mere existence, and never returning a
 * raw storage path to the caller.
 */
export async function getAnnouncementAttachmentDownloadUrl(
  attachmentId: string,
  adapter: StorageAdapter = getDefaultAdapter()
): Promise<AnnouncementAttachmentResult<{ url: string; fileName: string }>> {
  const supabase = await createClient();

  const { data, error } = await supabase.rpc("get_announcement_attachment_download_secure", {
    p_attachment_id: attachmentId,
  });

  if (error) return { ok: false, error: error.message, data: null };
  const row = data?.[0];
  if (!row) return { ok: false, error: "Attachment not found.", data: null };

  const signed = await adapter.createSignedUrl(BUCKET, row.storage_path, SIGNED_URL_TTL_SECONDS);
  if (!signed.url) return { ok: false, error: signed.error ?? "Could not sign the download URL.", data: null };

  return { ok: true, error: null, data: { url: signed.url, fileName: row.file_name } };
}
