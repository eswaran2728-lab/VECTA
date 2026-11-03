"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { cancelApprovedAnnualLeave } from "@/lib/avsec/duty/absence-actions";

/** Direct cancellation of an approved annual leave. The server decides who may do it and which days are released. */
export function DirectCancelLeave({ noticeId, staffName }: { noticeId: string; staffName: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (message) return <p className="text-[11px] font-mono text-success">{message}</p>;
  if (!open) {
    return (
      <button type="button" className="btn-secondary text-[11px] px-3 py-1" onClick={() => setOpen(true)}>
        Cancel approved leave…
      </button>
    );
  }
  return (
    <div className="mt-2 p-3 rounded-xl border border-border/80 bg-background/80 space-y-2">
      <p className="font-mono text-xs font-bold text-foreground">Cancel {staffName}&apos;s approved annual leave</p>
      <p className="font-mono text-[10px] text-muted-foreground">Leave not yet started is released in full. Leave already underway keeps today and earlier days; only tomorrow onward is released.</p>
      <textarea className="input-base text-xs" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (required)" />
      {error && <p className="text-xs text-destructive font-mono">{error}</p>}
      <div className="flex gap-2">
        <button
          type="button"
          className="btn-primary text-xs px-3 py-1"
          disabled={pending || reason.trim().length < 5}
          onClick={() =>
            startTransition(async () => {
              setError(null);
              const r = await cancelApprovedAnnualLeave({ noticeId, reason });
              if (!r.success) return setError(r.error ?? "Could not cancel this leave.");
              setMessage(r.kind === "partial" ? `Cancelled. Days from ${r.releasedFrom} are released; earlier days stay taken.` : "Cancelled. All days are released.");
              router.refresh();
            })
          }
        >
          {pending ? "Cancelling…" : "Confirm cancellation"}
        </button>
        <button type="button" className="btn-secondary text-xs px-3 py-1" onClick={() => setOpen(false)}>Keep leave</button>
      </div>
    </div>
  );
}
