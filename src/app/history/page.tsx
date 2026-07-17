import Link from "next/link";
import { requireProfile } from "@/lib/auth";
import { getMySubmissions } from "@/lib/reports/queries";
import { REPORT_META } from "@/lib/reference-data";
import { AppHeader } from "@/components/layout/AppHeader";
import { formatDateTimeMY } from "@/lib/datetime";

export default async function HistoryPage() {
  const profile = await requireProfile();
  const submissions = await getMySubmissions({ profileId: profile.id, limit: 200 });

  return (
    <main className="min-h-screen pb-12">
      <AppHeader profile={profile} title="My submissions" backHref="/home" />
      <div className="max-w-3xl mx-auto px-4 py-6">
        <section className="card divide-y divide-slate-200 dark:divide-slate-800">
          {submissions.length === 0 && (
            <p className="p-4 text-sm text-slate-500 dark:text-slate-400">
              No submissions yet.
            </p>
          )}
          {submissions.map((r) => (
            <Link
              key={`${r.type}-${r.id}`}
              href={`/reports/view/${r.type}/${r.id}`}
              className="flex items-center justify-between p-4 hover:bg-slate-50 dark:hover:bg-slate-800/50"
            >
              <div className="min-w-0">
                <p className="text-xs font-mono text-slate-400">{REPORT_META[r.type].code}</p>
                <p className="font-semibold text-sm truncate">{REPORT_META[r.type].name}</p>
                <p className="text-xs text-slate-500 dark:text-slate-400 truncate">{r.summary}</p>
              </div>
              <span className="text-xs text-slate-400 shrink-0 ml-3 text-right">
                {formatDateTimeMY(r.submitted_at ?? r.created_at)}
              </span>
            </Link>
          ))}
        </section>
      </div>
    </main>
  );
}
