import Link from "next/link";
import { requireRole, MONITOR_ROLES, landingPathForRole } from "@/lib/auth";
import { STATIONS, REPORT_META, REPORT_TYPES, ORG_WIDE_ROLES, type ReportType } from "@/lib/reference-data";
import {
  getTodayCounts,
  getShiftCompliance,
  getFlightCoverage,
  type DashboardFilters,
} from "@/lib/dashboard/queries";
import { getOpenBayBoard } from "@/lib/reports/queries";
import { getDutyComplianceForDate } from "@/lib/duty/compliance-queries";
import { AppHeader } from "@/components/layout/AppHeader";
import { BottomNav } from "@/components/layout/BottomNav";
import { formatDateTimeMY, todayISODateMY } from "@/lib/datetime";
import { cn } from "@/lib/utils";
import { searchDailyReportsByStaff, searchAircraftReportsByStaff } from "@/lib/search/queries";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Record<string, string | undefined>;
}) {
  const profile = await requireRole(MONITOR_ROLES);

  const today = todayISODateMY();
  const filters: DashboardFilters = {
    dateFrom: searchParams.dateFrom || today,
    dateTo: searchParams.dateTo || today,
    station: searchParams.station || undefined,
    team: searchParams.team || undefined,
    reportType: (searchParams.reportType as ReportType) || undefined,
  };

  const [{ counts, submissions }, bayBoard] = await Promise.all([
    getTodayCounts(filters),
    getOpenBayBoard(filters.station),
  ]);

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
      <AppHeader profile={profile} title="Dashboard" backHref={landingPathForRole(profile.role)} />
      <div className="max-w-5xl mx-auto px-4 py-6 space-y-6">
        {isOrgWideViewer && (
          <div className="grid grid-cols-2 gap-2">
            <Link href="/dashboard/duty-monitor" className="btn-secondary text-center">
              Check-In Monitoring →
            </Link>
            <Link href="/dashboard/heatmap" className="btn-secondary text-center">
              Duty Heat Map →
            </Link>
          </div>
        )}

        <section className="card p-4 space-y-3">
          <h2 className="section-title">Staff report lookup</h2>
          <p className="text-sm text-slate-500 dark:text-slate-400">
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
            <div className="divide-y divide-slate-200 dark:divide-slate-800 pt-2">
              <p className="text-xs text-slate-500 dark:text-slate-400 pb-2">
                {staffResults.length} result{staffResults.length === 1 ? "" : "s"} for &quot;
                {staffQuery}&quot; on {staffDate}
              </p>
              {staffResults.length === 0 && (
                <p className="py-3 text-sm text-slate-500 dark:text-slate-400">
                  No {staffCategory === "aircraft" ? "aircraft" : "daily"} report found for this
                  staff on this date.
                </p>
              )}
              {staffResults.map((r) => (
                <Link
                  key={`${r.reportType}-${r.reportId}`}
                  href={`/reports/view/${r.reportType}/${r.reportId}`}
                  className="flex items-center justify-between py-2 hover:bg-slate-50 dark:hover:bg-slate-800/50 text-sm"
                >
                  <div className="min-w-0">
                    <p className="font-mono text-xs text-slate-400">{REPORT_META[r.reportType].code}</p>
                    <p className="font-semibold">{r.staffName}</p>
                    <p className="text-xs text-slate-500 dark:text-slate-400 truncate">{r.detail}</p>
                  </div>
                  <span className="text-xs text-slate-500 text-right shrink-0 ml-3">
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
              href={`/api/export/excel?${new URLSearchParams(
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
                <p className="text-2xl font-bold">{counts[t]}</p>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">{REPORT_META[t].code}</p>
              </div>
            ))}
          </div>
        </section>

        {overdue.length > 0 && (
          <section className="card border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/30 p-4">
            <h2 className="font-bold text-red-800 dark:text-red-300 mb-2">
              ⚠ Bay Board — {overdue.length} aircraft overdue for SEC 029 search
            </h2>
            <ul className="space-y-1 text-sm text-red-700 dark:text-red-300">
              {overdue.map((a) => (
                <li key={a.id}>
                  {a.station} · Reg <span className="font-semibold">{a.reg_no}</span> · Bay {a.bay} ·{" "}
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
              <p className="text-sm text-slate-500">No officers registered at this station.</p>
            )}
            <div className="divide-y divide-slate-200 dark:divide-slate-800">
              {compliance.map((c) => {
                const duty = dutyCompliance.get(c.profile.id);
                const flagged = duty && (duty.lateMinutes > 0 || duty.earlyOutMinutes > 0);
                return (
                  <div key={c.profile.id} className="flex items-center justify-between py-2 gap-2">
                    <div className="min-w-0">
                      <p className="font-medium text-sm">{c.profile.name || c.profile.email}</p>
                      <p className="text-xs text-slate-500">{c.profile.team}</p>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <span
                        className={cn(
                          "text-xs font-bold px-2 py-1 rounded-full",
                          c.submitted
                            ? "bg-green-100 text-green-800 dark:bg-green-500/20 dark:text-green-300"
                            : "bg-red-100 text-red-800 dark:bg-red-500/20 dark:text-red-300",
                        )}
                      >
                        {c.submitted ? "SUBMITTED" : "MISSING"}
                      </span>
                      {flagged ? (
                        <details className="relative">
                          <summary
                            className="list-none cursor-pointer text-xs font-bold px-2 py-1 rounded-full bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300"
                          >
                            {duty.lateMinutes > 0 ? "LATE" : "EARLY-OUT"}
                          </summary>
                          <div className="absolute right-0 z-10 mt-1 w-56 p-2 text-xs rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-lg">
                            {duty.lateMinutes > 0 && (
                              <p>
                                <span className="font-semibold">Late {duty.lateMinutes} min</span> — {duty.lateRemark}
                              </p>
                            )}
                            {duty.earlyOutMinutes > 0 && (
                              <p className={duty.lateMinutes > 0 ? "mt-1.5" : ""}>
                                <span className="font-semibold">Early out {duty.earlyOutMinutes} min</span> —{" "}
                                {duty.earlyOutRemark}
                              </p>
                            )}
                          </div>
                        </details>
                      ) : (
                        <span
                          className={cn(
                            "text-xs font-bold px-2 py-1 rounded-full",
                            duty?.checkedIn
                              ? "bg-green-100 text-green-800 dark:bg-green-500/20 dark:text-green-300"
                              : "bg-red-100 text-red-800 dark:bg-red-500/20 dark:text-red-300",
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
          <div className="divide-y divide-slate-200 dark:divide-slate-800 text-sm">
            {flightCoverage.map((f) => (
              <Link
                key={f.id as string}
                href={`/reports/view/sec016/${f.id}`}
                className="flex items-center justify-between py-2 hover:bg-slate-50 dark:hover:bg-slate-800/50"
              >
                <span className="font-medium">
                  {f.flight as string} · {f.reg_no as string}
                </span>
                <span className="text-xs text-slate-500">
                  {f.station as string} · Bay {f.bay_no as string} ·{" "}
                  {formatDateTimeMY(f.submitted_at as string)}
                </span>
              </Link>
            ))}
            {flightCoverage.length === 0 && <p className="text-slate-500 py-2">No SEC 016 submissions in range.</p>}
          </div>
        </section>

        <section className="card p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="section-title">Submissions</h2>
            <span className="text-xs text-slate-500">{submissions.length} results</span>
          </div>
          <div className="divide-y divide-slate-200 dark:divide-slate-800 text-sm">
            {submissions.map((s) => (
              <Link
                key={`${s.type}-${s.id}`}
                href={`/reports/view/${s.type}/${s.id}`}
                className="flex items-center justify-between py-2 hover:bg-slate-50 dark:hover:bg-slate-800/50"
              >
                <div>
                  <p className="font-mono text-xs text-slate-400">{REPORT_META[s.type].code}</p>
                  <p className="font-medium">{s.summary}</p>
                </div>
                <span className="text-xs text-slate-500 text-right">
                  {s.station} · {s.team}
                  <br />
                  {formatDateTimeMY(s.submitted_at)}
                </span>
              </Link>
            ))}
            {submissions.length === 0 && <p className="text-slate-500 py-2">No submissions in range.</p>}
          </div>
        </section>
      </div>
      <BottomNav profile={profile} />
    </main>
  );
}
