import Link from "next/link";
import { requireRole, MONITOR_ROLES } from "@/lib/avsec/auth";
import { getFlightDetail } from "@/lib/dashboard/flight-detail";
import { formatDateTimeMY } from "@/lib/avsec/datetime";

export default async function FlightDetailPage({
  searchParams: searchParamsPromise,
}: {
  searchParams: Promise<{ flight?: string; date?: string; station?: string }>;
}) {
  await requireRole(MONITOR_ROLES);
  const searchParams = await searchParamsPromise;
  const { flight, date, station } = searchParams;

  if (!flight || !date || !station) {
    return (
      <main className="min-h-screen pb-32">
        <div className="max-w-3xl mx-auto px-4 py-6">
          <p className="font-mono text-sm text-muted-foreground">
            Missing flight, date, or station. <Link href="/avsec/flights" className="text-primary">Back to Flight Records →</Link>
          </p>
        </div>
      </main>
    );
  }

  const detail = await getFlightDetail(flight, date, station);
  const hasAnyRecords =
    detail.sec016Reports.length > 0 ||
    detail.sec029Reports.length > 0 ||
    detail.transactions.length > 0 ||
    detail.incidents.length > 0;

  return (
    <main className="min-h-screen pb-32">
      <div className="max-w-3xl mx-auto px-4 py-6 space-y-6">
        <div>
          <Link href="/avsec/flights" className="font-mono text-xs text-primary">← Flight Records</Link>
          <h1 className="font-display font-bold text-2xl text-foreground mt-1">
            {detail.flight} · {detail.date}
          </h1>
          <p className="font-mono text-xs text-muted-foreground">{detail.station} · Read-only aggregated view</p>
        </div>

        {!hasAnyRecords && (
          <p className="card p-4 font-mono text-xs text-muted-foreground">
            No records found for this flight, date, and station combination.
          </p>
        )}

        {detail.sec016Reports.length > 0 && (
          <section className="card p-4">
            <h2 className="section-title mb-3">SEC016 — Aircraft Attending Flight Report</h2>
            <div className="divide-y divide-border text-sm">
              {detail.sec016Reports.map((r) => (
                <Link
                  key={r.id}
                  href={`/avsec/reports/view/sec016/${r.id}`}
                  className="flex items-center justify-between py-2 hover:bg-card/40 group"
                >
                  <span className="font-semibold text-foreground group-hover:text-primary transition-colors">
                    {r.flightType ?? "—"} · Reg {r.regNo ?? "—"}
                  </span>
                  <span className="font-mono text-xs text-muted-foreground">
                    {r.submittedAt ? formatDateTimeMY(r.submittedAt) : "—"}
                  </span>
                </Link>
              ))}
            </div>
          </section>
        )}

        {detail.sec029Reports.length > 0 && (
          <section className="card p-4">
            <h2 className="section-title mb-3">SEC029 — Aircraft Search Checklist</h2>
            <div className="divide-y divide-border text-sm">
              {detail.sec029Reports.map((r) => (
                <Link
                  key={r.id}
                  href={`/avsec/reports/view/sec029/${r.id}`}
                  className="flex items-center justify-between py-2 hover:bg-card/40 group"
                >
                  <span className="font-semibold text-foreground group-hover:text-primary transition-colors">
                    Reg {r.regNo ?? "—"}
                  </span>
                  <span className="font-mono text-xs text-muted-foreground">
                    {r.submittedAt ? formatDateTimeMY(r.submittedAt) : "—"}
                  </span>
                </Link>
              ))}
            </div>
          </section>
        )}

        {detail.transactions.length > 0 && (
          <section className="card p-4">
            <h2 className="section-title mb-3">CaterLink Movements</h2>
            <div className="divide-y divide-border text-sm">
              {detail.transactions.map((t) => (
                <Link
                  key={t.id}
                  href={`/icms/transactions/${t.id}`}
                  className="flex items-center justify-between py-2 hover:bg-card/40 group"
                >
                  <div>
                    <span className="font-semibold text-foreground group-hover:text-primary transition-colors">
                      {t.transactionNumber} · {t.direction ?? "—"}
                    </span>
                    <p className="font-mono text-xs text-muted-foreground">{t.status}{t.driverName ? ` · ${t.driverName}` : ""}</p>
                  </div>
                  <span className="font-mono text-xs text-muted-foreground">{formatDateTimeMY(t.createdAt)}</span>
                </Link>
              ))}
            </div>
          </section>
        )}

        {detail.incidents.length > 0 && (
          <section className="card border-destructive/40 bg-destructive/10 p-4">
            <h2 className="font-bold text-destructive mb-3 font-mono text-xs uppercase tracking-wider">Incidents</h2>
            <div className="divide-y divide-border text-sm">
              {detail.incidents.map((i) => (
                <Link
                  key={i.id}
                  href={`/icms/incidents?highlight=${i.id}`}
                  className="flex items-center justify-between py-2 hover:bg-card/40 group"
                >
                  <span className="font-semibold text-foreground group-hover:text-primary transition-colors">
                    {i.incidentType} · {i.transactionNumber ?? "—"}
                  </span>
                  <span className="font-mono text-xs text-muted-foreground">{i.status} · {formatDateTimeMY(i.createdAt)}</span>
                </Link>
              ))}
            </div>
          </section>
        )}

        {detail.officers.length > 0 && (
          <section className="card p-4">
            <h2 className="section-title mb-3">Assigned Officers &amp; Staff</h2>
            <div className="divide-y divide-border text-sm">
              {detail.officers.map((o, i) => (
                <div key={i} className="flex items-center justify-between py-2">
                  <span className="font-semibold text-foreground">{o.name}</span>
                  <span className="font-mono text-xs text-muted-foreground">
                    {o.role}
                    {o.staffId ? ` · ${o.staffId}` : ""}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
