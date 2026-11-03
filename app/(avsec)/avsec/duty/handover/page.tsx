import Link from "next/link";
import { requireAttendanceProfile } from "@/lib/avsec/auth";
import { getVisibleHandovers, type ShiftHandoverRow } from "@/lib/avsec/duty/handover-queries";
import { formatDateTimeMY } from "@/lib/avsec/datetime";
import { AcknowledgeControl } from "@/components/avsec/duty/AcknowledgeControl";
import { HandoverRecipientActions, HandoverSenderActions } from "@/components/avsec/duty/HandoverActionsClient";

function UnfinishedWork({ h }: { h: ShiftHandoverRow }) {
  if (h.unfinished_work_summary.length === 0) return null;
  return (
    <div className="space-y-1">
      <p className="font-mono text-[10px] font-bold text-muted-foreground uppercase tracking-wider">Unfinished Work ({h.unfinished_work_summary.length})</p>
      <div className="divide-y divide-border/40">
        {h.unfinished_work_summary.map((item, i) => (
          <div key={i} className="py-1.5 text-xs">
            <span className="font-mono text-[10px] text-primary">{item.category}</span>
            <p className="text-foreground">{item.summary}</p>
            <p className="font-mono text-[10px] text-muted-foreground">{item.responsibleOfficer} — {item.nextAction}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function Header({ h }: { h: ShiftHandoverRow }) {
  return (
    <div>
      <p className="font-semibold text-sm text-foreground">
        {h.staff_name} ({h.staff_id}) — {h.team ?? "—"}
        {h.recipient_name ? ` → ${h.recipient_name}${h.recipient_staff_id ? ` (${h.recipient_staff_id})` : ""}` : ""}
      </p>
      <p className="font-mono text-xs text-muted-foreground">
        {h.place_category}: {h.place_detail}
        {h.flight_number ? ` · Flight ${h.flight_number}` : ""}
      </p>
      <p className="font-mono text-[10px] text-muted-foreground mt-0.5">{formatDateTimeMY(h.created_at)}</p>
    </div>
  );
}

export default async function ShiftHandoverPage() {
  const profile = await requireAttendanceProfile();
  const handovers = await getVisibleHandovers();

  const awaiting = handovers.filter((h) => h.effective_status === "pending" || (h.effective_status === "historical" && !h.acknowledged_at));
  const uncompleted = handovers.filter((h) => h.effective_status === "uncompleted");
  const history = handovers.filter((h) => h.effective_status === "completed" || (h.effective_status === "historical" && h.acknowledged_at));

  return (
    <main className="min-h-screen bg-background pb-28">
      <div className="mx-auto max-w-3xl space-y-6 px-4 py-6">
        <div className="flex items-center justify-between gap-3">
          <div>
            <span className="font-display text-base font-extrabold tracking-[0.06em] text-foreground">SHIFT HANDOVER</span>
            <p className="font-mono text-xs text-muted-foreground mt-0.5">
              {profile.station ?? "—"}
              {profile.team ? ` · ${profile.team}` : ""}
            </p>
          </div>
          <Link href="/avsec/duty/handover/new" className="btn-primary text-xs px-4 py-2">+ New Handover</Link>
        </div>

        <section className="space-y-3">
          <h2 className="section-title">Pending ({awaiting.length})</h2>
          {awaiting.length === 0 ? (
            <div className="card p-6 text-center font-mono text-xs text-muted-foreground">No handovers waiting to be completed.</div>
          ) : (
            <div className="space-y-3">
              {awaiting.map((h) => (
                <div key={h.id} className="card p-4 border-l-4 border-l-amber-500 bg-warning/5 space-y-3">
                  <Header h={h} />
                  <p className="text-sm text-foreground bg-background/60 rounded p-2.5 border border-border/50">{h.handover_notes}</p>
                  <UnfinishedWork h={h} />
                  {h.effective_status === "historical" ? (
                    <AcknowledgeControl handoverId={h.id} />
                  ) : h.outgoing_profile_id === profile.id ? (
                    <HandoverSenderActions handoverId={h.id} />
                  ) : h.recipient_profile_id === profile.id ? (
                    <HandoverRecipientActions handoverId={h.id} />
                  ) : (
                    <p className="font-mono text-[11px] text-muted-foreground">Waiting for {h.recipient_name ?? "the receiving officer"} to receive this in person.</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>

        {uncompleted.length > 0 && (
          <section className="space-y-3">
            <h2 className="section-title">Uncompleted ({uncompleted.length})</h2>
            <div className="divide-y divide-border">
              {uncompleted.map((h) => (
                <div key={h.id} className="py-3 text-sm">
                  <Header h={h} />
                  <p className="font-mono text-[10px] text-warning mt-0.5">Not completed before the outgoing officer checked out or the duty date ended. Responsibility was not transferred.</p>
                </div>
              ))}
            </div>
          </section>
        )}

        <section className="space-y-3">
          <h2 className="section-title">History ({history.length})</h2>
          <div className="divide-y divide-border">
            {history.map((h) => (
              <div key={h.id} className="py-3 text-sm">
                <Header h={h} />
                {h.effective_status === "completed" ? (
                  <p className="font-mono text-[10px] text-success mt-0.5">
                    Received by {h.recipient_name} {h.completed_at ? formatDateTimeMY(h.completed_at) : ""}
                    {h.verification?.distance_m != null ? ` · phones ${h.verification.distance_m} m apart` : ""}
                    {h.acknowledgment_notes ? ` — "${h.acknowledgment_notes}"` : ""}
                  </p>
                ) : (
                  <p className="font-mono text-[10px] text-muted-foreground mt-0.5">
                    Earlier record (not verified in person). Acknowledged {h.acknowledged_at ? formatDateTimeMY(h.acknowledged_at) : ""}
                    {h.acknowledgment_notes ? ` — "${h.acknowledgment_notes}"` : ""}
                  </p>
                )}
              </div>
            ))}
            {history.length === 0 && <p className="font-mono text-xs text-muted-foreground py-3">No completed handovers yet.</p>}
          </div>
        </section>
      </div>
    </main>
  );
}
