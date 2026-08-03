import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { getOverdueAircraft, getMySubmissions } from "@/lib/reports/queries";
import { REPORT_META } from "@/lib/reference-data";
import { AppHeader } from "@/components/layout/AppHeader";
import { formatDateTimeMY } from "@/lib/datetime";

export default async function HomePage() {
  const profile = await requireRole(["ASO"]);
  const [overdue, recent] = await Promise.all([
    profile.station ? getOverdueAircraft(profile.station) : Promise.resolve([]),
    getMySubmissions({ profileId: profile.id, limit: 5 }),
  ]);

  return (
    <main className="min-h-screen pb-12">
      <AppHeader profile={profile} />

      <div className="max-w-3xl mx-auto px-4 py-6 space-y-6">
        {overdue.length > 0 && (
          <section className="card border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/30 p-4">
            <h2 className="font-bold text-red-800 dark:text-red-300 mb-2">
              ⚠ {overdue.length} aircraft overdue for search (SEC 029)
            </h2>
            <ul className="space-y-1 text-sm text-red-700 dark:text-red-300">
              {overdue.map((a) => (
                <li key={a.id}>
                  Reg <span className="font-semibold">{a.reg_no}</span> · Bay {a.bay} ·{" "}
                  {a.hoursOnGround.toFixed(1)}h on ground
                </li>
              ))}
            </ul>
            <Link href="/bay-board" className="btn-quiet mt-2 inline-block">
              Open Bay Board →
            </Link>
          </section>
        )}

        <section>
          <h2 className="section-title mb-3">New report</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {(["sec016", "sec014", "sec029", "sec018"] as const).map((type) => (
              <Link
                key={type}
                href={`/reports/${type}`}
                className="card p-5 hover:border-brand-500 hover:shadow-md transition-all active:scale-[0.99]"
              >
                <p className="form-code-badge mb-2">{REPORT_META[type].code}</p>
                <p className="font-bold leading-snug">{REPORT_META[type].name}</p>
              </Link>
            ))}
          </div>
        </section>

        <section className="flex items-center justify-between">
          <h2 className="section-title">My submissions</h2>
          <Link href="/history" className="btn-quiet">
            View all →
          </Link>
        </section>

        <section className="card divide-y divide-slate-200 dark:divide-slate-800">
          {recent.length === 0 && (
            <p className="p-4 text-sm text-slate-500 dark:text-slate-400">
              No submissions yet. Your submitted reports will appear here.
            </p>
          )}
          {recent.map((r) => (
            <Link
              key={`${r.type}-${r.id}`}
              href={`/reports/view/${r.type}/${r.id}`}
              className="flex items-center justify-between p-4 hover:bg-slate-50 dark:hover:bg-slate-800/50"
            >
              <div className="min-w-0">
                <p className="font-semibold text-sm truncate">{REPORT_META[r.type].name}</p>
                <p className="text-xs text-slate-500 dark:text-slate-400 truncate">{r.summary}</p>
              </div>
              <span className="text-xs text-slate-400 shrink-0 ml-3">
                {formatDateTimeMY(r.submitted_at ?? r.created_at)}
              </span>
            </Link>
          ))}
        </section>

        <Link href="/bay-board" className="btn-secondary w-full">
          Bay Board
        </Link>
      </div>
    </main>
  );
}
