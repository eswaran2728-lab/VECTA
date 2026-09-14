import Link from "next/link";
import { requireRole, MANAGEMENT_ROLES } from "@/lib/avsec/auth";
import { STATIONS } from "@/lib/avsec/reference-data";
import { getAbsenceNotices, getAbsenceSummaryStats } from "@/lib/avsec/duty/absence-queries";
import {
  formatAbsenceGap,
  LEAVE_TYPES,
  LEAVE_TYPE_LABELS,
  LEAVE_TYPE_ICONS,
  type LeaveType,
  type LeaveApprovalStatus,
} from "@/lib/avsec/duty/absence-logic";
import { formatDateTimeMY, formatDateMY, todayISODateMY } from "@/lib/avsec/datetime";
import { LeaveReviewControls } from "@/components/avsec/duty/LeaveReviewControls";

function daysAgo(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export default async function AdminLeaveAuditPage({
  searchParams: searchParamsPromise,
}: {
  searchParams: Promise<{
    dateFrom?: string;
    dateTo?: string;
    station?: string;
    team?: string;
    opsGroup?: string;
    leaveType?: string;
    approvalStatus?: string;
    status?: string;
  }>;
}) {
  await requireRole(MANAGEMENT_ROLES);

  const searchParams = await searchParamsPromise;
  const today = todayISODateMY();
  const dateFrom = searchParams.dateFrom || daysAgo(today, 30);
  const dateTo = searchParams.dateTo || today;
  const station = searchParams.station || "";
  const team = searchParams.team || "";
  const opsGroup = searchParams.opsGroup || "";
  const leaveTypeFilter = (searchParams.leaveType as LeaveType | "all") || "all";
  const approvalStatusFilter = (searchParams.approvalStatus as LeaveApprovalStatus | "all") || "all";
  const statusFilter = (searchParams.status as "green" | "red" | "all") || "all";

  const [notices, stats] = await Promise.all([
    getAbsenceNotices({
      station: station || undefined,
      team: team || undefined,
      opsGroup: opsGroup || undefined,
      leaveType: leaveTypeFilter,
      approvalStatus: approvalStatusFilter,
      status: statusFilter,
      dateFrom,
      dateTo,
    }),
    getAbsenceSummaryStats({
      station: station || undefined,
      team: team || undefined,
      opsGroup: opsGroup || undefined,
      leaveType: leaveTypeFilter,
      approvalStatus: approvalStatusFilter,
      dateFrom,
      dateTo,
    }),
  ]);

  const baseQs = new URLSearchParams();
  if (dateFrom) baseQs.set("dateFrom", dateFrom);
  if (dateTo) baseQs.set("dateTo", dateTo);
  if (station) baseQs.set("station", station);
  if (team) baseQs.set("team", team);
  if (opsGroup) baseQs.set("opsGroup", opsGroup);
  if (leaveTypeFilter !== "all") baseQs.set("leaveType", leaveTypeFilter);
  if (approvalStatusFilter !== "all") baseQs.set("approvalStatus", approvalStatusFilter);

  return (
    <main className="min-h-screen bg-background pb-28">
      <div className="mx-auto max-w-6xl space-y-6 px-4 py-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <div>
            <div className="flex items-center gap-2">
              <span className="font-display text-lg font-extrabold tracking-[0.06em] text-foreground">
                LEAVE & ABSENCE AUDIT DASHBOARD
              </span>
              <span className="vecta-chip">Management Org-Wide</span>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              Comprehensive log of staff leave applications, DSE approvals, and same-day notice timing.
            </p>
          </div>
          <div className="flex gap-2">
            <Link href="/avsec/admin/attendance-report" className="btn-secondary text-xs">
              ← Attendance Report
            </Link>
          </div>
        </div>

        {/* KPI Aggregate Metric Cards */}
        <div className="grid grid-cols-2 sm:grid-cols-6 gap-3">
          <div className="vecta-tile !p-3 space-y-1 border-l-4 border-l-primary">
            <span className="vecta-eyebrow text-primary">TOTAL LEAVE</span>
            <div className="font-display text-xl font-bold text-foreground">{stats.totalCount}</div>
            <span className="font-mono text-[9px] text-muted-foreground">In period</span>
          </div>

          <div className="vecta-tile !p-3 space-y-1 border-l-4 border-l-warning">
            <span className="vecta-eyebrow text-warning">PENDING DSE</span>
            <div className="font-display text-xl font-bold text-warning">{stats.pendingApprovalCount}</div>
            <span className="font-mono text-[9px] text-muted-foreground">Awaiting review</span>
          </div>

          <div className="vecta-tile !p-3 space-y-1 border-l-4 border-l-success">
            <span className="vecta-eyebrow text-success">APPROVED</span>
            <div className="font-display text-xl font-bold text-success">{stats.approvedCount}</div>
            <span className="font-mono text-[9px] text-muted-foreground">By supervisors</span>
          </div>

          <div className="vecta-tile !p-3 space-y-1 border-l-4 border-l-brand">
            <span className="vecta-eyebrow text-brand">REJECTED</span>
            <div className="font-display text-xl font-bold text-brand">{stats.rejectedCount}</div>
            <span className="font-mono text-[9px] text-muted-foreground">Applications</span>
          </div>

          <div className="vecta-tile !p-3 space-y-1 border-l-4 border-l-emerald-500">
            <span className="vecta-eyebrow text-emerald-500">COMPLIANT (≥3H)</span>
            <div className="font-display text-xl font-bold text-emerald-500">{stats.greenCount}</div>
            <span className="font-mono text-[9px] text-muted-foreground">Same-day notice</span>
          </div>

          <div className="vecta-tile !p-3 space-y-1 border-l-4 border-l-rose-500">
            <span className="vecta-eyebrow text-rose-500">LATE NOTICE (&lt;3H)</span>
            <div className="font-display text-xl font-bold text-rose-500">{stats.redCount}</div>
            <span className="font-mono text-[9px] text-muted-foreground">Short notice / late</span>
          </div>
        </div>

        {/* Filter Controls */}
        <form method="get" className="vecta-panel space-y-3 !py-4">
          <div className="grid grid-cols-1 sm:grid-cols-6 gap-2.5">
            <div>
              <label className="vecta-label">From Date</label>
              <input type="date" name="dateFrom" defaultValue={dateFrom} className="vecta-input" />
            </div>
            <div>
              <label className="vecta-label">To Date</label>
              <input type="date" name="dateTo" defaultValue={dateTo} className="vecta-input" />
            </div>
            <div>
              <label className="vecta-label">Leave Type</label>
              <select name="leaveType" defaultValue={leaveTypeFilter} className="vecta-input">
                <option value="all">All Types</option>
                {LEAVE_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {LEAVE_TYPE_ICONS[t]} {LEAVE_TYPE_LABELS[t]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="vecta-label">Approval Status</label>
              <select name="approvalStatus" defaultValue={approvalStatusFilter} className="vecta-input">
                <option value="all">All Statuses</option>
                <option value="pending">Pending Application</option>
                <option value="approved">Approved</option>
                <option value="rejected">Rejected</option>
                <option value="pending_cancellation">Cancellation Requested</option>
                <option value="cancelled">Cancelled</option>
              </select>
            </div>
            <div>
              <label className="vecta-label">Station</label>
              <select name="station" defaultValue={station} className="vecta-input">
                <option value="">All Stations</option>
                {STATIONS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex items-end gap-2">
              <button type="submit" className="vecta-btn-primary flex-1 py-2 text-xs">
                Filter
              </button>
              <Link href="/avsec/admin/absences" className="btn-secondary py-2 text-xs">
                Reset
              </Link>
            </div>
          </div>
        </form>

        {/* Status Filter Tabs */}
        <div className="flex gap-2 flex-wrap">
          {(
            [
              { value: "all", label: "All Notices", count: stats.totalCount },
              { value: "green", label: "🟢 Compliant (≥3h)", count: stats.greenCount },
              { value: "red", label: "🔴 Late Notice (<3h / After Shift)", count: stats.redCount },
            ] as const
          ).map((t) => {
            const active = statusFilter === t.value;
            const qs = new URLSearchParams(baseQs);
            if (t.value !== "all") qs.set("status", t.value);
            else qs.delete("status");
            return (
              <Link
                key={t.value}
                href={`/avsec/admin/absences?${qs.toString()}`}
                className={`rounded-full px-3.5 py-1.5 font-mono text-xs font-semibold transition-colors ${
                  active
                    ? "bg-primary text-primary-foreground font-bold shadow-sm"
                    : "border border-border bg-card text-muted-foreground hover:text-foreground"
                }`}
              >
                {t.label} ({t.count})
              </Link>
            );
          })}
        </div>

        {/* Staff Performance Evaluation Aggregates */}
        {stats.staffStats.length > 0 && (
          <div className="vecta-panel space-y-3 !p-4">
            <div className="flex items-center justify-between">
              <span className="font-display text-sm font-bold text-foreground tracking-wide uppercase">
                Staff Performance Review Summary
              </span>
              <span className="font-mono text-[10px] text-muted-foreground">
                Sorted by highest late notice count
              </span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left font-mono text-xs">
                <thead>
                  <tr className="border-b border-border text-[10px] uppercase text-muted-foreground">
                    <th className="pb-2">Officer</th>
                    <th className="pb-2">Staff ID</th>
                    <th className="pb-2">Role</th>
                    <th className="pb-2">Station / Team</th>
                    <th className="pb-2 text-center">Total Applications</th>
                    <th className="pb-2 text-center text-success">Compliant (≥3h)</th>
                    <th className="pb-2 text-center text-brand">Late Notices</th>
                    <th className="pb-2 text-center text-warning">Pending</th>
                    <th className="pb-2 text-right">Late %</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/40">
                  {stats.staffStats.map((s) => {
                    const totalTimed = s.redCount + s.greenCount;
                    const latePct = totalTimed > 0 ? Math.round((s.redCount / totalTimed) * 100) : 0;
                    return (
                      <tr key={s.userId} className="hover:bg-muted/30">
                        <td className="py-2.5 font-sans font-semibold text-foreground">{s.staffName}</td>
                        <td className="py-2.5 text-muted-foreground">{s.staffId ?? "—"}</td>
                        <td className="py-2.5">
                          <span className="vecta-chip">{s.role}</span>
                        </td>
                        <td className="py-2.5 text-muted-foreground">
                          {s.station ?? "—"} {s.team ? `· ${s.team}` : ""}
                        </td>
                        <td className="py-2.5 text-center font-bold text-foreground">{s.totalAbsences}</td>
                        <td className="py-2.5 text-center font-bold text-success">{s.greenCount}</td>
                        <td className="py-2.5 text-center font-bold text-brand">{s.redCount}</td>
                        <td className="py-2.5 text-center font-bold text-warning">{s.pendingCount}</td>
                        <td className="py-2.5 text-right font-bold">
                          <span className={latePct > 0 ? "text-brand" : "text-success"}>{latePct}%</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Detailed Chronological Leave & Absence Log */}
        <div className="vecta-panel space-y-3 !p-4">
          <div className="flex items-center justify-between">
            <span className="font-display text-sm font-bold text-foreground tracking-wide uppercase">
              Chronological Leave Applications ({notices.length})
            </span>
          </div>

          {notices.length === 0 ? (
            <p className="py-8 text-center text-xs text-muted-foreground">
              No leave applications recorded matching the selected criteria.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left font-mono text-xs">
                <thead>
                  <tr className="border-b border-border text-[10px] uppercase text-muted-foreground">
                    <th className="pb-2">Date Range</th>
                    <th className="pb-2">Officer</th>
                    <th className="pb-2">Leave Type</th>
                    <th className="pb-2">Approval Status</th>
                    <th className="pb-2">Notice Timing</th>
                    <th className="pb-2">Submitted</th>
                    <th className="pb-2">Remarks & Review</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/40">
                  {notices.map((n) => {
                    const isApproved = n.approval_status === "approved";
                    const isRejected = n.approval_status === "rejected";
                    const isPending = n.approval_status === "pending";
                    const isPendingCancel = n.approval_status === "pending_cancellation";
                    const isCancelled = n.approval_status === "cancelled";
                    const typeLabel = LEAVE_TYPE_LABELS[n.leave_type] || n.leave_type;
                    const typeIcon = LEAVE_TYPE_ICONS[n.leave_type] || "🌴";

                    // Concurrency calculation for Annual Leave
                    const isAnnual = n.leave_type === "annual";
                    const overlappingApprovedCount = isAnnual
                      ? new Set(
                          notices
                            .filter(
                              (r) =>
                                r.leave_type === "annual" &&
                                r.approval_status === "approved" &&
                                r.team === n.team &&
                                r.station === n.station &&
                                r.user_id !== n.user_id &&
                                r.start_date <= n.end_date &&
                                r.end_date >= n.start_date
                            )
                            .map((r) => r.user_id)
                        ).size
                      : 0;
                    const isEscalated = isAnnual && isPending && overlappingApprovedCount >= 3;

                    return (
                      <tr
                        key={n.id}
                        className={`hover:bg-muted/30 ${
                          isPendingCancel
                            ? "bg-amber-500/[0.04]"
                            : isEscalated
                              ? "bg-purple-500/[0.04]"
                              : isCancelled
                                ? "opacity-75"
                                : ""
                        }`}
                      >
                        <td className="py-3">
                          <div className="font-sans font-semibold text-foreground">
                            {n.start_date === n.end_date
                              ? formatDateMY(n.start_date)
                              : `${formatDateMY(n.start_date)} → ${formatDateMY(n.end_date)}`}
                          </div>
                          <div className="text-[10px] text-muted-foreground">{n.shift_code ?? "DUTY"}</div>
                        </td>
                        <td className="py-3">
                          <div className="font-sans font-semibold text-foreground">{n.staff_name}</div>
                          <div className="text-[10px] text-muted-foreground">
                            {n.role} · {n.station ?? ""} {n.team ? `(${n.team})` : ""}
                          </div>
                        </td>
                        <td className="py-3">
                          <span className="font-mono text-xs font-semibold px-2 py-0.5 rounded bg-secondary text-foreground">
                            {typeIcon} {typeLabel}
                          </span>
                        </td>
                        <td className="py-3">
                          {isPendingCancel ? (
                            <span className="font-mono text-[10px] px-2 py-0.5 rounded-full font-bold uppercase bg-amber-500/20 text-amber-400 border border-amber-500/30 whitespace-nowrap">
                              ⚡ Cancel Requested
                            </span>
                          ) : isEscalated ? (
                            <span className="font-mono text-[10px] px-2 py-0.5 rounded-full font-bold uppercase bg-purple-500/20 text-purple-400 border border-purple-500/30 whitespace-nowrap">
                              ⚡ Escalated — Team Cap Exceeded ({overlappingApprovedCount}/3)
                            </span>
                          ) : (
                            <span
                              className={`font-mono text-[10px] px-2 py-0.5 rounded-full font-bold uppercase ${
                                isApproved
                                  ? "bg-success/20 text-success border border-success/30"
                                  : isRejected
                                    ? "bg-brand/20 text-brand border border-brand/30"
                                    : isCancelled
                                      ? "bg-muted text-muted-foreground border border-border"
                                      : "bg-warning/20 text-warning border border-warning/30"
                              }`}
                            >
                              {isApproved
                                ? "✓ Approved"
                                : isRejected
                                  ? "✕ Rejected"
                                  : isCancelled
                                    ? "✕ Cancelled"
                                    : "⏳ Pending"}
                            </span>
                          )}
                        </td>
                        <td className="py-3">
                          {n.gap_minutes !== null && n.status ? (
                            <span
                              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold ${
                                n.status === "green"
                                  ? "bg-success/20 text-success border border-success/40"
                                  : "bg-brand/20 text-brand border border-brand/40"
                              }`}
                            >
                              {n.status === "green" ? "🟢" : "🔴"} {formatAbsenceGap(n.gap_minutes)}
                            </span>
                          ) : (
                            <span className="text-muted-foreground text-[10px]">Advance Notice</span>
                          )}
                        </td>
                        <td className="py-3 text-muted-foreground">{formatDateTimeMY(n.submitted_at)}</td>
                        <td className="py-3 font-sans text-xs text-foreground max-w-xs break-words space-y-1">
                          <div>&ldquo;{n.remarks}&rdquo;</div>
                          {n.cancellation_reason && (
                            <div className="text-[11px] font-mono text-amber-300">
                              <strong>Cancel Reason:</strong> {n.cancellation_reason}
                            </div>
                          )}
                          {n.review_notes && (
                            <div className="text-[11px] font-mono text-muted-foreground">
                              <strong>Review:</strong> {n.review_notes}
                            </div>
                          )}
                          {isPending && (
                            <div className="pt-1">
                              <LeaveReviewControls
                                noticeId={n.id}
                                staffName={n.staff_name}
                                leaveTypeLabel={typeLabel}
                                mode="application"
                              />
                            </div>
                          )}
                          {isPendingCancel && (
                            <div className="pt-1">
                              <LeaveReviewControls
                                noticeId={n.id}
                                staffName={n.staff_name}
                                leaveTypeLabel={typeLabel}
                                mode="cancellation"
                              />
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
