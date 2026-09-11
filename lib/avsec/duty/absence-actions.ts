"use server";

import { revalidatePath } from "next/cache";
import { getCurrentProfile } from "@/lib/avsec/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { todayISODateMY } from "@/lib/avsec/datetime";
import { getTodayRoster, getTodayDutyRecord } from "./checkin-queries";
import { scheduledWindow } from "./lateness";
import { calculateAbsenceGap } from "./absence-logic";

export interface AbsenceSubmitResult {
  error: string | null;
  success: boolean;
  status?: "green" | "red";
  formattedGap?: string;
  submittedAt?: string;
}

/**
 * Server action to submit an official Absence Notice.
 * - Timestamp is captured server-side at the instant of execution (tamper-proof).
 * - Remarks are strictly required.
 * - Blocked if the staff member has already checked in for this shift.
 */
export async function submitAbsenceNotice(
  remarksInput: string
): Promise<AbsenceSubmitResult> {
  const profile = await getCurrentProfile();
  if (!profile) {
    return { error: "You must be signed in to submit an absence notice.", success: false };
  }

  const remarks = (remarksInput ?? "").trim();
  if (!remarks) {
    return { error: "Remarks are required. Please provide an explanation for your absence.", success: false };
  }

  const dutyDate = todayISODateMY();
  const station = profile.station ?? "";
  const team = profile.team ?? "";

  // 1. Fetch roster for scheduled shift time
  const roster = station ? await getTodayRoster(station, team) : null;
  const shiftCode = roster?.shift_code ?? "DUTY";

  // 2. Check if already checked in for today's shift (mutually exclusive)
  const existingRecord = await getTodayDutyRecord(profile.id, shiftCode);
  if (existingRecord?.check_in_at) {
    return {
      error: "Cannot report absence after checking in. Check-in already confirms attendance for this shift.",
      success: false,
    };
  }

  // 3. Capture server timestamp & calculate gap
  const submittedAt = new Date();
  let shiftStartTime: Date;

  if (roster?.start_time && roster?.end_time) {
    const window = scheduledWindow(dutyDate, roster.start_time, roster.end_time);
    shiftStartTime = window.start;
  } else {
    // If no specific start_time on roster, default to 08:00 MY time or current time
    shiftStartTime = new Date(`${dutyDate}T08:00:00+08:00`);
  }

  const { gapMinutes, status, formattedGap } = calculateAbsenceGap(
    shiftStartTime,
    submittedAt
  );

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
    duty_date: dutyDate,
    shift_start_time: shiftStartTime.toISOString(),
    submitted_at: submittedAt.toISOString(),
    gap_minutes: gapMinutes,
    status: status,
    remarks: remarks,
  });

  if (insertError) {
    console.error("[submitAbsenceNotice] DB Error:", insertError);
    return {
      error: `Could not record absence notice: ${insertError.message}`,
      success: false,
    };
  }

  // 5. Also upsert duty record to note absent status so reports know
  try {
    await supabase.from("duty_records").upsert(
      {
        profile_id: profile.id,
        duty_date: dutyDate,
        shift_code: shiftCode,
        station: station || "KUL",
        team: team || null,
        status: "absent",
        late_remark: `Absent notice: ${remarks} (${formattedGap})`,
      },
      { onConflict: "profile_id,duty_date,shift_code" }
    );
  } catch (err) {
    // Non-fatal if duty_records constraint differs
    console.warn("[submitAbsenceNotice] duty_records update note:", err);
  }

  revalidatePath("/avsec/duty");
  revalidatePath("/avsec/admin/absences");

  return {
    error: null,
    success: true,
    status,
    formattedGap,
    submittedAt: submittedAt.toISOString(),
  };
}
