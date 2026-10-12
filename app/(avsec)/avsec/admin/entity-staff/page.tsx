import Link from "next/link";
import { requireEntityLeadership } from "@/lib/dashboard/entity-guard";
import { getEntityAssignmentOptions, listEntityStaff } from "@/lib/avsec/admin/entity-staff";
import { EntityStaffManager } from "@/components/avsec/admin/EntityStaffManager";

/** MAA/AAX Admin: maintain their OWN entity's staff assignments. Every change is re-authorized and audited in the database. */
export default async function EntityStaffPage({ searchParams: searchParamsPromise }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { leadership } = await requireEntityLeadership("admin");
  const params = await searchParamsPromise;
  const search = (params.q ?? "").trim().slice(0, 60) || null;
  const pageRaw = Number.parseInt(params.page ?? "1", 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.min(pageRaw, 10_000) : 1;
  const [list, opts] = await Promise.all([listEntityStaff(search, page), getEntityAssignmentOptions()]);
  const lastPage = Math.max(1, Math.ceil(list.total / 50));
  const href = (p: number) => `/avsec/admin/entity-staff?${new URLSearchParams({ ...(search ? { q: search } : {}), page: String(p) }).toString()}`;

  return (
    <main className="min-h-screen pb-24">
      <div className="mx-auto max-w-4xl space-y-4 px-4 py-6">
        <header className="space-y-1">
          <h1 className="font-display text-xl font-bold">{leadership.entityCode} Staff Accounts</h1>
          <p className="font-mono text-xs text-muted-foreground">
            Deactivate, reassign or transfer {leadership.entityCode} staff. Leadership roles never appear here and you cannot change your own assignment.
          </p>
        </header>
        <form method="get" className="card flex flex-wrap items-end gap-3 p-4" aria-label="Staff search">
          <label className="space-y-1 text-xs">
            <span className="font-mono text-muted-foreground">Name or staff number</span>
            <input name="q" defaultValue={search ?? ""} className="input-base w-56" maxLength={60} />
          </label>
          <button type="submit" className="btn-primary min-h-[44px] px-4 text-xs">
            Search
          </button>
        </form>
        {!list.ok || !opts.ok || !opts.options ? (
          <p className="text-sm text-red-500" role="alert">
            {list.error ?? "The assignment options could not be loaded."}
          </p>
        ) : (
          <>
            <p className="font-mono text-[11px] text-muted-foreground" role="status">
              {list.total} staff · page {page} of {lastPage}
            </p>
            <EntityStaffManager rows={list.rows} options={opts.options} entityCode={leadership.entityCode} />
            <nav className="flex items-center justify-between" aria-label="Pagination">
              {page > 1 ? <Link href={href(page - 1)} className="btn-secondary inline-flex min-h-[44px] items-center px-4 text-xs">← Previous</Link> : <span />}
              {page < lastPage ? <Link href={href(page + 1)} className="btn-secondary inline-flex min-h-[44px] items-center px-4 text-xs">Next →</Link> : <span />}
            </nav>
          </>
        )}
      </div>
    </main>
  );
}
