import "server-only";

import { createClient } from "@/lib/supabase/server";

/**
 * Uploads a base64 PNG data URL (signature pad output / incident photo)
 * to a private storage bucket using the caller's own session, so storage
 * RLS applies. Returns the storage object path.
 */
export async function uploadDataUrl(
  bucket: "signatures" | "incident-photos",
  dataUrl: string,
  prefix: string
): Promise<string> {
  const match = dataUrl.match(/^data:(image\/(?:png|jpeg|webp));base64,(.+)$/);
  if (!match) {
    throw new Error("Invalid image data");
  }
  const contentType = match[1];
  const ext = contentType === "image/png" ? "png" : contentType === "image/jpeg" ? "jpg" : "webp";
  const bytes = Buffer.from(match[2], "base64");

  if (bytes.byteLength > 5 * 1024 * 1024) {
    throw new Error("Image exceeds 5MB limit");
  }

  const supabase = await createClient();
  const path = `${prefix}/${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`;

  const { error } = await supabase.storage.from(bucket).upload(path, bytes, { contentType });
  if (error) {
    throw new Error(`Upload failed: ${error.message}`);
  }
  return path;
}

/** Creates a short-lived signed URL for a private storage object. */
export async function signedUrl(
  bucket: "signatures" | "incident-photos",
  path: string | null
): Promise<string | null> {
  if (!path) return null;
  const supabase = await createClient();
  const { data } = await supabase.storage.from(bucket).createSignedUrl(path, 60 * 60);
  return data?.signedUrl ?? null;
}
