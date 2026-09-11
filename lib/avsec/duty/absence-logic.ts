export type AbsenceStatus = "green" | "red";

export type LeaveType =
  | "absent"
  | "mc"
  | "emergency"
  | "annual"
  | "compassionate"
  | "hospitalization"
  | "maternity_paternity"
  | "unpaid"
  | "representative";

export type LeaveApprovalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "pending_cancellation"
  | "cancelled";

export const LEAVE_TYPES: readonly LeaveType[] = [
  "absent",
  "mc",
  "emergency",
  "annual",
  "compassionate",
  "hospitalization",
  "maternity_paternity",
  "unpaid",
  "representative",
] as const;

export const LEAVE_TYPE_LABELS: Record<LeaveType, string> = {
  absent: "Absent / Uninformed",
  mc: "Sick Leave",
  emergency: "Emergency Leave",
  annual: "Annual Leave",
  compassionate: "Compassionate / Bereavement Leave",
  hospitalization: "Hospitalization Leave",
  maternity_paternity: "Maternity / Paternity Leave",
  unpaid: "Unpaid Leave",
  representative: "Representative Leave",
};

export const LEAVE_TYPE_SHORT_LABELS: Record<LeaveType, string> = {
  absent: "Absent",
  mc: "Sick Leave",
  emergency: "Emergency",
  annual: "Annual",
  compassionate: "Compassionate",
  hospitalization: "Hospitalization",
  maternity_paternity: "Maternity/Paternity",
  unpaid: "Unpaid",
  representative: "Representative",
};

export const LEAVE_TYPE_ICONS: Record<LeaveType, string> = {
  absent: "🚨",
  mc: "🏥",
  emergency: "⚡",
  annual: "🌴",
  compassionate: "🕯️",
  hospitalization: "🩺",
  maternity_paternity: "🍼",
  unpaid: "⏸️",
  representative: "💼",
};

/**
 * Returns the standard roster status label for an approved leave application,
 * e.g. "On Leave — Annual", "On Leave — MC", etc.
 */
export function formatOnLeaveLabel(leaveType: LeaveType): string {
  const short = LEAVE_TYPE_SHORT_LABELS[leaveType] || leaveType;
  return `On Leave — ${short}`;
}

/**
 * Checks if an approved leave is actively covering the specified date.
 * Trigger point: on approval only (pending/cancelled/rejected do not link).
 */
export function isLeaveActiveOnDate(
  leave: { approval_status: string; start_date: string; end_date: string },
  date: string
): boolean {
  return (
    leave.approval_status === "approved" &&
    leave.start_date <= date &&
    leave.end_date >= date
  );
}

/**
 * Checks if there is a coverage conflict between an active working shift and an approved leave.
 * A conflict exists if the officer is on approved leave while an active shift (not OFF) is rostered.
 */
export function hasRosterConflict(
  shiftCode: string | null | undefined,
  hasApprovedLeave: boolean
): boolean {
  if (!hasApprovedLeave || !shiftCode) return false;
  return shiftCode.toUpperCase() !== "OFF";
}

export interface AbsenceCalculationResult {
  gapMinutes: number;
  status: AbsenceStatus;
  isCompliant: boolean;
  formattedGap: string;
}

/**
 * Minimum advance notice required for compliant (green) absence reporting: 3 hours (180 minutes).
 */
export const COMPLIANT_NOTICE_MINUTES = 180;

/**
 * Maximum concurrent approved Annual Leave applications allowed per team before Management escalation.
 */
export const MAX_CONCURRENT_ANNUAL_LEAVE = 3;

/**
 * Checks if a leave application is for today (same-day notice).
 */
export function isSameDayLeave(startDate: string, todayDate: string): boolean {
  return startDate === todayDate;
}

/**
 * Checks if two date ranges [startA, endA] and [startB, endB] overlap (inclusive).
 */
export function checkDatesOverlap(
  startA: string,
  endA: string,
  startB: string,
  endB: string
): boolean {
  return startA <= endB && endA >= startB;
}

/**
 * Formats the gap between submission time and shift start into human-readable text.
 * E.g.:
 * - gapMinutes = 190 -> "Requested 3h 10m before shift"
 * - gapMinutes = 180 -> "Requested 3h before shift"
 * - gapMinutes = 45 -> "Requested 45m before shift"
 * - gapMinutes = -80 -> "Requested 1h 20m after shift start"
 * - gapMinutes = -45 -> "Requested 45m after shift start"
 * - gapMinutes = 0 -> "Requested at exact shift start"
 */
export function formatAbsenceGap(gapMinutes: number): string {
  if (gapMinutes === 0) {
    return "Requested at exact shift start";
  }

  if (gapMinutes > 0) {
    const hours = Math.floor(gapMinutes / 60);
    const mins = gapMinutes % 60;
    if (hours > 0 && mins > 0) {
      return `Requested ${hours}h ${mins}m before shift`;
    } else if (hours > 0) {
      return `Requested ${hours}h before shift`;
    } else {
      return `Requested ${mins}m before shift`;
    }
  } else {
    const absMinutes = Math.abs(gapMinutes);
    const hours = Math.floor(absMinutes / 60);
    const mins = absMinutes % 60;
    if (hours > 0 && mins > 0) {
      return `Requested ${hours}h ${mins}m after shift start`;
    } else if (hours > 0) {
      return `Requested ${hours}h after shift start`;
    } else {
      return `Requested ${mins}m after shift start`;
    }
  }
}

/**
 * Calculates the exact advance notice gap and status.
 * Notice timing:
 * - gapMinutes = Math.round((scheduledStart.getTime() - submittedAt.getTime()) / 60000)
 * - status = 'green' if gapMinutes >= 180, else 'red' (late notice or after shift start)
 */
export function calculateAbsenceGap(
  scheduledStart: Date,
  submittedAt: Date
): AbsenceCalculationResult {
  const gapMinutes = Math.round(
    (scheduledStart.getTime() - submittedAt.getTime()) / 60000
  );
  const isCompliant = gapMinutes >= COMPLIANT_NOTICE_MINUTES;
  const status: AbsenceStatus = isCompliant ? "green" : "red";
  const formattedGap = formatAbsenceGap(gapMinutes);

  return {
    gapMinutes,
    status,
    isCompliant,
    formattedGap,
  };
}
