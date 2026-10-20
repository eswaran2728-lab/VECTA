import Link from "next/link";
import { requireEntityLeadership } from "@/lib/dashboard/entity-guard";
import { getEntityReportCounts, searchEntityReports } from "@/lib/dashboard/entity-leadership";
import { parseEntityReportFilters, REPORT_STATUS_OPTIONS, REPORT_TYPE_OPTIONS, reportViewHref } from "@/lib/dashboard/entity-report-filters";
import { DashboardCard, StatTile } from "@/components/dashboard/DashboardCard";

/**
 * Entity reports (MAA / AAX Boss and Admin). Reports and the staff directory are SEPARATE functions: this page never lists staff,
 * and the directory never grants report access. Every row here already passed has_report_access() inside
 * search_reports_filtered_secure(), so an MAA leader can never see an AAX report (or the reverse); the counts use the same decision.
 */
export default async function EntityReportsPage({ searchParams: searchParamsPromise }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { leadership } = await requireEntityLeadership("any");
  const params = await searchParamsPromise;
  const filters = parseEntityReportFilters(params);
  const [counts, results] = await Promise.all([getEntityReportCounts(filters.from, filters.to), searchEntityReports(filters)]);

  const lastPage = Math.max(1, Math.ceil(results.total / filters.pageSize));
  const qs = (page: number) => {
    const q = new URLSearchParams();
    if (filters.registration) q.set("reg", filters.registration);
    if (filters.flight) q.set("flight", filters.flight);
    if (filters.from) q.set("from", filters.from);
    if (filters.to) q.set("to", filters.to);
    if (filters.sourceTable) q.set("type", filters.sourceTable);
    if (filters.status) q.set("status", filters.status);
    q.set("page", String(page));
    return `/avsec/entity-reports?${q.toString()}`;
  };

  return (
    <main className="min-h-screen pb-24">
      <div className="mx-auto max-w-5xl space-y-4 px-4 py-6">
        <header className="space-y-1">
          <h1 className="font-display text-xl font-bold tracking-[0.03em]">{leadership.entityCode} Entity Reports</h1>
          <p className="font-mono text-xs text-muted-foreground">
            Completed reports of the {leadership.entityCode} operating entity only. The staff directory is a separate function.
          </p>
          <Link href="/avsec/directory" className="inline-block font-mono text-xs text-primary">
            Staff Directory →
          </Link>
        </header>

        <DashboardCard title={`${leadership.entityCode} reports by type`} status={counts.status}>
          <div className="flex flex-wrap gap-2">
            <StatTile label={`${leadership.entityCode} total`} value={counts.entityTotal} />
            {counts.rows.map((r) => (
              <StatTile key={r.sourceTable} label={r.label} value={r.total} />
            ))}
          </div>
        </DashboardCard>

        <form method="get" className="card grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3" aria-label="Report search filters">
          <label className="space-y-1 text-xs">
            <span className="font-mono text-muted-foreground">Aircraft registration</span>
            <input name="reg" defaultValue={filters.registration ?? ""} className="input-base w-full" placeholder="9M-AXX" maxLength={20} />
          </label>
          <label className="space-y-1 text-xs">
            <span className="font-mono text-muted-foreground">Flight number</span>
            <input name="flight" defaultValue={filters.flight ?? ""} className="input-base w-full" placeholder="AK703 or D7 123" maxLength={12} />
          </label>
          <label className="space-y-1 text-xs">
            <span className="font-mono text-muted-foreground">Report type</span>
            <select name="type" defaultValue={filters.sourceTable ?? ""} className="input-base w-full">
              <option value="">All types</option>
              {REPORT_TYPE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-xs">
            <span className="font-mono text-muted-foreground">From date</span>
            <input type="date" name="from" defaultValue={filters.from ?? ""} className="input-base w-full" />
          </label>
          <label className="space-y-1 text-xs">
            <span className="font-mono text-muted-foreground">To date</span>
            <input type="date" name="to" defaultValue={filters.to ?? ""} className="input-base w-full" />
          </label>
          <label className="space-y-1 text-xs">
            <span className="font-mono text-muted-foreground">Status</span>
            <select name="status" defaultValue={filters.status ?? ""} className="input-base w-full">
              <option value="">Any status</option>
              {REPORT_STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <div className="flex items-end gap-2 sm:col-span-2 lg:col-span-3">
            <button type="submit" className="btn-primary min-h-[44px] px-4 text-xs">
              Search
            </button>
            <Link href="/avsec/entity-reports" className="btn-secondary inline-flex min-h-[44px] items-center px-4 text-xs">
              Clear
            </Link>
          </div>
        </form>

        <section className="card p-4" aria-label="Report results">
          {results.status === "error" && (
            <p className="font-mono text-xs text-destructive" role="alert">
              The search could not be completed right now. Try again shortly.
            </p>
          )}
          {results.status === "unauthorized" && <p className="font-mono text-xs italic text-muted-foreground">Not authorized for this scope.</p>}
          {results.status === "ok" && results.rows.length === 0 && (
            <p className="font-mono text-xs text-muted-foreground" role="status">
              No reports match these filters.
            </p>
          )}
          {results.status === "ok" && results.rows.length > 0 && (
            <>
              <p className="mb-2 font-mono text-[11px] text-muted-foreground" role="status">
                {results.total} report{results.total === 1 ? "" : "s"} · page {filters.page} of {lastPage}
              </p>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[40rem] text-left text-xs">
                  <thead className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                    <tr>
                      <th className="py-2 pr-3">Date</th>
                      <th className="py-2 pr-3">Type</th>
                      <th className="py-2 pr-3">Flight</th>
                      <th className="py-2 pr-3">Registration</th>
                      <th className="py-2 pr-3">Station</th>
                      <th className="py-2 pr-3">Status</th>
                      <th className="py-2 pr-3">
                        <span className="sr-only">Open</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {results.rows.map((r) => {
                      const href = reportViewHref(r.sourceTable, r.sourceId);
                      const typeLabel = REPORT_TYPE_OPTIONS.find((o) => o.value === r.sourceTable)?.label ?? r.sourceTable;
                      return (
                        <tr key={r.id} className="border-t border-border/60">
                          <td className="py-2 pr-3 font-mono">{r.reportDate ?? "—"}</td>
                          <td className="py-2 pr-3">{typeLabel}</td>
                          <td className="py-2 pr-3 font-mono">{r.flightNumber ?? "—"}</td>
                          <td className="py-2 pr-3 font-mono">{r.regNo ?? "—"}</td>
                          <td className="py-2 pr-3">{r.station ?? "—"}</td>
                          <td className="py-2 pr-3 capitalize">{r.status}</td>
                          <td className="py-2 pr-3">
                            {href ? (
                              <Link href={href} className="inline-flex min-h-[44px] items-center font-mono text-primary">
                                Open
                              </Link>
                            ) : (
                              <span className="font-mono text-muted-foreground">Summary only</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <nav className="mt-3 flex items-center justify-between" aria-label="Pagination">
                {filters.page > 1 ? (
                  <Link href={qs(filters.page - 1)} className="btn-secondary inline-flex min-h-[44px] items-center px-4 text-xs">
                    ← Previous
                  </Link>
                ) : (
                  <span />
                )}
                {filters.page < lastPage ? (
                  <Link href={qs(filters.page + 1)} className="btn-secondary inline-flex min-h-[44px] items-center px-4 text-xs">
                    Next →
                  </Link>
                ) : (
                  <span />
                )}
              </nav>
            </>
          )}
        </section>
      </div>
    </main>
  );
}
