import { notFound } from "next/navigation";
import { requireProfile } from "@/lib/avsec/auth";
import { getOvertimeRequestById } from "@/lib/avsec/duty/overtime-queries";
import { endorseOvertimeRequest, approveOvertimeRequest, rejectOvertimeRequest, withdrawOvertimeRequest } from "@/lib/avsec/duty/overtime-actions";
import { createClient } from "@/lib/supabase/server";
import { ORG_WIDE_ROLES, ROLE_RANK, type UserRole } from "@/lib/avsec/reference-data";
import { formatDateMY, formatDateTimeMY } from "@/lib/avsec/datetime";

const STATUS_LABEL: Record<string, string> = {
  pending: "Pending",
  endorsed: "Endorsed",
  approved: "Approved",
  rejected: "Rejected",
  cancelled: "Cancelled",
};

const STATUS_CLASS: Record<string, string> = {
  pending: "text-muted-foreground border-border",
  endorsed: "text-primary border-primary",
  approved: "text-success border-success",
  rejected: "text-brand border-brand",
  cancelled: "text-muted-foreground border-border",
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
  const orgWide = (ORG_WIDE_ROLES as readonly string[]).includes(profile.role);

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

  const statusClass = STATUS_CLASS[request.status] ?? "text-muted-foreground border-border";

  return (
    <main className="min-h-screen bg-background pb-28">
      <div className="border-b border-border bg-card px-4 py-5">
        <div className="mx-auto max-w-2xl">
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-[10px] text-muted-foreground">
              {request.category.replace(/_/g, " ").toUpperCase()}
            </span>
            <span className={`rounded-full border px-2.5 py-1 font-mono text-[9px] font-bold uppercase tracking-[0.14em] ${statusClass}`}>
              {STATUS_LABEL[request.status] ?? request.status}
            </span>
          </div>
          <h1 className="mt-3 font-display text-xl text-foreground">{Number(request.hours).toFixed(2)}h overtime</h1>
          <p className="mt-2 font-mono text-[10px] text-muted-foreground">
            {formatDateMY(request.work_date + "T00:00:00+08:00")} · {request.station}
            {request.team ? ` · ${request.team}` : ""}
            {!mine && submitter ? ` · ${submitter.name}` : ""}
          </p>
        </div>
      </div>

      <div className="mx-auto max-w-2xl space-y-4 px-4 py-6">
        {searchParams.error && (
          <div className="vecta-panel border-brand/40 bg-brand/10 px-5 py-4 text-sm font-medium text-brand">
            {searchParams.error}
          </div>
        )}

        <div className="vecta-panel space-y-2 !py-4">
          <p className="text-[13px] text-foreground/90">
            {formatDateTimeMY(request.start_at)} → {formatDateTimeMY(request.end_at)}
          </p>
          <p className="font-mono text-[10.5px] text-muted-foreground">
            Exact duration {Number(request.hours).toFixed(2)}h · Payable (whole hours) {request.payable_hours}h
          </p>
          <div>
            <p className="vecta-label">Reason</p>
            <p className="text-[13px] text-foreground/90">{request.reason}</p>
          </div>
        </div>

        {request.status === "rejected" && request.rejection_reason && (
          <div className="vecta-panel space-y-1 border-l-[3px] border-l-brand !py-4">
            <p className="font-mono text-[10px] font-bold text-brand">REJECTION REASON</p>
            <p className="text-[13px] text-foreground/90">{request.rejection_reason}</p>
          </div>
        )}

        {(canEndorse || canApprove || canReject || canWithdraw) && (
          <div className="vecta-panel space-y-3 !py-4">
            <p className="vecta-eyebrow">Actions</p>
            <div className="flex flex-wrap gap-2">
              {canEndorse && (
                <form action={endorseOvertimeRequest}>
                  <input type="hidden" name="id" value={request.id} />
                  <button type="submit" className="vecta-btn-primary !h-11 !w-auto px-6">
                    Endorse
                  </button>
                </form>
              )}
              {canApprove && (
                <form action={approveOvertimeRequest}>
                  <input type="hidden" name="id" value={request.id} />
                  <button type="submit" className="vecta-btn-primary !h-11 !w-auto px-6">
                    Approve
                  </button>
                </form>
              )}
              {canWithdraw && (
                <form action={withdrawOvertimeRequest}>
                  <input type="hidden" name="id" value={request.id} />
                  <button
                    type="submit"
                    className="rounded-full border border-border px-6 py-2.5 font-mono text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground transition-colors hover:border-primary hover:text-foreground"
                  >
                    Withdraw
                  </button>
                </form>
              )}
            </div>

            {canReject && (
              <form action={rejectOvertimeRequest} className="space-y-2 border-t border-border pt-3">
                <input type="hidden" name="id" value={request.id} />
                <label className="vecta-label">Reject with reason</label>
                <textarea name="rejection_reason" rows={2} className="vecta-input h-auto py-2.5" placeholder="Why is this rejected?" />
                <button
                  type="submit"
                  className="rounded-full border border-brand px-6 py-2.5 font-mono text-[11px] font-semibold uppercase tracking-[0.06em] text-brand transition-colors hover:bg-brand/10"
                >
                  Reject
                </button>
              </form>
            )}
          </div>
        )}

        <section className="vecta-panel">
          <h2 className="vecta-eyebrow mb-3">Record Trail</h2>
          <div className="space-y-3">
            <div className="grid grid-cols-[86px_1fr] gap-3">
              <p className="font-mono text-[11px] text-muted-foreground">
                {formatDateTimeMY(request.created_at, "dd MMM, HH:mm")}
              </p>
              <div className="relative border-l border-border pl-[18px]">
                <span className="absolute -left-[4.5px] top-1 h-2 w-2 rounded-full bg-primary" />
                <p className="text-[13px] font-semibold text-foreground">Submitted</p>
                <p className="mt-[2px] font-mono text-[10.5px] text-muted-foreground">
                  {mine ? "You" : (submitter?.name ?? "Submitter")}
                </p>
              </div>
            </div>
            {request.endorsed_at && (
              <div className="grid grid-cols-[86px_1fr] gap-3">
                <p className="font-mono text-[11px] text-muted-foreground">
                  {formatDateTimeMY(request.endorsed_at, "dd MMM, HH:mm")}
                </p>
                <div className="relative border-l border-border pl-[18px]">
                  <span className="absolute -left-[4.5px] top-1 h-2 w-2 rounded-full bg-primary" />
                  <p className="text-[13px] font-semibold text-foreground">Endorsed</p>
                  <p className="mt-[2px] font-mono text-[10.5px] text-muted-foreground">
                    {request.endorsed_by ? (profileById.get(request.endorsed_by)?.name ?? "Endorser") : ""}
                  </p>
                </div>
              </div>
            )}
            {request.approved_at && (
              <div className="grid grid-cols-[86px_1fr] gap-3">
                <p className="font-mono text-[11px] text-muted-foreground">
                  {formatDateTimeMY(request.approved_at, "dd MMM, HH:mm")}
                </p>
                <div className="relative border-l border-border pl-[18px]">
                  <span
                    className={`absolute -left-[4.5px] top-1 h-2 w-2 rounded-full ${
                      request.status === "rejected" ? "bg-brand" : "bg-success"
                    }`}
                  />
                  <p className="text-[13px] font-semibold text-foreground">
                    {request.status === "rejected" ? "Rejected" : "Approved"}
                  </p>
                  <p className="mt-[2px] font-mono text-[10.5px] text-muted-foreground">
                    {request.approved_by ? (profileById.get(request.approved_by)?.name ?? "Approver") : ""}
                  </p>
                </div>
              </div>
            )}
          </div>
        </section>
      </div>

    </main>
  );
}
