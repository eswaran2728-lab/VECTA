import { notFound } from "next/navigation";
import { requireProfile } from "@/lib/auth";
import { getDutyRecordDetail } from "@/lib/duty/timesheet-queries";
import { getDutyZone } from "@/lib/duty/checkin-queries";
import { AppHeader } from "@/components/layout/AppHeader";
import { BottomNav } from "@/components/layout/BottomNav";
import { formatDateMY, formatTimeMY } from "@/lib/datetime";

const STATUS_LABEL: Record<string, string> = {
  present: "Present",
  late: "Late",
  absent: "Absent",
  pending: "Pending",
};

function FenceBadge({ inside }: { inside: boolean | null }) {
  if (inside === null) return null;
  const color = inside ? "var(--green)" : "var(--red)";
  return (
    <span
      className="t-mono text-[8.5px] font-bold px-1.5 py-0.5"
      style={{ letterSpacing: "0.06em", color, border: `1px solid ${color}` }}
    >
      {inside ? "IN FENCE" : "OUT OF FENCE"}
    </span>
  );
}

export default async function DutyViewPage({ params }: { params: { id: string } }) {
  const profile = await requireProfile();

  // RLS scopes this select to records the caller may see (own, or monitor within
  // rank/station/team) — a null result means either "doesn't exist" or "no access",
  // same as the report view page.
  const record = await getDutyRecordDetail(params.id);
  if (!record) notFound();

  const zone = record.zone_id ? await getDutyZone(record.zone_id) : null;
  const statusColor = record.status === "late" ? "var(--red)" : "var(--green)";

  return (
    <main className="min-h-screen pb-32">
      <AppHeader profile={profile} title="Duty Record" backHref="/duty/timesheet" />

      <div style={{ background: "var(--view-header)", borderBottom: "1px solid var(--line)" }} className="px-4 py-5">
        <div className="max-w-2xl mx-auto">
          <div className="flex items-center justify-between gap-2">
            <span className="t-mono text-[10px]" style={{ color: "var(--mid)" }}>
              {record.shift_code} SHIFT
            </span>
            <span
              className="t-mono text-[9px] font-bold uppercase px-2.5 py-1"
              style={{ letterSpacing: "0.14em", background: statusColor, color: "var(--on-gold)" }}
            >
              {STATUS_LABEL[record.status] ?? record.status}
            </span>
          </div>
          <h1 className="t-display text-xl mt-3">{formatDateMY(record.duty_date + "T00:00:00+08:00")}</h1>
          <p className="t-mono text-[10px] mt-2" style={{ color: "var(--soft)" }}>
            {record.station}
            {record.team ? ` · ${record.team}` : ""}
            {zone ? ` · ${zone.name}` : ""}
          </p>
        </div>
      </div>

      <div className="max-w-2xl mx-auto px-4 py-6 space-y-4">
        {(record.late_minutes > 0 || record.early_out_minutes > 0) && (
          <div className="card p-4 space-y-2" style={{ borderLeft: "3px solid var(--red)" }}>
            {record.late_minutes > 0 && (
              <p className="text-[13px]" style={{ color: "var(--ink2)" }}>
                <span className="t-mono text-[10px] font-bold" style={{ color: "var(--red)" }}>
                  LATE {record.late_minutes} MIN
                </span>
                <br />
                {record.late_remark}
              </p>
            )}
            {record.early_out_minutes > 0 && (
              <p className="text-[13px]" style={{ color: "var(--ink2)" }}>
                <span className="t-mono text-[10px] font-bold" style={{ color: "var(--red)" }}>
                  EARLY OUT {record.early_out_minutes} MIN
                </span>
                <br />
                {record.early_out_remark}
              </p>
            )}
          </div>
        )}

        {(record.post_assignment || record.handover_notes) && (
          <div className="card p-4 space-y-2">
            {record.post_assignment && (
              <div>
                <p className="field-label">Post assignment</p>
                <p className="text-[13px]" style={{ color: "var(--ink2)" }}>
                  {record.post_assignment}
                </p>
              </div>
            )}
            {record.handover_notes && (
              <div>
                <p className="field-label">Handover notes</p>
                <p className="text-[13px]" style={{ color: "var(--ink2)" }}>
                  {record.handover_notes}
                </p>
              </div>
            )}
          </div>
        )}

        <section className="card p-4 sm:p-5">
          <h2 className="section-title mb-3">Record Trail</h2>
          <div className="space-y-3">
            {record.check_in_at && (
              <div className="grid grid-cols-[44px_1fr] gap-3">
                <p className="t-mono text-[11px]" style={{ color: "var(--mid)" }}>
                  {formatTimeMY(record.check_in_at)}
                </p>
                <div className="relative pl-[18px]" style={{ borderLeft: "1px solid var(--line3)" }}>
                  <span
                    className="absolute -left-[4.5px] top-1 w-2 h-2 rounded-full"
                    style={{ background: "var(--gold-fill)" }}
                  />
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="font-semibold text-[13px]" style={{ color: "var(--ink2)" }}>
                      Checked in
                    </p>
                    <FenceBadge inside={record.check_in_inside_fence} />
                    {record.check_in_offline && (
                      <span
                        className="t-mono text-[8.5px] font-bold px-1.5 py-0.5"
                        style={{ letterSpacing: "0.06em", color: "var(--blue)", border: "1px solid var(--blue)" }}
                      >
                        SYNCED OFFLINE
                      </span>
                    )}
                  </div>
                  <p className="t-mono text-[10.5px] mt-[2px]" style={{ color: "var(--soft)" }}>
                    Accuracy ±{Math.round(record.check_in_accuracy_m ?? 0)}m
                  </p>
                </div>
              </div>
            )}
            {record.check_out_at && (
              <div className="grid grid-cols-[44px_1fr] gap-3">
                <p className="t-mono text-[11px]" style={{ color: "var(--mid)" }}>
                  {formatTimeMY(record.check_out_at)}
                </p>
                <div className="relative pl-[18px]" style={{ borderLeft: "1px solid var(--line3)" }}>
                  <span
                    className="absolute -left-[4.5px] top-1 w-2 h-2 rounded-full"
                    style={{ background: "var(--blue)" }}
                  />
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="font-semibold text-[13px]" style={{ color: "var(--ink2)" }}>
                      Checked out
                    </p>
                    <FenceBadge inside={record.check_out_inside_fence} />
                  </div>
                </div>
              </div>
            )}
            {!record.check_out_at && record.check_in_at && (
              <p className="t-mono text-[10.5px]" style={{ color: "var(--faint)" }}>
                Still on duty — no check-out yet.
              </p>
            )}
          </div>
        </section>
      </div>
      <BottomNav profile={profile} />
    </main>
  );
}
