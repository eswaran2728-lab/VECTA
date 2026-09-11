"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  reviewLeaveApplication,
  requestLeaveCancellation,
  type LeaveReviewAction,
} from "@/lib/avsec/duty/absence-actions";

export function LeaveReviewControls({
  noticeId,
  staffName,
  leaveTypeLabel,
  mode = "application",
}: {
  noticeId: string;
  staffName: string;
  leaveTypeLabel: string;
  mode?: "application" | "cancellation";
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [showPrompt, setShowPrompt] = useState<"approve" | "reject" | null>(null);
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);

  const isCancelMode = mode === "cancellation";

  function handleReview(actionType: "approve" | "reject") {
    setError(null);
    startTransition(async () => {
      const action: LeaveReviewAction = isCancelMode
        ? actionType === "approve"
          ? "approve_cancellation"
          : "reject_cancellation"
        : actionType;

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
          {isCancelMode
            ? showPrompt === "approve"
              ? `✅ Approve Leave Cancellation for ${staffName} (${leaveTypeLabel})`
              : `❌ Reject Cancellation Request for ${staffName} (${leaveTypeLabel})`
            : showPrompt === "approve"
              ? `✅ Approve Leave Application for ${staffName} (${leaveTypeLabel})`
              : `❌ Reject Leave Application for ${staffName} (${leaveTypeLabel})`}
        </div>
        <textarea
          rows={2}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder={`Optional review notes or rationale for ${isCancelMode ? (showPrompt === "approve" ? "cancellation approval" : "rejection") : showPrompt}...`}
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
            {isPending
              ? "Updating…"
              : isCancelMode
                ? showPrompt === "approve"
                  ? "Confirm Cancellation"
                  : "Reject Cancel Request"
                : `Confirm ${showPrompt === "approve" ? "Approval" : "Rejection"}`}
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
        {isCancelMode ? "✓ Approve Cancellation" : "✓ Approve"}
      </button>
      <button
        type="button"
        className="btn-secondary !text-brand hover:!bg-brand/20 px-3 py-1 text-xs font-mono font-bold"
        onClick={() => setShowPrompt("reject")}
      >
        {isCancelMode ? "✕ Reject Request" : "✕ Reject"}
      </button>
    </div>
  );
}

export function RequestLeaveCancellationControl({
  noticeId,
  leaveTypeLabel,
  startDate,
  endDate,
}: {
  noticeId: string;
  leaveTypeLabel: string;
  startDate: string;
  endDate: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [showModal, setShowModal] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  function handleRequest() {
    setError(null);
    startTransition(async () => {
      const res = await requestLeaveCancellation({
        noticeId,
        reason,
      });

      if (!res.success || res.error) {
        setError(res.error ?? "Failed to request cancellation.");
        return;
      }

      setShowModal(false);
      setReason("");
      router.refresh();
    });
  }

  if (showModal) {
    return (
      <div className="mt-2.5 p-3 rounded-xl border border-border/80 bg-background/90 space-y-2">
        <div className="font-mono text-xs font-bold text-foreground">
          Request Cancellation of Leave ({leaveTypeLabel} · {startDate === endDate ? startDate : `${startDate} → ${endDate}`})
        </div>
        <p className="font-mono text-[11px] text-muted-foreground">
          Your cancellation request will be submitted to your DSE for review and approval.
        </p>
        <textarea
          rows={2}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Reason for requesting cancellation (optional)..."
          className="vecta-input text-xs"
        />
        {error && <p className="font-mono text-[11px] text-brand">{error}</p>}
        <div className="flex gap-2 justify-end">
          <button
            type="button"
            className="btn-secondary px-3 py-1 text-xs"
            onClick={() => {
              setShowModal(false);
              setError(null);
            }}
            disabled={isPending}
          >
            Back
          </button>
          <button
            type="button"
            className="px-3 py-1 rounded font-mono text-xs font-bold text-white bg-warning hover:opacity-90 transition-opacity"
            onClick={handleRequest}
            disabled={isPending}
          >
            {isPending ? "Submitting…" : "Submit Cancel Request"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-2">
      <button
        type="button"
        className="btn-secondary !text-muted-foreground hover:!text-foreground hover:!border-brand/40 px-2.5 py-1 text-[11px] font-mono"
        onClick={() => setShowModal(true)}
      >
        ↩ Request Cancellation
      </button>
    </div>
  );
}
