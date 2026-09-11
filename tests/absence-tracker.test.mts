import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateAbsenceGap,
  formatAbsenceGap,
  COMPLIANT_NOTICE_MINUTES,
  LEAVE_TYPES,
  LEAVE_TYPE_LABELS,
  isSameDayLeave,
  type LeaveType,
} from "../lib/avsec/duty/absence-logic.ts";

test("LEAVE_TYPES: covers all 9 required leave types", () => {
  const expected: LeaveType[] = [
    "absent",
    "mc",
    "emergency",
    "annual",
    "compassionate",
    "hospitalization",
    "maternity_paternity",
    "unpaid",
    "representative",
  ];

  assert.equal(LEAVE_TYPES.length, 9);
  for (const t of expected) {
    assert.ok(LEAVE_TYPES.includes(t), `Missing leave type: ${t}`);
    assert.ok(LEAVE_TYPE_LABELS[t], `Missing label for leave type: ${t}`);
  }
});

test("isSameDayLeave: true only when start date matches today date", () => {
  assert.equal(isSameDayLeave("2026-09-12", "2026-09-12"), true);
  assert.equal(isSameDayLeave("2026-09-13", "2026-09-12"), false);
  assert.equal(isSameDayLeave("2026-10-01", "2026-09-12"), false);
});

test("calculateAbsenceGap: compliant notice >= 3 hours (180 minutes) yields green status", () => {
  // Shift starts at 08:00 (480 mins from midnight)
  // Submitted at 04:50 (290 mins from midnight) -> gap = 190 mins (3h 10m)
  const shiftStart = new Date("2026-09-12T08:00:00+08:00");
  const submittedAt = new Date("2026-09-12T04:50:00+08:00");

  const result = calculateAbsenceGap(shiftStart, submittedAt);
  assert.equal(result.gapMinutes, 190);
  assert.equal(result.isCompliant, true);
  assert.equal(result.status, "green");
});

test("calculateAbsenceGap: exactly 3 hours (180 minutes) before shift yields green status", () => {
  const shiftStart = new Date("2026-09-12T08:00:00+08:00");
  const submittedAt = new Date("2026-09-12T05:00:00+08:00");

  const result = calculateAbsenceGap(shiftStart, submittedAt);
  assert.equal(result.gapMinutes, 180);
  assert.equal(result.isCompliant, true);
  assert.equal(result.status, "green");
});

test("calculateAbsenceGap: 2h59m (179 minutes) before shift yields red status (late notice)", () => {
  const shiftStart = new Date("2026-09-12T08:00:00+08:00");
  const submittedAt = new Date("2026-09-12T05:01:00+08:00");

  const result = calculateAbsenceGap(shiftStart, submittedAt);
  assert.equal(result.gapMinutes, 179);
  assert.equal(result.isCompliant, false);
  assert.equal(result.status, "red");
});

test("calculateAbsenceGap: 2 hours (120 minutes) before shift yields red status under 3-hour threshold", () => {
  const shiftStart = new Date("2026-09-12T08:00:00+08:00");
  const submittedAt = new Date("2026-09-12T06:00:00+08:00");

  const result = calculateAbsenceGap(shiftStart, submittedAt);
  assert.equal(result.gapMinutes, 120);
  assert.equal(result.isCompliant, false);
  assert.equal(result.status, "red");
});

test("calculateAbsenceGap: 45 minutes before shift yields red status", () => {
  const shiftStart = new Date("2026-09-12T08:00:00+08:00");
  const submittedAt = new Date("2026-09-12T07:15:00+08:00");

  const result = calculateAbsenceGap(shiftStart, submittedAt);
  assert.equal(result.gapMinutes, 45);
  assert.equal(result.isCompliant, false);
  assert.equal(result.status, "red");
});

test("calculateAbsenceGap: at exact shift start (0m) yields red status", () => {
  const shiftStart = new Date("2026-09-12T08:00:00+08:00");
  const submittedAt = new Date("2026-09-12T08:00:00+08:00");

  const result = calculateAbsenceGap(shiftStart, submittedAt);
  assert.equal(result.gapMinutes, 0);
  assert.equal(result.isCompliant, false);
  assert.equal(result.status, "red");
});

test("calculateAbsenceGap: after shift start (negative gap) is accepted and yields red status", () => {
  // Submitted 1 hour 20 minutes (80m) after shift start
  const shiftStart = new Date("2026-09-12T08:00:00+08:00");
  const submittedAt = new Date("2026-09-12T09:20:00+08:00");

  const result = calculateAbsenceGap(shiftStart, submittedAt);
  assert.equal(result.gapMinutes, -80);
  assert.equal(result.isCompliant, false);
  assert.equal(result.status, "red");
});

test("formatAbsenceGap: formats human-readable strings according to spec", () => {
  assert.equal(formatAbsenceGap(190), "Requested 3h 10m before shift");
  assert.equal(formatAbsenceGap(180), "Requested 3h before shift");
  assert.equal(formatAbsenceGap(45), "Requested 45m before shift");
  assert.equal(formatAbsenceGap(-80), "Requested 1h 20m after shift start");
  assert.equal(formatAbsenceGap(120), "Requested 2h before shift");
  assert.equal(formatAbsenceGap(60), "Requested 1h before shift");
  assert.equal(formatAbsenceGap(1), "Requested 1m before shift");
  assert.equal(formatAbsenceGap(-1), "Requested 1m after shift start");
  assert.equal(formatAbsenceGap(0), "Requested at exact shift start");
});

test("COMPLIANT_NOTICE_MINUTES constant equals 180 (3 hours)", () => {
  assert.equal(COMPLIANT_NOTICE_MINUTES, 180);
});

test("MAX_CONCURRENT_ANNUAL_LEAVE constant equals 3", async () => {
  const { MAX_CONCURRENT_ANNUAL_LEAVE } = await import("../lib/avsec/duty/absence-logic.ts");
  assert.equal(MAX_CONCURRENT_ANNUAL_LEAVE, 3);
});

test("checkDatesOverlap: correctly identifies overlapping and non-overlapping date ranges", async () => {
  const { checkDatesOverlap } = await import("../lib/avsec/duty/absence-logic.ts");

  // Exact same range
  assert.equal(checkDatesOverlap("2026-10-01", "2026-10-05", "2026-10-01", "2026-10-05"), true);

  // Partial overlap (A starts earlier, B ends later)
  assert.equal(checkDatesOverlap("2026-10-01", "2026-10-05", "2026-10-03", "2026-10-08"), true);

  // Single day boundary overlap
  assert.equal(checkDatesOverlap("2026-10-01", "2026-10-05", "2026-10-05", "2026-10-10"), true);
  assert.equal(checkDatesOverlap("2026-10-05", "2026-10-10", "2026-10-01", "2026-10-05"), true);

  // Contained within
  assert.equal(checkDatesOverlap("2026-10-01", "2026-10-10", "2026-10-03", "2026-10-06"), true);

  // Non-overlapping (disjoint before)
  assert.equal(checkDatesOverlap("2026-10-01", "2026-10-04", "2026-10-05", "2026-10-10"), false);

  // Non-overlapping (disjoint after)
  assert.equal(checkDatesOverlap("2026-10-11", "2026-10-15", "2026-10-01", "2026-10-10"), false);
});

test("Annual Leave Concurrency Cap: 3-person cap blocks 4th overlapping application on same team from DSE", async () => {
  const { checkDatesOverlap, MAX_CONCURRENT_ANNUAL_LEAVE } = await import("../lib/avsec/duty/absence-logic.ts");

  // Simulated existing approved applications in DB
  interface MockLeave {
    user_id: string;
    station: string;
    team: string;
    leave_type: LeaveType;
    approval_status: string;
    start_date: string;
    end_date: string;
  }

  const existingApproved: MockLeave[] = [
    {
      user_id: "user-1",
      station: "KUL",
      team: "Alpha",
      leave_type: "annual",
      approval_status: "approved",
      start_date: "2026-10-01",
      end_date: "2026-10-05",
    },
    {
      user_id: "user-2",
      station: "KUL",
      team: "Alpha",
      leave_type: "annual",
      approval_status: "approved",
      start_date: "2026-10-03",
      end_date: "2026-10-07",
    },
    {
      user_id: "user-3",
      station: "KUL",
      team: "Alpha",
      leave_type: "annual",
      approval_status: "approved",
      start_date: "2026-10-04",
      end_date: "2026-10-10",
    },
  ];

  function evaluateDSEApproval(
    newApplication: MockLeave,
    userRole: "DSE" | "MANAGEMENT"
  ): { allowed: boolean; reason?: string } {
    const isOrgWide = userRole === "MANAGEMENT";

    if (newApplication.leave_type === "annual" && !isOrgWide) {
      const overlappingUsers = new Set<string>();
      for (const row of existingApproved) {
        if (
          row.leave_type === "annual" &&
          row.approval_status === "approved" &&
          row.station === newApplication.station &&
          row.team === newApplication.team &&
          row.user_id !== newApplication.user_id &&
          checkDatesOverlap(row.start_date, row.end_date, newApplication.start_date, newApplication.end_date)
        ) {
          overlappingUsers.add(row.user_id);
        }
      }

      if (overlappingUsers.size >= MAX_CONCURRENT_ANNUAL_LEAVE) {
        return {
          allowed: false,
          reason: `Team Annual Leave concurrency cap reached (${overlappingUsers.size}/3 approved for overlapping dates). Approving this 4th application is escalated and requires Management approval.`,
        };
      }
    }

    return { allowed: true };
  }

  // 1. 4th person on Team Alpha with overlapping dates (Oct 4 - Oct 6) -> BLOCKED for DSE
  const person4Overlapping: MockLeave = {
    user_id: "user-4",
    station: "KUL",
    team: "Alpha",
    leave_type: "annual",
    approval_status: "pending",
    start_date: "2026-10-04",
    end_date: "2026-10-06",
  };
  const dseResult1 = evaluateDSEApproval(person4Overlapping, "DSE");
  assert.equal(dseResult1.allowed, false);
  assert.ok(dseResult1.reason?.includes("Team Annual Leave concurrency cap reached"));

  // 2. Management CAN approve the 4th escalated application
  const mgmtResult = evaluateDSEApproval(person4Overlapping, "MANAGEMENT");
  assert.equal(mgmtResult.allowed, true);

  // 3. 4th person on Team Alpha with NON-overlapping dates (Oct 15 - Oct 20) -> ALLOWED for DSE
  const person4NonOverlapping: MockLeave = {
    user_id: "user-4",
    station: "KUL",
    team: "Alpha",
    leave_type: "annual",
    approval_status: "pending",
    start_date: "2026-10-15",
    end_date: "2026-10-20",
  };
  const dseResult2 = evaluateDSEApproval(person4NonOverlapping, "DSE");
  assert.equal(dseResult2.allowed, true);

  // 4. Person on Team Bravo (different team, same station) with overlapping dates -> ALLOWED for DSE (team scoped)
  const teamBravoPerson: MockLeave = {
    user_id: "user-5",
    station: "KUL",
    team: "Bravo",
    leave_type: "annual",
    approval_status: "pending",
    start_date: "2026-10-04",
    end_date: "2026-10-06",
  };
  const dseResult3 = evaluateDSEApproval(teamBravoPerson, "DSE");
  assert.equal(dseResult3.allowed, true);

  // 5. Non-Annual leave types (e.g. MC, Emergency) on Team Alpha with 3+ approved -> NEVER restricted by concurrency cap
  const nonAnnualTypes: LeaveType[] = [
    "mc",
    "emergency",
    "compassionate",
    "hospitalization",
    "maternity_paternity",
    "unpaid",
    "representative",
    "absent",
  ];
  for (const lt of nonAnnualTypes) {
    const nonAnnualApp: MockLeave = {
      user_id: "user-6",
      station: "KUL",
      team: "Alpha",
      leave_type: lt,
      approval_status: "pending",
      start_date: "2026-10-04",
      end_date: "2026-10-06",
    };
    const res = evaluateDSEApproval(nonAnnualApp, "DSE");
    assert.equal(res.allowed, true, `Leave type ${lt} should not be subject to annual leave concurrency cap`);
  }
});

