"use client";

import { useState } from "react";
import { resumeReportSubmission } from "@/lib/avsec/reports/actions";

/**
 * Shown when a submission fails AFTER the parent report row was already
 * created server-side (round 7's `id: report.id` on every child-insert
 * failure return, plus every finalization failure) -- the report is not
 * lost, but is "stranded": either its child rows never landed, or its
 * child rows landed but the finalize/index step didn't. Either way the
 * SAME parent id must be reused on retry, never a fresh submission (which
 * would create a duplicate report).
 *
 * This is the actual user-facing recovery path -- a server action alone
 * (resumeReportSubmission) is not a usable workflow without a way for the
 * submitter to actually invoke it after seeing the failure.
 */
export function SubmissionRecovery({
  reportType,
  reportId,
  message,
  payload,
  onRecovered,
  onGiveUp,
}: {
  reportType: string;
  reportId: string;
  message: string;
  /** The exact validated payload from the failed submit attempt -- reused
   * only if the report's child rows still need to be (re)inserted; ignored
   * if they already landed and only finalization needs retrying. */
  payload: unknown;
  onRecovered: (result: { id: string; submittedAt?: string; reportNo?: string }) => void;
  onGiveUp: () => void;
}) {
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);

  async function handleRetry() {
    setRetrying(true);
    setRetryError(null);
    try {
      const result = await resumeReportSubmission(reportType, reportId, payload);
      if (result.ok) {
        onRecovered({ id: result.id ?? reportId, submittedAt: result.submittedAt, reportNo: result.reportNo });
      } else {
        setRetryError(result.error ?? "Retry failed for an unknown reason.");
      }
    } catch {
      setRetryError("Retry failed — check your connection and try again.");
    } finally {
      setRetrying(false);
    }
  }

  return (
    <div className="rounded-lg border border-amber-400/40 bg-amber-50 dark:bg-amber-950/30 p-4 space-y-3">
      <p className="font-medium text-amber-900 dark:text-amber-200">Your report was saved but not fully submitted</p>
      <p className="text-sm text-amber-800 dark:text-amber-300">{message}</p>
      <p className="text-xs text-amber-700 dark:text-amber-400">Report reference: {reportId}</p>
      {retryError && <p className="text-sm text-red-700 dark:text-red-400">{retryError}</p>}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={handleRetry}
          disabled={retrying}
          className="btn-primary disabled:opacity-60"
        >
          {retrying ? "Retrying…" : "Retry submission"}
        </button>
        <button type="button" onClick={onGiveUp} className="btn-secondary">
          Dismiss
        </button>
      </div>
    </div>
  );
}
