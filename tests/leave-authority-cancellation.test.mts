import { test } from "node:test";
import assert from "node:assert/strict";
import { inclusiveLeaveDays, unpaidFinalApprover, peakSameDayOverlap, requiresOverlapException, planAnnualLeaveCancellation, malaysiaToday } from "../lib/avsec/duty/leave-rules.ts";

test("inclusive calendar days: same day is 1, two consecutive days is 2, across a month and year end", () => {
  assert.equal(inclusiveLeaveDays("2026-11-03", "2026-11-03"), 1);
  assert.equal(inclusiveLeaveDays("2026-11-03", "2026-11-04"), 2);
  assert.equal(inclusiveLeaveDays("2026-11-03", "2026-11-05"), 3);
  assert.equal(inclusiveLeaveDays("2026-12-31", "2027-01-02"), 3);
});

test("unpaid leave: 1-2 inclusive days finalised by the Operation Manager, 3+ by the submitter's entity Boss; route never client-supplied", () => {
  assert.deepEqual(unpaidFinalApprover("2026-11-03", "2026-11-04", "MAA"), { route: "operation_manager" });
  assert.deepEqual(unpaidFinalApprover("2026-11-03", "2026-11-05", "MAA"), { route: "boss", role: "maa_boss" });
  assert.deepEqual(unpaidFinalApprover("2026-11-03", "2026-11-05", "AAX"), { route: "boss", role: "aax_boss" });
  assert.deepEqual(unpaidFinalApprover("2026-11-03", "2026-11-05", null), { route: "none" }, "no single active entity: nobody can finalise it");
  assert.deepEqual(unpaidFinalApprover("2026-11-03", "2026-11-04", null), { route: "operation_manager" });
});

test("overlap exception: four distinct officers absent on at least ONE same calendar day; ranges that only touch on different days do not count", () => {
  const leaves = (spans: [string, string, string][]) => spans.map(([user, start, end]) => ({ user, start, end }));
  const three = leaves([["a", "2026-12-01", "2026-12-03"], ["b", "2026-12-02", "2026-12-04"], ["c", "2026-12-03", "2026-12-05"]]);
  assert.equal(peakSameDayOverlap(three, "2026-12-03", "2026-12-03", "d"), 3, "all three overlap on the 3rd");
  assert.equal(requiresOverlapException(three, "2026-12-03", "2026-12-03", "d"), true);
  // d only touches a on the 1st and c on the 5th, never all three on one day
  assert.equal(peakSameDayOverlap(three, "2026-12-05", "2026-12-07", "d"), 1);
  assert.equal(requiresOverlapException(three, "2026-12-05", "2026-12-07", "d"), false);
  // the old rule (any overlap counts) would have flagged this chain; the day-by-day rule must not
  const chain = leaves([["a", "2026-12-01", "2026-12-02"], ["b", "2026-12-03", "2026-12-04"], ["c", "2026-12-05", "2026-12-06"]]);
  assert.equal(requiresOverlapException(chain, "2026-12-01", "2026-12-06", "d"), false);
  assert.equal(peakSameDayOverlap(three, "2026-12-03", "2026-12-03", "a"), 2, "the applicant's own leave is excluded");
});

test("cancellation plan: future leave is fully released; underway keeps today and earlier and releases tomorrow onward; completed cannot be cancelled", () => {
  const base = { approval_status: "approved", leave_type: "annual", cancelled_at: null as string | null };
  const today = "2026-12-10";
  assert.deepEqual(planAnnualLeaveCancellation({ ...base, start_date: "2026-12-11", end_date: "2026-12-14" }, today), { ok: true, kind: "full", keepThrough: null, releaseFrom: "2026-12-11" });
  assert.deepEqual(planAnnualLeaveCancellation({ ...base, start_date: "2026-12-08", end_date: "2026-12-14" }, today), { ok: true, kind: "partial", keepThrough: "2026-12-10", releaseFrom: "2026-12-11" });
  assert.deepEqual(planAnnualLeaveCancellation({ ...base, start_date: "2026-12-10", end_date: "2026-12-12" }, today), { ok: true, kind: "partial", keepThrough: "2026-12-10", releaseFrom: "2026-12-11" }, "starting today keeps today");
  const ended = planAnnualLeaveCancellation({ ...base, start_date: "2026-12-08", end_date: "2026-12-09" }, today);
  assert.equal(ended.ok, false);
  const lastDay = planAnnualLeaveCancellation({ ...base, start_date: "2026-12-08", end_date: "2026-12-10" }, today);
  assert.equal(lastDay.ok, false, "ending today: nothing from tomorrow to release");
  assert.equal(planAnnualLeaveCancellation({ ...base, start_date: "2026-12-11", end_date: "2026-12-12", cancelled_at: "2026-12-10T00:00:00Z" }, today).ok, false, "repeat cancellation rejected");
  assert.equal(planAnnualLeaveCancellation({ ...base, approval_status: "cancelled", start_date: "2026-12-11", end_date: "2026-12-12" }, today).ok, false);
  assert.equal(planAnnualLeaveCancellation({ ...base, approval_status: "pending", start_date: "2026-12-11", end_date: "2026-12-12" }, today).ok, false);
  assert.equal(planAnnualLeaveCancellation({ ...base, leave_type: "mc", start_date: "2026-12-11", end_date: "2026-12-12" }, today).ok, false);
});

test("Malaysia midnight: 16:00 UTC is already the next Malaysian day", () => {
  assert.equal(malaysiaToday(Date.UTC(2026, 11, 9, 15, 59, 59)), "2026-12-09");
  assert.equal(malaysiaToday(Date.UTC(2026, 11, 9, 16, 0, 0)), "2026-12-10");
  // a leave ending 9 Dec is completed from 00:00 MYT on 10 Dec
  const n = { approval_status: "approved", leave_type: "annual", cancelled_at: null, start_date: "2026-12-05", end_date: "2026-12-09" };
  assert.equal(planAnnualLeaveCancellation(n, malaysiaToday(Date.UTC(2026, 11, 9, 15, 59, 59))).ok, false, "9 Dec is the last day: nothing after today");
  assert.equal(planAnnualLeaveCancellation({ ...n, end_date: "2026-12-10" }, malaysiaToday(Date.UTC(2026, 11, 9, 15, 59, 59))).ok, true, "tomorrow (10 Dec) still releasable before midnight");
  assert.equal(planAnnualLeaveCancellation({ ...n, end_date: "2026-12-10" }, malaysiaToday(Date.UTC(2026, 11, 9, 16, 0, 0))).ok, false, "after midnight 10 Dec is today, so nothing is released");
});
