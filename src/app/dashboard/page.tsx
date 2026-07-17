import Link from "next/link";
import { requireRole, SUPERVISOR_ROLES } from "@/lib/auth";
import { STATIONS, TEAMS, REPORT_META, REPORT_TYPES, type ReportType } from "@/lib/reference-data";
import {
  getTodayCounts,
  getShiftCompliance,
  getFlightCoverage,
  getDiscrepancyCount,
  buildShiftSummary,
  type DashboardFilters,
} from "@/lib/dashboard/queries";
import { getOpenBayBoard } from "@/lib/reports/queries";
import { AppHeader } from "@/components/layout/AppHeader";
import { CopyButton } from "@/components/dashboard/CopyButton";
import { formatDateTimeMY, todayISODateMY } from "@/lib/datetime";
import { cn } from "@/lib/utils";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Record<string, string | undefined>;
}) {
  const profile = await requireRole(SUPERVISOR_ROLES);
  const isManager = profile.role === "MANAGER" || profile.role === "ADMIN";

  const today = todayISODateMY();
  const filters: DashboardFilters = {
    dateFrom: searchParams.dateFrom || today,
    dateTo: searchParams.dateTo || today,
    station: searchParams.station || (isManager ? undefined : profile.station ?? undefined),
    team: searchParams.team || undefined,
    reportType: (searchParams.reportType as ReportType) || undefined,
  };

  const [{ counts, submissions }, bayBoard, discrepancyCount] = await Promise.all([
    getTodayCounts(filters),
    getOpenBayBoard(filters.station),
    getDiscrepancyCount(filters),
  ]);

  const complianceStation = filters.station ?? profile.station ?? "";
  const compliance = complianceStation
    ? await getShiftCompliance(complianceStation, filters.dateFrom)
    : [];

  const flightCoverage = await getFlightCoverage(filters);

  const overdue = bayBoard.filter((b) => b.hoursOnGround >= 4);
  const shiftSummary = buildShiftSummary(
    filters.team ?? "ALL",
    filters.dateFrom,
    counts,
    discrepancyCount,
  );

  return (
    <main className="min-h-screen pb-16">
      <AppHeader profile={profile} title="Dashboard" backHref="/home" />
      <div className="max-w-5xl mx-auto px-4 py-6 space-y-6">
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
            <select name="station" defaultValue={filters.station ?? ""} className="input-base" disabled={!isManager}>
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
            <select name="team" defaultValue={filters.team ?? ""} className="input-base">
              <option value="">All</option>
              {TEAMS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
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

        {complianceStation && (
          <section className="card p-4">
            <h2 className="section-title mb-3">
              Shift compliance — SEC 014 · {complianceStation} · {filters.dateFrom}
            </h2>
            {compliance.length === 0 && (
              <p className="text-sm text-slate-500">No officers registered at this station.</p>
            )}
            <div className="divide-y divide-slate-200 dark:divide-slate-800">
              {compliance.map((c) => (
                <div key={c.profile.id} className="flex items-center justify-between py-2">
                  <div>
                    <p className="font-medium text-sm">{c.profile.name || c.profile.email}</p>
                    <p className="text-xs text-slate-500">{c.profile.team}</p>
                  </div>
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
                </div>
              ))}
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

        <section className="card p-4 space-y-3">
          <h2 className="section-title">Shift summary</h2>
          <p className="text-sm bg-slate-50 dark:bg-slate-800/50 rounded-lg p-3 font-mono">
            {shiftSummary}
          </p>
          <CopyButton text={shiftSummary} />
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
    </main>
  );
}
