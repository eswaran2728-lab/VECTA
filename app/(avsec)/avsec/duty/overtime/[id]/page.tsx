import { notFound } from "next/navigation";
import { requireProfile } from "@/lib/avsec/auth";
import { getOvertimeRequestById } from "@/lib/avsec/duty/overtime-queries";
import { endorseOvertimeRequest, approveOvertimeRequest, rejectOvertimeRequest, withdrawOvertimeRequest } from "@/lib/avsec/duty/overtime-actions";
import { createClient } from "@/lib/supabase/server";
import { ROLE_RANK, type UserRole } from "@/lib/avsec/reference-data";
import { AppHeader } from "@/components/avsec/layout/AppHeader";
import { BottomNav } from "@/components/avsec/layout/BottomNav";
import { formatDateMY, formatDateTimeMY } from "@/lib/avsec/datetime";

const STATUS_LABEL: Record<string, string> = {
  pending: "Pending",
  endorsed: "Endorsed",
  approved: "Approved",
  rejected: "Rejected",
  cancelled: "Cancelled",
};

const STATUS_COLOR: Record<string, string> = {
  pending: "var(--faint)",
  endorsed: "var(--blue)",
  approved: "var(--green)",
  rejected: "var(--red)",
  cancelled: "var(--faint)",
};

export default async function OvertimeDetailPage({
  params: paramsPromise,
  searchParams: searchParamsPromise,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const params = await paramsPromise;
  const searchParams = await searchParamsPromise;
  const profile = await requireProfile();

  // RLS scopes this to requests the caller may see (own, or monitor within rank/station/team).
  const request = await getOvertimeRequestById(params.id);
  if (!request) notFound();

  const otherIds = Array.from(
    new Set([request.profile_id, request.endorsed_by, request.approved_by].filter((id): id is string => !!id)),
  );
  const supabase = await createClient();
  const { data: profileRows } = await supabase.from("profiles").select("id, name, role").in("id", otherIds);
  const profileById = new Map((profileRows ?? []).map((p) => [p.id, p as { id: string; name: string; role: UserRole }]));

  const submitter = profileById.get(request.profile_id);
  const mine = request.profile_id === profile.id;
  const viewerRank = ROLE_RANK[profile.role];
  const submitterRank = submitter ? ROLE_RANK[submitter.role] : 0;
  const sameScope =
    viewerRank >= ROLE_RANK.ENFORCEMENT ||
    (profile.station === request.station && (profile.team ?? "") === (request.team ?? ""));
  const canSettle = !mine && viewerRank > submitterRank && sameScope;
  // DSE endorses a pending request; Management/Admin only give final approval once it's
  // endorsed — no skipping straight from pending. Either DSE or Management/Admin can still
  // reject at the stage they'd otherwise act on.
  const canEndorse = canSettle && profile.role === "DSE" && request.status === "pending";
  const canApprove = canSettle && viewerRank >= ROLE_RANK.MANAGEMENT && request.status === "endorsed";
  const canReject =
    canSettle &&
    ((profile.role === "DSE" && request.status === "pending") ||
      (viewerRank >= ROLE_RANK.MANAGEMENT && ["pending", "endorsed"].includes(request.status)));
  const canWithdraw = mine && request.status === "pending";

  const color = STATUS_COLOR[request.status] ?? "var(--faint)";

  return (
    <main className="min-h-screen pb-32">
      <AppHeader profile={profile} title="Overtime Request" backHref="/avsec/duty/overtime" />

      <div style={{ background: "var(--view-header)", borderBottom: "1px solid var(--line)" }} className="px-4 py-5">
        <div className="max-w-2xl mx-auto">
          <div className="flex items-center justify-between gap-2">
            <span className="t-mono text-[10px]" style={{ color: "var(--mid)" }}>
              {request.category.replace(/_/g, " ").toUpperCase()}
            </span>
            <span
              className="t-mono text-[9px] font-bold uppercase px-2.5 py-1"
              style={{ letterSpacing: "0.14em", background: color, color: "var(--on-gold)" }}
            >
              {STATUS_LABEL[request.status] ?? request.status}
            </span>
          </div>
          <h1 className="t-display text-xl mt-3">{Number(request.hours).toFixed(2)}h overtime</h1>
          <p className="t-mono text-[10px] mt-2" style={{ color: "var(--soft)" }}>
            {formatDateMY(request.work_date + "T00:00:00+08:00")} · {request.station}
            {request.team ? ` · ${request.team}` : ""}
            {!mine && submitter ? ` · ${submitter.name}` : ""}
          </p>
        </div>
      </div>

      <div className="max-w-2xl mx-auto px-4 py-6 space-y-4">
        {searchParams.error && <div className="disclaimer-band">{searchParams.error}</div>}

        <div className="card p-4 space-y-2">
          <p className="text-[13px]" style={{ color: "var(--ink2)" }}>
            {formatDateTimeMY(request.start_at)} → {formatDateTimeMY(request.end_at)}
          </p>
          <p className="t-mono text-[10.5px]" style={{ color: "var(--soft)" }}>
            Exact duration {Number(request.hours).toFixed(2)}h · Payable (whole hours) {request.payable_hours}h
          </p>
          <div>
            <p className="field-label">Reason</p>
            <p className="text-[13px]" style={{ color: "var(--ink2)" }}>
              {request.reason}
            </p>
          </div>
        </div>

        {request.status === "rejected" && request.rejection_reason && (
          <div className="card p-4 space-y-1" style={{ borderLeft: "3px solid var(--red)" }}>
            <p className="t-mono text-[10px] font-bold" style={{ color: "var(--red)" }}>
              REJECTION REASON
            </p>
            <p className="text-[13px]" style={{ color: "var(--ink2)" }}>
              {request.rejection_reason}
            </p>
          </div>
        )}

        {(canEndorse || canApprove || canReject || canWithdraw) && (
          <div className="card p-4 space-y-3">
            <p className="section-title">Actions</p>
            <div className="flex flex-wrap gap-2">
              {canEndorse && (
                <form action={endorseOvertimeRequest}>
                  <input type="hidden" name="id" value={request.id} />
                  <button type="submit" className="btn-primary">
                    Endorse
                  </button>
                </form>
              )}
              {canApprove && (
                <form action={approveOvertimeRequest}>
                  <input type="hidden" name="id" value={request.id} />
                  <button type="submit" className="btn-primary">
                    Approve
                  </button>
                </form>
              )}
              {canWithdraw && (
                <form action={withdrawOvertimeRequest}>
                  <input type="hidden" name="id" value={request.id} />
                  <button type="submit" className="btn-secondary">
                    Withdraw
                  </button>
                </form>
              )}
            </div>

            {canReject && (
              <form action={rejectOvertimeRequest} className="space-y-2 pt-2" style={{ borderTop: "1px solid var(--line2)" }}>
                <input type="hidden" name="id" value={request.id} />
                <label className="field-label">Reject with reason</label>
                <textarea name="rejection_reason" rows={2} className="input-base" placeholder="Why is this rejected?" />
                <button type="submit" className="btn-secondary" style={{ color: "var(--red)" }}>
                  Reject
                </button>
              </form>
            )}
          </div>
        )}

        <section className="card p-4 sm:p-5">
          <h2 className="section-title mb-3">Record Trail</h2>
          <div className="space-y-3">
            <div className="grid grid-cols-[86px_1fr] gap-3">
              <p className="t-mono text-[11px]" style={{ color: "var(--mid)" }}>
                {formatDateTimeMY(request.created_at, "dd MMM, HH:mm")}
              </p>
              <div className="relative pl-[18px]" style={{ borderLeft: "1px solid var(--line3)" }}>
                <span className="absolute -left-[4.5px] top-1 w-2 h-2 rounded-full" style={{ background: "var(--gold-fill)" }} />
                <p className="font-semibold text-[13px]" style={{ color: "var(--ink2)" }}>
                  Submitted
                </p>
                <p className="t-mono text-[10.5px] mt-[2px]" style={{ color: "var(--soft)" }}>
                  {mine ? "You" : (submitter?.name ?? "Submitter")}
                </p>
              </div>
            </div>
            {request.endorsed_at && (
              <div className="grid grid-cols-[86px_1fr] gap-3">
                <p className="t-mono text-[11px]" style={{ color: "var(--mid)" }}>
                  {formatDateTimeMY(request.endorsed_at, "dd MMM, HH:mm")}
                </p>
                <div className="relative pl-[18px]" style={{ borderLeft: "1px solid var(--line3)" }}>
                  <span className="absolute -left-[4.5px] top-1 w-2 h-2 rounded-full" style={{ background: "var(--blue)" }} />
                  <p className="font-semibold text-[13px]" style={{ color: "var(--ink2)" }}>
                    Endorsed
                  </p>
                  <p className="t-mono text-[10.5px] mt-[2px]" style={{ color: "var(--soft)" }}>
                    {request.endorsed_by ? (profileById.get(request.endorsed_by)?.name ?? "Endorser") : ""}
                  </p>
                </div>
              </div>
            )}
            {request.approved_at && (
              <div className="grid grid-cols-[86px_1fr] gap-3">
                <p className="t-mono text-[11px]" style={{ color: "var(--mid)" }}>
                  {formatDateTimeMY(request.approved_at, "dd MMM, HH:mm")}
                </p>
                <div className="relative pl-[18px]" style={{ borderLeft: "1px solid var(--line3)" }}>
                  <span
                    className="absolute -left-[4.5px] top-1 w-2 h-2 rounded-full"
                    style={{ background: request.status === "rejected" ? "var(--red)" : "var(--green)" }}
                  />
                  <p className="font-semibold text-[13px]" style={{ color: "var(--ink2)" }}>
                    {request.status === "rejected" ? "Rejected" : "Approved"}
                  </p>
                  <p className="t-mono text-[10.5px] mt-[2px]" style={{ color: "var(--soft)" }}>
                    {request.approved_by ? (profileById.get(request.approved_by)?.name ?? "Approver") : ""}
                  </p>
                </div>
              </div>
            )}
          </div>
        </section>
      </div>
      <BottomNav profile={profile} />
    </main>
  );
}
