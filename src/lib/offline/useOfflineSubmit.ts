"use client";

import { useCallback, useState } from "react";
import type { ReportType } from "@/lib/reference-data";
import { enqueueSubmission } from "./db";
import type { ActionResult } from "@/lib/reports/actions";

type SubmitFn = (input: unknown) => Promise<ActionResult>;

export type SubmitOutcome =
  | { kind: "submitted"; id: string; submittedAt?: string }
  | { kind: "queued"; localId: string }
  | { kind: "error"; message: string };

/**
 * Wraps a report's server action: submits online, or transparently queues to
 * IndexedDB (synced later by OfflineSyncProvider) when the network is unavailable.
 */
export function useOfflineSubmit(type: ReportType, submitFn: SubmitFn) {
  const [pending, setPending] = useState(false);

  const submit = useCallback(
    async (values: unknown): Promise<SubmitOutcome> => {
      setPending(true);
      try {
        if (typeof navigator !== "undefined" && !navigator.onLine) {
          const localId = await enqueueSubmission(type, values);
          return { kind: "queued", localId };
        }

        const result = await submitFn(values);
        if (result.ok && result.id) {
          return { kind: "submitted", id: result.id, submittedAt: result.submittedAt };
        }
        if (!result.ok && result.error) {
          return { kind: "error", message: result.error };
        }
        return { kind: "error", message: "Unknown submission error" };
      } catch {
        // Network / fetch failure — queue for later sync rather than losing the report.
        const localId = await enqueueSubmission(type, values);
        return { kind: "queued", localId };
      } finally {
        setPending(false);
      }
    },
    [submitFn, type],
  );

  return { submit, pending };
}
