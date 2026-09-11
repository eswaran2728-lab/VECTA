"use server";

import { revalidatePath } from "next/cache";
import { getCurrentProfile, requireProfile } from "@/lib/avsec/auth";
import { createAdminClient } from "@/lib/supabase/admin";
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

export interface LeaveSubmitInput {
  leaveType?: LeaveType;
  startDate?: string;
  endDate?: string;
  remarks: string;
}

export interface LeaveSubmitResult {
  error: string | null;
  success: boolean;
  leaveType?: LeaveType;
  startDate?: string;
  endDate?: string;
  approvalStatus?: LeaveApprovalStatus;
  status?: "green" | "red" | null;
  formattedGap?: string;
  submittedAt?: string;
}

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
  const profile = await getCurrentProfile();
  if (!profile) {
    return { error: "You must be signed in to submit a leave application.", success: false };
  }

  const remarks = (input.remarks ?? "").trim();
  if (!remarks) {
    return { error: "Remarks are required. Please provide an explanation for your leave.", success: false };
  }

  const today = todayISODateMY();
  const leaveType: LeaveType = input.leaveType ?? "absent";
  const startDate = input.startDate || today;
  const endDate = input.endDate || startDate;

  // Validate date logic
  if (endDate < startDate) {
    return { error: "End date cannot be earlier than start date.", success: false };
  }

  const isSameDay = isSameDayLeave(startDate, today);
  const station = profile.station ?? "";
  const team = profile.team ?? "";

  const submittedAt = new Date();
  let shiftCode = "DUTY";
  let shiftStartTime: Date = new Date(`${today}T08:00:00+08:00`);
  let gapMinutes: number | null = null;
  let status: "green" | "red" | null = null;
  let formattedGap = "Advance Planned Leave · Pending Review";

  if (isSameDay) {
    // 1. Fetch roster for scheduled shift time
    const roster = station ? await getTodayRoster(station, team) : null;
    shiftCode = roster?.shift_code ?? "DUTY";

    // 2. Check if already checked in for today's shift (mutually exclusive)
    const existingRecord = await getTodayDutyRecord(profile.id, shiftCode);
    if (existingRecord?.check_in_at) {
      return {
        error: "Cannot apply for leave covering today after checking in. Check-in already confirms attendance for this shift.",
        success: false,
      };
    }

    // 3. Calculate 3-hour compliance gap
    if (roster?.start_time && roster?.end_time) {
      const window = scheduledWindow(today, roster.start_time, roster.end_time);
      shiftStartTime = window.start;
    }

    const calcResult = calculateAbsenceGap(shiftStartTime, submittedAt);
    gapMinutes = calcResult.gapMinutes;
    status = calcResult.status;
    formattedGap = calcResult.formattedGap;
  } else {
    shiftStartTime = new Date(`${startDate}T08:00:00+08:00`);
  }

  const supabase = createAdminClient();

  // 4. Save to public.absence_notices
  const { error: insertError } = await supabase.from("absence_notices").insert({
    user_id: profile.id,
    staff_name: profile.name,
    staff_id: profile.staff_no,
    role: profile.role,
    station: profile.station,
    team: profile.team,
    ops_group: profile.ops_group,
    shift_code: shiftCode,
    duty_date: today,
    leave_type: leaveType,
    start_date: startDate,
    end_date: endDate,
    shift_start_time: shiftStartTime.toISOString(),
    submitted_at: submittedAt.toISOString(),
    gap_minutes: gapMinutes,
    status: status,
    approval_status: "pending",
    remarks: remarks,
  });

  if (insertError) {
    console.error("[submitLeaveApplication] DB Error:", insertError);
    return {
      error: `Could not record leave application: ${insertError.message}`,
      success: false,
    };
  }

  // 5. If same-day, also mark duty record so reports & bay board know
  if (isSameDay) {
    try {
      const typeLabel = LEAVE_TYPE_LABELS[leaveType] || leaveType;
      await supabase.from("duty_records").upsert(
        {
          profile_id: profile.id,
          duty_date: today,
          shift_code: shiftCode,
          station: station || "KUL",
          team: team || null,
          status: "absent",
          late_remark: `Leave [${typeLabel}]: ${remarks} (${formattedGap})`,
        },
        { onConflict: "profile_id,duty_date,shift_code" }
      );
    } catch (err) {
      console.warn("[submitLeaveApplication] duty_records update note:", err);
    }
  }

  revalidatePath("/avsec/duty");
  revalidatePath("/avsec/duty/absences");
  revalidatePath("/avsec/admin/absences");

  return {
    error: null,
    success: true,
    leaveType,
    startDate,
    endDate,
    approvalStatus: "pending",
    status,
    formattedGap,
    submittedAt: submittedAt.toISOString(),
  };
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

/**
 * Server action for DSE or Management to Approve or Reject a Leave Application.
 */
export async function reviewLeaveApplication(input: {
  noticeId: string;
  action: "approve" | "reject";
  reviewNotes?: string;
}): Promise<LeaveReviewResult> {
  const profile = await requireProfile();
  const isOrgWide = (ORG_WIDE_ROLES as readonly string[]).includes(profile.role);
  const isDSE = profile.role === "DSE";

  if (!isOrgWide && !isDSE) {
    return { error: "Unauthorized: Only DSE or Management can review leave applications.", success: false };
  }

  const supabase = createAdminClient();

  // Fetch application to verify station scope for DSE
  const { data: notice, error: fetchErr } = await supabase
    .from("absence_notices")
    .select("id, station, team, user_id, staff_name, leave_type")
    .eq("id", input.noticeId)
    .single();

  if (fetchErr || !notice) {
    return { error: "Leave application record not found.", success: false };
  }

  if (isDSE && !isOrgWide && notice.station && notice.station !== profile.station) {
    return { error: "Unauthorized: You can only review leave applications within your station.", success: false };
  }

  const newStatus: LeaveApprovalStatus = input.action === "approve" ? "approved" : "rejected";
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

  return { error: null, success: true };
}
