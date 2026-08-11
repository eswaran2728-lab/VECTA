"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import {
  listQueuedSubmissions,
  removeQueuedSubmission,
  updateQueuedSubmission,
  type QueuedSubmission,
} from "@/lib/offline/db";
import { clearLocalDraft } from "@/lib/offline/useDraftAutosave";
import { submitSec016, submitSec014, submitSec029, submitSec018, submitSec033 } from "@/lib/reports/actions";
import type { ReportType } from "@/lib/reference-data";

const SUBMIT_FNS: Record<ReportType, (input: unknown) => Promise<{ ok: boolean }>> = {
  sec016: submitSec016,
  sec014: submitSec014,
  sec029: submitSec029,
  sec018: submitSec018,
  sec033: submitSec033,
};

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
          const result = await SUBMIT_FNS[item.type](item.payload);
          if (result.ok) {
            await removeQueuedSubmission(item.localId);
            clearLocalDraft(item.type);
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
