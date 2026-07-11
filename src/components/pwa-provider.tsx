"use client";

import { useCallback, useEffect, useState } from "react";
import { CloudOff, RefreshCw, Wifi } from "lucide-react";
import {
  listQueue,
  markQueuedError,
  removeQueued,
  type QueuedItem,
} from "@/lib/offline-queue";

/**
 * Registers the service worker, shows a persistent online/offline indicator
 * with a pending-sync badge, and replays queued submissions on reconnect.
 * Conflicts (server rejected a queued item) surface with a discard option.
 */
export function PwaProvider() {
  const [online, setOnline] = useState(true);
  const [queue, setQueue] = useState<QueuedItem[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [open, setOpen] = useState(false);

  const refreshQueue = useCallback(() => {
    listQueue().then(setQueue).catch(() => setQueue([]));
  }, []);

  const sync = useCallback(async () => {
    if (!navigator.onLine) return;
    setSyncing(true);
    try {
      const items = await listQueue();
      for (const item of items.filter((i) => !i.error)) {
        try {
          const res = await fetch("/api/sync", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ kind: item.kind, payload: item.payload }),
          });
          if (res.ok) {
            await removeQueued(item.id);
          } else if (res.status === 409) {
            const body = await res.json();
            await markQueuedError(item, body.error ?? "Rejected by server.");
          }
          // Other failures (500/network): keep for the next attempt.
        } catch {
          break; // connection dropped mid-sync
        }
      }
    } finally {
      setSyncing(false);
      refreshQueue();
    }
  }, [refreshQueue]);

  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    }
    setOnline(navigator.onLine);
    refreshQueue();

    const goOnline = () => {
      setOnline(true);
      void sync();
    };
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    window.addEventListener("cscs-queue-changed", refreshQueue);
    void sync();

    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
      window.removeEventListener("cscs-queue-changed", refreshQueue);
    };
  }, [refreshQueue, sync]);

  const pending = queue.length;
  const conflicts = queue.filter((i) => i.error);

  if (online && pending === 0) {
    return null;
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold ${
          online
            ? "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200"
            : "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200"
        }`}
        aria-label="Sync status"
      >
        {online ? <Wifi className="h-3.5 w-3.5" /> : <CloudOff className="h-3.5 w-3.5" />}
        {online ? "" : "Offline"}
        {pending > 0 ? ` · ${pending} pending` : ""}
        {syncing ? <RefreshCw className="h-3 w-3 animate-spin" /> : null}
      </button>

      {open && pending > 0 ? (
        <div className="absolute right-0 top-9 z-50 w-80 rounded-lg border bg-card p-3 text-sm shadow-lg">
          <p className="mb-2 font-semibold">Pending offline submissions</p>
          <ul className="max-h-64 space-y-2 overflow-y-auto">
            {queue.map((item) => (
              <li key={item.id} className="rounded border p-2">
                <p className="font-mono text-xs">{item.kind}</p>
                <p className="text-xs text-muted-foreground">
                  queued {new Date(item.createdAt).toLocaleTimeString()}
                </p>
                {item.error ? (
                  <>
                    <p className="mt-1 text-xs text-red-600">{item.error}</p>
                    <button
                      type="button"
                      onClick={() => removeQueued(item.id)}
                      className="mt-1 text-xs text-primary underline"
                    >
                      Discard (the server state has moved on)
                    </button>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
          {conflicts.length === 0 ? (
            <button
              type="button"
              onClick={() => void sync()}
              disabled={!online || syncing}
              className="mt-2 text-xs text-primary underline disabled:opacity-50"
            >
              Sync now
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
