import Link from "next/link";
import { notFound } from "next/navigation";
import { requireProfile } from "@/lib/avsec/auth";
import { getDutyRecordDetail } from "@/lib/avsec/duty/timesheet-queries";
import { getDutyZone } from "@/lib/avsec/duty/checkin-queries";
import { TeamBottomNav } from "@/components/layout/TeamBottomNav";
import { ORG_WIDE_ROLES } from "@/lib/avsec/reference-data";
import { formatDateMY, formatTimeMY } from "@/lib/avsec/datetime";

const STATUS_LABEL: Record<string, string> = {
  present: "Present",
  late: "Late",
  absent: "Absent",
  pending: "Pending",
};

function FenceBadge({ inside }: { inside: boolean | null }) {
  if (inside === null) return null;
  return (
    <span
      className={`rounded-full border px-1.5 py-0.5 font-mono text-[8.5px] font-bold tracking-[0.06em] ${
        inside ? "border-success text-success" : "border-brand text-brand"
      }`}
    >
      {inside ? "IN FENCE" : "OUT OF FENCE"}
    </span>
  );
}

export default async function DutyViewPage({ params: paramsPromise }: { params: Promise<{ id: string }> }) {
  const params = await paramsPromise;
  const profile = await requireProfile();
  const orgWide = (ORG_WIDE_ROLES as readonly string[]).includes(profile.role);

  // RLS scopes this select to records the caller may see (own, or monitor within
  // rank/station/team) — a null result means either "doesn't exist" or "no access",
  // same as the report view page.
  const record = await getDutyRecordDetail(params.id);
  if (!record) notFound();

  const zone = record.zone_id ? await getDutyZone(record.zone_id) : null;
  const statusClass = record.status === "late" ? "bg-brand" : "bg-success";

  return (
    <main className="dark min-h-screen bg-background pb-28">
      <div className="flex items-center gap-3 border-b border-border px-6 py-[18px]">
        <Link
          href="/avsec/duty/timesheet"
          aria-label="Back"
          className="flex h-11 w-11 items-center justify-center font-mono text-base text-muted-foreground transition-colors hover:text-foreground"
        >
          &larr;
        </Link>
        <span className="font-display text-base font-extrabold tracking-[0.06em] text-foreground">DUTY RECORD</span>
      </div>

      <div className="border-b border-border bg-card px-4 py-5">
        <div className="mx-auto max-w-2xl">
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-[10px] text-muted-foreground">{record.shift_code} SHIFT</span>
            <span className={`rounded-full px-2.5 py-1 font-mono text-[9px] font-bold uppercase tracking-[0.14em] text-primary-foreground ${statusClass}`}>
              {STATUS_LABEL[record.status] ?? record.status}
            </span>
          </div>
          <h1 className="mt-3 font-display text-xl text-foreground">
            {formatDateMY(record.duty_date + "T00:00:00+08:00")}
          </h1>
          <p className="mt-2 font-mono text-[10px] text-muted-foreground">
            {record.station}
            {record.team ? ` · ${record.team}` : ""}
            {zone ? ` · ${zone.name}` : ""}
          </p>
        </div>
      </div>

      <div className="mx-auto max-w-2xl space-y-4 px-4 py-6">
        <a
          href={`/api/avsec/export/pdf/duty/${record.id}`}
          className="block w-full rounded-full border border-border px-4 py-2.5 text-center font-mono text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground transition-colors hover:border-primary hover:text-foreground"
          target="_blank"
        >
          Download PDF
        </a>

        {(record.late_minutes > 0 || record.early_out_minutes > 0) && (
          <div className="vecta-panel space-y-2 border-l-[3px] border-l-brand !py-4">
            {record.late_minutes > 0 && (
              <p className="text-[13px] text-foreground/90">
                <span className="font-mono text-[10px] font-bold text-brand">LATE {record.late_minutes} MIN</span>
                <br />
                {record.late_remark}
              </p>
            )}
            {record.early_out_minutes > 0 && (
              <p className="text-[13px] text-foreground/90">
                <span className="font-mono text-[10px] font-bold text-brand">EARLY OUT {record.early_out_minutes} MIN</span>
                <br />
                {record.early_out_remark}
              </p>
            )}
          </div>
        )}

        {(record.post_assignment || record.handover_notes) && (
          <div className="vecta-panel space-y-2 !py-4">
            {record.post_assignment && (
              <div>
                <p className="vecta-label">Post assignment</p>
                <p className="text-[13px] text-foreground/90">{record.post_assignment}</p>
              </div>
            )}
            {record.handover_notes && (
              <div>
                <p className="vecta-label">Handover notes</p>
                <p className="text-[13px] text-foreground/90">{record.handover_notes}</p>
              </div>
            )}
          </div>
        )}

        <section className="vecta-panel">
          <h2 className="vecta-eyebrow mb-3">Record Trail</h2>
          <div className="space-y-3">
            {record.check_in_at && (
              <div className="grid grid-cols-[44px_1fr] gap-3">
                <p className="font-mono text-[11px] text-muted-foreground">{formatTimeMY(record.check_in_at)}</p>
                <div className="relative border-l border-border pl-[18px]">
                  <span className="absolute -left-[4.5px] top-1 h-2 w-2 rounded-full bg-primary" />
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-[13px] font-semibold text-foreground">Checked in</p>
                    <FenceBadge inside={record.check_in_inside_fence} />
                    {record.check_in_offline && (
                      <span className="rounded-full border border-primary px-1.5 py-0.5 font-mono text-[8.5px] font-bold tracking-[0.06em] text-primary">
                        SYNCED OFFLINE
                      </span>
                    )}
                  </div>
                  <p className="mt-[2px] font-mono text-[10.5px] text-muted-foreground">
                    Accuracy ±{Math.round(record.check_in_accuracy_m ?? 0)}m
                  </p>
                </div>
              </div>
            )}
            {record.check_out_at && (
              <div className="grid grid-cols-[44px_1fr] gap-3">
                <p className="font-mono text-[11px] text-muted-foreground">{formatTimeMY(record.check_out_at)}</p>
                <div className="relative border-l border-border pl-[18px]">
                  <span className="absolute -left-[4.5px] top-1 h-2 w-2 rounded-full bg-primary" />
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-[13px] font-semibold text-foreground">Checked out</p>
                    <FenceBadge inside={record.check_out_inside_fence} />
                  </div>
                </div>
              </div>
            )}
            {!record.check_out_at && record.check_in_at && (
              <p className="font-mono text-[10.5px] text-muted-foreground">Still on duty — no check-out yet.</p>
            )}
          </div>
        </section>
      </div>

      <TeamBottomNav opsGroup={profile.ops_group} orgWide={orgWide} />
    </main>
  );
}
