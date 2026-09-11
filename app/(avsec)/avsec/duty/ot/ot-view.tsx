"use client";

import { useState } from "react";
import Link from "next/link";
import { reviewOtRequest, type OtRequestRow } from "@/lib/avsec/duty/ot-actions";
import { Clock, Plus, Check, X, Calendar, User } from "lucide-react";
import { formatDateMY } from "@/lib/avsec/datetime";
import { OPS_GROUP_LABELS, type OpsGroup } from "@/lib/avsec/reference-data";

export function OtView({
  initialRequests,
  userRole,
  userBranch,
}: {
  initialRequests: OtRequestRow[];
  userRole: string;
  userBranch: string | null;
}) {
  const [requests, setRequests] = useState<OtRequestRow[]>(initialRequests);
  const [activeTab, setActiveTab] = useState<"all" | "pending" | "approved" | "rejected">("all");
  const [reviewNotes, setReviewNotes] = useState<Record<string, string>>({});
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const isAso = userRole === "ASO";
  const isDse = userRole === "DSE";

  const filtered = requests.filter((r) => {
    if (activeTab === "all") return true;
    return r.status === activeTab;
  });

  const handleReview = async (id: string, decision: "approved" | "rejected") => {
    setActionLoading(id);
    const notes = reviewNotes[id] || "";
    const res = await reviewOtRequest(id, decision, notes);
    if (res.success) {
      setRequests(
        requests.map((r) =>
          r.id === id
            ? {
                ...r,
                status: decision,
                reviewed_at: new Date().toISOString(),
                notes: notes || r.notes,
              }
            : r
        )
      );
    }
    setActionLoading(null);
  };

  return (
    <div className="flex flex-col gap-6">
      {/* Header Panel */}
      <div className="vecta-panel flex flex-wrap items-center justify-between gap-4 px-6 py-5">
        <div>
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary border border-primary/20">
              <Clock className="h-5 w-5" />
            </span>
            <div>
              <h1 className="font-display text-lg font-bold tracking-[0.03em] text-foreground">
                Overtime (OT) Management
              </h1>
              <p className="font-mono text-xs text-muted-foreground mt-0.5">
                {isAso
                  ? `ASO Request Portal · ${userBranch ? OPS_GROUP_LABELS[userBranch as OpsGroup] : ""}`
                  : isDse
                  ? `DSE Approval Queue · ${userBranch ? OPS_GROUP_LABELS[userBranch as OpsGroup] : ""}`
                  : "Org-wide Overtime Review"}
              </p>
            </div>
          </div>
        </div>

        {isAso && (
          <Link
            href="/avsec/duty/ot/new"
            className="vecta-btn-primary flex items-center gap-2 cursor-pointer"
          >
            <Plus className="h-4 w-4" />
            <span>Submit OT Request</span>
          </Link>
        )}
      </div>

      {/* Filter Tabs */}
      <div className="vecta-pill-tabs w-fit">
        {(["all", "pending", "approved", "rejected"] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setActiveTab(tab)}
            className={`vecta-pill cursor-pointer capitalize ${activeTab === tab ? "is-active" : ""}`}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* List */}
      <div className="space-y-3">
        {filtered.length === 0 ? (
          <div className="vecta-panel py-10 text-center text-sm text-muted-foreground">
            No {activeTab !== "all" ? activeTab : ""} OT requests found.
          </div>
        ) : (
          filtered.map((req) => {
            const isPending = req.status === "pending";
            const isApproved = req.status === "approved";
            const isRejected = req.status === "rejected";

            return (
              <div
                key={req.id}
                className="vecta-panel flex flex-col gap-4 px-6 py-5 border-border/80"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex flex-col gap-1">
                    <div className="flex items-center gap-2.5">
                      <span className="font-display text-base font-bold text-foreground">
                        {req.hours} Hours OT
                      </span>
                      <span
                        className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 font-mono text-[10.5px] font-semibold uppercase tracking-wider ${
                          isApproved
                            ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                            : isRejected
                            ? "bg-brand/10 text-brand border border-brand/20"
                            : "bg-amber-500/10 text-amber-400 border border-amber-500/20"
                        }`}
                      >
                        <span
                          className={`h-1.5 w-1.5 rounded-full ${
                            isApproved
                              ? "bg-emerald-400"
                              : isRejected
                              ? "bg-brand"
                              : "bg-amber-400 animate-pulse"
                          }`}
                        />
                        {req.status}
                      </span>
                      <span className="vecta-chip font-mono text-[10px]">
                        {OPS_GROUP_LABELS[req.branch] ?? req.branch}
                      </span>
                    </div>

                    <div className="flex flex-wrap items-center gap-4 font-mono text-xs text-muted-foreground mt-1">
                      <span className="flex items-center gap-1">
                        <Calendar className="h-3.5 w-3.5" />
                        Date: {req.work_date}
                      </span>
                      <span className="flex items-center gap-1">
                        <User className="h-3.5 w-3.5" />
                        Requester: {req.requester_name || "ASO Staff"}{" "}
                        {req.requester_staff_no ? `(${req.requester_staff_no})` : ""}
                      </span>
                      <span className="flex items-center gap-1">
                        <Clock className="h-3.5 w-3.5" />
                        Submitted: {formatDateMY(req.requested_at)}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Reason */}
                <div className="rounded-lg bg-surface/70 border border-border/60 p-3 text-xs text-foreground/90">
                  <p className="font-mono text-[10px] uppercase text-muted-foreground mb-1">
                    Justification / Reason
                  </p>
                  <p className="whitespace-pre-wrap">{req.reason}</p>
                </div>

                {/* Review info if reviewed */}
                {req.reviewed_at && (
                  <div className="font-mono text-[11px] text-muted-foreground border-t border-border/40 pt-2 flex flex-wrap items-center justify-between gap-2">
                    <span>
                      Reviewed by {req.reviewed_by_name || "DSE"} on{" "}
                      {formatDateMY(req.reviewed_at)}
                    </span>
                    {req.notes && (
                      <span className="italic text-foreground/80">Notes: &ldquo;{req.notes}&rdquo;</span>
                    )}
                  </div>
                )}

                {/* DSE Action Controls */}
                {isDse && isPending && (
                  <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 pt-2 border-t border-border/60">
                    <input
                      type="text"
                      placeholder="Optional review notes…"
                      value={reviewNotes[req.id] || ""}
                      onChange={(e) =>
                        setReviewNotes({ ...reviewNotes, [req.id]: e.target.value })
                      }
                      className="vecta-input flex-1 text-xs py-1.5"
                    />
                    <div className="flex gap-2">
                      <button
                        type="button"
                        disabled={actionLoading === req.id}
                        onClick={() => handleReview(req.id, "approved")}
                        className="rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/20 px-4 py-2 font-mono text-xs font-semibold flex items-center gap-1.5 cursor-pointer transition-colors"
                      >
                        <Check className="h-3.5 w-3.5" />
                        <span>Approve</span>
                      </button>
                      <button
                        type="button"
                        disabled={actionLoading === req.id}
                        onClick={() => handleReview(req.id, "rejected")}
                        className="rounded-lg bg-brand/10 border border-brand/30 text-brand hover:bg-brand/20 px-4 py-2 font-mono text-xs font-semibold flex items-center gap-1.5 cursor-pointer transition-colors"
                      >
                        <X className="h-3.5 w-3.5" />
                        <span>Reject</span>
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
