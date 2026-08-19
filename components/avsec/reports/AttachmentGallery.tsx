"use client";

import { useState } from "react";
import type { ReportAttachment } from "@/lib/avsec/attachments/actions";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Read-only gallery for a submitted report's attachments — thumbnails open a lightbox;
 * PDFs open the signed URL directly in a new tab since there's nothing to preview inline. */
export function AttachmentGallery({ attachments }: { attachments: ReportAttachment[] }) {
  const [lightbox, setLightbox] = useState<ReportAttachment | null>(null);

  if (attachments.length === 0) return null;

  return (
    <section className="card p-4 sm:p-5 space-y-3">
      <h2 className="section-title">Attachments ({attachments.length})</h2>
      <div className="grid grid-cols-3 gap-2">
        {attachments.map((a) => {
          const isImage = a.mime_type.startsWith("image/");
          const openTarget = isImage ? undefined : a.url ?? undefined;
          return (
            <button
              key={a.id}
              type="button"
              className="relative card-inset p-1.5 aspect-square flex items-center justify-center overflow-hidden text-left"
              onClick={() => {
                if (isImage) setLightbox(a);
                else if (openTarget) window.open(openTarget, "_blank", "noopener,noreferrer");
              }}
            >
              {isImage && a.url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={a.url} alt={a.file_name} className="w-full h-full object-cover" />
              ) : (
                <span className="t-mono text-[8.5px] text-center px-1 break-all" style={{ color: "var(--soft)" }}>
                  {a.file_name}
                </span>
              )}
              <span
                className="absolute bottom-0 left-0 right-0 t-mono text-[7.5px] text-center py-[2px]"
                style={{ background: "rgba(0,0,0,0.55)", color: "#fff" }}
              >
                {formatSize(a.size_bytes)}
              </span>
            </button>
          );
        })}
      </div>

      {lightbox && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: "rgba(0,0,0,0.85)" }}
          onClick={() => setLightbox(null)}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={lightbox.url ?? undefined}
            alt={lightbox.file_name}
            className="max-w-full max-h-full object-contain"
          />
          <button
            type="button"
            className="absolute top-4 right-4 w-9 h-9 flex items-center justify-center text-xl font-bold"
            style={{ background: "var(--red)", color: "#fff", borderRadius: "50%" }}
            onClick={() => setLightbox(null)}
            aria-label="Close"
          >
            ×
          </button>
        </div>
      )}
    </section>
  );
}
