import Link from "next/link";
import { requireRole, MONITOR_ROLES, landingPathForRole } from "@/lib/avsec/auth";
import { STATIONS, REPORT_META, REPORT_TYPES, ORG_WIDE_ROLES, type ReportType } from "@/lib/avsec/reference-data";
import {
  getTodayCounts,
  getShiftCompliance,
  getFlightCoverage,
  type DashboardFilters,
} from "@/lib/avsec/dashboard/queries";
import { getOpenBayBoard } from "@/lib/avsec/reports/queries";
import { getAttachmentCounts } from "@/lib/avsec/attachments/actions";
import { getDutyComplianceForDate } from "@/lib/avsec/duty/compliance-queries";
import { formatDateTimeMY, todayISODateMY } from "@/lib/avsec/datetime";
import { cn } from "@/lib/avsec/utils";
import { getActiveAnnouncementsForUser } from "@/lib/avsec/announcements/queries";
import { getManagementFeedbackStats } from "@/lib/avsec/feedback/queries";
import { AnnouncementBanner } from "@/components/avsec/announcements/AnnouncementBanner";
import { searchDailyReportsByStaff, searchAircraftReportsByStaff } from "@/lib/avsec/search/queries";

export default async function DashboardPage({
  searchParams: searchParamsPromise,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const searchParams = await searchParamsPromise;
  const profile = await requireRole(MONITOR_ROLES);

  const today = todayISODateMY();
  const filters: DashboardFilters = {
    dateFrom: searchParams.dateFrom || today,
    dateTo: searchParams.dateTo || today,
    station: searchParams.station || undefined,
    team: searchParams.team || undefined,
    reportType: (searchParams.reportType as ReportType) || undefined,
  };

  const isManagement = profile.role === "MANAGEMENT" || profile.role === "ADMIN";

  const [{ counts, submissions }, bayBoard, announcements, feedbackStats] = await Promise.all([
    getTodayCounts(filters),
    getOpenBayBoard(filters.station),
    getActiveAnnouncementsForUser(profile),
    isManagement ? getManagementFeedbackStats() : Promise.resolve({ totalOpen: 0, urgentSafetyCount: 0 }),
  ]);
  const attachmentCounts = await getAttachmentCounts(submissions.map((s) => s.id));

  const isOrgWideViewer = (ORG_WIDE_ROLES as readonly string[]).includes(profile.role);
  const complianceStation = filters.station ?? profile.station ?? "";
  const complianceTeam = isOrgWideViewer ? filters.team : filters.team ?? profile.team ?? undefined;
  // Org-wide roles (Enforcement/Management/Admin) get the dedicated /dashboard/duty-monitor
  // page instead — this panel stays for SO/DSE, who don't have that page.
  const showCompliance = complianceStation && !isOrgWideViewer;
  const [compliance, dutyCompliance] = showCompliance
    ? await Promise.all([
        getShiftCompliance(complianceStation, filters.dateFrom, complianceTeam),
        getDutyComplianceForDate(complianceStation, filters.dateFrom, complianceTeam),
      ])
    : [[], new Map()];

  const flightCoverage = await getFlightCoverage(filters);

  const overdue = bayBoard.filter((b) => b.hoursOnGround >= 4);

  const staffQuery = (searchParams.staffQuery || "").trim();
  const staffDate = searchParams.staffDate || today;
  const staffCategory = searchParams.staffCategory === "aircraft" ? "aircraft" : "daily";
  const staffResults = staffQuery
    ? await (staffCategory === "aircraft"
        ? searchAircraftReportsByStaff(staffQuery, staffDate)
        : searchDailyReportsByStaff(staffQuery, staffDate))
    : [];

  return (
    <main className="min-h-screen pb-32">
      <div className="max-w-5xl mx-auto px-4 py-6 space-y-6">
        {/* Active Announcements */}
        <AnnouncementBanner announcements={announcements} />

        {/* Management Communication Portal */}
        {isManagement && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Link
              href="/avsec/management/feedback"
              className={cn(
                "p-4 rounded-xl border flex items-center justify-between transition-all",
                feedbackStats.urgentSafetyCount > 0
                  ? "border-red-500/60 bg-red-500/10 text-red-400 animate-pulse"
                  : "border-border/80 bg-surface/80 hover:border-primary/50 text-foreground"
              )}
            >
              <div>
                <p className="text-[10px] font-mono font-bold uppercase tracking-wider text-muted-foreground">
                  Anonymous Feedback Inbox
                </p>
                <p className="text-sm font-bold mt-0.5">
                  {feedbackStats.urgentSafetyCount > 0 ? (
                    <span className="text-red-400">🚨 {feedbackStats.urgentSafetyCount} Urgent Safety Concern{feedbackStats.urgentSafetyCount === 1 ? "" : "s"}</span>
                  ) : (
                    <span>{feedbackStats.totalOpen} Open Thread{feedbackStats.totalOpen === 1 ? "" : "s"}</span>
                  )}
                </p>
              </div>
              <span className="px-2.5 py-1 rounded text-xs font-mono font-bold bg-primary/10 text-primary border border-primary/20">
                View Inbox →
              </span>
            </Link>

            <Link
              href="/avsec/management/announcements"
              className="p-4 rounded-xl border border-border/80 bg-surface/80 hover:border-primary/50 text-foreground flex items-center justify-between transition-all"
            >
              <div>
                <p className="text-[10px] font-mono font-bold uppercase tracking-wider text-muted-foreground">
                  Staff Directives
                </p>
                <p className="text-sm font-bold mt-0.5">
                  Broadcast Announcements
                </p>
              </div>
              <span className="px-2.5 py-1 rounded text-xs font-mono font-bold bg-primary/10 text-primary border border-primary/20">
                Manage →
              </span>
            </Link>
          </div>
        )}

        {isOrgWideViewer && (
          <div className="grid grid-cols-2 gap-2">
            <Link href="/avsec/admin/attendance-monitor" className="btn-secondary text-center col-span-2 !border-primary/40 !text-primary hover:!bg-primary/10">
              📊 Attendance & Overtime Monitor →
            </Link>
            <Link href="/avsec/dashboard/duty-monitor" className="btn-secondary text-center">
              Check-In Monitoring →
            </Link>
            <Link href="/avsec/dashboard/heatmap" className="btn-secondary text-center">
              Duty Heat Map →
            </Link>
            <Link href="/avsec/admin/attendance-report" className="btn-secondary text-center col-span-2">
              Attendance Anomaly Report →
            </Link>
          </div>
        )}

        {(profile.role === "ENFORCEMENT" || profile.role === "MANAGEMENT") && (
          <Link href="/avsec/enforcement/search" className="btn-secondary w-full text-center">
            Enforcement Search →
          </Link>
        )}

        <section className="card p-4 space-y-3">
          <h2 className="section-title">Staff report lookup</h2>
          <p className="font-mono text-xs text-muted-foreground">
            End-of-shift check: search a staff name to see their daily report or aircraft reports
            for that day.
          </p>
          <form method="get" className="grid grid-cols-2 sm:grid-cols-4 gap-3 items-end">
            <div className="col-span-2 sm:col-span-1">
              <label className="field-label">Staff name</label>
              <input
                type="text"
                name="staffQuery"
                defaultValue={staffQuery}
                placeholder="e.g. Eswaran"
                className="input-base"
              />
            </div>
            <div>
              <label className="field-label">Date</label>
              <input type="date" name="staffDate" defaultValue={staffDate} className="input-base" />
            </div>
            <div>
              <label className="field-label">Report</label>
              <select name="staffCategory" defaultValue={staffCategory} className="input-base">
                <option value="daily">Daily report</option>
                <option value="aircraft">Aircraft report</option>
              </select>
            </div>
            <button type="submit" className="btn-primary">
              Search
            </button>
          </form>

          {staffQuery && (
            <div className="divide-y divide-border pt-2">
              <p className="font-mono text-xs text-muted-foreground pb-2">
                {staffResults.length} result{staffResults.length === 1 ? "" : "s"} for &quot;
                {staffQuery}&quot; on {staffDate}
              </p>
              {staffResults.length === 0 && (
                <p className="py-3 font-mono text-sm text-muted-foreground">
                  No {staffCategory === "aircraft" ? "aircraft" : "daily"} report found for this
                  staff on this date.
                </p>
              )}
              {staffResults.map((r) => (
                <Link
                  key={`${r.reportType}-${r.reportId}`}
                  href={`/avsec/reports/view/${r.reportType}/${r.reportId}`}
                  className="flex items-center justify-between py-2 hover:bg-card/40 text-sm group"
                >
                  <div className="min-w-0">
                    <p className="font-mono text-xs text-primary">{REPORT_META[r.reportType].code}</p>
                    <p className="font-semibold text-foreground group-hover:text-primary transition-colors">{r.staffName}</p>
                    <p className="font-mono text-xs text-muted-foreground truncate">{r.detail}</p>
                  </div>
                  <span className="font-mono text-xs text-muted-foreground text-right shrink-0 ml-3">
                    {r.station} · {r.team}
                    <br />
                    {formatDateTimeMY(r.submittedAt)}
                  </span>
                </Link>
              ))}
            </div>
          )}
        </section>

        <form method="get" className="card p-4 grid grid-cols-2 sm:grid-cols-5 gap-3 items-end">
          <div>
            <label className="field-label">From</label>
            <input type="date" name="dateFrom" defaultValue={filters.dateFrom} className="input-base" />
          </div>
          <div>
            <label className="field-label">To</label>
            <input type="date" name="dateTo" defaultValue={filters.dateTo} className="input-base" />
          </div>
          <div>
            <label className="field-label">Station</label>
            <select name="station" defaultValue={filters.station ?? ""} className="input-base">
              <option value="">All</option>
              {STATIONS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="field-label">Team</label>
            <input
              type="text"
              name="team"
              defaultValue={filters.team ?? ""}
              placeholder="All"
              className="input-base"
            />
          </div>
          <div>
            <label className="field-label">Report type</label>
            <select name="reportType" defaultValue={filters.reportType ?? ""} className="input-base">
              <option value="">All</option>
              {REPORT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {REPORT_META[t].code}
                </option>
              ))}
            </select>
          </div>
          <div className="col-span-2 sm:col-span-5 flex gap-3">
            <button type="submit" className="btn-primary">
              Apply filters
            </button>
            <Link
              href={`/api/avsec/export/excel?${new URLSearchParams(
                Object.entries(filters).filter(([, v]) => v) as [string, string][],
              ).toString()}`}
              className="btn-secondary"
            >
              Export Excel
            </Link>
          </div>
        </form>

        <section>
          <h2 className="section-title mb-3">Today · {filters.dateFrom}{filters.dateTo !== filters.dateFrom ? ` – ${filters.dateTo}` : ""}</h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {REPORT_TYPES.map((t) => (
              <div key={t} className="card p-4 text-center">
                <p className="font-mono text-2xl font-bold text-foreground">{counts[t]}</p>
                <p className="font-mono text-[10px] text-muted-foreground mt-1">{REPORT_META[t].code}</p>
              </div>
            ))}
          </div>
        </section>

        {overdue.length > 0 && (
          <section className="card border-destructive/40 bg-destructive/10 p-4">
            <h2 className="font-bold text-destructive mb-2 font-mono text-xs uppercase tracking-wider">
              ⚠ Bay Board — {overdue.length} aircraft overdue for SEC 029 search
            </h2>
            <ul className="space-y-1 text-xs text-destructive-foreground/90 font-mono">
              {overdue.map((a) => (
                <li key={a.id}>
                  {a.station} · Reg <span className="font-bold text-foreground">{a.reg_no}</span> · Bay {a.bay} ·{" "}
                  {a.hoursOnGround.toFixed(1)}h on ground
                </li>
              ))}
            </ul>
          </section>
        )}

        {showCompliance && (
          <section className="card p-4">
            <h2 className="section-title mb-3">
              Shift compliance — SEC 014 · {complianceStation}
              {complianceTeam ? ` · ${complianceTeam}` : ""} · {filters.dateFrom}
            </h2>
            {compliance.length === 0 && (
              <p className="font-mono text-sm text-muted-foreground">No officers registered at this station.</p>
            )}
            <div className="divide-y divide-border">
              {compliance.map((c) => {
                const duty = dutyCompliance.get(c.profile.id);
                const flagged = duty && (duty.lateMinutes > 0 || duty.earlyOutMinutes > 0);
                return (
                  <div key={c.profile.id} className="flex items-center justify-between py-2 gap-2">
                    <div className="min-w-0">
                      <p className="font-semibold text-sm text-foreground">{c.profile.name || c.profile.email}</p>
                      <p className="font-mono text-xs text-muted-foreground">{c.profile.team}</p>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <span
                        className={cn(
                          "font-mono text-[9px] font-bold px-2 py-0.5 rounded border uppercase tracking-wider",
                          c.submitted
                            ? "bg-success/10 text-success border-success/30"
                            : "bg-destructive/10 text-destructive border-destructive/30",
                        )}
                      >
                        {c.submitted ? "SUBMITTED" : "MISSING"}
                      </span>
                      {flagged ? (
                        <details className="relative">
                          <summary
                            className="list-none cursor-pointer font-mono text-[9px] font-bold px-2 py-0.5 rounded border border-primary/30 bg-primary/10 text-primary uppercase tracking-wider"
                          >
                            {duty.lateMinutes > 0 ? "LATE" : "EARLY-OUT"}
                          </summary>
                          <div className="absolute right-0 z-10 mt-1 w-56 p-2.5 text-xs rounded-lg border border-border bg-card shadow-lg font-mono">
                            {duty.lateMinutes > 0 && (
                              <p className="text-foreground">
                                <span className="font-semibold text-primary">Late {duty.lateMinutes} min</span> — {duty.lateRemark}
                              </p>
                            )}
                            {duty.earlyOutMinutes > 0 && (
                              <p className={`text-foreground ${duty.lateMinutes > 0 ? "mt-1.5" : ""}`}>
                                <span className="font-semibold text-primary">Early out {duty.earlyOutMinutes} min</span> —{" "}
                                {duty.earlyOutRemark}
                              </p>
                            )}
                          </div>
                        </details>
                      ) : (
                        <span
                          className={cn(
                            "font-mono text-[9px] font-bold px-2 py-0.5 rounded border uppercase tracking-wider",
                            duty?.checkedIn
                              ? "bg-success/10 text-success border-success/30"
                              : "bg-destructive/10 text-destructive border-destructive/30",
                          )}
                        >
                          {duty?.checkedIn ? "CHECKED-IN" : "NOT CHECKED-IN"}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        <section className="card p-4">
          <h2 className="section-title mb-3">
            Flight report coverage — SEC 016 · {flightCoverage.length} flights
          </h2>
          <div className="divide-y divide-border text-sm">
            {flightCoverage.map((f) => (
              <Link
                key={f.id as string}
                href={`/avsec/reports/view/sec016/${f.id}`}
                className="flex items-center justify-between py-2 hover:bg-card/40 group"
              >
                <span className="font-semibold text-foreground group-hover:text-primary transition-colors">
                  {f.flight as string} · {f.reg_no as string}
                </span>
                <span className="font-mono text-xs text-muted-foreground">
                  {f.station as string} · Bay {f.bay_no as string} ·{" "}
                  {formatDateTimeMY(f.submitted_at as string)}
                </span>
              </Link>
            ))}
            {flightCoverage.length === 0 && <p className="font-mono text-xs text-muted-foreground py-2">No SEC 016 submissions in range.</p>}
          </div>
        </section>

        <section className="card p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="section-title">Submissions</h2>
            <span className="font-mono text-xs text-muted-foreground">{submissions.length} results</span>
          </div>
          <div className="divide-y divide-border text-sm">
            {submissions.map((s) => (
              <Link
                key={`${s.type}-${s.id}`}
                href={`/avsec/reports/view/${s.type}/${s.id}`}
                className="flex items-center justify-between py-2 hover:bg-card/40 group"
              >
                <div>
                  <p className="font-mono text-xs text-primary">
                    {REPORT_META[s.type].code}
                    {s.report_no ? ` · ${s.report_no}` : ""}
                  </p>
                  <p className="font-semibold text-foreground group-hover:text-primary transition-colors">
                    {s.summary}
                    {attachmentCounts[s.id] ? ` · 📎 ${attachmentCounts[s.id]}` : ""}
                  </p>
                </div>
                <span className="font-mono text-xs text-muted-foreground text-right">
                  {s.station} · {s.team}
                  <br />
                  {formatDateTimeMY(s.submitted_at)}
                </span>
              </Link>
            ))}
            {submissions.length === 0 && <p className="font-mono text-xs text-muted-foreground py-2">No submissions in range.</p>}
          </div>
        </section>
      </div>
    </main>
  );
}
