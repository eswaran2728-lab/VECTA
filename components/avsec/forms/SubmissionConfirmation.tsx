"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import QRCode from "qrcode";
import { formatDateTimeMY } from "@/lib/avsec/datetime";
import { cn } from "@/lib/avsec/utils";

export function SubmissionConfirmation({
  reportName,
  formCode,
  id,
  submittedAt,
  reportNo,
  queued,
  pendingAttachments,
  attachmentErrors,
  onSubmitAnother,
}: {
  reportName: string;
  formCode: string;
  id?: string;
  submittedAt?: string;
  reportNo?: string;
  queued?: boolean;
  pendingAttachments?: number;
  attachmentErrors?: string[];
  onSubmitAnother: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!reportNo) {
      setQrDataUrl(null);
      return;
    }
    let cancelled = false;
    QRCode.toDataURL(reportNo, { margin: 1, width: 160 })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setQrDataUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [reportNo]);

  async function copyReportNo() {
    if (!reportNo) return;
    try {
      await navigator.clipboard.writeText(reportNo);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API can be unavailable (e.g. non-HTTPS) — the number is still visible
      // to copy by hand, so this failure is silent rather than an error message.
    }
  }

  return (
    <div className="py-6 space-y-5 max-w-lg mx-auto">
      <div
        className={cn(
          "w-16 h-16 rounded-2xl flex items-center justify-center text-3xl font-bold border mx-auto",
          queued
            ? "bg-blue-500/10 border-blue-500/30 text-blue-400"
            : "bg-emerald-500/10 border-emerald-500/30 text-emerald-400"
        )}
      >
        {queued ? "⇅" : "✓"}
      </div>

      <div className="text-center space-y-2">
        <h1 className="font-display text-2xl font-bold text-foreground">
          {queued ? "Queued Offline" : "Report Submitted"}
        </h1>
        <p className="text-xs text-muted-foreground leading-relaxed max-w-sm mx-auto">
          {queued
            ? `You're offline. This report${pendingAttachments ? " and its attachments are" : " is"} saved on your device and will submit automatically once you're back online.`
            : "Recorded as an immutable submission. Corrections must be filed as an amendment referencing this record."}
        </p>
      </div>

      {attachmentErrors && attachmentErrors.length > 0 && (
        <div className="card p-4 space-y-1.5 border-red-500/50 bg-red-500/10">
          <p className="font-mono text-[10px] font-bold uppercase tracking-wider text-red-400">
            ATTACHMENT UPLOAD ISSUE
          </p>
          <p className="text-xs text-red-300">
            The report itself was submitted successfully. These attachments will keep retrying in the background:
          </p>
          {attachmentErrors.map((e) => (
            <p key={e} className="font-mono text-[11px] text-red-400">
              {e}
            </p>
          ))}
        </div>
      )}

      {/* Report number */}
      <div className="card p-6 text-center space-y-3 border-primary/50 bg-primary/5 shadow-sm">
        <p className="font-mono text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
          OFFICIAL REPORT NUMBER
        </p>
        {queued || !reportNo ? (
          <p className="font-display text-xl text-muted-foreground font-semibold">
            PENDING — assigned on sync
          </p>
        ) : (
          <>
            <p className="font-mono font-bold text-3xl tracking-wider text-primary break-all">
              {reportNo}
            </p>
            <p className="font-mono text-xs font-semibold text-amber-400">
              Write this number on the paper form
            </p>
            {qrDataUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={qrDataUrl} alt={`QR code for ${reportNo}`} className="mx-auto rounded-lg p-1 bg-white" width={130} height={130} />
            )}
            <button type="button" className="btn-secondary w-full text-xs" onClick={copyReportNo}>
              {copied ? "Copied ✓" : "Copy Report Number"}
            </button>
          </>
        )}
      </div>

      <div className="card p-4 border-border/80 bg-surface/70 space-y-1">
        <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
          {formCode}
        </p>
        <p className="font-bold text-sm text-foreground">
          {reportName}
        </p>
        <p className="font-mono text-xs text-primary pt-1">
          {queued ? "QUEUE REF · SAVED LOCALLY" : id ? `RECORD · ${id.slice(0, 8)}` : "RECORD"}
          {!queued && submittedAt ? ` · ${formatDateTimeMY(submittedAt)}` : ""}
        </p>
      </div>

      <div className="flex gap-2.5 pt-2">
        <button type="button" className="btn-secondary flex-1 text-xs" onClick={onSubmitAnother}>
          Submit Another
        </button>
        <Link href="/avsec/home" className="btn-primary flex-1 text-center text-xs flex items-center justify-center">
          Done
        </Link>
      </div>
    </div>
  );
}
