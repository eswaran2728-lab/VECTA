"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { acknowledgeHandover } from "@/lib/avsec/duty/handover-actions";

export function AcknowledgeControl({ handoverId }: { handoverId: string }) {
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  return (
    <div className="border-t border-border/50 pt-3 space-y-2">
      <label className="field-label" htmlFor={`ack-notes-${handoverId}`}>
        Acknowledgment notes (optional)
      </label>
      <textarea
        id={`ack-notes-${handoverId}`}
        rows={2}
        className="input-base text-xs"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Confirming receipt of handover…"
      />
      {error && <p className="text-xs text-red-400 font-mono">{error}</p>}
      <button
        type="button"
        className="btn-primary w-full text-xs"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            setError(null);
            const outcome = await acknowledgeHandover(handoverId, notes);
            if (!outcome.ok) {
              setError(outcome.error);
              return;
            }
            router.refresh();
          })
        }
      >
        {pending ? "Acknowledging…" : "Acknowledge Handover ▸"}
      </button>
    </div>
  );
}
