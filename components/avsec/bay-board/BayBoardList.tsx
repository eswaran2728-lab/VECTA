"use client";

import { useState } from "react";
import { formatDateTimeMY } from "@/lib/avsec/datetime";
import { cn } from "@/lib/avsec/utils";
import { clearBayBoardEntry } from "@/lib/avsec/reports/actions";
import { Plane, AlertTriangle, CheckCircle2, Clock, X, Loader2 } from "lucide-react";
import type { BayBoardRow } from "@/lib/avsec/types";

export function BayBoardList({
  initialEntries,
  station,
}: {
  initialEntries: (BayBoardRow & { hoursOnGround: number })[];
  station: string;
}) {
  const [entries, setEntries] = useState(initialEntries);
  const [clearingId, setClearingId] = useState<string | null>(null);

  const handleClear = async (id: string, regNo: string) => {
    if (!confirm(`Are you sure you want to remove aircraft ${regNo} from the Bay Board?`)) {
      return;
    }
    setClearingId(id);
    const res = await clearBayBoardEntry(id);
    if (res.ok) {
      setEntries((prev) => prev.filter((e) => e.id !== id));
    } else {
      alert(res.error || "Failed to remove aircraft");
    }
    setClearingId(null);
  };

  if (entries.length === 0) {
    return (
      <div className="card p-8 text-center space-y-2 border-border/60">
        <Plane className="h-8 w-8 mx-auto text-muted-foreground opacity-50" />
        <p className="text-sm font-semibold text-foreground">
          No aircraft currently logged on ground at {station}.
        </p>
        <p className="text-xs text-muted-foreground">
          Aircraft will appear here automatically upon filing an Arrival SEC016 or via manual logging.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {entries.map((e) => {
        const overdue = e.hoursOnGround >= 4;
        const isClearing = clearingId === e.id;

        return (
          <div
            key={e.id}
            className={cn(
              "card p-4 transition-all border",
              overdue
                ? "border-red-500/50 bg-red-500/5 dark:bg-red-950/20"
                : "border-border/80 bg-surface/90"
            )}
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-display text-base font-bold text-foreground">
                    {e.reg_no}
                  </span>
                  {e.flight && (
                    <span className="t-mono text-xs font-bold text-primary px-2 py-0.5 rounded bg-primary/10 border border-primary/20">
                      {e.flight}
                    </span>
                  )}
                  {e.aircraft_type && (
                    <span className="text-xs text-muted-foreground font-mono">
                      · {e.aircraft_type}
                    </span>
                  )}
                  {e.is_manual ? (
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-mono font-semibold uppercase bg-amber-500/10 text-amber-500 border border-amber-500/20">
                      Manual Entry
                    </span>
                  ) : (
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-mono font-semibold uppercase bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                      SEC016 Auto
                    </span>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground font-mono">
                  <span>Bay: <strong className="text-foreground">{e.bay}</strong></span>
                  <span>·</span>
                  <span className="flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    On ground since {formatDateTimeMY(e.on_ground_since)}
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-4 shrink-0">
                <div className={cn("text-right font-mono", overdue && "text-red-400")}>
                  <div className="text-base font-bold">
                    {e.hoursOnGround.toFixed(1)}h
                  </div>
                  {overdue ? (
                    <p className="text-[10px] font-bold uppercase tracking-wider flex items-center gap-1 text-red-400">
                      <AlertTriangle className="h-3 w-3" />
                      Search Overdue (&gt;4h)
                    </p>
                  ) : (
                    <p className="text-[10px] font-semibold text-emerald-400 flex items-center gap-1">
                      <CheckCircle2 className="h-3 w-3" />
                      Normal
                    </p>
                  )}
                </div>

                <button
                  type="button"
                  disabled={isClearing}
                  onClick={() => handleClear(e.id, e.reg_no)}
                  className="rounded-lg border border-border/80 bg-surface/70 px-2.5 py-1.5 text-xs font-mono text-muted-foreground hover:text-brand hover:border-brand/40 hover:bg-brand/5 transition-colors cursor-pointer disabled:opacity-50"
                  title="Manually clear/remove from Bay Board"
                >
                  {isClearing ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <span className="flex items-center gap-1">
                      <X className="h-3.5 w-3.5" />
                      <span>Clear</span>
                    </span>
                  )}
                </button>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
