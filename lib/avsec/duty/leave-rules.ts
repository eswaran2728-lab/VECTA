/**
 * Leave authority and cancellation rules. Pure so every boundary is unit-tested; the DATABASE functions review_leave_request_secure() and
 * cancel_approved_leave_secure() (migration 20261203000002) apply the same rules and are the authority. All dates are Malaysia calendar dates (YYYY-MM-DD).
 */
const DAY_MS = 86_400_000;
const dayNumber = (iso: string) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / DAY_MS);
const isoOf = (n: number) => new Date(n * DAY_MS).toISOString().slice(0, 10);

/** Malaysia (UTC+8, no DST) calendar date of an instant. */
export function malaysiaToday(ms: number): string {
  return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/** Both the first and the last day count: 3 Nov to 3 Nov is one day. */
export function inclusiveLeaveDays(start: string, end: string): number {
  return dayNumber(end) - dayNumber(start) + 1;
}

export type UnpaidApprover = { route: "operation_manager" } | { route: "boss"; role: "maa_boss" | "aax_boss" } | { route: "none" };

/** 1-2 inclusive days: Operation Manager. 3 or more: the Boss of the submitter's own operating entity. The route is derived, never supplied. */
export function unpaidFinalApprover(start: string, end: string, entity: "MAA" | "AAX" | string | null): UnpaidApprover {
  if (inclusiveLeaveDays(start, end) <= 2) return { route: "operation_manager" };
  if (entity === "MAA") return { route: "boss", role: "maa_boss" };
  if (entity === "AAX") return { route: "boss", role: "aax_boss" };
  return { route: "none" };
}

export interface ApprovedSpan {
  user: string;
  start: string;
  end: string;
}

/** The highest number of OTHER distinct officers already absent on any single calendar day of [start, end]. */
export function peakSameDayOverlap(approved: ReadonlyArray<ApprovedSpan>, start: string, end: string, applicant: string): number {
  let peak = 0;
  for (let d = dayNumber(start); d <= dayNumber(end); d += 1) {
    const iso = isoOf(d);
    const who = new Set(approved.filter((a) => a.user !== applicant && a.start <= iso && a.end >= iso).map((a) => a.user));
    peak = Math.max(peak, who.size);
  }
  return peak;
}

/** The applicant would be the fourth (or later) officer absent on at least one same day, so only the Operation Manager may approve it as an exception. */
export function requiresOverlapException(approved: ReadonlyArray<ApprovedSpan>, start: string, end: string, applicant: string): boolean {
  return peakSameDayOverlap(approved, start, end, applicant) >= 3;
}

export interface CancellableNotice {
  approval_status: string;
  leave_type: string;
  start_date: string;
  end_date: string;
  cancelled_at: string | null;
}

export type CancellationPlan =
  | { ok: true; kind: "full" | "partial"; keepThrough: string | null; releaseFrom: string }
  | { ok: false; reason: string };

/**
 * Future leave is released in full. Leave already underway keeps today and every earlier Malaysia day as taken and releases only tomorrow onward.
 * Completed leave, repeated cancellation and leave with nothing after today cannot be cancelled.
 */
export function planAnnualLeaveCancellation(n: CancellableNotice, today: string): CancellationPlan {
  if (n.leave_type !== "annual") return { ok: false, reason: "Only annual leave can be cancelled this way." };
  if (n.cancelled_at || n.approval_status === "cancelled") return { ok: false, reason: "This leave has already been cancelled." };
  if (n.approval_status !== "approved") return { ok: false, reason: "Only approved leave can be cancelled this way." };
  if (n.end_date < today) return { ok: false, reason: "Completed leave cannot be cancelled." };
  if (n.start_date > today) return { ok: true, kind: "full", keepThrough: null, releaseFrom: n.start_date };
  if (n.end_date <= today) return { ok: false, reason: "No days remain after today to release." };
  return { ok: true, kind: "partial", keepThrough: today, releaseFrom: isoOf(dayNumber(today) + 1) };
}
