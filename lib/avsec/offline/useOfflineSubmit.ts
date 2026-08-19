"use client";

import { useCallback, useState } from "react";
import { enqueueSubmission, type QueueItemType, type QueuedAttachment } from "./db";
import { uploadReportAttachment } from "@/lib/avsec/attachments/actions";
import { REPORT_TYPES } from "@/lib/avsec/reference-data";
import type { ActionResult } from "@/lib/avsec/reports/actions";

type SubmitFn = (input: unknown) => Promise<ActionResult>;

export type SubmitOutcome =
  | { kind: "submitted"; id: string; submittedAt?: string; reportNo?: string; attachmentErrors?: string[] }
  | { kind: "queued"; localId: string }
  | { kind: "error"; message: string };

async function uploadAttachments(reportType: string, reportId: string, attachments: QueuedAttachment[]): Promise<string[] | undefined> {
  const errors: string[] = [];
  for (const att of attachments) {
    const fd = new FormData();
    fd.set("reportType", reportType);
    fd.set("reportId", reportId);
    fd.set("file", new File([att.blob], att.name, { type: att.mimeType }));
    const res = await uploadReportAttachment(fd);
    if (!res.ok) errors.push(`${att.name}: ${res.error}`);
  }
  return errors.length > 0 ? errors : undefined;
}

/**
 * Wraps a report's (or duty check-in/out's) server action: submits online, or
 * transparently queues to IndexedDB (synced later by OfflineSyncProvider) when the
 * network is unavailable. Optional attachments ride along with the submission and are
 * only uploaded once the report itself has a real id — never before it exists.
 */
export function useOfflineSubmit(type: QueueItemType, submitFn: SubmitFn) {
  const [pending, setPending] = useState(false);

  const submit = useCallback(
    async (values: unknown, attachments?: QueuedAttachment[]): Promise<SubmitOutcome> => {
      setPending(true);
      try {
        if (typeof navigator !== "undefined" && !navigator.onLine) {
          const localId = await enqueueSubmission(type, values, attachments);
          return { kind: "queued", localId };
        }

        const result = await submitFn(values);
        if (result.ok && result.id) {
          const attachmentErrors =
            attachments && attachments.length > 0 && (REPORT_TYPES as readonly string[]).includes(type)
              ? await uploadAttachments(type, result.id, attachments)
              : undefined;
          return {
            kind: "submitted",
            id: result.id,
            submittedAt: result.submittedAt,
            reportNo: result.reportNo,
            attachmentErrors,
          };
        }
        if (!result.ok && result.error) {
          return { kind: "error", message: result.error };
        }
        return { kind: "error", message: "Unknown submission error" };
      } catch {
        // Network / fetch failure — queue for later sync rather than losing the report.
        const localId = await enqueueSubmission(type, values, attachments);
        return { kind: "queued", localId };
      } finally {
        setPending(false);
      }
    },
    [submitFn, type],
  );

  return { submit, pending };
}
