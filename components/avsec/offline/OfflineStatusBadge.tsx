"use client";

import { useOfflineStatus } from "./OfflineSyncProvider";

export function OfflineStatusBadge() {
  const { isOnline, queueCount, syncing } = useOfflineStatus();

  if (isOnline && queueCount === 0) return null;

  return (
    <div
      className={
        "w-full text-center text-sm font-medium py-1.5 px-3 " +
        (isOnline
          ? "bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300"
          : "bg-slate-800 text-white")
      }
    >
      {!isOnline && "Offline — reports will be saved and submitted automatically when back online"}
      {isOnline && queueCount > 0 &&
        (syncing
          ? `Syncing ${queueCount} queued submission${queueCount === 1 ? "" : "s"}…`
          : `${queueCount} submission${queueCount === 1 ? "" : "s"} queued — will submit shortly`)}
    </div>
  );
}
