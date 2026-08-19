"use client";

import { useEffect, useState } from "react";
import { Clock3, AlertTriangle } from "lucide-react";

function format(msLeft: number): string {
  const totalSeconds = Math.floor(Math.abs(msLeft) / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

/**
 * Live countdown to a segment's SLA deadline (Upgrade 5). Ticks client-side
 * off the deadline timestamp so it stays accurate without polling the
 * server; escalate_timeouts() (pg_cron, every 15 min) is still the actual
 * authority that raises SEGMENT_TIMEOUT — this is a read-only visual aid.
 */
export function SegmentCountdown({ deadline }: { deadline: string | null }) {
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    if (!deadline) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [deadline]);

  if (!deadline || now === null) return null;

  const msLeft = new Date(deadline).getTime() - now;
  const overdue = msLeft <= 0;

  return (
    <span
      className={`inline-flex items-center gap-1 text-xs font-medium ${
        overdue
          ? "text-red-600 dark:text-red-400"
          : msLeft < 5 * 60 * 1000
            ? "text-amber-600 dark:text-amber-400"
            : "text-muted-foreground"
      }`}
    >
      {overdue ? <AlertTriangle className="h-3.5 w-3.5" /> : <Clock3 className="h-3.5 w-3.5" />}
      {overdue ? `Overdue by ${format(msLeft)}` : `${format(msLeft)} left`}
    </span>
  );
}
