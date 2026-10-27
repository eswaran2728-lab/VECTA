"use server";

import { revalidatePath } from "next/cache";
import { getAttendanceProfile, requireAttendanceProfile } from "@/lib/avsec/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { leaveRpcArgs, mapLeaveRpcResult, type LeaveSubmitInput, type LeaveSubmitResult } from "./leave-submit";
import { todayISODateMY } from "@/lib/avsec/datetime";
import { getTodayRoster, getTodayDutyRecord } from "./checkin-queries";
import { scheduledWindow } from "./lateness";
import {
  calculateAbsenceGap,
  type LeaveType,
  type LeaveApprovalStatus,
  LEAVE_TYPE_LABELS,
  isSameDayLeave,
} from "./absence-logic";
import { ORG_WIDE_ROLES } from "@/lib/avsec/reference-data";
import { reviewLeaveRequestSecure } from "@/lib/phase8/workforce";

export type { LeaveSubmitInput, LeaveSubmitResult };

/**
 * Server action to submit an official Leave Application / Absence Notice.
 * - Timestamp is captured server-side at the instant of execution (tamper-proof).
 * - Remarks are strictly required.
 * - Same-day applications (startDate = today):
 *   - Calculates 3-hour gap against rostered shift start time.
 *   - Blocked if the staff member has already checked in for today's shift.
 * - Future-dated applications (startDate > today):
 *   - Skips gap calculation and creates pending approval record.
 */
export async function submitLeaveApplication(
  input: LeaveSubmitInput
): Promise<LeaveSubmitResult> {
  const profile = await getAttendanceProfile();
  if (!profile) {
    return { error: "You must be signed in to submit a leave application.", success: false };
  }

  // One authenticated RPC records the notice AND the same-day absent duty state in a single database transaction. The caller, station,
  // team, shift, three-hour gap, duplicate and already-checked-in checks are all decided inside the database; nothing here writes a table.
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("submit_leave_application_secure", leaveRpcArgs(input));
  if (error) {
    console.error("[submitLeaveApplication] RPC error:", error.code);
  }
  const result = mapLeaveRpcResult(data, error);

  if (result.success) {
    revalidatePath("/avsec/duty");
    revalidatePath("/avsec/duty/absences");
    revalidatePath("/avsec/admin/absences");
  }
  return result;
}

/**
 * Backward-compatible alias for simple absence reporting.
 */
export async function submitAbsenceNotice(
  remarksInput: string
): Promise<LeaveSubmitResult> {
  return submitLeaveApplication({
    leaveType: "absent",
    remarks: remarksInput,
  });
}

export interface LeaveReviewResult {
  error: string | null;
  success: boolean;
}

export type LeaveReviewAction =
  | "approve"
  | "reject"
  | "approve_cancellation"
  | "reject_cancellation";

/**
 * Server action for a staff member to request cancellation of an applied or approved leave.
 * Unilateral self-cancellation is strictly forbidden; submitting routes to DSE/Management for review.
 */
export async function requestLeaveCancellation(input: {
  noticeId: string;
  reason?: string;
}): Promise<LeaveReviewResult> {
  const profile = await requireAttendanceProfile();
  const supabase = createAdminClient();

  const { data: notice, error: fetchErr } = await supabase
    .from("absence_notices")
    .select("id, user_id, approval_status, leave_type")
    .eq("id", input.noticeId)
    .single();

  if (fetchErr || !notice) {
    return { error: "Leave application record not found.", success: false };
  }

  const isOrgWide = (ORG_WIDE_ROLES as readonly string[]).includes(profile.role);
  if (notice.user_id !== profile.id && !isOrgWide) {
    return { error: "Unauthorized: You can only request cancellation for your own leave applications.", success: false };
  }

  if (notice.approval_status === "cancelled") {
    return { error: "This leave application is already cancelled.", success: false };
  }

  if (notice.approval_status === "rejected") {
    return { error: "Cannot request cancellation for a rejected application.", success: false };
  }

  if (notice.approval_status === "pending_cancellation") {
    return { error: "A cancellation request is already pending review.", success: false };
  }

  const now = new Date().toISOString();
  const { error: updateErr } = await supabase
    .from("absence_notices")
    .update({
      approval_status: "pending_cancellation",
      cancel_requested_at: now,
      cancellation_reason: input.reason?.trim() || null,
    })
    .eq("id", input.noticeId);

  if (updateErr) {
    console.error("[requestLeaveCancellation] Update Error:", updateErr);
    return { error: `Failed to submit cancellation request: ${updateErr.message}`, success: false };
  }

  revalidatePath("/avsec/duty");
  revalidatePath("/avsec/duty/absences");
  revalidatePath("/avsec/admin/absences");
  revalidatePath("/avsec/admin/roster");

  return { error: null, success: true };
}

/**
 * Server action for DSE or Management to Approve or Reject a Leave Application
 * or Review a Leave Cancellation Request.
 */
export async function reviewLeaveApplication(input: {
  noticeId: string;
  action: LeaveReviewAction;
  reviewNotes?: string;
}): Promise<LeaveReviewResult> {
  const profile = await requireAttendanceProfile();
  const isOrgWide = (ORG_WIDE_ROLES as readonly string[]).includes(profile.role);
  const isDSE = profile.role === "DSE";

  if (!isOrgWide && !isDSE) {
    return { error: "Unauthorized: Only DSE or Management can review leave applications.", success: false };
  }

  const supabase = createAdminClient();

  // Phase 8: any account holding an active Phase 3 scoped role assignment
  // (operation_manager / hub_se / dse / main_enforcement / ...) MUST go
  // through the concurrency-safe review_leave_request_secure() RPC for
  // approve/reject -- never the legacy race-prone path below. The legacy
  // path is retained ONLY as temporary compatibility for accounts that
  // have not yet been migrated to a Phase 3 role assignment (see Phase 8
  // Round 2, Part 12 -- production currently has zero active assignments).
  if (input.action === "approve" || input.action === "reject") {
    const nowIso = new Date().toISOString();
    const { count: activeAssignmentCount } = await supabase
      .from("user_role_assignments")
      .select("id", { count: "exact", head: true })
      .eq("profile_id", profile.id)
      .is("revoked_at", null)
      .lte("starts_at", nowIso)
      .or(`ends_at.is.null,ends_at.gt.${nowIso}`);

    if ((activeAssignmentCount ?? 0) > 0) {
      const secureResult = await reviewLeaveRequestSecure(input.noticeId, input.action, input.reviewNotes);
      if (!secureResult.ok) {
        return { error: secureResult.error ?? "Failed to update review status.", success: false };
      }
      revalidatePath("/avsec/duty");
      revalidatePath("/avsec/duty/absences");
      revalidatePath("/avsec/admin/absences");
      revalidatePath("/avsec/admin/roster");
      return { error: null, success: true };
    }
  }

  // Fetch application to verify station scope for DSE and check concurrency cap
  const { data: notice, error: fetchErr } = await supabase
    .from("absence_notices")
    .select("id, station, team, user_id, staff_name, leave_type, start_date, end_date, approval_status")
    .eq("id", input.noticeId)
    .single();

  if (fetchErr || !notice) {
    return { error: "Leave application record not found.", success: false };
  }

  // DSE scope is the assigned station AND team (canonical accounts never reach this fallback: they use review_leave_request_secure, which enforces the same).
  if (isDSE && !isOrgWide && (!notice.station || !notice.team || notice.station !== profile.station || notice.team !== profile.team)) {
    return { error: "Unauthorized: You can only review leave applications within your station and team.", success: false };
  }

  // Check Annual Leave concurrency cap (max 3 approved overlapping per team for DSE)
  if (input.action === "approve" && notice.leave_type === "annual" && !isOrgWide) {
    let query = supabase
      .from("absence_notices")
      .select("user_id")
      .eq("leave_type", "annual")
      .eq("approval_status", "approved")
      .lte("start_date", notice.end_date)
      .gte("end_date", notice.start_date);

    if (notice.station) {
      query = query.eq("station", notice.station);
    }
    if (notice.team) {
      query = query.eq("team", notice.team);
    }

    const { data: overlappingApproved } = await query;

    const distinctUsers = new Set<string>();
    for (const row of overlappingApproved || []) {
      if (row.user_id !== notice.user_id) {
        distinctUsers.add(row.user_id);
      }
    }

    if (distinctUsers.size >= 3) {
      return {
        error: `Team Annual Leave concurrency cap reached (${distinctUsers.size}/3 approved for overlapping dates). Approving this 4th application is escalated and requires Management approval.`,
        success: false,
      };
    }
  }

  let newStatus: LeaveApprovalStatus;
  if (input.action === "approve") {
    newStatus = "approved";
  } else if (input.action === "reject") {
    newStatus = "rejected";
  } else if (input.action === "approve_cancellation") {
    newStatus = "cancelled";
  } else if (input.action === "reject_cancellation") {
    newStatus = "approved";
  } else {
    return { error: "Invalid review action.", success: false };
  }

  const reviewedAt = new Date().toISOString();

  const { error: updateErr } = await supabase
    .from("absence_notices")
    .update({
      approval_status: newStatus,
      reviewed_by: profile.id,
      reviewed_at: reviewedAt,
      review_notes: input.reviewNotes?.trim() || null,
    })
    .eq("id", input.noticeId);

  if (updateErr) {
    console.error("[reviewLeaveApplication] Update Error:", updateErr);
    return { error: `Failed to update status: ${updateErr.message}`, success: false };
  }

  revalidatePath("/avsec/duty");
  revalidatePath("/avsec/duty/absences");
  revalidatePath("/avsec/admin/absences");
  revalidatePath("/avsec/admin/roster");

  return { error: null, success: true };
}

