import Link from "next/link";
import { redirect } from "next/navigation";
import { requireProfile } from "@/lib/avsec/auth";
import type { CanonicalAccess } from "@/lib/auth/canonical-access";
import { getTeamSubmissions } from "@/lib/avsec/reports/team-history";
import { TEAM_HISTORY_TYPES, parseTeamHistoryFilters, teamHistoryHref } from "@/lib/avsec/reports/team-history-filters";
import { REPORT_META, type ReportType } from "@/lib/avsec/reference-data";
import { formatDateTimeMY } from "@/lib/avsec/datetime";
import { reportViewHref } from "@/lib/dashboard/entity-report-filters";
import { cn } from "@/lib/avsec/utils";

export const dynamic = "force-dynamic";

const ENTITY_LABEL: Record<string, string> = { MAA: "AK · MAA", AAX: "D7 · AAX" };

/**
 * Team Submission History: every submitted report of the signed-in DSE's or SO's OWN station and team, both entities. "My Submission History" stays personal.
 * Scope is decided by list_team_submissions_secure() from the caller's assignments; nothing on this page widens it, and a direct URL for another team's report
 * is refused by the report detail function, not by this list.
 */
export default async function TeamHistoryPage({ searchParams: searchParamsPromise }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const profile = await requireProfile();
  const roles = (profile.canonical as CanonicalAccess).roleCodes;
  if (!roles.includes("dse") && !roles.includes("so")) redirect("/avsec/history");

  const filters = parseTeamHistoryFilters(await searchParamsPromise);
  const result = await getTeamSubmissions(filters);

  return (
    <main className="min-h-screen pb-32">
      <div className="mx-auto max-w-5xl space-y-4 px-4 py-6">
        <div>
          <h1 className="font-display text-xl font-bold">Team Submission History</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            Reports submitted by every officer of your station and team, for both airlines (AK · MAA and D7 · AAX). Your own reports are in My Submission History.
          </p>
        </div>

        <nav aria-label="History" className="flex gap-2 text-xs font-mono font-semibold">
          <Link href="/avsec/history" className="rounded border border-border/60 bg-surface px-3 py-2 text-muted-foreground hover:bg-muted">My Submission History</Link>
          <span aria-current="page" className="rounded bg-primary px-3 py-2 text-primary-foreground">Team Submission History</span>
        </nav>

        <form method="get" action="/avsec/history/team" className="card grid grid-cols-1 gap-3 p-3.5 sm:grid-cols-2 lg:grid-cols-4" aria-label="Filter team submissions">
          <label className="text-xs">
            <span className="field-label">Search officer, staff ID or report no.</span>
            <input name="q" defaultValue={filters.search ?? ""} className="input-base" placeholder="Name, staff ID or report no." />
          </label>
          <label className="text-xs">
            <span className="field-label">Report type</span>
            <select name="type" defaultValue={filters.type ?? ""} className="input-base">
              <option value="">All types</option>
              {TEAM_HISTORY_TYPES.map((t) => (
                <option key={t} value={t}>{REPORT_META[t as ReportType].code} · {REPORT_META[t as ReportType].name}</option>
              ))}
            </select>
          </label>
          <label className="text-xs">
            <span className="field-label">Entity</span>
            <select name="entity" defaultValue={filters.entity ?? ""} className="input-base">
              <option value="">Both (AK · MAA and D7 · AAX)</option>
              <option value="MAA">AK · MAA</option>
              <option value="AAX">D7 · AAX</option>
            </select>
          </label>
          <label className="text-xs">
            <span className="field-label">Flight</span>
            <input name="flight" defaultValue={filters.flight ?? ""} className="input-base" placeholder="e.g. AK5001" />
          </label>
          <label className="text-xs">
            <span className="field-label">From</span>
            <input type="date" name="from" defaultValue={filters.from ?? ""} className="input-base" />
          </label>
          <label className="text-xs">
            <span className="field-label">To</span>
            <input type="date" name="to" defaultValue={filters.to ?? ""} className="input-base" />
          </label>
          <label className="text-xs">
            <span className="field-label">Acknowledgment</span>
            <select name="ack" defaultValue={filters.ack ?? ""} className="input-base">
              <option value="">Any</option>
              <option value="pending">Not yet acknowledged</option>
              <option value="acknowledged">Acknowledged</option>
            </select>
          </label>
          <div className="flex items-end gap-2">
            <button type="submit" className="btn-primary px-4 py-2 text-xs">Apply filters</button>
            <Link href="/avsec/history/team" className="btn-secondary px-4 py-2 text-xs">Reset</Link>
          </div>
        </form>

        {!result.ok ? (
          <div role="alert" className="card border-l-[3px] border-l-warning p-4 text-sm">{result.error}</div>
        ) : result.rows.length === 0 ? (
          <div className="card space-y-1 border-dashed p-8 text-center">
            <p className="text-sm font-semibold text-foreground">No team submissions found</p>
            <p className="text-xs text-muted-foreground">Change or reset the filters. Only submitted reports of your own station and team are listed.</p>
          </div>
        ) : (
          <>
            <p className="font-mono text-[11px] text-muted-foreground" aria-live="polite">
              {result.total} report{result.total === 1 ? "" : "s"} · page {filters.page} of {result.pageCount}
            </p>

            {/* phones: one card per report */}
            <ul className="space-y-2.5 md:hidden" aria-label="Team submissions">
              {result.rows.map((r) => (
                <li key={`${r.source_table}-${r.id}`}>
                  <Link href={reportViewHref(r.source_table, r.id) ?? "/avsec/history"} className="card block space-y-1.5 border-border/80 p-4 hover:border-primary/60">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-mono text-xs font-bold text-primary">{REPORT_META[r.report_type as ReportType]?.code ?? r.report_type}{r.report_no ? ` · ${r.report_no}` : ""}</span>
                      <span className={cn("rounded px-2 py-0.5 font-mono text-[10px] font-semibold", r.acknowledged_at ? "bg-success/15 text-success" : "bg-warning/15 text-warning")}>
                        {r.acknowledged_at ? "Acknowledged" : "Not acknowledged"}
                      </span>
                    </div>
                    <p className="text-sm font-semibold text-foreground">{r.staff_name ?? "—"} <span className="font-mono text-xs font-normal text-muted-foreground">({r.staff_id ?? "—"})</span></p>
                    <p className="font-mono text-xs text-muted-foreground">
                      {r.flight ? `${r.flight} · ` : ""}{r.entity ? ENTITY_LABEL[r.entity] ?? r.entity : "Entity not classified"} · {r.station} · {r.team}
                    </p>
                    <p className="font-mono text-[11px] text-muted-foreground">
                      {r.submitted_at ? formatDateTimeMY(r.submitted_at) : "—"} · {r.status}
                      {r.acknowledged_at ? ` · by ${r.acknowledged_by_name ?? "—"}` : ""}
                    </p>
                  </Link>
                </li>
              ))}
            </ul>

            {/* tablets and desktops: a table */}
            <div className="card hidden overflow-x-auto md:block">
              <table className="w-full text-left text-xs">
                <caption className="sr-only">Reports submitted by officers of your station and team</caption>
                <thead>
                  <tr className="border-b border-border/60 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                    <th scope="col" className="px-3 py-2">Report</th>
                    <th scope="col" className="px-3 py-2">Type</th>
                    <th scope="col" className="px-3 py-2">Officer</th>
                    <th scope="col" className="px-3 py-2">Staff ID</th>
                    <th scope="col" className="px-3 py-2">Flight</th>
                    <th scope="col" className="px-3 py-2">Entity</th>
                    <th scope="col" className="px-3 py-2">Station · Team</th>
                    <th scope="col" className="px-3 py-2">Submitted</th>
                    <th scope="col" className="px-3 py-2">Status</th>
                    <th scope="col" className="px-3 py-2">Acknowledgment</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/40">
                  {result.rows.map((r) => (
                    <tr key={`${r.source_table}-${r.id}`} className="hover:bg-muted/40">
                      <td className="px-3 py-2 font-mono font-semibold"><Link href={reportViewHref(r.source_table, r.id) ?? "/avsec/history"} className="text-primary underline-offset-2 hover:underline">{r.report_no ?? "Open"}</Link></td>
                      <td className="px-3 py-2">{REPORT_META[r.report_type as ReportType]?.code ?? r.report_type}</td>
                      <td className="px-3 py-2">{r.staff_name ?? "—"}</td>
                      <td className="px-3 py-2 font-mono">{r.staff_id ?? "—"}</td>
                      <td className="px-3 py-2 font-mono">{r.flight ?? "—"}</td>
                      <td className="px-3 py-2">{r.entity ? ENTITY_LABEL[r.entity] ?? r.entity : "—"}</td>
                      <td className="px-3 py-2">{r.station} · {r.team}</td>
                      <td className="px-3 py-2 font-mono">{r.submitted_at ? formatDateTimeMY(r.submitted_at) : "—"}</td>
                      <td className="px-3 py-2 capitalize">{r.status}</td>
                      <td className="px-3 py-2">{r.acknowledged_at ? `Acknowledged by ${r.acknowledged_by_name ?? "—"}` : r.can_acknowledge ? "Awaiting your acknowledgment" : "Not acknowledged"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex items-center justify-between gap-2 font-mono text-xs">
              {filters.page > 1 ? <Link href={teamHistoryHref(filters, { page: filters.page - 1 })} className="btn-secondary px-3 py-2">◂ Previous</Link> : <span />}
              {filters.page < result.pageCount ? <Link href={teamHistoryHref(filters, { page: filters.page + 1 })} className="btn-secondary px-3 py-2">Next ▸</Link> : <span />}
            </div>
          </>
        )}
      </div>
    </main>
  );
}
