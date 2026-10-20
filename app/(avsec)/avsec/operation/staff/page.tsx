import Link from "next/link";
import { redirect } from "next/navigation";
import { requireProfile } from "@/lib/avsec/auth";
import type { CanonicalAccess } from "@/lib/auth/canonical-access";
import { createClient } from "@/lib/supabase/server";

/**
 * Operation Manager: READ-ONLY operational staff search. User accounts are administered by the MAA / AAX Admin of the person's own
 * entity (registration and staff accounts) and, for exceptional platform tasks, Super Admin -- never from this page.
 */
export default async function OperationStaffPage({ searchParams: searchParamsPromise }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const profile = await requireProfile();
  if (!(profile.canonical as CanonicalAccess).roleCodes.includes("operation_manager")) redirect("/avsec/my-dashboard");
  const params = await searchParamsPromise;
  const q = (params.q ?? "").trim().slice(0, 60) || null;
  const pageRaw = Number.parseInt(params.page ?? "1", 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.min(pageRaw, 10_000) : 1;
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("search_operation_staff_secure", { p_search: q, p_page: page, p_page_size: 50 });
  const total = data && data.length > 0 ? Number(data[0].total_count) : 0;
  const lastPage = Math.max(1, Math.ceil(total / 50));
  const href = (p: number) => `/avsec/operation/staff?${new URLSearchParams({ ...(q ? { q } : {}), page: String(p) }).toString()}`;

  return (
    <main className="min-h-screen pb-24">
      <div className="mx-auto max-w-5xl space-y-4 px-4 py-6">
        <header className="space-y-1">
          <h1 className="font-display text-xl font-bold">Operation staff (read-only)</h1>
          <p className="font-mono text-xs text-muted-foreground">Search only. Account changes are made by the MAA or AAX Admin of the person&apos;s entity.</p>
        </header>
        <form method="get" className="card flex flex-wrap items-end gap-3 p-4" aria-label="Staff search">
          <label className="space-y-1 text-xs">
            <span className="font-mono text-muted-foreground">Name or staff number</span>
            <input name="q" defaultValue={q ?? ""} className="input-base w-56" maxLength={60} />
          </label>
          <button type="submit" className="btn-primary min-h-[44px] px-4 text-xs">Search</button>
        </form>
        {error && <p className="font-mono text-xs text-destructive" role="alert">The staff list could not be loaded right now.</p>}
        {!error && (data ?? []).length === 0 && <p className="card p-6 text-center font-mono text-xs text-muted-foreground" role="status">No staff match.</p>}
        {(data ?? []).length > 0 && (
          <div className="card overflow-x-auto p-4">
            <p className="mb-2 font-mono text-[11px] text-muted-foreground" role="status">{total} staff · page {page} of {lastPage}</p>
            <table className="w-full min-w-[34rem] text-left text-xs">
              <thead className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                <tr><th className="py-2 pr-3">Staff no.</th><th className="py-2 pr-3">Name</th><th className="py-2 pr-3">Role</th><th className="py-2 pr-3">Hub</th><th className="py-2 pr-3">Station</th><th className="py-2 pr-3">Team</th></tr>
              </thead>
              <tbody>
                {(data ?? []).map((s) => (
                  <tr key={`${s.staff_no}:${s.role_code}`} className="border-t border-border/60">
                    <td className="py-2 pr-3 font-mono">{s.staff_no}</td><td className="py-2 pr-3">{s.staff_name}</td><td className="py-2 pr-3 font-mono">{s.role_code}</td>
                    <td className="py-2 pr-3">{s.hub_code ?? "—"}</td><td className="py-2 pr-3">{s.station_code ?? "—"}</td><td className="py-2 pr-3">{s.team_name ?? "—"}</td>
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
