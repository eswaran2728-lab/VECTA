"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { reviewAircraftSearch } from "@/lib/avsec/aircraft-search/actions";

export function ReviewControls({ recordId, canConfirm }: { recordId: string; canConfirm: boolean }) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const decide = (decision: "confirm" | "exception") =>
    start(async () => {
      setError(null);
      const r = await reviewAircraftSearch({ recordId, decision, note });
      if (!r.ok) return setError(r.error);
      router.refresh();
    });
  return (
    <div className="space-y-2 border-t border-border/50 pt-2">
      <textarea rows={2} className="input-base text-xs" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Review note (required for an exception or a flagged search)" />
      {error && <p className="font-mono text-xs text-destructive">{error}</p>}
      <div className="flex gap-2">
        {canConfirm && (
          <button type="button" className="btn-primary text-xs px-3 py-1" disabled={pending} onClick={() => decide("confirm")}>
            Confirm search
          </button>
        )}
        <button type="button" className="btn-secondary text-xs px-3 py-1" disabled={pending} onClick={() => decide("exception")}>
          Record exception
        </button>
      </div>
    </div>
  );
}
