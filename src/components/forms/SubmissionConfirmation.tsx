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
  return (
    <div className="card p-6 text-center space-y-4">
      <div
        className={
          "mx-auto flex h-14 w-14 items-center justify-center rounded-full text-2xl " +
          (queued ? "bg-amber-100 text-amber-700" : "bg-green-100 text-green-700")
        }
      >
        {queued ? "⏳" : "✓"}
      </div>
      <div>
        <h2 className="section-title">{queued ? "Queued for submission" : "Report submitted"}</h2>
        <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
          {reportName} · <span className="form-code-badge">{formCode}</span>
        </p>
      </div>

      {queued ? (
        <p className="text-sm text-slate-600 dark:text-slate-300">
          You&apos;re offline. This report is saved on your device and will submit automatically
          once you&apos;re back online.
        </p>
      ) : (
        <div className="text-sm text-slate-600 dark:text-slate-300 space-y-1">
          {id && (
            <p>
              Submission ID: <span className="font-mono">{id}</span>
            </p>
          )}
          {submittedAt && <p>Submitted: {formatDateTimeMY(submittedAt)}</p>}
        </div>
      )}

      <div className="flex flex-col sm:flex-row gap-3 justify-center pt-2">
        <button className="btn-secondary" onClick={onSubmitAnother}>
          Submit another
        </button>
        <Link href="/home" className="btn-primary">
          Back to home
        </Link>
      </div>
    </div>
  );
}
