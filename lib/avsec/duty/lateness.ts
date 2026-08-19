import { combineDateTimeMY } from "@/lib/avsec/datetime";

// Below this many minutes past/before the scheduled edge, no remark is required and the
// check-in/out counts as on-time — avoids flagging trivial 2-3 minute drift.
export const GRACE_MINUTES = 10;

/** Scheduled shift start/end as real Date instants, correctly rolling the end into the
 * next calendar day for overnight shifts (e.g. Night 1900-0700). */
export function scheduledWindow(dutyDate: string, startTime: string, endTime: string): { start: Date; end: Date } {
  const start = new Date(combineDateTimeMY(dutyDate, startTime.slice(0, 5)));
  let end = new Date(combineDateTimeMY(dutyDate, endTime.slice(0, 5)));
  if (end.getTime() <= start.getTime()) {
    end = new Date(end.getTime() + 24 * 60 * 60 * 1000);
  }
  return { start, end };
}

/** Minutes late past scheduled start, past the grace window — 0 if within grace (on-time). */
export function computeLateMinutes(scheduledStart: Date, actual: Date, grace = GRACE_MINUTES): number {
  const raw = Math.round((actual.getTime() - scheduledStart.getTime()) / 60000);
  return raw > grace ? raw : 0;
}

/** Minutes checked out before scheduled end, past the grace window — 0 if within grace. */
export function computeEarlyMinutes(scheduledEnd: Date, actual: Date, grace = GRACE_MINUTES): number {
  const raw = Math.round((scheduledEnd.getTime() - actual.getTime()) / 60000);
  return raw > grace ? raw : 0;
}
