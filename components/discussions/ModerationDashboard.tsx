"use client";

import { useState } from "react";
import Link from "next/link";
import {
  ShieldAlert,
  ArrowLeft,
  CheckCircle2,
  XCircle,
  ExternalLink,
  KeyRound,
  Filter,
  AlertTriangle,
  Loader2,
} from "lucide-react";
import type { DiscussionReport } from "@/lib/discussions/types";
import { formatTimeMY } from "@/lib/avsec/datetime";
import { reviewReportAction } from "@/lib/discussions/actions";
import { IdentityResolutionModal } from "./IdentityResolutionModal";

interface ModerationDashboardProps {
  initialReports: DiscussionReport[];
}

export function ModerationDashboard({ initialReports }: ModerationDashboardProps) {
  const [reports, setReports] = useState(initialReports);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [busyReportId, setBusyReportId] = useState<string | null>(null);

  // Identity resolution modal state
  const [identityTarget, setIdentityTarget] = useState<{
    contentType: "thread" | "reply";
    contentId: string;
    authorAlias: string;
  } | null>(null);

  const filteredReports = reports.filter((r) => {
    if (statusFilter !== "all" && r.status !== statusFilter) return false;
    return true;
  });

  const handleReviewReport = async (reportId: string, status: "reviewed" | "dismissed") => {
    const reason = window.prompt(
      `Please provide an audit justification to mark this report as ${status}:`,
      status === "reviewed" ? "Reviewed violation and applied policy" : "Dismissed as non-actionable"
    );
    if (!reason || !reason.trim()) return;

    setBusyReportId(reportId);
    try {
      const res = await reviewReportAction(reportId, status, reason);
      if (res.ok) {
        setReports((prev) =>
          prev.map((r) => (r.id === reportId ? { ...r, status } : r))
        );
      }
    } finally {
      setBusyReportId(null);
    }
  };

  return (
    <div className="max-w-5xl mx-auto py-6 px-4 space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Link
              href="/avsec/discussions"
              className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <ArrowLeft className="h-4 w-4" />
              <span>Back to Discussions</span>
            </Link>
          </div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-foreground flex items-center gap-2">
            <ShieldAlert className="h-6 w-6 text-primary" />
            <span>Discussion Moderation & Safety</span>
          </h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Audit reported content, manage enforcement actions, and handle privileged governance resolutions.
          </p>
        </div>

        {/* Filter Pills */}
        <div className="flex items-center gap-1.5 self-start sm:self-center">
          <Filter className="h-3.5 w-3.5 text-muted-foreground mr-1" />
          {(["all", "open", "reviewed", "dismissed"] as const).map((status) => (
            <button
              key={status}
              type="button"
              onClick={() => setStatusFilter(status)}
              className={`px-2.5 py-1 rounded-md text-xs font-medium capitalize transition-colors ${
                statusFilter === status
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:text-foreground"
              }`}
            >
              {status}
            </button>
          ))}
        </div>
      </div>

      {/* Reports Table / List */}
      {filteredReports.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-12 text-center space-y-2">
          <CheckCircle2 className="h-8 w-8 text-emerald-400 mx-auto" />
          <h3 className="text-sm font-semibold text-foreground">No reports match the current filter</h3>
          <p className="text-xs text-muted-foreground">
            All reported items have been handled or no reports exist.
          </p>
        </div>
      ) : (
        <div className="rounded-xl border border-border bg-card overflow-hidden shadow-sm">
          <div className="divide-y divide-border/60">
            {filteredReports.map((report) => {
              const isOpen = report.status === "open";
              const isReviewed = report.status === "reviewed";

              return (
                <div key={report.id} className="p-4 sm:p-5 flex flex-col md:flex-row md:items-center justify-between gap-4 hover:bg-muted/30 transition-colors">
                  <div className="space-y-1.5 flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-[10.5px] font-semibold uppercase tracking-wider bg-muted text-foreground border border-border">
                        {report.content_type}
                      </span>
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-destructive/15 text-destructive border border-destructive/25 capitalize">
                        <AlertTriangle className="h-3 w-3" />
                        <span>{report.reason.replace("_", " ")}</span>
                      </span>
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded text-[10.5px] font-medium capitalize ${
                          isOpen
                            ? "bg-amber-500/15 text-amber-400 border border-amber-500/30"
                            : isReviewed
                            ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/30"
                            : "bg-muted text-muted-foreground border border-border"
                        }`}
                      >
                        {report.status}
                      </span>
                      <span className="text-[11px] text-muted-foreground">
                        Reported {formatTimeMY(report.created_at)}
                      </span>
                    </div>

                    {report.details ? (
                      <p className="text-xs text-foreground bg-muted/40 p-2.5 rounded-lg border border-border/50 italic">
                        &quot;{report.details}&quot;
                      </p>
                    ) : (
                      <p className="text-xs text-muted-foreground italic">
                        No additional notes provided by reporter.
                      </p>
                    )}

                    <div className="flex items-center gap-3 pt-1 text-xs">
                      <Link
                        href={`/avsec/discussions/${report.thread_id}`}
                        className="inline-flex items-center gap-1 text-primary hover:underline font-medium text-[11.5px]"
                        target="_blank"
                      >
                        <span>Inspect in Context</span>
                        <ExternalLink className="h-3 w-3" />
                      </Link>
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-2 flex-shrink-0 self-end md:self-center">
                    {isOpen && (
                      <>
                        <button
                          type="button"
                          onClick={() => handleReviewReport(report.id, "reviewed")}
                          disabled={busyReportId === report.id}
                          className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white transition-colors"
                        >
                          {busyReportId === report.id ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <CheckCircle2 className="h-3.5 w-3.5" />
                          )}
                          <span>Mark Reviewed</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => handleReviewReport(report.id, "dismissed")}
                          disabled={busyReportId === report.id}
                          className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-lg border border-border hover:bg-muted text-foreground transition-colors"
                        >
                          <XCircle className="h-3.5 w-3.5 text-muted-foreground" />
                          <span>Dismiss</span>
                        </button>
                      </>
                    )}

                    <button
                      type="button"
                      onClick={() =>
                        setIdentityTarget({
                          contentType: report.content_type,
                          contentId: report.content_id,
                          authorAlias: "Content Author",
                        })
                      }
                      className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-lg border border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/20 transition-colors"
                      title="Audited Identity Resolution"
                    >
                      <KeyRound className="h-3.5 w-3.5" />
                      <span>Investigate Author</span>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Identity Resolution Modal */}
      {identityTarget && (
        <IdentityResolutionModal
          isOpen={Boolean(identityTarget)}
          contentType={identityTarget.contentType}
          contentId={identityTarget.contentId}
          authorAlias={identityTarget.authorAlias}
          onClose={() => setIdentityTarget(null)}
        />
      )}
    </div>
  );
}
