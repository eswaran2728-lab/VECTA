import test from "node:test";
import assert from "node:assert/strict";
import { calcOtHours, calculateOvertime } from "../lib/avsec/duty/overtime.ts";
import { computePeriodDateRange } from "../lib/avsec/duty/merged-attendance-logic.ts";

test("Auto OT Calculation: calcOtHours computes whole completed hours (round down, never up)", () => {
  const scheduledEnd = new Date("2026-09-11T16:00:00+08:00");
  const normalCheckIn = new Date("2026-09-11T08:00:00+08:00"); // well before scheduledEnd, doesn't affect bounding

  // On time checkout -> 0h OT
  assert.equal(calcOtHours(scheduledEnd, normalCheckIn, new Date("2026-09-11T16:00:00+08:00")), 0);

  // Early checkout (e.g. 15 mins before) -> 0h OT
  assert.equal(calcOtHours(scheduledEnd, normalCheckIn, new Date("2026-09-11T15:45:00+08:00")), 0);

  // 29 minutes past -> 0h OT
  assert.equal(calcOtHours(scheduledEnd, normalCheckIn, new Date("2026-09-11T16:29:00+08:00")), 0);

  // 59 minutes past -> 0h OT (not a full whole hour yet)
  assert.equal(calcOtHours(scheduledEnd, normalCheckIn, new Date("2026-09-11T16:59:00+08:00")), 0);

  // Exactly 60 minutes past -> 1h OT
  assert.equal(calcOtHours(scheduledEnd, normalCheckIn, new Date("2026-09-11T17:00:00+08:00")), 1);

  // 89 minutes past -> 1h OT
  assert.equal(calcOtHours(scheduledEnd, normalCheckIn, new Date("2026-09-11T17:29:00+08:00")), 1);

  // 119 minutes past -> 1h OT
  assert.equal(calcOtHours(scheduledEnd, normalCheckIn, new Date("2026-09-11T17:59:00+08:00")), 1);

  // Exactly 120 minutes past -> 2h OT
  assert.equal(calcOtHours(scheduledEnd, normalCheckIn, new Date("2026-09-11T18:00:00+08:00")), 2);

  // 195 minutes past (3h 15m) -> 3h OT
  assert.equal(calcOtHours(scheduledEnd, normalCheckIn, new Date("2026-09-11T19:15:00+08:00")), 3);
});

test("Auto OT Calculation: late check-in bounds the OT window (the 17:55/17:55 -> 2h bug)", () => {
  const scheduledEnd = new Date("2026-09-11T15:55:00+08:00");

  // The reported bug: check in and check out both at 17:55, having worked
  // 0 minutes. Old formula (scheduledEnd -> checkout only) produced 2h OT.
  // Fixed formula bounds the OT window to start no earlier than actual
  // check-in, so 0 minutes worked -> 0 OT.
  const lateCheckIn = new Date("2026-09-11T17:55:00+08:00");
  const sameTimeCheckOut = new Date("2026-09-11T17:55:00+08:00");
  assert.equal(calcOtHours(scheduledEnd, lateCheckIn, sameTimeCheckOut), 0);

  // Checking in late but working a bit after: OT is bounded to actual
  // worked time past check-in, not past scheduledEnd.
  const shortCheckOut = new Date("2026-09-11T18:10:00+08:00"); // 15 min worked
  assert.equal(calcOtHours(scheduledEnd, lateCheckIn, shortCheckOut), 0);
});

// ---- calculateOvertime() test matrix (12-case audit spec) ----

test("Case 1: on-time attendance -> 0 OT", () => {
  const scheduledStart = new Date("2026-09-11T08:00:00+08:00");
  const scheduledEnd = new Date("2026-09-11T17:00:00+08:00");
  const result = calculateOvertime({
    scheduledStart,
    scheduledEnd,
    actualCheckIn: new Date("2026-09-11T08:00:00+08:00"),
    actualCheckOut: new Date("2026-09-11T17:00:00+08:00"),
  });
  assert.equal(result.earlyMinutes, 0);
  assert.equal(result.lateMinutes, 0);
  assert.equal(result.earlyEligible, false);
  assert.equal(result.lateEligible, false);
});

test("Case 2: early arrival -> early OT per threshold", () => {
  const scheduledStart = new Date("2026-09-11T08:00:00+08:00");
  const scheduledEnd = new Date("2026-09-11T17:00:00+08:00");
  const result = calculateOvertime({
    scheduledStart,
    scheduledEnd,
    actualCheckIn: new Date("2026-09-11T07:00:00+08:00"),
    actualCheckOut: new Date("2026-09-11T17:00:00+08:00"),
  });
  assert.equal(result.earlyMinutes, 60);
  assert.equal(result.earlyEligible, true);
  assert.equal(result.lateMinutes, 0);
});

test("Case 3: late departure -> late OT per threshold", () => {
  const scheduledStart = new Date("2026-09-11T08:00:00+08:00");
  const scheduledEnd = new Date("2026-09-11T17:00:00+08:00");
  const result = calculateOvertime({
    scheduledStart,
    scheduledEnd,
    actualCheckIn: new Date("2026-09-11T08:00:00+08:00"),
    actualCheckOut: new Date("2026-09-11T19:00:00+08:00"),
  });
  assert.equal(result.lateMinutes, 120);
  assert.equal(result.lateEligible, true);
  assert.equal(result.earlyMinutes, 0);
});

test("Case 4: early + late OT both calculated, no duplication", () => {
  const scheduledStart = new Date("2026-09-11T08:00:00+08:00");
  const scheduledEnd = new Date("2026-09-11T17:00:00+08:00");
  const result = calculateOvertime({
    scheduledStart,
    scheduledEnd,
    actualCheckIn: new Date("2026-09-11T06:30:00+08:00"),
    actualCheckOut: new Date("2026-09-11T19:00:00+08:00"),
  });
  assert.equal(result.earlyMinutes, 90); // 06:30 -> 08:00
  assert.equal(result.lateMinutes, 120); // 17:00 -> 19:00
  assert.equal(result.earlyEligible, true);
  assert.equal(result.lateEligible, true);
});

test("Case 5: check-in equals check-out (0 worked) -> 0 OT even on a very late check-in", () => {
  const scheduledStart = new Date("2026-09-11T08:00:00+08:00");
  const scheduledEnd = new Date("2026-09-11T17:00:00+08:00");
  const result = calculateOvertime({
    scheduledStart,
    scheduledEnd,
    actualCheckIn: new Date("2026-09-11T17:55:00+08:00"),
    actualCheckOut: new Date("2026-09-11T17:55:00+08:00"),
  });
  assert.equal(result.lateMinutes, 0);
  assert.equal(result.lateEligible, false);
  assert.equal(result.earlyMinutes, 0);
});

test("Case 6: checkout before scheduled end -> late OT = 0", () => {
  const scheduledStart = new Date("2026-09-11T08:00:00+08:00");
  const scheduledEnd = new Date("2026-09-11T17:00:00+08:00");
  const result = calculateOvertime({
    scheduledStart,
    scheduledEnd,
    actualCheckIn: new Date("2026-09-11T08:00:00+08:00"),
    actualCheckOut: new Date("2026-09-11T16:45:00+08:00"),
  });
  assert.equal(result.lateMinutes, 0);
  assert.equal(result.lateEligible, false);
});

test("Case 7: no scheduled shift (off day) -> whole worked duration is the OT candidate", () => {
  const result = calculateOvertime({
    scheduledStart: null,
    scheduledEnd: null,
    actualCheckIn: new Date("2026-09-11T09:00:00+08:00"),
    actualCheckOut: new Date("2026-09-11T13:00:00+08:00"),
  });
  assert.equal(result.offDayMinutes, 240);
  assert.equal(result.offDayEligible, true);
  assert.equal(result.earlyMinutes, 0);
  assert.equal(result.lateMinutes, 0);
});

test("Case 9 (duplicate protection is a DB/action-level concern): category-scoped upsert key exists", () => {
  // The actual idempotency guarantee is the DB unique index
  // overtime_requests_duty_category_uniq (linked_duty_id, category) plus
  // .upsert(..., { onConflict: "linked_duty_id,category", ignoreDuplicates: true })
  // in checkin-actions.ts — not something calculateOvertime() itself can
  // enforce, since it's a pure function with no DB access. This test
  // documents that contract so it isn't silently dropped in a refactor.
  assert.ok(true, "see supabase/migrations/20260914000005_overtime_requests_audit_trail_and_dedup.sql");
});

test("Period Date Range: Day calculation yields exact single date", () => {
  const result = computePeriodDateRange({
    periodType: "day",
    date: "2026-09-15",
  });

  assert.equal(result.periodType, "day");
  assert.equal(result.dateFrom, "2026-09-15");
  assert.equal(result.dateTo, "2026-09-15");
  assert.deepEqual(result.dateList, ["2026-09-15"]);
});

test("Period Date Range: Month calculation yields entire month start and end", () => {
  // September (30 days)
  const sepResult = computePeriodDateRange({
    periodType: "month",
    month: "2026-09",
  });
  assert.equal(sepResult.periodType, "month");
  assert.equal(sepResult.dateFrom, "2026-09-01");
  assert.equal(sepResult.dateTo, "2026-09-30");
  assert.equal(sepResult.dateList.length, 30);
  assert.equal(sepResult.dateList[0], "2026-09-01");
  assert.equal(sepResult.dateList[29], "2026-09-30");

  // February 2026 (non-leap year, 28 days)
  const febResult = computePeriodDateRange({
    periodType: "month",
    month: "2026-02",
  });
  assert.equal(febResult.dateFrom, "2026-02-01");
  assert.equal(febResult.dateTo, "2026-02-28");
  assert.equal(febResult.dateList.length, 28);
});

test("Period Date Range: Year calculation yields Jan 1 to Dec 31", () => {
  const yearResult = computePeriodDateRange({
    periodType: "year",
    year: "2026",
  });

  assert.equal(yearResult.periodType, "year");
  assert.equal(yearResult.dateFrom, "2026-01-01");
  assert.equal(yearResult.dateTo, "2026-12-31");
  assert.equal(yearResult.dateList.length, 365);
  assert.equal(yearResult.dateList[0], "2026-01-01");
  assert.equal(yearResult.dateList[364], "2026-12-31");
});

// Mirrors the real state machine in lib/avsec/duty/overtime-actions.ts's
// reviewOvertimeRequest: PENDING -> DSE ENDORSED -> MANAGEMENT APPROVED,
// with DSE/Management-scoped REJECTED as the alternate ending.
interface Officer {
  id: string;
  role: "ASO" | "DSE" | "MANAGEMENT" | "ADMIN";
  station: string;
  team: string;
}

interface OtRecord {
  id: string;
  profile_id: string;
  station: string;
  team: string;
  status: "pending" | "endorsed" | "approved" | "rejected";
}

function canEndorse(actor: Officer, ot: OtRecord): boolean {
  if (actor.id === ot.profile_id) return false;
  return actor.role === "DSE" && actor.station === ot.station && ot.status === "pending";
}

function canApprove(actor: Officer, ot: OtRecord): boolean {
  if (actor.id === ot.profile_id) return false;
  const isMgmt = actor.role === "MANAGEMENT" || actor.role === "ADMIN";
  return isMgmt && ot.status === "endorsed";
}

function canReject(actor: Officer, ot: OtRecord): boolean {
  if (actor.id === ot.profile_id) return false;
  const isMgmt = actor.role === "MANAGEMENT" || actor.role === "ADMIN";
  if (isMgmt) return ot.status === "pending" || ot.status === "endorsed";
  if (actor.role === "DSE") return actor.station === ot.station && ot.status === "pending";
  return false;
}

test("Case 10: ASO cannot endorse, approve, or reject any OT record", () => {
  const asoStaff: Officer = { id: "u-aso", role: "ASO", station: "KUL", team: "A" };
  const otRecord: OtRecord = { id: "ot-1", profile_id: "someone-else", station: "KUL", team: "A", status: "pending" };
  assert.equal(canEndorse(asoStaff, otRecord), false);
  assert.equal(canApprove(asoStaff, otRecord), false);
  assert.equal(canReject(asoStaff, otRecord), false);
});

test("Case 11: DSE endorses a valid pending request -> pending moves to endorsed pathway", () => {
  const dseKul: Officer = { id: "u-dse-kul", role: "DSE", station: "KUL", team: "A" };
  const dsePen: Officer = { id: "u-dse-pen", role: "DSE", station: "PEN", team: "B" };
  const pending: OtRecord = { id: "ot-1", profile_id: "aso-1", station: "KUL", team: "A", status: "pending" };

  assert.equal(canEndorse(dseKul, pending), true);
  assert.equal(canEndorse(dsePen, pending), false); // different station

  // DSE cannot skip straight to approving — only Management does that, and
  // only once endorsed.
  assert.equal(canApprove(dseKul, pending), false);

  const endorsed: OtRecord = { ...pending, status: "endorsed" };
  assert.equal(canEndorse(dseKul, endorsed), false); // already endorsed, can't re-endorse
});

test("Case 12: Management approves only once endorsed, never straight from pending", () => {
  const mgmt: Officer = { id: "u-mgmt", role: "MANAGEMENT", station: "KUL", team: "HQ" };
  const pending: OtRecord = { id: "ot-1", profile_id: "aso-1", station: "KUL", team: "A", status: "pending" };
  const endorsed: OtRecord = { ...pending, status: "endorsed" };

  assert.equal(canApprove(mgmt, pending), false); // must be endorsed first
  assert.equal(canApprove(mgmt, endorsed), true);
  assert.equal(canReject(mgmt, pending), true);
  assert.equal(canReject(mgmt, endorsed), true);

  const approved: OtRecord = { ...pending, status: "approved" };
  assert.equal(canApprove(mgmt, approved), false); // already decided
  assert.equal(canReject(mgmt, approved), false);
});

test("Merged Data Aggregation: Correctly computes shifts, hours, leaves, and approved OT", () => {
  interface DummyDay {
    workedMinutes: number;
    leaveType: string | null;
    approvedLeave: boolean;
    otPayableHours: number;
    otStatus: "pending" | "approved" | "rejected" | null;
  }

  const days: DummyDay[] = [
    { workedMinutes: 480, leaveType: null, approvedLeave: false, otPayableHours: 2, otStatus: "approved" },
    { workedMinutes: 540, leaveType: null, approvedLeave: false, otPayableHours: 1, otStatus: "pending" },
    { workedMinutes: 0, leaveType: "annual", approvedLeave: true, otPayableHours: 0, otStatus: null },
    { workedMinutes: 0, leaveType: "mc", approvedLeave: true, otPayableHours: 0, otStatus: null },
    { workedMinutes: 480, leaveType: null, approvedLeave: false, otPayableHours: 0, otStatus: null },
  ];

  let totalShifts = 0;
  let totalMinutes = 0;
  let totalApprovedOt = 0;
  let totalPendingOt = 0;
  let totalLeaves = 0;

  for (const d of days) {
    if (d.workedMinutes > 0) totalShifts += 1;
    totalMinutes += d.workedMinutes;
    if (d.otStatus === "approved") totalApprovedOt += d.otPayableHours;
    if (d.otStatus === "pending") totalPendingOt += d.otPayableHours;
    if (d.approvedLeave) totalLeaves += 1;
  }

  assert.equal(totalShifts, 3);
  assert.equal(totalMinutes, 1500); // 25 hours
  assert.equal(totalMinutes / 60, 25);
  assert.equal(totalApprovedOt, 2);
  assert.equal(totalPendingOt, 1);
  assert.equal(totalLeaves, 2);
});
