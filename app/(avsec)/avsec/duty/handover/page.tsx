import Link from "next/link";
import { requireProfile } from "@/lib/avsec/auth";
import { getVisibleHandovers } from "@/lib/avsec/duty/handover-queries";
import { formatDateTimeMY } from "@/lib/avsec/datetime";
import { AcknowledgeControl } from "@/components/avsec/duty/AcknowledgeControl";

export default async function ShiftHandoverPage() {
  const profile = await requireProfile();
  const handovers = await getVisibleHandovers();

  const pending = handovers.filter((h) => !h.acknowledged_at);
  const history = handovers.filter((h) => h.acknowledged_at);

  return (
    <main className="min-h-screen bg-background pb-28">
      <div className="mx-auto max-w-3xl space-y-6 px-4 py-6">
        <div className="flex items-center justify-between gap-3">
          <div>
            <span className="font-display text-base font-extrabold tracking-[0.06em] text-foreground">
              SHIFT HANDOVER
            </span>
            <p className="font-mono text-xs text-muted-foreground mt-0.5">
              {profile.station ?? "—"}
              {profile.team ? ` · ${profile.team}` : ""}
            </p>
          </div>
          <Link href="/avsec/duty/handover/new" className="btn-primary text-xs px-4 py-2">
            + New Handover
          </Link>
        </div>

        <section className="space-y-3">
          <h2 className="section-title">
            Pending Acknowledgment ({pending.length})
          </h2>
          {pending.length === 0 ? (
            <div className="card p-6 text-center font-mono text-xs text-muted-foreground">
              No handovers awaiting acknowledgment.
            </div>
          ) : (
            <div className="space-y-3">
              {pending.map((h) => (
                <div key={h.id} className="card p-4 border-l-4 border-l-amber-500 bg-amber-500/5 space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-semibold text-sm text-foreground">
                        {h.staff_name} ({h.staff_id}) — {h.team ?? "—"}
                      </p>
                      <p className="font-mono text-xs text-muted-foreground">
                        {h.place_category}: {h.place_detail}
                        {h.flight_number ? ` · Flight ${h.flight_number}` : ""}
                      </p>
                      <p className="font-mono text-[10px] text-muted-foreground mt-0.5">
                        {formatDateTimeMY(h.created_at)}
                      </p>
                    </div>
                  </div>

                  <p className="text-sm text-foreground bg-background/60 rounded p-2.5 border border-border/50">
                    {h.handover_notes}
                  </p>

                  {h.unfinished_work_summary.length > 0 && (
                    <div className="space-y-1">
                      <p className="font-mono text-[10px] font-bold text-muted-foreground uppercase tracking-wider">
                        Unfinished Work ({h.unfinished_work_summary.length})
                      </p>
                      <div className="divide-y divide-border/40">
                        {h.unfinished_work_summary.map((item, i) => (
                          <div key={i} className="py-1.5 text-xs">
                            <span className="font-mono text-[10px] text-primary">{item.category}</span>
                            <p className="text-foreground">{item.summary}</p>
                            <p className="font-mono text-[10px] text-muted-foreground">
                              {item.responsibleOfficer} — {item.nextAction}
                            </p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <AcknowledgeControl handoverId={h.id} />
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="space-y-3">
          <h2 className="section-title">History ({history.length})</h2>
          <div className="divide-y divide-border">
            {history.map((h) => (
              <div key={h.id} className="py-3 text-sm">
                <p className="font-semibold text-foreground">
                  {h.staff_name} ({h.staff_id}) — {h.team ?? "—"}
                </p>
                <p className="font-mono text-xs text-muted-foreground">
                  {h.place_category}: {h.place_detail}
                  {h.flight_number ? ` · Flight ${h.flight_number}` : ""}
                </p>
                <p className="font-mono text-[10px] text-emerald-500 mt-0.5">
                  Acknowledged {h.acknowledged_at ? formatDateTimeMY(h.acknowledged_at) : ""}
                  {h.acknowledgment_notes ? ` — "${h.acknowledgment_notes}"` : ""}
                </p>
              </div>
            ))}
            {history.length === 0 && (
              <p className="font-mono text-xs text-muted-foreground py-3">No acknowledged handovers yet.</p>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
