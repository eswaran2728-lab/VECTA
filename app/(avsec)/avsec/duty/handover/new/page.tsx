import { requireProfile } from "@/lib/avsec/auth";
import { getUnfinishedWorkSummary } from "@/lib/avsec/duty/handover-queries";
import { NewHandoverForm } from "@/components/avsec/duty/NewHandoverForm";

export default async function NewHandoverPage() {
  const profile = await requireProfile();
  const unfinishedWork = profile.station
    ? await getUnfinishedWorkSummary(profile.station, profile.team ?? undefined)
    : [];

  return (
    <main className="min-h-screen bg-background pb-28">
      <div className="mx-auto max-w-2xl space-y-6 px-4 py-6">
        <div>
          <span className="font-display text-base font-extrabold tracking-[0.06em] text-foreground">
            NEW SHIFT HANDOVER
          </span>
          <p className="font-mono text-xs text-muted-foreground mt-0.5">
            {profile.station ?? "—"}
            {profile.team ? ` · ${profile.team}` : ""}
          </p>
        </div>

        <section className="card p-4 space-y-2">
          <h2 className="section-title">
            Unfinished Work Snapshot ({unfinishedWork.length})
          </h2>
          <p className="font-mono text-[11px] text-muted-foreground">
            This is captured automatically and included with your handover record.
          </p>
          {unfinishedWork.length === 0 ? (
            <p className="font-mono text-xs text-muted-foreground py-2">Nothing outstanding right now.</p>
          ) : (
            <div className="divide-y divide-border/40">
              {unfinishedWork.map((item, i) => (
                <div key={i} className="py-2 text-sm">
                  <span className="font-mono text-[10px] text-primary">{item.category}</span>
                  <p className="text-foreground">{item.summary}</p>
                  <p className="font-mono text-[10px] text-muted-foreground">
                    {item.responsibleOfficer} — {item.nextAction}
                  </p>
                </div>
              ))}
            </div>
          )}
        </section>

        <NewHandoverForm
          defaultTeam={profile.team ?? ""}
          defaultStaffName={profile.name}
          defaultStaffId={profile.staff_no}
        />
      </div>
    </main>
  );
}
