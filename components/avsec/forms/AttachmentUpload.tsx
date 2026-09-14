"use client";

import { useRef, useState } from "react";
import { compressImage } from "@/lib/avsec/image-compression";

const MAX_ATTACHMENTS = 5;
const MAX_BYTES = 10 * 1024 * 1024;
const ACCEPTED_MIME = ["image/jpeg", "image/png", "image/webp", "application/pdf"];

export interface PendingAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  blob: Blob;
  previewUrl: string;
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
        <span className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider">
          {value.length}/{MAX_ATTACHMENTS} · PHOTO OR PDF
        </span>
      </div>

      {value.length > 0 && (
        <div className="grid grid-cols-3 gap-2">
          {value.map((a) => (
            <div key={a.id} className="relative card p-1.5 aspect-square flex items-center justify-center overflow-hidden border border-border/80 bg-surface/70 rounded-lg">
              {a.previewUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={a.previewUrl} alt={a.name} className="w-full h-full object-cover rounded" />
              ) : (
                <span className="font-mono text-[9px] text-center px-1 break-all text-muted-foreground">
                  {a.name}
                </span>
              )}
              <span
                className="absolute bottom-0 left-0 right-0 font-mono text-[8px] text-center py-[2px] bg-black/75 text-foreground/90 backdrop-blur-xs"
              >
                {formatSize(a.size)}
              </span>
              <button
                type="button"
                onClick={() => remove(a.id)}
                disabled={disabled}
                className="absolute top-1 right-1 w-5 h-5 flex items-center justify-center text-xs font-bold leading-none bg-red-500 hover:bg-red-600 text-white rounded-full transition-colors cursor-pointer"
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
          className="btn-secondary w-full text-xs"
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
