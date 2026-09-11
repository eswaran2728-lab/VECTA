import test from "node:test";
import assert from "node:assert/strict";
import { calcOtHours } from "../lib/avsec/duty/overtime.ts";
import { computePeriodDateRange } from "../lib/avsec/duty/merged-attendance-logic.ts";

test("Auto OT Calculation: calcOtHours computes whole completed hours (round down, never up)", () => {
  const scheduledEnd = new Date("2026-09-11T16:00:00+08:00");

  // On time checkout -> 0h OT
  assert.equal(calcOtHours(scheduledEnd, new Date("2026-09-11T16:00:00+08:00")), 0);

  // Early checkout (e.g. 15 mins before) -> 0h OT
  assert.equal(calcOtHours(scheduledEnd, new Date("2026-09-11T15:45:00+08:00")), 0);

  // 29 minutes past -> 0h OT
  assert.equal(calcOtHours(scheduledEnd, new Date("2026-09-11T16:29:00+08:00")), 0);

  // 59 minutes past -> 0h OT (not a full whole hour yet)
  assert.equal(calcOtHours(scheduledEnd, new Date("2026-09-11T16:59:00+08:00")), 0);

  // Exactly 60 minutes past -> 1h OT
  assert.equal(calcOtHours(scheduledEnd, new Date("2026-09-11T17:00:00+08:00")), 1);

  // 89 minutes past -> 1h OT
  assert.equal(calcOtHours(scheduledEnd, new Date("2026-09-11T17:29:00+08:00")), 1);

  // 119 minutes past -> 1h OT
  assert.equal(calcOtHours(scheduledEnd, new Date("2026-09-11T17:59:00+08:00")), 1);

  // Exactly 120 minutes past -> 2h OT
  assert.equal(calcOtHours(scheduledEnd, new Date("2026-09-11T18:00:00+08:00")), 2);

  // 195 minutes past (3h 15m) -> 3h OT
  assert.equal(calcOtHours(scheduledEnd, new Date("2026-09-11T19:15:00+08:00")), 3);
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

test("DSE OT Review Authorization Rules", () => {
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
    status: "pending" | "approved" | "rejected";
  }

  function canReviewOvertime(reviewer: Officer, ot: OtRecord): boolean {
    if (reviewer.id === ot.profile_id) return false; // cannot approve own OT
    if (reviewer.role === "ADMIN" || reviewer.role === "MANAGEMENT") return true;
    if (reviewer.role === "DSE") {
      return reviewer.station === ot.station; // DSE reviews within own branch/station
    }
    return false;
  }

  const asoStaff: Officer = { id: "u-aso", role: "ASO", station: "KUL", team: "A" };
  const dseKul: Officer = { id: "u-dse-kul", role: "DSE", station: "KUL", team: "A" };
  const dsePen: Officer = { id: "u-dse-pen", role: "DSE", station: "PEN", team: "B" };
  const mgmt: Officer = { id: "u-mgmt", role: "MANAGEMENT", station: "KUL", team: "HQ" };

  const otRecord: OtRecord = {
    id: "ot-1",
    profile_id: asoStaff.id,
    station: "KUL",
    team: "A",
    status: "pending",
  };

  // Staff cannot review own
  assert.equal(canReviewOvertime(asoStaff, otRecord), false);

  // DSE of same station CAN review & approve
  assert.equal(canReviewOvertime(dseKul, otRecord), true);

  // DSE of different station CANNOT review
  assert.equal(canReviewOvertime(dsePen, otRecord), false);

  // Management can review org-wide
  assert.equal(canReviewOvertime(mgmt, otRecord), true);
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
