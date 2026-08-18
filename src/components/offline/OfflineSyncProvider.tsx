"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import {
  listQueuedSubmissions,
  removeQueuedSubmission,
  updateQueuedSubmission,
  enqueueSubmission,
  type QueuedSubmission,
  type QueuedAttachment,
  type QueuedAttachmentPayload,
  type QueueItemType,
} from "@/lib/offline/db";
import { clearLocalDraft } from "@/lib/offline/useDraftAutosave";
import {
  submitSec016,
  submitSec014,
  submitSec029,
  submitSec018,
  submitSec033,
  submitSec013,
  submitOffload,
} from "@/lib/reports/actions";
import { submitDutyCheckIn, submitDutyCheckOut } from "@/lib/duty/checkin-actions";
import { uploadReportAttachment } from "@/lib/attachments/actions";
import { REPORT_TYPES, type ReportType } from "@/lib/reference-data";

const SUBMIT_FNS: Record<
  Exclude<QueueItemType, "attachment">,
  (input: unknown) => Promise<{ ok: boolean; id?: string }>
> = {
  sec016: submitSec016,
  sec014: submitSec014,
  sec029: submitSec029,
  sec018: submitSec018,
  sec033: submitSec033,
  sec013: submitSec013,
  offload: submitOffload,
  duty_checkin: submitDutyCheckIn,
  duty_checkout: submitDutyCheckOut,
};

async function syncOneAttachment(reportType: string, reportId: string, att: QueuedAttachment) {
  const fd = new FormData();
  fd.set("reportType", reportType);
  fd.set("reportId", reportId);
  fd.set("file", new File([att.blob], att.name, { type: att.mimeType }));
  return uploadReportAttachment(fd);
}

function isReportType(type: QueueItemType): type is ReportType {
  return (REPORT_TYPES as readonly string[]).includes(type);
}

interface OfflineContextValue {
  isOnline: boolean;
  queueCount: number;
  syncing: boolean;
  syncNow: () => Promise<void>;
}

const OfflineContext = createContext<OfflineContextValue>({
  isOnline: true,
  queueCount: 0,
  syncing: false,
  syncNow: async () => {},
});

export function useOfflineStatus() {
  return useContext(OfflineContext);
}

export function OfflineSyncProvider({ children }: { children: React.ReactNode }) {
  const [isOnline, setIsOnline] = useState(true);
  const [queueCount, setQueueCount] = useState(0);
  const [syncing, setSyncing] = useState(false);

  const refreshCount = useCallback(async () => {
    const items = await listQueuedSubmissions();
    setQueueCount(items.length);
  }, []);

  const syncNow = useCallback(async () => {
    if (typeof navigator !== "undefined" && !navigator.onLine) return;
    setSyncing(true);
    try {
      const items = await listQueuedSubmissions();
      for (const item of items) {
        try {
          // A standalone attachment retry (the report it belongs to already synced) —
          // never resubmits the report, only retries the file upload.
          if (item.type === "attachment") {
            const payload = item.payload as QueuedAttachmentPayload;
            const att = item.attachments?.[0];
            if (!att) {
              await removeQueuedSubmission(item.localId);
              continue;
            }
            const res = await syncOneAttachment(payload.reportType, payload.reportId, att);
            if (res.ok) {
              await removeQueuedSubmission(item.localId);
            } else {
              await updateQueuedSubmission({
                ...item,
                attempts: item.attempts + 1,
                lastError: res.error ?? "Attachment upload failed",
              } as QueuedSubmission);
            }
            continue;
          }

          const result = await SUBMIT_FNS[item.type](item.payload);
          if (result.ok) {
            await removeQueuedSubmission(item.localId);
            if (isReportType(item.type)) clearLocalDraft(item.type);

            // Report synced — now upload any attachments queued alongside it. A failed
            // attachment never re-queues the report itself, only a standalone retry item.
            if (isReportType(item.type) && result.id && item.attachments && item.attachments.length > 0) {
              for (const att of item.attachments) {
                const res = await syncOneAttachment(item.type, result.id, att);
                if (!res.ok) {
                  await enqueueSubmission(
                    "attachment",
                    { reportType: item.type, reportId: result.id } as QueuedAttachmentPayload,
                    [att],
                  );
                }
              }
            }
          } else {
            await updateQueuedSubmission({
              ...item,
              attempts: item.attempts + 1,
              lastError: "Server rejected submission",
            } as QueuedSubmission);
          }
        } catch (err) {
          await updateQueuedSubmission({
            ...item,
            attempts: item.attempts + 1,
            lastError: err instanceof Error ? err.message : "Sync failed",
          } as QueuedSubmission);
        }
      }
    } finally {
      setSyncing(false);
      await refreshCount();
    }
  }, [refreshCount]);

  useEffect(() => {
    setIsOnline(typeof navigator === "undefined" ? true : navigator.onLine);
    refreshCount();

    const handleOnline = () => {
      setIsOnline(true);
      syncNow();
    };
    const handleOffline = () => setIsOnline(false);

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    const interval = setInterval(refreshCount, 8000);
    if (typeof navigator !== "undefined" && navigator.onLine) syncNow();

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <OfflineContext.Provider value={{ isOnline, queueCount, syncing, syncNow }}>
      {children}
    </OfflineContext.Provider>
  );
}
