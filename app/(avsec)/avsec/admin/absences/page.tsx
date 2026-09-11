import Link from "next/link";
import { requireRole, MANAGEMENT_ROLES } from "@/lib/avsec/auth";
import { STATIONS, OPS_GROUPS } from "@/lib/avsec/reference-data";
import { getAbsenceNotices, getAbsenceSummaryStats } from "@/lib/avsec/duty/absence-queries";
import { formatAbsenceGap } from "@/lib/avsec/duty/absence-logic";
import { formatDateTimeMY, formatDateMY, todayISODateMY } from "@/lib/avsec/datetime";

function daysAgo(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export default async function AdminAbsencesPage({
  searchParams: searchParamsPromise,
}: {
  searchParams: Promise<{
    dateFrom?: string;
    dateTo?: string;
    station?: string;
    team?: string;
    opsGroup?: string;
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
  const statusFilter = (searchParams.status as "green" | "red" | "all") || "all";

  const [notices, stats] = await Promise.all([
    getAbsenceNotices({
      station: station || undefined,
      team: team || undefined,
      opsGroup: opsGroup || undefined,
      status: statusFilter,
      dateFrom,
      dateTo,
    }),
    getAbsenceSummaryStats({
      station: station || undefined,
      team: team || undefined,
      opsGroup: opsGroup || undefined,
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

  return (
    <main className="min-h-screen bg-background pb-28">
      <div className="mx-auto max-w-5xl space-y-6 px-4 py-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <div>
            <div className="flex items-center gap-2">
              <span className="font-display text-lg font-extrabold tracking-[0.06em] text-foreground">
                ABSENCE LATE-NOTICE AUDIT LOG
              </span>
              <span className="vecta-chip">Management Log</span>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              System-captured advance notice timestamps for staff performance evaluations.
            </p>
          </div>
          <div className="flex gap-2">
            <Link href="/avsec/admin/attendance-report" className="btn-secondary text-xs">
              ← Attendance Report
            </Link>
          </div>
        </div>

        {/* KPI Aggregate Metric Cards */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="vecta-tile !p-3.5 space-y-1 border-l-4 border-l-primary">
            <span className="vecta-eyebrow text-primary">TOTAL ABSENCES</span>
            <div className="font-display text-2xl font-bold text-foreground">{stats.totalCount}</div>
            <span className="font-mono text-[10px] text-muted-foreground">Recorded in period</span>
          </div>

          <div className="vecta-tile !p-3.5 space-y-1 border-l-4 border-l-success">
            <span className="vecta-eyebrow text-success">COMPLIANT (≥2H)</span>
            <div className="font-display text-2xl font-bold text-success">{stats.greenCount}</div>
            <span className="font-mono text-[10px] text-muted-foreground">Timely notice given</span>
          </div>

          <div className="vecta-tile !p-3.5 space-y-1 border-l-4 border-l-brand">
            <span className="vecta-eyebrow text-brand">LATE NOTICE (&lt;2H)</span>
            <div className="font-display text-2xl font-bold text-brand">{stats.redCount}</div>
            <span className="font-mono text-[10px] text-muted-foreground">Short notice / after shift</span>
          </div>

          <div className="vecta-tile !p-3.5 space-y-1 border-l-4 border-l-warning">
            <span className="vecta-eyebrow text-warning">LATE NOTICE RATE</span>
            <div className="font-display text-2xl font-bold text-foreground">{stats.lateRatePercent}%</div>
            <span className="font-mono text-[10px] text-muted-foreground">Of total absence notices</span>
          </div>
        </div>

        {/* Filter Controls */}
        <form method="get" className="vecta-panel space-y-3 !py-4">
          <div className="grid grid-cols-1 sm:grid-cols-5 gap-3">
            <div>
              <label className="vecta-label">From Date</label>
              <input type="date" name="dateFrom" defaultValue={dateFrom} className="vecta-input" />
            </div>
            <div>
              <label className="vecta-label">To Date</label>
              <input type="date" name="dateTo" defaultValue={dateTo} className="vecta-input" />
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
            <div>
              <label className="vecta-label">Branch / Ops Group</label>
              <select name="opsGroup" defaultValue={opsGroup} className="vecta-input">
                <option value="">All Branches</option>
                {OPS_GROUPS.map((g) => (
                  <option key={g} value={g}>
                    {g === "operation_avsec" ? "Operation AVSEC" : g === "ifc_avsec" ? "IFC AVSEC" : "Hub AVSEC"}
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
        <div className="flex gap-2">
          {(
            [
              { value: "all", label: "All Notices", count: stats.totalCount },
              { value: "green", label: "🟢 Compliant (≥2h)", count: stats.greenCount },
              { value: "red", label: "🔴 Late Notice (<2h / After Shift)", count: stats.redCount },
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
                    <th className="pb-2 text-center">Total Absences</th>
                    <th className="pb-2 text-center text-success">Compliant (≥2h)</th>
                    <th className="pb-2 text-center text-brand">Late Notices</th>
                    <th className="pb-2 text-right">Late %</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/40">
                  {stats.staffStats.map((s) => {
                    const latePct = Math.round((s.redCount / s.totalAbsences) * 100);
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

        {/* Detailed Chronological Absence Log */}
        <div className="vecta-panel space-y-3 !p-4">
          <div className="flex items-center justify-between">
            <span className="font-display text-sm font-bold text-foreground tracking-wide uppercase">
              Chronological Notice Records ({notices.length})
            </span>
          </div>

          {notices.length === 0 ? (
            <p className="py-8 text-center text-xs text-muted-foreground">
              No absence notices recorded matching the selected criteria.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left font-mono text-xs">
                <thead>
                  <tr className="border-b border-border text-[10px] uppercase text-muted-foreground">
                    <th className="pb-2">Date / Shift</th>
                    <th className="pb-2">Officer</th>
                    <th className="pb-2">Notice Timing & Status</th>
                    <th className="pb-2">Informed Timestamp</th>
                    <th className="pb-2">Shift Start</th>
                    <th className="pb-2">Remarks</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/40">
                  {notices.map((n) => (
                    <tr key={n.id} className="hover:bg-muted/30">
                      <td className="py-3">
                        <div className="font-sans font-semibold text-foreground">{formatDateMY(n.duty_date)}</div>
                        <div className="text-[10px] text-muted-foreground">{n.shift_code ?? "DUTY"}</div>
                      </td>
                      <td className="py-3">
                        <div className="font-sans font-semibold text-foreground">{n.staff_name}</div>
                        <div className="text-[10px] text-muted-foreground">
                          {n.role} · {n.station ?? ""} {n.team ? `(${n.team})` : ""}
                        </div>
                      </td>
                      <td className="py-3">
                        <span
                          className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-bold ${
                            n.status === "green"
                              ? "bg-success/20 text-success border border-success/40"
                              : "bg-brand/20 text-brand border border-brand/40"
                          }`}
                        >
                          {n.status === "green" ? "🟢" : "🔴"} {formatAbsenceGap(n.gap_minutes)}
                        </span>
                      </td>
                      <td className="py-3 text-muted-foreground">{formatDateTimeMY(n.submitted_at)}</td>
                      <td className="py-3 text-muted-foreground">{formatDateTimeMY(n.shift_start_time)}</td>
                      <td className="py-3 font-sans text-xs text-foreground max-w-xs break-words">
                        &ldquo;{n.remarks}&rdquo;
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
