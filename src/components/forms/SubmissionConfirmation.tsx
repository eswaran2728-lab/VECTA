"use client";

import Link from "next/link";
import { formatDateTimeMY } from "@/lib/datetime";

export function SubmissionConfirmation({
  reportName,
  formCode,
  id,
  submittedAt,
  queued,
  onSubmitAnother,
}: {
  reportName: string;
  formCode: string;
  id?: string;
  submittedAt?: string;
  queued?: boolean;
  onSubmitAnother: () => void;
}) {
  const accent = queued ? "var(--blue)" : "var(--gold-fill)";

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
            ? "You're offline. This report is saved on your device and will submit automatically once you're back online — no re-entry needed."
            : "Recorded as an immutable submission. Corrections must be filed as an amendment referencing this record."}
        </p>
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
