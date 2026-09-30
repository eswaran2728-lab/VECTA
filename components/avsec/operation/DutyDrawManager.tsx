"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  initiateDutyDraw,
  recordDutyDrawAssignment,
  finalizeDutyDraw,
  type DutyZoneOption,
} from "@/lib/phase8/duty-draw";
import { formatDateMY, formatDateTimeMY } from "@/lib/avsec/datetime";

interface DrawRow {
  draw_id: string;
  status: string;
  profile_id: string | null;
  zone_id: string | null;
  assigned_at: string | null;
}

interface HistoryRow {
  draw_id: string;
  draw_date: string;
  status: string;
  initiated_by: string;
  finalized_by: string | null;
  finalized_at: string | null;
}

export function DutyDrawManager({
  station,
  drawDate,
  isOperationManager,
  initialRows,
  initialHistory,
  staff,
  zones,
  fetchError,
}: {
  station: string;
  drawDate: string;
  isOperationManager: boolean;
  initialRows: DrawRow[];
  initialHistory: HistoryRow[];
  staff: { profile_id: string; name: string; staff_no: string | null }[];
  zones: DutyZoneOption[];
  fetchError: string | null;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [assignProfile, setAssignProfile] = useState("");
  const [assignZone, setAssignZone] = useState("");

  const draw = initialRows[0] ?? null;
  const drawId = draw?.draw_id ?? null;
  const status = draw?.status ?? null;
  const assignments = initialRows.filter((r) => r.profile_id);

  function nameFor(profileId: string) {
    return staff.find((s) => s.profile_id === profileId)?.name ?? profileId;
  }
  function zoneFor(zoneId: string | null) {
    if (!zoneId) return "—";
    return zones.find((z) => z.id === zoneId)?.name ?? zoneId;
  }

  return (
    <div className="space-y-5">
      {(error || fetchError) && (
        <div className="card p-4 border-red-500/50 bg-red-500/10 text-xs text-red-400 font-mono">{error ?? fetchError}</div>
      )}

      {isOperationManager && !drawId && (
        <button
          type="button"
          disabled={isPending}
          className="btn-primary w-full text-xs"
          onClick={() =>
            startTransition(async () => {
              setError(null);
              const res = await initiateDutyDraw(station, drawDate);
              if (!res.ok) {
                setError(res.error ?? "Failed to initiate draw.");
                return;
              }
              router.refresh();
            })
          }
        >
          {isPending ? "Initiating…" : `Initiate Draw for ${formatDateMY(drawDate)}`}
        </button>
      )}

      {drawId && (
        <section className="space-y-2.5">
          <h2 className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
            {formatDateMY(drawDate)} — {status}
          </h2>

          {isOperationManager && status === "draft" && (
            <div className="card p-3 space-y-2 border-border/80 bg-surface/80">
              <div className="font-mono text-xs font-bold text-foreground">Add / Update Assignment</div>
              <div className="grid grid-cols-2 gap-2">
                <select className="input-base text-xs" value={assignProfile} onChange={(e) => setAssignProfile(e.target.value)}>
                  <option value="">Select staff…</option>
                  {staff.map((s) => (
                    <option key={s.profile_id} value={s.profile_id}>
                      {s.name} {s.staff_no ? `(${s.staff_no})` : ""}
                    </option>
                  ))}
                </select>
                <select className="input-base text-xs" value={assignZone} onChange={(e) => setAssignZone(e.target.value)}>
                  <option value="">Select zone…</option>
                  {zones.map((z) => (
                    <option key={z.id} value={z.id}>
                      {z.name}
                    </option>
                  ))}
                </select>
              </div>
              <button
                type="button"
                disabled={isPending || !assignProfile || !assignZone}
                className="btn-secondary w-full text-xs"
                onClick={() =>
                  startTransition(async () => {
                    setError(null);
                    const res = await recordDutyDrawAssignment(drawId, assignProfile, assignZone);
                    if (!res.ok) {
                      setError(res.error ?? "Failed to record assignment.");
                      return;
                    }
                    setAssignProfile("");
                    setAssignZone("");
                    router.refresh();
                  })
                }
              >
                {isPending ? "Saving…" : "Save Assignment"}
              </button>
            </div>
          )}

          <div className="space-y-1.5">
            {assignments.length === 0 && (
              <div className="card p-4 text-center text-xs text-muted-foreground border-dashed">No assignments recorded.</div>
            )}
            {assignments.map((a) => (
              <div key={a.profile_id} className="card p-3 flex items-center justify-between gap-3 border-border/80 bg-surface/80">
                <p className="font-semibold text-sm text-foreground">{isOperationManager ? nameFor(a.profile_id!) : a.profile_id}</p>
                <p className="font-mono text-xs text-muted-foreground">{zoneFor(a.zone_id)}</p>
              </div>
            ))}
          </div>

          {isOperationManager && status === "draft" && (
            <button
              type="button"
              disabled={isPending || assignments.length === 0}
              className="px-3 py-1 rounded font-mono text-xs font-bold text-white bg-success hover:opacity-90 w-full"
              onClick={() =>
                startTransition(async () => {
                  setError(null);
                  const res = await finalizeDutyDraw(drawId);
                  if (!res.ok) {
                    setError(res.error ?? "Failed to finalize.");
                    return;
                  }
                  router.refresh();
                })
              }
            >
              {isPending ? "Finalizing…" : "Finalize Draw (irreversible)"}
            </button>
          )}
        </section>
      )}

      {!drawId && !isOperationManager && (
        <div className="card p-6 text-center text-xs text-muted-foreground border-dashed">
          No published duty-zone draw for {station} on {formatDateMY(drawDate)} yet.
        </div>
      )}

      <section className="space-y-2">
        <h2 className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">History ({initialHistory.length})</h2>
        {initialHistory.map((h) => (
          <div key={h.draw_id} className="card p-3 flex items-center justify-between gap-3 border-border/80 bg-surface/80">
            <p className="font-mono text-xs">{formatDateMY(h.draw_date)} · {h.status}</p>
            {h.finalized_at && <p className="font-mono text-[11px] text-muted-foreground">{formatDateTimeMY(h.finalized_at)}</p>}
          </div>
        ))}
      </section>
    </div>
  );
}
