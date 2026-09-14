/**
 * Single authoritative OT calculation. Every place that auto-generates or
 * previews overtime (check-in, check-out, heatmap, suggestions) must go
 * through this — do not re-derive the formula locally.
 *
 * Core rule this exists to enforce: OT can never be computed past how long
 * someone actually worked. A late-departure OT window starts at
 * max(scheduledEnd, actualCheckIn) — never at scheduledEnd alone — so
 * checking in long after a shift was supposed to end and checking straight
 * back out can never read as hours of "late overtime" that were never
 * worked (the bug this fixes: check-in 17:55 / check-out 17:55 on a shift
 * scheduled to end at 15:55 must yield 0 OT, not 2 payable hours).
 */

// Below this many minutes, it's not worth recording as OT — matches the
// "even 30 minutes counts" policy without generating noise for a
// two-minute overrun.
export const OT_THRESHOLD_MINUTES = 30;

export interface OvertimeCalcResult {
  /** Minutes worked before the scheduled shift start (0 if no scheduled shift). */
  earlyMinutes: number;
  /** Minutes worked after the scheduled shift end, bounded by actual check-in
   * and actual checkout (0 if no scheduled shift, or nothing worked past it). */
  lateMinutes: number;
  /** Minutes worked when there was no scheduled shift at all (rostered OFF
   * day) — the whole worked duration is potential OT in that case. */
  offDayMinutes: number;
  earlyEligible: boolean;
  lateEligible: boolean;
  offDayEligible: boolean;
}

export function calculateOvertime({
  scheduledStart,
  scheduledEnd,
  actualCheckIn,
  actualCheckOut,
  thresholdMinutes = OT_THRESHOLD_MINUTES,
}: {
  scheduledStart: Date | null;
  scheduledEnd: Date | null;
  actualCheckIn: Date;
  actualCheckOut: Date;
  thresholdMinutes?: number;
}): OvertimeCalcResult {
  const hasScheduledShift = scheduledStart !== null && scheduledEnd !== null;

  let earlyMinutes = 0;
  let lateMinutes = 0;
  let offDayMinutes = 0;

  if (hasScheduledShift) {
    // Early arrival: how long before scheduled start they actually checked in.
    earlyMinutes = Math.max(0, Math.round((scheduledStart!.getTime() - actualCheckIn.getTime()) / 60000));

    // Late departure: OT clock starts at whichever is LATER — the scheduled
    // end, or when they actually checked in (never earlier than either) —
    // and ends at actual checkout, never later.
    const otStart = new Date(Math.max(scheduledEnd!.getTime(), actualCheckIn.getTime()));
    lateMinutes = Math.max(0, Math.round((actualCheckOut.getTime() - otStart.getTime()) / 60000));
  } else {
    // No scheduled shift (rostered OFF / no roster row) — the entire worked
    // duration is potential OT, bounded by actual check-in/checkout only.
    offDayMinutes = Math.max(0, Math.round((actualCheckOut.getTime() - actualCheckIn.getTime()) / 60000));
  }

  return {
    earlyMinutes,
    lateMinutes,
    offDayMinutes,
    earlyEligible: earlyMinutes >= thresholdMinutes,
    lateEligible: lateMinutes >= thresholdMinutes,
    offDayEligible: offDayMinutes >= thresholdMinutes,
  };
}

/** Whole completed hours only, never rounded up. Bounded by actual check-in
 * so a late check-in can't inflate "hours worked beyond scheduled end". */
export function calcOtHours(scheduledEnd: Date, checkIn: Date, checkOut: Date): number {
  const otStart = new Date(Math.max(scheduledEnd.getTime(), checkIn.getTime()));
  const minutesPast = Math.floor((checkOut.getTime() - otStart.getTime()) / 60000);
  if (minutesPast <= 0) return 0;
  return Math.floor(minutesPast / 60);
}
