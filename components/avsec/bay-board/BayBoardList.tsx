"use client";

import { useState } from "react";
import { formatDateTimeMY } from "@/lib/avsec/datetime";
import { cn } from "@/lib/avsec/utils";
import { correctBayBoardEntry } from "@/lib/avsec/reports/actions";
import { Plane, AlertTriangle, CheckCircle2, Clock, X, Loader2 } from "lucide-react";
import type { BayBoardRow } from "@/lib/avsec/types";

export function BayBoardList({
  initialEntries,
  station,
}: {
  initialEntries: (BayBoardRow & { hoursOnGround: number })[];
  /** null for an org-wide viewer with no single station — shows "all stations" instead of a blank. */
  station: string | null;
}) {
  const [entries, setEntries] = useState(initialEntries);
  const [clearingId, setClearingId] = useState<string | null>(null);
  const [correctingId, setCorrectingId] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleCorrect = async (id: string) => {
    setClearingId(id);
    setError(null);
    const res = await correctBayBoardEntry(id, reason);
    if (res.ok) {
      setEntries((prev) => prev.filter((e) => e.id !== id));
      setCorrectingId(null);
      setReason("");
    } else {
      setError(res.error || "Failed to correct the entry");
    }
    setClearingId(null);
  };

  if (entries.length === 0) {
    return (
      <div className="card p-8 text-center space-y-2 border-border/60">
        <Plane className="h-8 w-8 mx-auto text-muted-foreground opacity-50" />
        <p className="text-sm font-semibold text-foreground">
          No aircraft currently logged on ground at {station ?? "all stations"}.
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
                ? "border-destructive/50 bg-destructive/5 dark:bg-destructive/20"
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
                    <span className="t-mono text-xs font-bold text-foreground px-2 py-0.5 rounded bg-primary/10 border border-primary/20">
                      {e.flight}
                    </span>
                  )}
                  {e.aircraft_type && (
                    <span className="text-xs text-muted-foreground font-mono">
                      · {e.aircraft_type}
                    </span>
                  )}
                  {e.search_state && e.search_state !== "pending" && (
                    <span
                      data-testid="search-state"
                      className={cn(
                        "inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-mono font-semibold uppercase border",
                        e.search_state === "confirmed" && "bg-success/10 text-success border-success/30",
                        e.search_state === "submitted" && "bg-warning/10 text-warning border-warning/30",
                        e.search_state === "exception" && "bg-destructive/10 text-destructive border-destructive/30",
                        e.search_state === "not_required" && "bg-muted text-muted-foreground border-border",
                      )}
                    >
                      {e.search_state === "submitted" ? "Search submitted · awaiting review" : e.search_state === "confirmed" ? "Search confirmed" : e.search_state === "exception" ? (e.departed_without_confirmed_search ? "Departed · search exception" : "Search exception") : "Search not required"}
                    </span>
                  )}
                  {e.is_manual ? (
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-mono font-semibold uppercase bg-warning/10 text-warning border border-warning/20">
                      Manual Entry
                    </span>
                  ) : (
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-mono font-semibold uppercase bg-success/10 text-success border border-success/20">
                      SEC016 Auto
                    </span>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground font-mono">
                  {station === null && (
                    <>
                      <span className="text-foreground font-semibold">{e.station}</span>
                      <span>·</span>
                    </>
                  )}
                  <span>Bay: <strong className="text-foreground">{e.bay}</strong></span>
                  <span>·</span>
                  <span className="flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    On ground since {formatDateTimeMY(e.on_ground_since)}
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-4 shrink-0">
                <div className={cn("text-right font-mono", overdue && "text-destructive")}>
                  <div className="text-base font-bold">
                    {e.hoursOnGround.toFixed(1)}h
                  </div>
                  {overdue ? (
                    <p className="text-[10px] font-bold uppercase tracking-wider flex items-center gap-1 text-destructive">
                      <AlertTriangle className="h-3 w-3" />
                      Search Overdue (&gt;4h)
                    </p>
                  ) : (
                    <p className="text-[10px] font-semibold text-success flex items-center gap-1">
                      <CheckCircle2 className="h-3 w-3" />
                      Normal
                    </p>
                  )}
                </div>

                <button
                  type="button"
                  onClick={() => { setCorrectingId(correctingId === e.id ? null : e.id); setReason(""); setError(null); }}
                  className="rounded-lg border border-border/80 bg-surface/70 px-2.5 py-1.5 text-xs font-mono text-muted-foreground hover:text-brand hover:border-brand/40"
                  title="Correct an incorrect entry (supervisor, reason required, audited)"
                >
                  <span className="flex items-center gap-1">
                    <X className="h-3.5 w-3.5" />
                    <span>Correct entry</span>
                  </span>
                </button>
              </div>
            </div>
            {correctingId === e.id && (
              <div className="mt-3 space-y-2 border-t border-border/60 pt-3">
                <p className="font-mono text-[11px] text-muted-foreground">For an entry that was genuinely made in error. A supervisor (SO, SSO or DSE; an aircraft that still needs a search needs a DSE or the Operation Manager) must give a reason. This is recorded as a correction, not as a completed search.</p>
                <textarea className="input-base text-xs" rows={2} value={reason} onChange={(ev) => setReason(ev.target.value)} placeholder="Reason (at least 10 characters)" />
                {error && <p className="font-mono text-xs text-destructive">{error}</p>}
                <div className="flex gap-2">
                  <button type="button" className="btn-primary text-xs px-3 py-1" disabled={isClearing || reason.trim().length < 10} onClick={() => handleCorrect(e.id)}>{isClearing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Confirm correction"}</button>
                  <button type="button" className="btn-secondary text-xs px-3 py-1" onClick={() => setCorrectingId(null)}>Cancel</button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
