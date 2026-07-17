import { requireProfile } from "@/lib/auth";
import { getOpenBayBoard } from "@/lib/reports/queries";
import { AppHeader } from "@/components/layout/AppHeader";
import { AddBayBoardForm } from "@/components/forms/AddBayBoardForm";
import { formatDateTimeMY } from "@/lib/datetime";
import { cn } from "@/lib/utils";

export default async function BayBoardPage() {
  const profile = await requireProfile();
  const entries = profile.station ? await getOpenBayBoard(profile.station) : [];

  return (
    <main className="min-h-screen pb-16">
      <AppHeader profile={profile} title="Bay Board" backHref="/home" />
      <div className="max-w-2xl mx-auto px-4 py-6 space-y-4">
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Aircraft on ground exceeding 4 hours without a completed AIRCRAFT SEARCH CHECKLIST SEC
          029 are flagged in red. Submitting SEC 029 for a registration clears its flag
          automatically.
        </p>

        <AddBayBoardForm station={profile.station!} />

        <div className="space-y-2">
          {entries.length === 0 && (
            <p className="text-sm text-slate-500 dark:text-slate-400 text-center py-6">
              No aircraft currently logged on ground at {profile.station}.
            </p>
          )}
          {entries.map((e) => {
            const overdue = e.hoursOnGround >= 4;
            return (
              <div
                key={e.id}
                className={cn(
                  "card p-4 flex items-center justify-between",
                  overdue && "border-red-400 bg-red-50 dark:bg-red-950/30 dark:border-red-800",
                )}
              >
                <div>
                  <p className="font-bold">
                    {e.reg_no} {e.aircraft_type ? `· ${e.aircraft_type}` : ""}
                  </p>
                  <p className="text-sm text-slate-500 dark:text-slate-400">
                    Bay {e.bay} · on ground since {formatDateTimeMY(e.on_ground_since)}
                  </p>
                </div>
                <div className={cn("text-right font-bold", overdue && "text-red-700 dark:text-red-400")}>
                  {e.hoursOnGround.toFixed(1)}h
                  {overdue && <p className="text-xs font-semibold">SEARCH OVERDUE</p>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </main>
  );
}
