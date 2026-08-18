"use client";

import { useRef, useState } from "react";

const MAX_ATTACHMENTS = 5;
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_DIMENSION = 1600;
const JPEG_QUALITY = 0.8;
const ACCEPTED_MIME = ["image/jpeg", "image/png", "image/webp", "application/pdf"];

export interface PendingAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  blob: Blob;
  previewUrl: string;
}

async function compressImage(file: File): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, w, h);
    const blob: Blob | null = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY));
    return blob && blob.size < file.size ? blob : file;
  } catch {
    return file;
  }
}

/** Releases the blob: URLs behind a set of pending previews — call after a successful
 * submit/queue or when resetting the form for "Submit another". */
export function revokeAttachmentPreviews(attachments: PendingAttachment[]) {
  attachments.forEach((a) => a.previewUrl && URL.revokeObjectURL(a.previewUrl));
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Optional photo/PDF attachments for a report form. Never required — every caller wires
 * this into an already-valid submit flow, it just carries extra files alongside it.
 * Images are compressed client-side (long edge ~1600px, JPEG q0.8) before anything else
 * touches them, so both the online upload and the offline IndexedDB queue stay small. */
export function AttachmentUpload({
  value,
  onChange,
  disabled,
}: {
  value: PendingAttachment[];
  onChange: (next: PendingAttachment[]) => void;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList);
    if (value.length + files.length > MAX_ATTACHMENTS) {
      alert(`Maximum ${MAX_ATTACHMENTS} attachments per report.`);
      return;
    }
    setBusy(true);
    try {
      const next: PendingAttachment[] = [...value];
      for (const file of files) {
        const isPdf = file.type === "application/pdf";
        const isImage = file.type.startsWith("image/");
        if (!isPdf && !isImage) {
          alert(`${file.name}: only photos or PDF files are supported.`);
          continue;
        }
        const blob = isImage ? await compressImage(file) : file;
        const mimeType = isImage ? "image/jpeg" : file.type;
        if (!ACCEPTED_MIME.includes(mimeType)) {
          alert(`${file.name}: unsupported file type.`);
          continue;
        }
        if (blob.size > MAX_BYTES) {
          alert(`${file.name} is too large even after compression (max 10MB).`);
          continue;
        }
        next.push({
          id: crypto.randomUUID(),
          name: file.name,
          mimeType,
          size: blob.size,
          blob,
          previewUrl: isImage ? URL.createObjectURL(blob) : "",
        });
      }
      onChange(next);
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  function remove(id: string) {
    const target = value.find((a) => a.id === id);
    if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
    onChange(value.filter((a) => a.id !== id));
  }

  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between">
        <span className="field-label">Attachments (optional)</span>
        <span className="t-mono text-[9.5px]" style={{ color: "var(--faint)" }}>
          {value.length}/{MAX_ATTACHMENTS} · PHOTO OR PDF
        </span>
      </div>

      {value.length > 0 && (
        <div className="grid grid-cols-3 gap-2">
          {value.map((a) => (
            <div key={a.id} className="relative card p-1.5 aspect-square flex items-center justify-center overflow-hidden">
              {a.previewUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={a.previewUrl} alt={a.name} className="w-full h-full object-cover" />
              ) : (
                <span className="t-mono text-[8.5px] text-center px-1 break-all" style={{ color: "var(--soft)" }}>
                  {a.name}
                </span>
              )}
              <span
                className="absolute bottom-0 left-0 right-0 t-mono text-[7.5px] text-center py-[2px]"
                style={{ background: "rgba(0,0,0,0.55)", color: "#fff" }}
              >
                {formatSize(a.size)}
              </span>
              <button
                type="button"
                onClick={() => remove(a.id)}
                disabled={disabled}
                className="absolute top-1 right-1 w-5 h-5 flex items-center justify-center text-[11px] font-bold leading-none"
                style={{ background: "var(--red)", color: "#fff", borderRadius: "50%" }}
                aria-label={`Remove ${a.name}`}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {value.length < MAX_ATTACHMENTS && (
        <button
          type="button"
          className="btn-secondary w-full"
          disabled={disabled || busy}
          onClick={() => inputRef.current?.click()}
        >
          {busy ? "Processing…" : "Add photo or PDF"}
        </button>
      )}
      <input
        ref={inputRef}
        type="file"
        accept="image/*,application/pdf"
        multiple
        className="hidden"
        onChange={(e) => handleFiles(e.target.files)}
      />
    </div>
  );
}
