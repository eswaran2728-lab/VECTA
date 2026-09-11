import Link from "next/link";
import { requireProfile } from "@/lib/avsec/auth";
import { formatAbsenceGap, LEAVE_TYPE_LABELS, LEAVE_TYPE_ICONS } from "@/lib/avsec/duty/absence-logic";
import { getAbsenceNotices } from "@/lib/avsec/duty/absence-queries";
import { ROLE_LABELS, ORG_WIDE_ROLES } from "@/lib/avsec/reference-data";
import { LeaveReviewControls } from "@/components/avsec/duty/LeaveReviewControls";

export default async function StaffLeavePortalPage() {
  const profile = await requireProfile();
  const isManagement = (ORG_WIDE_ROLES as readonly string[]).includes(profile.role);
  const isDSE = profile.role === "DSE";

  // Fetch staff's own records
  const personalRecords = await getAbsenceNotices({
    userId: profile.id,
    limit: 50,
  });

  // If DSE, also fetch station/team records
  const teamRecords = isDSE
    ? await getAbsenceNotices({
        station: profile.station ?? undefined,
        team: profile.team ?? undefined,
        limit: 100,
      })
    : [];

  const pendingCount = teamRecords.filter((r) => r.approval_status === "pending").length;

  return (
    <main className="min-h-screen bg-background pb-32">
      <div className="max-w-4xl mx-auto px-4 py-6 space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-border pb-4">
          <div>
            <div className="font-mono text-xs font-semibold text-primary uppercase tracking-widest">
              Duty Ops · Leave Management
            </div>
            <h1 className="font-display font-bold text-2xl text-foreground mt-0.5">
              Leave & Absence Portal
            </h1>
            <p className="font-mono text-xs text-muted-foreground mt-1">
              Apply for leave, track DSE approvals, and review same-day notice compliance.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <Link
              href="/avsec/duty"
              className="btn btn-secondary text-xs px-3 py-1.5"
            >
              ← Back to Duty
            </Link>
            {isManagement && (
              <Link
                href="/avsec/admin/absences"
                className="btn btn-primary text-xs px-3 py-1.5"
              >
                Management Audit View →
              </Link>
            )}
          </div>
        </div>

        {/* Policy notice */}
        <div className="card p-4 border-l-4 border-l-primary/60 bg-muted/20 space-y-1.5">
          <div className="font-mono text-xs font-bold text-foreground flex items-center gap-2">
            <span>ℹ️</span> Leave & Compliance Policy
          </div>
          <p className="font-mono text-xs text-muted-foreground leading-relaxed">
            • <strong>Same-Day Leave (Starts Today)</strong>: Must give $\ge 3$ hours notice before shift start for compliant (🟢) timing. Late notice (<strong className="text-rose-500">🔴</strong>) is logged for performance review.<br />
            • <strong>Advance Leave (Future Dates)</strong>: Logged in advance and routed to DSE for approval.<br />
            • <strong>Approval Workflow</strong>: All leave submissions require DSE review (Approved / Rejected / Pending).
          </p>
        </div>

        {/* DSE Pending Approvals Feed */}
        {isDSE && (
          <section className="space-y-3 pt-2">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="font-display font-semibold text-base text-foreground flex items-center gap-2">
                  <span>📥</span> DSE Review Queue ({profile.station || "All"} · Team {profile.team || "All"})
                </h2>
                <p className="font-mono text-xs text-muted-foreground">
                  Pending leave applications submitted by duty staff in your station/team.
                </p>
              </div>
              {pendingCount > 0 ? (
                <span className="font-mono text-xs px-2.5 py-1 rounded-full bg-warning/20 text-warning font-bold border border-warning/30">
                  {pendingCount} Pending Review
                </span>
              ) : (
                <span className="font-mono text-xs text-muted-foreground">
                  Queue Clean (0 Pending)
                </span>
              )}
            </div>

            {teamRecords.length === 0 ? (
              <div className="card p-6 text-center font-mono text-xs text-muted-foreground">
                No recent leave notices in your station/team.
              </div>
            ) : (
              <div className="space-y-3">
                {teamRecords.map((item) => {
                  const isGreen = item.status === "green";
                  const isPending = item.approval_status === "pending";
                  const isApproved = item.approval_status === "approved";
                  const typeLabel = LEAVE_TYPE_LABELS[item.leave_type] || item.leave_type;
                  const typeIcon = LEAVE_TYPE_ICONS[item.leave_type] || "🌴";

                  return (
                    <div
                      key={item.id}
                      className={`card p-4 border-l-4 transition-all ${
                        isPending
                          ? "border-l-warning bg-warning/5"
                          : isApproved
                            ? "border-l-success bg-success/5"
                            : "border-l-brand bg-brand/5"
                      }`}
                    >
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-border/40 pb-2">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-display font-bold text-sm text-foreground">
                            {item.staff_name}
                          </span>
                          <span className="font-mono text-xs text-muted-foreground">
                            {ROLE_LABELS[item.role] || item.role} · {item.staff_id || "—"}
                          </span>
                          <span className="font-mono text-xs px-2 py-0.5 rounded bg-secondary text-foreground font-semibold">
                            {typeIcon} {typeLabel}
                          </span>
                        </div>

                        <div className="flex items-center gap-2">
                          {/* Approval Status Badge */}
                          <span
                            className={`font-mono text-xs px-2.5 py-0.5 rounded font-bold uppercase ${
                              isApproved
                                ? "bg-success/20 text-success border border-success/30"
                                : item.approval_status === "rejected"
                                  ? "bg-brand/20 text-brand border border-brand/30"
                                  : "bg-warning/20 text-warning border border-warning/30"
                            }`}
                          >
                            {item.approval_status === "approved"
                              ? "✓ Approved"
                              : item.approval_status === "rejected"
                                ? "✕ Rejected"
                                : "⏳ Pending DSE"}
                          </span>

                          {/* Compliance Badge if same-day */}
                          {item.status && item.gap_minutes !== null && (
                            <span
                              className={`font-mono text-xs px-2 py-0.5 rounded font-bold ${
                                isGreen
                                  ? "bg-emerald-500/20 text-emerald-400"
                                  : "bg-rose-500/20 text-rose-400"
                              }`}
                            >
                              {formatAbsenceGap(item.gap_minutes)}
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="mt-2 text-xs font-mono text-muted-foreground flex flex-wrap gap-x-4 gap-y-1">
                        <span>
                          <strong>Date Range:</strong> {item.start_date === item.end_date ? item.start_date : `${item.start_date} → ${item.end_date}`}
                        </span>
                        <span>
                          <strong>Submitted:</strong> {new Date(item.submitted_at).toLocaleString("en-MY", { timeZone: "Asia/Kuala_Lumpur", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false })}
                        </span>
                      </div>

                      <div className="mt-2 p-2.5 rounded bg-background/60 border border-border/50 text-xs text-foreground">
                        <div className="font-mono text-[10px] text-muted-foreground uppercase mb-0.5">Remarks:</div>
                        {item.remarks}
                      </div>

                      {item.review_notes && (
                        <div className="mt-2 text-xs font-mono text-muted-foreground">
                          <strong>DSE Note:</strong> {item.review_notes}
                        </div>
                      )}

                      {/* Interactive Review Controls if pending */}
                      {isPending && (
                        <LeaveReviewControls
                          noticeId={item.id}
                          staffName={item.staff_name}
                          leaveTypeLabel={typeLabel}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        )}

        {/* My Records */}
        <section className="space-y-3 pt-4">
          <div className="flex items-center justify-between">
            <h2 className="font-display font-semibold text-base text-foreground flex items-center gap-2">
              <span>👤</span> My Leave Applications ({personalRecords.length})
            </h2>
          </div>

          {personalRecords.length === 0 ? (
            <div className="card p-8 text-center space-y-2">
              <div className="text-3xl">🌴</div>
              <div className="font-display font-semibold text-sm text-foreground">
                No leave applications submitted
              </div>
              <p className="font-mono text-xs text-muted-foreground">
                You have not submitted any leave or absence notices. Use the &quot;Apply Leave&quot; button on your duty page.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {personalRecords.map((item) => {
                const isGreen = item.status === "green";
                const isApproved = item.approval_status === "approved";
                const isRejected = item.approval_status === "rejected";
                const typeLabel = LEAVE_TYPE_LABELS[item.leave_type] || item.leave_type;
                const typeIcon = LEAVE_TYPE_ICONS[item.leave_type] || "🌴";

                return (
                  <div
                    key={item.id}
                    className={`card p-4 border-l-4 transition-all ${
                      isApproved
                        ? "border-l-success bg-success/5"
                        : isRejected
                          ? "border-l-brand bg-brand/5"
                          : "border-l-warning bg-warning/5"
                    }`}
                  >
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-border/40 pb-2.5">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-display font-bold text-sm text-foreground flex items-center gap-1.5">
                          <span>{typeIcon}</span> {typeLabel}
                        </span>

                        <span
                          className={`font-mono text-xs px-2.5 py-0.5 rounded-full font-bold uppercase ${
                            isApproved
                              ? "bg-success/20 text-success border border-success/30"
                              : isRejected
                                ? "bg-brand/20 text-brand border border-brand/30"
                                : "bg-warning/20 text-warning border border-warning/30"
                          }`}
                        >
                          {isApproved
                            ? "✓ Approved by DSE"
                            : isRejected
                              ? "✕ Rejected by DSE"
                              : "⏳ Pending DSE Review"}
                        </span>

                        {item.status && item.gap_minutes !== null && (
                          <span
                            className={`font-mono text-xs px-2 py-0.5 rounded-full font-bold uppercase ${
                              isGreen
                                ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30"
                                : "bg-rose-500/20 text-rose-400 border border-rose-500/30"
                            }`}
                          >
                            {isGreen ? "🟢 Compliant (≥3H)" : "🔴 Late Notice (<3H)"}
                          </span>
                        )}
                      </div>

                      <div className="font-mono text-xs font-semibold text-foreground">
                        {item.start_date === item.end_date
                          ? item.start_date
                          : `${item.start_date} → ${item.end_date}`}
                      </div>
                    </div>

                    <div className="mt-3 space-y-2">
                      <div className="font-mono text-xs text-muted-foreground flex flex-wrap gap-x-4 gap-y-1">
                        <span>
                          <strong className="text-foreground">Submitted:</strong>{" "}
                          {new Date(item.submitted_at).toLocaleString("en-MY", {
                            timeZone: "Asia/Kuala_Lumpur",
                            day: "2-digit",
                            month: "short",
                            year: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                            second: "2-digit",
                            hour12: false,
                          })}
                        </span>
                        {item.gap_minutes !== null && (
                          <span>
                            <strong className="text-foreground">Timing:</strong>{" "}
                            {formatAbsenceGap(item.gap_minutes)}
                          </span>
                        )}
                      </div>

                      <div className="p-2.5 rounded-lg bg-background/60 border border-border/50 text-xs font-sans text-foreground">
                        <div className="font-mono text-[10px] text-muted-foreground uppercase mb-1">
                          Remarks / Reason:
                        </div>
                        {item.remarks}
                      </div>

                      {item.review_notes && (
                        <div className="p-2 rounded bg-muted/40 font-mono text-xs text-muted-foreground border border-border/40">
                          <strong className="text-foreground">DSE Feedback:</strong> {item.review_notes}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
