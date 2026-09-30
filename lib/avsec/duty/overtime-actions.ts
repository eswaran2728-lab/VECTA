"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireProfile } from "@/lib/avsec/auth";
import { ROLE_RANK } from "@/lib/avsec/reference-data";
import { notifyOvertimeApproval } from "@/lib/avsec/email/notifyOvertimeApproval";

function backTo(id: string) {
  return `/avsec/duty/overtime/${id}`;
}

/** DSE endorses a pending request, within their own station+team. RLS ("overtime dse
 * endorse") is the actual authorization boundary — this check just keeps the wrong-role
 * action from being attempted in the first place. */
export async function endorseOvertimeRequest(formData: FormData) {
  const profile = await requireProfile();
  const id = String(formData.get("id") || "");
  if (!id) return;

  if (profile.role !== "DSE") {
    redirect(backTo(id) + "?error=" + encodeURIComponent("Only DSE can endorse an overtime request."));
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("overtime_requests")
    .update({ status: "endorsed", endorsed_by: profile.id, endorsed_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "pending");

  if (error) redirect(backTo(id) + "?error=" + encodeURIComponent(error.message));

  revalidatePath(backTo(id));
  revalidatePath("/avsec/duty/overtime");
}

export async function reviewOvertimeRequest(input: {
  requestId: string;
  action: "approve" | "reject";
  reviewNotes?: string;
}): Promise<{ success: boolean; error?: string }> {
  try {
    const profile = await requireProfile();
    const { requestId, action, reviewNotes } = input;
    if (!requestId) return { success: false, error: "Missing request ID." };

    const isDse = profile.role === "DSE";
    const isMgmt = (ROLE_RANK[profile.role] ?? 0) >= ROLE_RANK.MANAGEMENT;

    const supabase = await createClient();

    // Phase 8: an account holding an active Phase 3 scoped role (hub_se,
    // operation_manager, main_enforcement) is also allowed to attempt this
    // action -- the actual authority is the "overtime phase8 scoped
    // update" RLS policy + enforce_overtime_transition() trigger added by
    // the Phase 8 migration, which independently verify department
    // separation (main_enforcement only for Enforcement-dept submitters,
    // operation_manager only for Operation-dept submitters) at the
    // database layer. This app-layer gate only decides whether to attempt
    // the write at all; it is never the actual authorization boundary.
    let hasPhase8OtRole = false;
    if (!isDse && !isMgmt) {
      for (const roleCode of ["hub_se", "operation_manager", "main_enforcement"]) {
        const { data } = await supabase.rpc("has_active_role", { p_role_code: roleCode });
        if (data === true) {
          hasPhase8OtRole = true;
          break;
        }
      }
    }

    if (!isDse && !isMgmt && !hasPhase8OtRole) {
      return { success: false, error: "Only DSE, Hub SE, Operation Manager or Main Enforcement can review overtime requests." };
    }

    // Final approval requires Management rank OR an active Phase 8 scoped
    // approval role -- DSE's/Hub SE's role in this workflow is endorsement
    // (see endorseOvertimeRequest), not final approval. Enforced here in
    // addition to the UI not offering the control, since a server action
    // is its own reachable endpoint independent of what the page shows.
    if (action === "approve" && !isMgmt && !hasPhase8OtRole) {
      return { success: false, error: "Only Management, Operation Manager or Main Enforcement can give final approval. DSE/Hub SE endorses first." };
    }
    const { data: request, error: fetchErr } = await supabase
      .from("overtime_requests")
      .select("id, profile_id, station, team, work_date, payable_hours, category, status")
      .eq("id", requestId)
      .maybeSingle();

    if (fetchErr || !request) {
      return { success: false, error: fetchErr?.message ?? "Overtime record not found." };
    }

    // DSE branch scoping
    if (isDse && profile.station && request.station !== profile.station) {
      return { success: false, error: "You can only review overtime records for your own station/branch." };
    }

    // Workflow enforcement: PENDING -> DSE ENDORSED -> MANAGEMENT APPROVED.
    // Management can only give final approval to an already-endorsed
    // record — never skip straight from pending to approved.
    if (action === "approve" && request.status !== "endorsed") {
      return {
        success: false,
        error:
          request.status === "pending"
            ? "This request must be endorsed by DSE before Management can approve it."
            : `This request is already ${request.status} and cannot be approved.`,
      };
    }
    // DSE may only reject a request still at pending (their own station,
    // already scoped above); Management may reject at pending or endorsed —
    // either way, an already-decided record can't be re-rejected.
    if (action === "reject") {
      if (!["pending", "endorsed"].includes(request.status)) {
        return { success: false, error: `This request is already ${request.status} and cannot be rejected.` };
      }
      if (isDse && !isMgmt && request.status !== "pending") {
        return { success: false, error: "DSE can only reject a request that is still pending review." };
      }
    }

    const nowIso = new Date().toISOString();
    if (action === "approve") {
      const { data: updated, error: updateErr } = await supabase
        .from("overtime_requests")
        .update({
          status: "approved",
          approved_by: profile.id,
          approved_at: nowIso,
          rejection_reason: reviewNotes?.trim() || null,
        })
        .eq("id", requestId)
        .eq("status", "endorsed")
        .select("id, profile_id, station, team, work_date, payable_hours, category")
        .maybeSingle();

      if (updateErr) return { success: false, error: updateErr.message };
      if (!updated) return { success: false, error: "This request is no longer endorsed — it may have changed status already." };

      if (updated) {
        const { data: submitter } = await supabase
          .from("profiles")
          .select("name, staff_no")
          .eq("id", updated.profile_id)
          .maybeSingle();

        if (submitter) {
          await notifyOvertimeApproval({
            requestId: updated.id,
            submitterName: submitter.name,
            submitterStaffNo: submitter.staff_no,
            station: updated.station,
            team: updated.team,
            workDate: updated.work_date,
            payableHours: updated.payable_hours ?? 0,
            category: updated.category,
            approvedByName: profile.name,
          });
        }
      }
    } else {
      const reason = reviewNotes?.trim() || "Rejected by reviewer.";
      const { data: rejected, error: updateErr } = await supabase
        .from("overtime_requests")
        .update({
          status: "rejected",
          approved_by: profile.id,
          approved_at: nowIso,
          rejection_reason: reason,
        })
        .eq("id", requestId)
        .in("status", isDse && !isMgmt ? ["pending"] : ["pending", "endorsed"])
        .select("id")
        .maybeSingle();

      if (updateErr) return { success: false, error: updateErr.message };
      if (!rejected) return { success: false, error: "This request's status has already changed." };
    }

    revalidatePath("/avsec/duty/overtime");
    revalidatePath(`/avsec/duty/overtime/${requestId}`);
    revalidatePath("/avsec/admin/attendance-monitor");
    revalidatePath("/avsec/admin/attendance-report");
    revalidatePath("/avsec/duty");
    return { success: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to review overtime record.";
    return { success: false, error: message };
  }
}

export async function approveOvertimeRequest(formData: FormData) {
  const profile = await requireProfile();
  const id = String(formData.get("id") || "");
  if (!id) return;

  // Final approval is Management-only — DSE endorses via endorseOvertimeRequest.
  const isMgmt = (ROLE_RANK[profile.role] ?? 0) >= ROLE_RANK.MANAGEMENT;
  if (!isMgmt) {
    redirect(backTo(id) + "?error=" + encodeURIComponent("Only Management can give final approval."));
  }

  const res = await reviewOvertimeRequest({ requestId: id, action: "approve" });
  if (!res.success) {
    redirect(backTo(id) + "?error=" + encodeURIComponent(res.error ?? "Failed to approve."));
  }

  revalidatePath(backTo(id));
  revalidatePath("/avsec/duty/overtime");
}

export async function rejectOvertimeRequest(formData: FormData) {
  const id = String(formData.get("id") || "");
  const reason = String(formData.get("rejection_reason") || "").trim();
  if (!id) return;
  if (!reason) redirect(backTo(id) + "?error=" + encodeURIComponent("A rejection reason is required."));

  const res = await reviewOvertimeRequest({ requestId: id, action: "reject", reviewNotes: reason });
  if (!res.success) {
    redirect(backTo(id) + "?error=" + encodeURIComponent(res.error ?? "Failed to reject."));
  }

  revalidatePath(backTo(id));
  revalidatePath("/avsec/duty/overtime");
}

/** The claimant can withdraw their own request while it's still untouched — RLS
 * ("overtime own update") only allows this while status = 'pending'. */
export async function withdrawOvertimeRequest(formData: FormData) {
  const profile = await requireProfile();
  const id = String(formData.get("id") || "");
  if (!id) return;

  const supabase = await createClient();
  const { error } = await supabase
    .from("overtime_requests")
    .update({ status: "cancelled" })
    .eq("id", id)
    .eq("profile_id", profile.id)
    .eq("status", "pending");

  if (error) redirect(backTo(id) + "?error=" + encodeURIComponent(error.message));

  revalidatePath(backTo(id));
  revalidatePath("/avsec/duty/overtime");
}
