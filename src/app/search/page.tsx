import Link from "next/link";
import { requireRole, ENFORCEMENT_ROLES } from "@/lib/auth";
import { searchByAircraftReg } from "@/lib/search/queries";
import { AppHeader } from "@/components/layout/AppHeader";
import { BottomNav } from "@/components/layout/BottomNav";
import { REPORT_META } from "@/lib/reference-data";
import { formatDateTimeMY } from "@/lib/datetime";

export default async function SearchPage({
  searchParams,
}: {
  searchParams: { reg?: string };
}) {
  const profile = await requireRole(ENFORCEMENT_ROLES);
  const reg = (searchParams.reg || "").trim();
  const results = reg ? await searchByAircraftReg(reg) : [];

  return (
    <main className="min-h-screen pb-32">
      <AppHeader profile={profile} title="Search by aircraft" backHref="/dashboard" />
      <div className="max-w-2xl mx-auto px-4 py-6 space-y-4">
        <form method="get" className="flex gap-2">
          <input
            name="reg"
            defaultValue={reg}
            placeholder="Aircraft registration, e.g. 9M-AAB"
            className="input-base flex-1"
            autoCapitalize="characters"
          />
          <button type="submit" className="btn-primary shrink-0">
            Search
          </button>
        </form>

        {reg && (
          <section className="card divide-y divide-slate-200 dark:divide-slate-800">
            <div className="p-3 flex items-center justify-between text-sm">
              <span className="text-slate-500 dark:text-slate-400">
                Results for &quot;{reg}&quot;
              </span>
              <span className="text-slate-500 dark:text-slate-400">{results.length} reports</span>
            </div>
            {results.length === 0 && (
              <p className="p-4 text-sm text-slate-500 dark:text-slate-400">
                No submitted reports found for this registration.
              </p>
            )}
            {results.map((r) => (
              <Link
                key={`${r.reportType}-${r.reportId}-${r.regNo}`}
                href={`/reports/view/${r.reportType}/${r.reportId}`}
                className="flex items-center justify-between p-4 hover:bg-slate-50 dark:hover:bg-slate-800/50"
              >
                <div className="min-w-0">
                  <p className="font-mono text-xs text-slate-400">{REPORT_META[r.reportType].code}</p>
                  <p className="font-semibold text-sm">
                    {r.regNo} · Submitted by {r.staffName}
                  </p>
                  <p className="text-xs text-slate-500 dark:text-slate-400">{r.detail}</p>
                </div>
                <span className="text-xs text-slate-500 text-right shrink-0 ml-3">
                  {r.station} · {r.team}
                  <br />
                  {r.submittedAt ? formatDateTimeMY(r.submittedAt) : "—"}
                </span>
              </Link>
            ))}
          </section>
        )}
      </div>
      <BottomNav profile={profile} />
    </main>
  );
}
