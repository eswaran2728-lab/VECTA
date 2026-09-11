import Link from "next/link";
import { requireProfile } from "@/lib/avsec/auth";
import { getVisibleOvertimeRequests } from "@/lib/avsec/duty/overtime-queries";
import { createClient } from "@/lib/supabase/server";
import { ORG_WIDE_ROLES } from "@/lib/avsec/reference-data";
import { formatDateMY } from "@/lib/avsec/datetime";
import { OvertimeReviewControls } from "@/components/avsec/duty/OvertimeReviewControls";
import { Clock, BarChart2 } from "lucide-react";

const FILTERS = ["ALL", "PENDING", "APPROVED", "REJECTED"] as const;

const STATUS_CLASS: Record<string, string> = {
  pending: "text-amber-500 border-amber-500/30 bg-amber-500/10",
  endorsed: "text-primary border-primary bg-primary/10",
  approved: "text-success border-success bg-success/10",
  rejected: "text-brand border-brand bg-brand/10",
  cancelled: "text-muted-foreground border-border",
};

export default async function OvertimeListPage({
  searchParams: searchParamsPromise,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const searchParams = await searchParamsPromise;
  const profile = await requireProfile();
  const isDse = profile.role === "DSE";
  const orgWide = (ORG_WIDE_ROLES as readonly string[]).includes(profile.role);
  const rows = await getVisibleOvertimeRequests();

  const active = FILTERS.includes(searchParams.status as (typeof FILTERS)[number])
    ? (searchParams.status as (typeof FILTERS)[number])
    : "ALL";
  const filtered = active === "ALL" ? rows : rows.filter((r) => r.status.toUpperCase() === active);

  const otherIds = Array.from(new Set(rows.map((r) => r.profile_id).filter((id) => id !== profile.id)));
  let nameById = new Map<string, string>();
  if (otherIds.length > 0) {
    const supabase = await createClient();
    const { data } = await supabase.from("profiles").select("id, name").in("id", otherIds);
    nameById = new Map((data ?? []).map((p) => [p.id, p.name]));
  }


  return (
    <main className="min-h-screen bg-background pb-28">
      <div className="mx-auto max-w-3xl space-y-4 px-4 py-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <span className="font-display text-base font-extrabold tracking-[0.06em] text-foreground">
              OVERTIME (OT)
            </span>
            <p className="font-mono text-xs text-muted-foreground mt-0.5">
              {isDse
                ? `DSE Approval Queue · ${profile.station ?? "All Stations"}`
                : orgWide
                ? "Management Overtime Review"
                : "Auto-Calculated Overtime Records"}
            </p>
          </div>
          {orgWide && (
            <Link
              href="/avsec/admin/attendance-monitor"
              className="btn-secondary flex items-center gap-1.5 text-xs font-mono"
            >
              <BarChart2 className="h-3.5 w-3.5" />
              <span>Attendance Monitor</span>
            </Link>
          )}
        </div>

        {/* Auto OT System Info Card */}
        <div className="rounded-xl border border-primary/20 bg-primary/5 p-3.5 flex items-start gap-3">
          <Clock className="h-4 w-4 text-primary shrink-0 mt-0.5" />
          <div className="text-xs text-foreground/90 space-y-1">
            <p className="font-semibold text-foreground">
              Automated Calculation on Duty Check-Out
            </p>
            <p className="text-muted-foreground leading-relaxed">
              Overtime is automatically computed from check-in/out timestamps compared against scheduled shift end times (rounded down to completed whole hours).
            </p>
          </div>
        </div>

        {/* Filter tabs */}
        <div className="flex flex-wrap gap-1.5">
          {FILTERS.map((f) => {
            const on = f === active;
            const count = f === "ALL" ? rows.length : rows.filter((r) => r.status.toUpperCase() === f).length;
            return (
              <Link
                key={f}
                href={f === "ALL" ? "/avsec/duty/overtime" : `/avsec/duty/overtime?status=${f}`}
                className={`rounded-full border px-3 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.1em] transition-colors ${
                  on ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:text-foreground"
                }`}
              >
                {f} · {count}
              </Link>
            );
          })}
        </div>

        {filtered.length === 0 && (
          <p className="text-center text-sm text-muted-foreground py-8">No overtime records found.</p>
        )}

        <div className="space-y-3">
          {filtered.map((r) => {
            const statusClass = STATUS_CLASS[r.status] ?? "text-muted-foreground border-border";
            const mine = r.profile_id === profile.id;
            const staffName = mine ? "You" : (nameById.get(r.profile_id) ?? "Team member");
            const canReview = (isDse || orgWide) && !mine && r.status === "pending";

            return (
              <div key={r.id} className="vecta-panel space-y-2 !p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[10px] font-bold text-muted-foreground">
                        {formatDateMY(r.work_date + "T00:00:00+08:00")}
                      </span>
                      <span className="font-mono text-[10px] text-muted-foreground">·</span>
                      <span className="font-mono text-[10px] text-muted-foreground">
                        {r.station}{r.team ? ` · ${r.team}` : ""}
                      </span>
                    </div>
                    <Link href={`/avsec/duty/overtime/${r.id}`} className="hover:underline">
                      <p className="mt-1 font-semibold text-sm text-foreground">
                        {r.payable_hours}h Payable OT ({Number(r.hours).toFixed(2)}h total duration)
                      </p>
                    </Link>
                    <p className="mt-0.5 font-mono text-xs text-muted-foreground">
                      Staff: <span className="text-foreground font-medium">{staffName}</span>
                    </p>
                    {r.reason && (
                      <p className="mt-1 text-xs text-muted-foreground/90 line-clamp-2">
                        {r.reason}
                      </p>
                    )}
                  </div>
                  <span className={`shrink-0 rounded-full border px-2.5 py-1 font-mono text-[9px] font-bold tracking-[0.08em] ${statusClass}`}>
                    {r.status.toUpperCase()}
                  </span>
                </div>

                {/* Inline Review Controls for DSE and Management */}
                {canReview && (
                  <div className="border-t border-border pt-2">
                    <OvertimeReviewControls
                      requestId={r.id}
                      staffName={staffName}
                      payableHours={r.payable_hours}
                      workDate={r.work_date}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </main>
  );
}
