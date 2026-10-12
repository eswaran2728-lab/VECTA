import Link from "next/link";
import { redirect } from "next/navigation";
import { requireProfile } from "@/lib/avsec/auth";
import type { CanonicalAccess } from "@/lib/auth/canonical-access";
import { createClient } from "@/lib/supabase/server";

const STATUSES = ["CREATED", "INFLIGHT_POST_APPROVED", "AIRPORT_POST_APPROVED", "REDQ_RESEALED", "POST2_APPROVED", "POST6_APPROVED", "COMPLETED", "ESCALATED"] as const;

/**
 * Read-only CaterLink movement dashboard for Compliance (and the Operation Manager). It lists movements and nothing else: no scanner,
 * no transaction completion, no incident resolution, no QR signing, no whitelist or user administration. The RPC re-checks the role and
 * omits driver identity, QR token and seal values.
 */
export default async function CaterlinkMovementsPage({ searchParams: searchParamsPromise }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const profile = await requireProfile();
  const roles = (profile.canonical as CanonicalAccess).roleCodes;
  if (!roles.includes("compliance") && !roles.includes("operation_manager")) redirect("/avsec/my-dashboard");
  const params = await searchParamsPromise;
  const status = (STATUSES as readonly string[]).includes(params.status ?? "") ? (params.status as string) : null;
  const pageRaw = Number.parseInt(params.page ?? "1", 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.min(pageRaw, 10_000) : 1;

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("list_caterlink_movements_readonly_secure", { p_station_code: null, p_status: status, p_page: page, p_page_size: 25 });
  const total = data && data.length > 0 ? Number(data[0].total_count) : 0;
  const lastPage = Math.max(1, Math.ceil(total / 25));
  const href = (p: number) => `/avsec/caterlink/movements?${new URLSearchParams({ ...(status ? { status } : {}), page: String(p) }).toString()}`;

  return (
    <main className="min-h-screen pb-24">
      <div className="mx-auto max-w-5xl space-y-4 px-4 py-6">
        <header className="space-y-1">
          <h1 className="font-display text-xl font-bold">CaterLink movements (read-only)</h1>
          <p className="font-mono text-xs text-muted-foreground">Live view of Malaysia CaterLink movements. No actions are available here.</p>
        </header>
        <nav className="flex flex-wrap gap-2 text-xs" aria-label="Status filter">
          {[null, ...STATUSES].map((s) => (
            <Link key={s ?? "all"} href={s ? `/avsec/caterlink/movements?status=${s}` : "/avsec/caterlink/movements"} className={`inline-flex min-h-[44px] items-center rounded border px-3 ${s === status ? "border-primary" : "border-border"}`}>
              {s ?? "All"}
            </Link>
          ))}
        </nav>
        {error && (
          <p className="font-mono text-xs text-red-500" role="alert">
            The movements could not be loaded right now.
          </p>
        )}
        {!error && (data ?? []).length === 0 && (
          <p className="card p-6 text-center font-mono text-xs text-muted-foreground" role="status">
            No movements match this filter.
          </p>
        )}
        {(data ?? []).length > 0 && (
          <div className="card overflow-x-auto p-4">
            <table className="w-full min-w-[44rem] text-left text-xs">
              <thead className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="py-2 pr-3">Number</th>
                  <th className="py-2 pr-3">Direction</th>
                  <th className="py-2 pr-3">Route</th>
                  <th className="py-2 pr-3">Status</th>
                  <th className="py-2 pr-3">From → to</th>
                  <th className="py-2 pr-3">Flight</th>
                  <th className="py-2 pr-3">Created</th>
                </tr>
              </thead>
              <tbody>
                {(data ?? []).map((m) => (
                  <tr key={m.id} className="border-t border-border/60">
                    <td className="py-2 pr-3 font-mono">{m.transaction_number}</td>
                    <td className="py-2 pr-3">{m.direction}</td>
                    <td className="py-2 pr-3">{m.route ?? "—"}</td>
                    <td className="py-2 pr-3 font-mono">{m.status ?? "—"}</td>
                    <td className="py-2 pr-3">{m.origin_station ?? "?"} → {m.destination_station ?? "?"}</td>
                    <td className="py-2 pr-3 font-mono">{m.flight_number ?? "—"} {m.aircraft_registration ?? ""}</td>
                    <td className="py-2 pr-3 font-mono">{new Date(m.created_at).toLocaleString("en-MY")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <nav className="flex items-center justify-between" aria-label="Pagination">
          {page > 1 ? <Link href={href(page - 1)} className="btn-secondary inline-flex min-h-[44px] items-center px-4 text-xs">← Previous</Link> : <span />}
          {page < lastPage ? <Link href={href(page + 1)} className="btn-secondary inline-flex min-h-[44px] items-center px-4 text-xs">Next →</Link> : <span />}
        </nav>
      </div>
    </main>
  );
}
