import Link from "next/link";
import { requireRouteAccess } from "@/lib/avsec/auth";
import { listReportAudit, listReportGrants, listReportRequests } from "@/lib/avsec/reports/grc";
import { GrcRowActions } from "@/components/avsec/reports/GrcRowActions";

const VIEWS = [
  { id: "requests", label: "Requests" },
  { id: "grants", label: "Grants & expiry" },
  { id: "audit", label: "Export & access audit" },
] as const;

/**
 * Global Reporting Controller workspace. Route access comes from the canonical role table (only global_reporting_controller links
 * here) and every RPC re-checks the role; the page lists identifiers and summaries, never report content.
 */
export default async function ReportRequestsPage({ searchParams: searchParamsPromise }: { searchParams: Promise<Record<string, string | undefined>> }) {
  await requireRouteAccess("/avsec/reports/requests", []);
  const params = await searchParamsPromise;
  const view = VIEWS.some((v) => v.id === params.view) ? (params.view as (typeof VIEWS)[number]["id"]) : "requests";
  const pageRaw = Number.parseInt(params.page ?? "1", 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.min(pageRaw, 10_000) : 1;
  const status = ["pending", "approved", "rejected"].includes(params.status ?? "") ? (params.status as string) : "pending";
  const state = ["active", "scheduled", "expired", "revoked"].includes(params.state ?? "") ? (params.state as string) : null;
  const scope = ["export", "grants", "denied"].includes(params.scope ?? "") ? (params.scope as string) : "export";

  const requests = view === "requests" ? await listReportRequests(status, page) : null;
  const grants = view === "grants" ? await listReportGrants(state, page) : null;
  const audit = view === "audit" ? await listReportAudit(scope, page) : null;
  const total = (requests ?? grants ?? audit)?.total ?? 0;
  const lastPage = Math.max(1, Math.ceil(total / 25));
  const link = (extra: Record<string, string>) => `/avsec/reports/requests?${new URLSearchParams({ view, ...extra }).toString()}`;

  return (
    <main className="min-h-screen pb-24">
      <div className="mx-auto max-w-5xl space-y-4 px-4 py-6">
        <header className="space-y-1">
          <h1 className="font-display text-xl font-bold">Report requests, grants & audit</h1>
          <p className="font-mono text-xs text-muted-foreground">Global Reporting Controller · grants are read-only and time-limited · nothing here shows report content.</p>
        </header>

        <nav className="flex flex-wrap gap-2" aria-label="Views">
          {VIEWS.map((v) => (
            <Link
              key={v.id}
              href={`/avsec/reports/requests?view=${v.id}`}
              aria-current={v.id === view ? "page" : undefined}
              className={`inline-flex min-h-[44px] items-center rounded-lg border px-4 text-xs ${v.id === view ? "border-primary bg-primary text-primary-foreground" : "border-border"}`}
            >
              {v.label}
            </Link>
          ))}
        </nav>

        {view === "requests" && (
          <section className="space-y-3" aria-label="Requests">
            <div className="flex flex-wrap gap-2 text-xs">
              {["pending", "approved", "rejected"].map((s) => (
                <Link key={s} href={link({ status: s })} className={`rounded border px-3 py-2 capitalize ${s === status ? "border-primary" : "border-border"}`}>
                  {s}
                </Link>
              ))}
            </div>
            {requests && !requests.ok && (
              <p className="font-mono text-xs text-red-500" role="alert">
                {requests.error}
              </p>
            )}
            {requests?.ok && requests.rows.length === 0 && (
              <p className="font-mono text-xs text-muted-foreground" role="status">
                No {status} requests.
              </p>
            )}
            {requests?.rows.map((r) => (
              <article key={r.id} className="card space-y-2 p-4">
                <p className="text-sm font-semibold">
                  {r.requesterName} <span className="font-mono text-xs text-muted-foreground">({r.requesterStaffNo})</span>
                </p>
                <p className="font-mono text-[11px] text-muted-foreground">
                  {r.sourceTable} · {r.entityCode ?? "unclassified"} · {r.flightNumber ?? "no flight"} · {r.reportDate ?? "no date"} · asked for{" "}
                  {r.requestedDurationDays ?? "—"} day(s) · {new Date(r.createdAt).toLocaleString("en-MY")}
                </p>
                <p className="text-xs">Reason: {r.businessReason}</p>
                {r.status === "pending" ? (
                  <GrcRowActions kind="request" requestId={r.id} requesterProfileId={r.requesterProfileId} />
                ) : (
                  <p className="font-mono text-[11px] capitalize text-muted-foreground">
                    {r.status}
                    {r.decisionReason ? ` — ${r.decisionReason}` : ""}
                  </p>
                )}
              </article>
            ))}
          </section>
        )}

        {view === "grants" && (
          <section className="space-y-3" aria-label="Grants">
            <div className="flex flex-wrap gap-2 text-xs">
              {[null, "active", "scheduled", "expired", "revoked"].map((s) => (
                <Link key={s ?? "all"} href={link(s ? { state: s } : {})} className={`rounded border px-3 py-2 capitalize ${s === state ? "border-primary" : "border-border"}`}>
                  {s ?? "all"}
                </Link>
              ))}
            </div>
            {grants && !grants.ok && (
              <p className="font-mono text-xs text-red-500" role="alert">
                {grants.error}
              </p>
            )}
            {grants?.ok && grants.rows.length === 0 && (
              <p className="font-mono text-xs text-muted-foreground" role="status">
                No grants in this state.
              </p>
            )}
            {grants?.rows.map((g) => (
              <article key={g.id} className="card space-y-2 p-4">
                <p className="text-sm font-semibold">
                  {g.granteeName} <span className="font-mono text-xs text-muted-foreground">({g.granteeStaffNo})</span> · <span className="capitalize">{g.state}</span>
                </p>
                <p className="font-mono text-[11px] text-muted-foreground">
                  {g.sourceTable} · {g.entityCode ?? "unclassified"} · granted by {g.grantedByName} · from {new Date(g.startsAt).toLocaleString("en-MY")} · expires{" "}
                  {g.expiresAt ? new Date(g.expiresAt).toLocaleString("en-MY") : "never"}
                  {g.revokedAt ? ` · revoked ${new Date(g.revokedAt).toLocaleString("en-MY")}` : ""}
                </p>
                <p className="text-xs">Reason: {g.reason}</p>
                {g.state === "active" || g.state === "scheduled" ? <GrcRowActions kind="grant" grantId={g.id} /> : null}
              </article>
            ))}
          </section>
        )}

        {view === "audit" && (
          <section className="space-y-3" aria-label="Audit">
            <div className="flex flex-wrap gap-2 text-xs">
              {[
                ["export", "Exports, PDFs & downloads"],
                ["grants", "Requests & grants"],
                ["denied", "Denied attempts"],
              ].map(([s, label]) => (
                <Link key={s} href={link({ scope: s })} className={`rounded border px-3 py-2 ${s === scope ? "border-primary" : "border-border"}`}>
                  {label}
                </Link>
              ))}
            </div>
            {audit && !audit.ok && (
              <p className="font-mono text-xs text-red-500" role="alert">
                {audit.error}
              </p>
            )}
            {audit?.ok && audit.rows.length === 0 && (
              <p className="font-mono text-xs text-muted-foreground" role="status">
                No audit events in this scope.
              </p>
            )}
            {audit && audit.rows.length > 0 && (
              <div className="card overflow-x-auto p-4">
                <table className="w-full min-w-[40rem] text-left text-xs">
                  <thead className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                    <tr>
                      <th className="py-2 pr-3">When</th>
                      <th className="py-2 pr-3">Who</th>
                      <th className="py-2 pr-3">Action</th>
                      <th className="py-2 pr-3">Report</th>
                      <th className="py-2 pr-3">Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {audit.rows.map((a) => (
                      <tr key={a.id} className="border-t border-border/60">
                        <td className="py-2 pr-3 font-mono">{new Date(a.createdAt).toLocaleString("en-MY")}</td>
                        <td className="py-2 pr-3">{a.actorName ?? "—"}</td>
                        <td className="py-2 pr-3 font-mono">{a.action}</td>
                        <td className="py-2 pr-3">{a.sourceTable ?? "—"} · {a.entityCode ?? "—"}</td>
                        <td className="py-2 pr-3">{a.reason ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}

        {total > 25 && (
          <nav className="flex items-center justify-between" aria-label="Pagination">
            {page > 1 ? <Link href={link({ status, scope, ...(state ? { state } : {}), page: String(page - 1) })} className="btn-secondary inline-flex min-h-[44px] items-center px-4 text-xs">← Previous</Link> : <span />}
            {page < lastPage ? <Link href={link({ status, scope, ...(state ? { state } : {}), page: String(page + 1) })} className="btn-secondary inline-flex min-h-[44px] items-center px-4 text-xs">Next →</Link> : <span />}
          </nav>
        )}
      </div>
    </main>
  );
}
