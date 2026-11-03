"use client";

import { useEffect, useState } from "react";
import { previewDepartureSearch, type DepartureAssessment } from "@/lib/avsec/aircraft-search/actions";

const REASON_LABEL: Record<string, string> = { ground_4h: "on ground 4 hours or more", night_stop: "night stop", towed_from_hangar: "towed from hangar" };

/**
 * Departure SEC016: shows whether an aircraft search is required, the linked SEC029 and BOTH gaps from SEC029 submission (to the staff-entered STD, and to this
 * report). A late or missing search needs a reason and is escalated to the reviewer; it never blocks the report. Not the cabin crew aircraft security check.
 */
export function DepartureSearchPanel({
  station,
  registration,
  flight,
  std,
  aircraftType,
  towed,
  reason,
  onTowedChange,
  onReasonChange,
}: {
  station: string;
  registration: string;
  flight: string;
  std: string;
  aircraftType: string;
  towed: boolean;
  reason: string;
  onTowedChange: (v: boolean) => void;
  onReasonChange: (v: string) => void;
}) {
  const [a, setA] = useState<DepartureAssessment | null>(null);
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      previewDepartureSearch({ station, registration, flight, std, aircraftType, towed }).then((r) => live && setA(r)).catch(() => live && setA(null));
    }, 600);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [station, registration, flight, std, aircraftType, towed]);

  const gap = (n: number | null) => (n === null || n === undefined ? "—" : `${Number(n).toFixed(0)} min`);
  return (
    <div className="card p-4 space-y-2 border border-warning/30 bg-warning/5" data-testid="departure-search-panel">
      <h3 className="section-title">Aircraft search (SEC029)</h3>
      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" checked={towed} onChange={(e) => onTowedChange(e.target.checked)} className="h-4 w-4" />
        Aircraft was towed from a hangar
      </label>
      {!a ? (
        <p className="font-mono text-[11px] text-muted-foreground">Enter station, flight, registration and STD to check the search requirement.</p>
      ) : !a.required ? (
        <p className="font-mono text-[11px] text-muted-foreground">No aircraft search is required for this departure (not on ground 4 hours, no night stop, not towed).</p>
      ) : (
        <div className="space-y-1 font-mono text-[11px]">
          <p className="text-foreground">Search required: {a.reasons.map((r) => REASON_LABEL[r] ?? r).join(", ")}.</p>
          {a.missing ? (
            <p className="text-destructive">No SEC029 is linked to this station, flight and aircraft. A reason is required and the supervising officer will be alerted.</p>
          ) : (
            <>
              <p>SEC029 submitted {a.std_gap_minutes !== null ? "" : ""}— gap to the STD you entered (staff-entered): <strong className={a.std_flag ? "text-destructive" : "text-success"}>{gap(a.std_gap_minutes)}</strong> · gap to this report: <strong className={a.departure_flag ? "text-destructive" : "text-success"}>{gap(a.departure_gap_minutes)}</strong> (minimum {a.threshold_minutes} min for {a.carrier}).</p>
              {a.duplicate_ids.length > 0 && <p className="text-warning">More than one SEC029 matches; the earliest is used and the reviewer is told.</p>}
            </>
          )}
          {a.flagged && (
            <div>
              <label className="field-label" htmlFor="search-late-reason">Reason for the late or missing search (required)</label>
              <textarea id="search-late-reason" rows={2} className="input-base text-xs" value={reason} onChange={(e) => onReasonChange(e.target.value)} />
            </div>
          )}
        </div>
      )}
      <p className="font-mono text-[10px] text-muted-foreground">The cabin crew aircraft security check is separate and is never accepted as an aircraft search.</p>
    </div>
  );
}
