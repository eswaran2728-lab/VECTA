import Link from "next/link";
import { requireEntityLeadership } from "@/lib/dashboard/entity-guard";
import { getStaffDirectory } from "@/lib/dashboard/entity-leadership";
import { DirectoryExportButton } from "@/components/dashboard/DirectoryExportButton";

const PAGE_SIZE = 50;

/**
 * Combined Malaysia staff directory (MAA + AAX), safe fields only. This is a SEPARATE function from entity reports: seeing a person
 * here never grants access to any report. Admins may additionally export their OWN entity's directory.
 */
export default async function StaffDirectoryPage({ searchParams: searchParamsPromise }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { leadership } = await requireEntityLeadership("any");
  const params = await searchParamsPromise;
  const search = (params.q ?? "").trim().slice(0, 60) || null;
  const entity = params.entity === "MAA" || params.entity === "AAX" ? params.entity : null;
  const pageRaw = Number.parseInt(params.page ?? "1", 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.min(pageRaw, 10_000) : 1;

  const directory = await getStaffDirectory(search, entity, page, PAGE_SIZE);
  const lastPage = Math.max(1, Math.ceil(directory.total / PAGE_SIZE));
  const href = (p: number) => {
    const q = new URLSearchParams();
    if (search) q.set("q", search);
    if (entity) q.set("entity", entity);
    q.set("page", String(p));
    return `/avsec/directory?${q.toString()}`;
  };

  return (
    <main className="min-h-screen pb-24">
      <div className="mx-auto max-w-5xl space-y-4 px-4 py-6">
        <header className="space-y-1">
          <h1 className="font-display text-xl font-bold tracking-[0.03em]">Malaysia Staff Directory</h1>
          <p className="font-mono text-xs text-muted-foreground">
            MAA and AAX staff, safe fields only. Visibility here does not grant report access.
          </p>
          <Link href="/avsec/entity-reports" className="inline-block font-mono text-xs text-primary">
            {leadership.entityCode} Entity Reports →
          </Link>
        </header>

        <form method="get" className="card flex flex-wrap items-end gap-3 p-4" aria-label="Directory filters">
          <label className="space-y-1 text-xs">
            <span className="font-mono text-muted-foreground">Name or staff number</span>
            <input name="q" defaultValue={search ?? ""} className="input-base w-56" maxLength={60} />
          </label>
          <label className="space-y-1 text-xs">
            <span className="font-mono text-muted-foreground">Entity</span>
            <select name="entity" defaultValue={entity ?? ""} className="input-base">
              <option value="">MAA + AAX</option>
              <option value="MAA">MAA</option>
              <option value="AAX">AAX</option>
            </select>
          </label>
          <button type="submit" className="btn-primary min-h-[44px] px-4 text-xs">
            Search
          </button>
          {leadership.isAdmin ? <DirectoryExportButton entityCode={leadership.entityCode} /> : null}
        </form>

        <section className="card p-4" aria-label="Directory results">
          {directory.status === "error" && (
            <p className="font-mono text-xs text-red-500" role="alert">
              The directory could not be loaded right now. Try again shortly.
            </p>
          )}
          {directory.status === "unauthorized" && <p className="font-mono text-xs italic text-muted-foreground">Not authorized for this scope.</p>}
          {directory.status === "ok" && directory.rows.length === 0 && (
            <p className="font-mono text-xs text-muted-foreground" role="status">
              No staff match these filters.
            </p>
          )}
          {directory.status === "ok" && directory.rows.length > 0 && (
            <>
              <p className="mb-2 font-mono text-[11px] text-muted-foreground" role="status">
                {directory.total} staff · page {page} of {lastPage}
              </p>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[44rem] text-left text-xs">
                  <thead className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                    <tr>
                      <th className="py-2 pr-3">Staff no.</th>
                      <th className="py-2 pr-3">Name</th>
                      <th className="py-2 pr-3">Entity</th>
                      <th className="py-2 pr-3">Role</th>
                      <th className="py-2 pr-3">Department / unit</th>
                      <th className="py-2 pr-3">Hub / station / team</th>
                      <th className="py-2 pr-3">Account</th>
                    </tr>
                  </thead>
                  <tbody>
                    {directory.rows.map((r) => (
                      <tr key={`${r.entityCode}:${r.staffNo}`} className="border-t border-border/60">
                        <td className="py-2 pr-3 font-mono">{r.staffNo}</td>
                        <td className="py-2 pr-3">{r.staffName}</td>
                        <td className="py-2 pr-3 font-mono">{r.entityCode}</td>
                        <td className="py-2 pr-3 font-mono">{r.roleCode ?? "—"}</td>
                        <td className="py-2 pr-3">{[r.departmentCode, r.unitCode].filter(Boolean).join(" / ") || "—"}</td>
                        <td className="py-2 pr-3">{[r.hubCode, r.stationCode, r.teamName].filter(Boolean).join(" / ") || "—"}</td>
                        <td className="py-2 pr-3 capitalize">{r.accountState}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <nav className="mt-3 flex items-center justify-between" aria-label="Pagination">
                {page > 1 ? (
                  <Link href={href(page - 1)} className="btn-secondary inline-flex min-h-[44px] items-center px-4 text-xs">
                    ← Previous
                  </Link>
                ) : (
                  <span />
                )}
                {page < lastPage ? (
                  <Link href={href(page + 1)} className="btn-secondary inline-flex min-h-[44px] items-center px-4 text-xs">
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
