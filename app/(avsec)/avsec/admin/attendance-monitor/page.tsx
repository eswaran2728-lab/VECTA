import Link from "next/link";
import { requireRole } from "@/lib/avsec/auth";
import { STATIONS, ORG_WIDE_ROLES, ROLE_LABELS } from "@/lib/avsec/reference-data";
import {
  getMergedAttendanceData,
  type PeriodType,
} from "@/lib/avsec/duty/merged-attendance-queries";
import { UnifiedHeader } from "@/components/layout/UnifiedHeader";
import { signOut } from "@/lib/avsec/profile-actions";
import { formatDateMY, formatTimeMY, todayISODateMY } from "@/lib/avsec/datetime";
import {
  Users,
  Calendar,
  Clock,
  Zap,
  Coffee,
  AlertCircle,
  Download,
  Search,
  Filter,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";

export default async function AttendanceMonitorPage({
  searchParams: searchParamsPromise,
}: {
  searchParams: Promise<{
    periodType?: string;
    date?: string;
    month?: string;
    year?: string;
    station?: string;
    team?: string;
    search?: string;
    page?: string;
  }>;
}) {
  const searchParams = await searchParamsPromise;
  const profile = await requireRole([...ORG_WIDE_ROLES]);

  const today = todayISODateMY();
  const periodType: PeriodType = (
    ["day", "month", "year"] as const
  ).includes(searchParams.periodType as PeriodType)
    ? (searchParams.periodType as PeriodType)
    : "day";

  const date = searchParams.date || today;
  const month = searchParams.month || today.slice(0, 7);
  const year = searchParams.year || today.slice(0, 4);
  const station = searchParams.station || "";
  const team = searchParams.team || "";
  const search = searchParams.search || "";
  const page = Math.max(1, parseInt(searchParams.page || "1", 10) || 1);

  const data = await getMergedAttendanceData({
    periodType,
    date,
    month,
    year,
    station: station || undefined,
    team: team || undefined,
    search: search || undefined,
    page,
    pageSize: periodType === "year" ? 25 : 50,
  });

  // Build Export Query String for on-demand OT export
  const exportQs = new URLSearchParams();
  exportQs.set("periodType", periodType);
  if (periodType === "day") exportQs.set("date", data.selectedDate);
  if (periodType === "month") exportQs.set("month", data.selectedMonth);
  if (periodType === "year") exportQs.set("year", data.selectedYear);
  if (station) exportQs.set("station", station);
  if (team) exportQs.set("team", team);
  if (search) exportQs.set("q", search);

  const otExportUrl = `/api/avsec/export/overtime?${exportQs.toString()}`;

  return (
    <main className="min-h-screen bg-background pb-28">
      <UnifiedHeader
        name={profile.name}
        roleLabel={ROLE_LABELS[profile.role]}
        signOutAction={signOut}
        homeHref="/avsec/dashboard"
      />

      <div className="mx-auto max-w-7xl px-4 py-6 space-y-6">
        {/* Page Title & Navigation */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="font-display text-xl font-bold tracking-[0.03em] text-foreground">
                Attendance & Overtime Monitor
              </span>
              <span className="rounded-full bg-primary/10 border border-primary/20 px-2.5 py-0.5 font-mono text-[10px] font-bold text-primary">
                MANAGEMENT
              </span>
            </div>
            <p className="font-mono text-xs text-muted-foreground mt-0.5">
              Unified cross-reference of Scheduled Rosters, Actual Check-In/Out, Approved Leaves, and Auto-Calculated Overtime.
            </p>
          </div>

          <div className="flex items-center gap-2.5">
            <Link
              href={otExportUrl}
              className="vecta-btn-primary flex items-center gap-2 text-xs font-mono font-bold cursor-pointer"
              title="Download OT records only for this selected period"
            >
              <Download className="h-4 w-4" />
              <span>Export OT (XLSX)</span>
            </Link>
            <Link
              href="/avsec/duty/overtime"
              className="btn-secondary text-xs font-mono"
            >
              OT Approval Queue →
            </Link>
          </div>
        </div>

        {/* Filter Controls Card */}
        <div className="vecta-panel space-y-4 p-5">
          {/* Period Type Selection Tabs */}
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider font-mono">
                View Period:
              </span>
              <div className="flex gap-1">
                {(["day", "month", "year"] as const).map((p) => {
                  const active = periodType === p;
                  const qs = new URLSearchParams({
                    periodType: p,
                    date,
                    month,
                    year,
                    station,
                    team,
                    search,
                  });
                  return (
                    <Link
                      key={p}
                      href={`/avsec/admin/attendance-monitor?${qs.toString()}`}
                      className={`px-3 py-1 rounded-lg font-mono text-xs font-bold uppercase transition-colors ${
                        active
                          ? "bg-primary text-primary-foreground shadow-sm"
                          : "bg-muted text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {p}
                    </Link>
                  );
                })}
              </div>
            </div>

            <span className="font-mono text-xs text-muted-foreground">
              Period: <strong className="text-foreground">{data.dateFrom}</strong> {data.dateFrom !== data.dateTo ? `→ ` + data.dateTo : ""}
            </span>
          </div>

          <form method="get" className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3 items-end">
            <input type="hidden" name="periodType" value={periodType} />

            {/* Dynamic Period Input */}
            {periodType === "day" && (
              <div>
                <label className="vecta-label">Select Date</label>
                <input
                  type="date"
                  name="date"
                  defaultValue={data.selectedDate}
                  className="vecta-input"
                />
              </div>
            )}

            {periodType === "month" && (
              <div>
                <label className="vecta-label">Select Month</label>
                <input
                  type="month"
                  name="month"
                  defaultValue={data.selectedMonth}
                  className="vecta-input"
                />
              </div>
            )}

            {periodType === "year" && (
              <div>
                <label className="vecta-label">Select Year</label>
                <input
                  type="number"
                  name="year"
                  min="2020"
                  max="2035"
                  defaultValue={data.selectedYear}
                  className="vecta-input"
                />
              </div>
            )}

            {/* Station Filter */}
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

            {/* Team Filter */}
            <div>
              <label className="vecta-label">Team</label>
              <input
                type="text"
                name="team"
                defaultValue={team}
                placeholder="e.g. A, B, Charlie"
                className="vecta-input"
              />
            </div>

            {/* Search Filter */}
            <div className="lg:col-span-2">
              <label className="vecta-label">Officer Search</label>
              <div className="relative">
                <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                <input
                  type="text"
                  name="search"
                  defaultValue={search}
                  placeholder="Officer Name or Staff ID…"
                  className="vecta-input pl-9"
                />
              </div>
            </div>

            <div className="flex gap-2">
              <button
                type="submit"
                className="btn-secondary flex-1 flex items-center justify-center gap-1.5"
              >
                <Filter className="h-3.5 w-3.5" />
                <span>Filter</span>
              </button>
            </div>
          </form>
        </div>

        {/* KPI Metrics Summary Grid */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <div className="card p-4 space-y-1">
            <div className="flex items-center justify-between text-muted-foreground">
              <span className="font-mono text-[10.5px] uppercase">Staff Members</span>
              <Users className="h-4 w-4 text-primary" />
            </div>
            <p className="font-display text-2xl font-extrabold text-foreground">
              {data.totals.totalStaff}
            </p>
          </div>

          <div className="card p-4 space-y-1">
            <div className="flex items-center justify-between text-muted-foreground">
              <span className="font-mono text-[10.5px] uppercase">Shifts Worked</span>
              <Calendar className="h-4 w-4 text-blue-500" />
            </div>
            <p className="font-display text-2xl font-extrabold text-foreground">
              {data.totals.totalShiftsWorked}
            </p>
          </div>

          <div className="card p-4 space-y-1">
            <div className="flex items-center justify-between text-muted-foreground">
              <span className="font-mono text-[10.5px] uppercase">Hours Worked</span>
              <Clock className="h-4 w-4 text-indigo-500" />
            </div>
            <p className="font-display text-2xl font-extrabold text-foreground">
              {data.totals.totalHoursWorked}h
            </p>
          </div>

          <div className="card p-4 space-y-1">
            <div className="flex items-center justify-between text-muted-foreground">
              <span className="font-mono text-[10.5px] uppercase">Approved OT</span>
              <Zap className="h-4 w-4 text-amber-500" />
            </div>
            <p className="font-display text-2xl font-extrabold text-success">
              {data.totals.totalApprovedOtHours}h
            </p>
          </div>

          <div className="card p-4 space-y-1">
            <div className="flex items-center justify-between text-muted-foreground">
              <span className="font-mono text-[10.5px] uppercase">Leave Days</span>
              <Coffee className="h-4 w-4 text-emerald-500" />
            </div>
            <p className="font-display text-2xl font-extrabold text-foreground">
              {data.totals.totalLeaveDaysTaken}
            </p>
          </div>

          <div className="card p-4 space-y-1">
            <div className="flex items-center justify-between text-muted-foreground">
              <span className="font-mono text-[10.5px] uppercase">Pending OT</span>
              <AlertCircle className="h-4 w-4 text-amber-500" />
            </div>
            <p className="font-display text-2xl font-extrabold text-amber-500">
              {data.totals.totalPendingOtCount}
            </p>
          </div>
        </div>

        {/* Staff Merged Records List */}
        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-base font-bold tracking-wide text-foreground">
              Staff Attendance & Overtime Records ({data.summaries.length})
            </h2>
            <span className="font-mono text-xs text-muted-foreground">
              Showing {periodType.toUpperCase()} view ({data.dateList.length} {data.dateList.length === 1 ? "day" : "days"})
            </span>
          </div>

          {data.summaries.length === 0 ? (
            <div className="vecta-panel text-center py-12 text-muted-foreground">
              <p className="text-sm">No staff records found matching your filters.</p>
            </div>
          ) : (
            <div className="space-y-4">
              {data.summaries.map((staff) => (
                <div
                  key={staff.profileId}
                  className="vecta-panel !p-5 space-y-4 transition-all"
                >
                  {/* Staff Header Row */}
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-border pb-3">
                    <div>
                      <div className="flex items-center gap-2.5">
                        <span className="font-semibold text-base text-foreground">
                          {staff.staffName}
                        </span>
                        <span className="font-mono text-xs text-muted-foreground">
                          ({staff.staffNo})
                        </span>
                        <span className="rounded bg-muted px-2 py-0.5 font-mono text-[10px] font-semibold text-muted-foreground">
                          {staff.role}
                        </span>
                      </div>
                      <p className="font-mono text-xs text-muted-foreground mt-0.5">
                        {staff.station} {staff.team ? `· Team ${staff.team}` : ""}
                      </p>
                    </div>

                    {/* Quick Stats Badges */}
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="badge-neutral font-mono text-xs">
                        Shifts: <strong className="text-foreground">{staff.totalShiftsWorked}</strong>
                      </span>
                      <span className="badge-neutral font-mono text-xs">
                        Hours: <strong className="text-foreground">{staff.totalHoursWorked}h</strong>
                      </span>
                      <span className="badge-success font-mono text-xs">
                        Approved OT: <strong className="text-success">{staff.totalApprovedOtHours}h</strong>
                      </span>
                      {staff.totalPendingOtHours > 0 && (
                        <span className="badge-warning font-mono text-xs">
                          Pending OT: <strong>{staff.totalPendingOtHours}h</strong>
                        </span>
                      )}
                      {staff.leavesTaken.length > 0 && (
                        <span className="badge-brand font-mono text-xs">
                          Leaves: <strong>{staff.leavesTaken.reduce((acc, l) => acc + l.daysCount, 0)}d</strong>
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Leave Breakdown if any */}
                  {staff.leavesTaken.length > 0 && (
                    <div className="flex flex-wrap gap-2 text-xs">
                      <span className="font-mono text-muted-foreground font-semibold">Leaves Taken:</span>
                      {staff.leavesTaken.map((l) => (
                        <span
                          key={l.leaveType}
                          className="rounded-full bg-primary/10 border border-primary/20 px-2.5 py-0.5 font-mono text-[11px] text-primary"
                        >
                          {l.leaveLabel}: {l.daysCount}d ({l.dateRanges.join(", ")})
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Daily Merged Table */}
                  <div className="overflow-x-auto rounded-lg border border-border">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-muted/50 font-mono text-[11px] uppercase tracking-wider text-muted-foreground border-b border-border">
                        <tr>
                          <th className="py-2.5 px-3">Date</th>
                          <th className="py-2.5 px-3">Scheduled Shift</th>
                          <th className="py-2.5 px-3">Actual Check-In / Out</th>
                          <th className="py-2.5 px-3">Hours Worked</th>
                          <th className="py-2.5 px-3">Leave Status</th>
                          <th className="py-2.5 px-3">Auto OT Status</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border/60">
                        {staff.dailyEntries.map((day) => {
                          const duty = day.dutyRecord;
                          const leave = day.leave;
                          const ot = day.overtime;
                          const shift = day.scheduledShift;

                          return (
                            <tr key={day.date} className="hover:bg-muted/30 transition-colors">
                              {/* Date */}
                              <td className="py-2.5 px-3 font-mono font-medium text-foreground whitespace-nowrap">
                                {formatDateMY(day.date + "T00:00:00+08:00")}
                              </td>

                              {/* Scheduled Shift */}
                              <td className="py-2.5 px-3 whitespace-nowrap">
                                {shift ? (
                                  <div>
                                    <span className="font-bold text-foreground font-mono">
                                      {shift.code}
                                    </span>
                                    {shift.startTime && shift.endTime && (
                                      <span className="font-mono text-muted-foreground text-[11px] ml-1.5">
                                        ({shift.startTime} - {shift.endTime})
                                      </span>
                                    )}
                                  </div>
                                ) : (
                                  <span className="font-mono text-muted-foreground">—</span>
                                )}
                              </td>

                              {/* Actual Check-In / Out */}
                              <td className="py-2.5 px-3 whitespace-nowrap font-mono">
                                {duty && (duty.checkInAt || duty.checkOutAt) ? (
                                  <div className="space-y-0.5">
                                    <span>
                                      {formatTimeMY(duty.checkInAt)} →{" "}
                                      {duty.isMissingCheckout ? (
                                        <span className="text-brand font-bold">Missing</span>
                                      ) : (
                                        formatTimeMY(duty.checkOutAt)
                                      )}
                                    </span>
                                  </div>
                                ) : (
                                  <span className="text-muted-foreground">—</span>
                                )}
                              </td>

                              {/* Total Hours */}
                              <td className="py-2.5 px-3 font-mono whitespace-nowrap">
                                {duty?.totalMinutes != null && !duty.isMissingCheckout ? (
                                  <span className="font-semibold text-foreground">
                                    {(duty.totalMinutes / 60).toFixed(1)}h
                                  </span>
                                ) : (
                                  <span className="text-muted-foreground">—</span>
                                )}
                              </td>

                              {/* Leave Status */}
                              <td className="py-2.5 px-3 whitespace-nowrap">
                                {leave ? (
                                  <div className="flex items-center gap-1.5">
                                    <span
                                      className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-bold ${
                                        leave.isApproved
                                          ? "bg-success/15 text-success border border-success/30"
                                          : leave.approvalStatus === "rejected"
                                          ? "bg-brand/15 text-brand border border-brand/30"
                                          : "bg-amber-500/15 text-amber-500 border border-amber-500/30"
                                      }`}
                                    >
                                      {leave.leaveLabel} ({leave.approvalStatus.toUpperCase()})
                                    </span>
                                  </div>
                                ) : (
                                  <span className="font-mono text-muted-foreground">—</span>
                                )}
                              </td>

                              {/* OT Status */}
                              <td className="py-2.5 px-3 whitespace-nowrap">
                                {ot ? (
                                  <div className="flex items-center gap-1.5">
                                    <span
                                      className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-bold ${
                                        ot.isApproved
                                          ? "bg-success/15 text-success border border-success/30"
                                          : ot.status === "rejected"
                                          ? "bg-brand/15 text-brand border border-brand/30"
                                          : "bg-amber-500/15 text-amber-500 border border-amber-500/30"
                                      }`}
                                    >
                                      +{ot.payableHours}h OT ({ot.status.toUpperCase()})
                                    </span>
                                  </div>
                                ) : (
                                  <span className="font-mono text-muted-foreground">—</span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Pagination Controls */}
          {data.pagination && data.pagination.totalPages > 1 && (
            <div className="flex flex-col sm:flex-row items-center justify-between gap-3 border-t border-border pt-4">
              <span className="font-mono text-xs text-muted-foreground">
                Showing Page <strong className="text-foreground">{data.pagination.page}</strong> of{" "}
                <strong className="text-foreground">{data.pagination.totalPages}</strong> ({data.pagination.totalProfiles} officers total)
              </span>

              <div className="flex items-center gap-2">
                {data.pagination.page > 1 ? (
                  <Link
                    href={`/avsec/admin/attendance-monitor?${new URLSearchParams({
                      periodType,
                      date,
                      month,
                      year,
                      station,
                      team,
                      search,
                      page: String(data.pagination.page - 1),
                    }).toString()}`}
                    className="btn-secondary flex items-center gap-1 text-xs font-mono"
                  >
                    <ChevronLeft className="h-3.5 w-3.5" />
                    <span>Previous</span>
                  </Link>
                ) : (
                  <button
                    disabled
                    className="btn-secondary flex items-center gap-1 text-xs font-mono opacity-40 cursor-not-allowed"
                  >
                    <ChevronLeft className="h-3.5 w-3.5" />
                    <span>Previous</span>
                  </button>
                )}

                {data.pagination.page < data.pagination.totalPages ? (
                  <Link
                    href={`/avsec/admin/attendance-monitor?${new URLSearchParams({
                      periodType,
                      date,
                      month,
                      year,
                      station,
                      team,
                      search,
                      page: String(data.pagination.page + 1),
                    }).toString()}`}
                    className="btn-secondary flex items-center gap-1 text-xs font-mono"
                  >
                    <span>Next</span>
                    <ChevronRight className="h-3.5 w-3.5" />
                  </Link>
                ) : (
                  <button
                    disabled
                    className="btn-secondary flex items-center gap-1 text-xs font-mono opacity-40 cursor-not-allowed"
                  >
                    <span>Next</span>
                    <ChevronRight className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
