"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import QRCode from "qrcode";
import { formatDateTimeMY } from "@/lib/datetime";

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
  const accent = queued ? "var(--blue)" : "var(--gold-fill)";
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
    <div className="py-6 space-y-5">
      <div
        className="w-[60px] h-[66px] flex items-center justify-center text-2xl font-bold"
        style={{
          background: accent,
          color: "var(--on-gold)",
          clipPath: "polygon(50% 0,100% 16%,100% 62%,50% 100%,0 62%,0 16%)",
        }}
      >
        {queued ? "⇅" : "✓"}
      </div>

      <div>
        <h1 className="t-display text-2xl">{queued ? "Queued offline" : "Report submitted"}</h1>
        <p className="text-[13px] leading-relaxed mt-2" style={{ color: "var(--mid)" }}>
          {queued
            ? `You're offline. This report${pendingAttachments ? " and its attachments are" : " is"} saved on your device and will submit automatically once you're back online — no re-entry needed.`
            : "Recorded as an immutable submission. Corrections must be filed as an amendment referencing this record."}
        </p>
      </div>

      {attachmentErrors && attachmentErrors.length > 0 && (
        <div className="card p-4 space-y-1.5" style={{ borderColor: "var(--red)" }}>
          <p className="t-mono text-[9px] font-semibold" style={{ letterSpacing: "0.12em", color: "var(--red)" }}>
            ATTACHMENT UPLOAD ISSUE
          </p>
          <p className="text-[12.5px]" style={{ color: "var(--soft)" }}>
            The report itself was submitted successfully. These attachments will keep retrying in the background:
          </p>
          {attachmentErrors.map((e) => (
            <p key={e} className="t-mono text-[10.5px]" style={{ color: "var(--red)" }}>
              {e}
            </p>
          ))}
        </div>
      )}

      {/* Report number — the arm's-length, outdoor-readable panel that ties this digital
          record to the paper AA/SEC/F form the officer also files. */}
      <div className="card p-5 text-center space-y-3" style={{ borderColor: "var(--gold-fill)" }}>
        <p className="t-mono text-[9px] font-semibold" style={{ letterSpacing: "0.14em", color: "var(--faint)" }}>
          REPORT NUMBER
        </p>
        {queued || !reportNo ? (
          <p className="t-display text-xl" style={{ color: "var(--soft)" }}>
            PENDING — assigned on sync
          </p>
        ) : (
          <>
            <p
              className="t-mono font-bold text-[28px] leading-none break-all"
              style={{ color: "var(--ink)", letterSpacing: "0.02em" }}
            >
              {reportNo}
            </p>
            <p className="t-mono text-[10.5px] font-semibold" style={{ color: "var(--red)" }}>
              Write this number on the paper form
            </p>
            {qrDataUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={qrDataUrl} alt={`QR code for ${reportNo}`} className="mx-auto" width={120} height={120} />
            )}
            <button type="button" className="btn-secondary w-full" onClick={copyReportNo}>
              {copied ? "Copied ✓" : "Copy report number"}
            </button>
          </>
        )}
      </div>

      <div className="card p-4">
        <p className="t-mono text-[9px] font-medium" style={{ letterSpacing: "0.12em", color: "var(--faint)" }}>
          {formCode}
        </p>
        <p className="font-semibold text-[15px] mt-1.5" style={{ color: "var(--ink)" }}>
          {reportName}
        </p>
        <p className="t-mono text-[10.5px] mt-2" style={{ color: "var(--gold)" }}>
          {queued ? "QUEUE REF · SAVED LOCALLY" : id ? `RECORD · ${id.slice(0, 8)}` : "RECORD"}
          {!queued && submittedAt ? ` · ${formatDateTimeMY(submittedAt)}` : ""}
        </p>
      </div>

      <div className="flex gap-2.5">
        <button type="button" className="btn-secondary flex-1" onClick={onSubmitAnother}>
          Submit another
        </button>
        <Link href="/home" className="btn-primary flex-1 text-center">
          Done
        </Link>
      </div>
    </div>
  );
}
