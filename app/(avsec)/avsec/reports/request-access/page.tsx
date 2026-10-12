import Link from "next/link";
import { redirect } from "next/navigation";
import { requireProfile } from "@/lib/avsec/auth";
import type { CanonicalAccess } from "@/lib/auth/canonical-access";
import { listMyRequests, searchReportStubs } from "@/lib/avsec/reports/access-requests";
import { parseEntityReportFilters, REPORT_TYPE_OPTIONS, reportViewHref } from "@/lib/dashboard/entity-report-filters";
import { RequestAccessButton } from "@/components/avsec/reports/RequestAccessButton";

/**
 * GHOD / AirAsia Management: find a report by flight or date and request time-limited, read-only access. The search returns metadata
 * stubs only (no content, staff, station or registration). AirAsia Management stays aggregate-only unless a request is approved.
 */
export default async function RequestAccessPage({ searchParams: searchParamsPromise }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const profile = await requireProfile();
  const roles = (profile.canonical as CanonicalAccess).roleCodes;
  if (!roles.includes("ghod") && !roles.includes("airasia_management")) redirect("/avsec/my-dashboard");
  const params = await searchParamsPromise;
  const f = parseEntityReportFilters(params);
  const searched = Boolean(f.flight || f.from || f.to);
  const [stubs, mine] = await Promise.all([
    searched ? searchReportStubs({ flight: f.flight, from: f.from, to: f.to, type: f.sourceTable, page: f.page }) : Promise.resolve(null),
    listMyRequests(),
  ]);
  const label = (t: string) => REPORT_TYPE_OPTIONS.find((o) => o.value === t)?.label ?? t;

  return (
    <main className="min-h-screen pb-24">
      <div className="mx-auto max-w-4xl space-y-5 px-4 py-6">
        <header className="space-y-1">
          <h1 className="font-display text-xl font-bold">Request report access</h1>
          <p className="font-mono text-xs text-muted-foreground">
            Search by flight or date. You see only that a report exists; access needs the Global Reporting Controller&apos;s approval, is read-only, time-limited and audited.
          </p>
        </header>

        <form method="get" className="card grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4" aria-label="Find a report">
          <label className="space-y-1 text-xs">
            <span className="font-mono text-muted-foreground">Flight number</span>
            <input name="flight" defaultValue={f.flight ?? ""} placeholder="AK703 or D7 123" className="input-base w-full" maxLength={12} />
          </label>
          <label className="space-y-1 text-xs">
            <span className="font-mono text-muted-foreground">From date</span>
            <input type="date" name="from" defaultValue={f.from ?? ""} className="input-base w-full" />
          </label>
          <label className="space-y-1 text-xs">
            <span className="font-mono text-muted-foreground">To date</span>
            <input type="date" name="to" defaultValue={f.to ?? ""} className="input-base w-full" />
          </label>
          <label className="space-y-1 text-xs">
            <span className="font-mono text-muted-foreground">Report type</span>
            <select name="type" defaultValue={f.sourceTable ?? ""} className="input-base w-full">
              <option value="">Any type</option>
              {REPORT_TYPE_OPTIONS.map((o) => (<option key={o.value} value={o.value}>{o.label}</option>))}
            </select>
          </label>
          <div className="sm:col-span-2 lg:col-span-4">
            <button type="submit" className="btn-primary min-h-[44px] px-4 text-xs">Search</button>
          </div>
        </form>

        <section aria-label="Search results" className="space-y-3">
          {!searched && <p className="font-mono text-xs text-muted-foreground" role="status">Enter a flight number or a date range to look for a report.</p>}
          {stubs && !stubs.ok && <p className="font-mono text-xs text-red-500" role="alert">{stubs.error}</p>}
          {stubs?.ok && stubs.rows.length === 0 && <p className="font-mono text-xs text-muted-foreground" role="status">No reports match.</p>}
          {stubs?.rows.map((r) => (
            <article key={r.id} className="card space-y-2 p-4">
              <p className="text-sm font-semibold">{label(r.sourceTable)}</p>
              <p className="font-mono text-[11px] text-muted-foreground">{r.entityCode ?? "unclassified"} · {r.flightNumber ?? "no flight"} · {r.reportDate ?? "no date"} · {r.status}</p>
              {r.alreadyAccessible ? (
                <p className="font-mono text-[11px] text-muted-foreground">You already have access to this report.</p>
              ) : (
                <RequestAccessButton reportId={r.id} label={`${label(r.sourceTable)} ${r.flightNumber ?? ""} ${r.reportDate ?? ""}`} />
              )}
            </article>
          ))}
        </section>

        <section aria-label="My requests" className="space-y-3">
          <h2 className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">My requests ({mine.rows.length})</h2>
          {!mine.ok && <p className="font-mono text-xs text-red-500" role="alert">{mine.error}</p>}
          {mine.ok && mine.rows.length === 0 && <p className="font-mono text-xs text-muted-foreground" role="status">You have not requested any report yet.</p>}
          {mine.rows.map((r) => {
            const href = r.sourceId ? reportViewHref(r.sourceTable, r.sourceId) : null;
            return (
              <article key={r.id} className="card space-y-1 p-4">
                <p className="text-sm font-semibold">{label(r.sourceTable)} · {r.flightNumber ?? "no flight"} · {r.reportDate ?? "no date"}</p>
                <p className="font-mono text-[11px] text-muted-foreground capitalize">
                  {r.status}
                  {r.decisionReason ? ` — ${r.decisionReason}` : ""}
                  {r.grantState ? ` · access ${r.grantState}${r.grantExpiresAt ? ` until ${new Date(r.grantExpiresAt).toLocaleString("en-MY")}` : ""}` : ""}
                </p>
                <p className="text-xs">Reason: {r.businessReason}</p>
                {href ? <Link href={href} className="inline-flex min-h-[44px] items-center font-mono text-xs text-primary">Open report (read-only) →</Link> : null}
              </article>
            );
          })}
        </section>
      </div>
    </main>
  );
}
