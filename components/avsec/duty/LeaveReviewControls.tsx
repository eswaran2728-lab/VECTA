"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { reviewLeaveApplication } from "@/lib/avsec/duty/absence-actions";

export function LeaveReviewControls({
  noticeId,
  staffName,
  leaveTypeLabel,
}: {
  noticeId: string;
  staffName: string;
  leaveTypeLabel: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [showPrompt, setShowPrompt] = useState<"approve" | "reject" | null>(null);
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);

  function handleReview(action: "approve" | "reject") {
    setError(null);
    startTransition(async () => {
      const res = await reviewLeaveApplication({
        noticeId,
        action,
        reviewNotes: notes,
      });

      if (!res.success || res.error) {
        setError(res.error ?? "Failed to update review status.");
        return;
      }

      setShowPrompt(null);
      setNotes("");
      router.refresh();
    });
  }

  if (showPrompt) {
    return (
      <div className="mt-3 p-3 rounded-xl border border-border/80 bg-background/80 space-y-2.5">
        <div className="font-mono text-xs font-bold text-foreground">
          {showPrompt === "approve" ? "✅ Approve Leave Application" : "❌ Reject Leave Application"} for {staffName} ({leaveTypeLabel})
        </div>
        <textarea
          rows={2}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder={`Optional review notes or rationale for ${showPrompt}...`}
          className="vecta-input text-xs"
        />
        {error && <p className="font-mono text-[11px] text-brand">{error}</p>}
        <div className="flex gap-2 justify-end">
          <button
            type="button"
            className="btn-secondary px-3 py-1 text-xs"
            onClick={() => {
              setShowPrompt(null);
              setError(null);
            }}
            disabled={isPending}
          >
            Cancel
          </button>
          <button
            type="button"
            className={`px-3 py-1 rounded font-mono text-xs font-bold text-white transition-opacity ${
              showPrompt === "approve"
                ? "bg-success hover:opacity-90"
                : "bg-brand hover:opacity-90"
            }`}
            onClick={() => handleReview(showPrompt)}
            disabled={isPending}
          >
            {isPending ? "Updating…" : `Confirm ${showPrompt === "approve" ? "Approval" : "Rejection"}`}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 mt-2">
      <button
        type="button"
        className="btn-secondary !text-success hover:!bg-success/20 px-3 py-1 text-xs font-mono font-bold"
        onClick={() => setShowPrompt("approve")}
      >
        ✓ Approve
      </button>
      <button
        type="button"
        className="btn-secondary !text-brand hover:!bg-brand/20 px-3 py-1 text-xs font-mono font-bold"
        onClick={() => setShowPrompt("reject")}
      >
        ✕ Reject
      </button>
    </div>
  );
}
