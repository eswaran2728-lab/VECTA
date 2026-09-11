import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateAbsenceGap,
  formatAbsenceGap,
  COMPLIANT_NOTICE_MINUTES,
} from "../lib/avsec/duty/absence-logic.ts";

test("calculateAbsenceGap: compliant notice >= 2 hours (120 minutes) yields green status", () => {
  // Shift starts at 08:00 (480 mins from midnight)
  // Submitted at 04:50 (290 mins from midnight) -> gap = 190 mins (3h 10m)
  const shiftStart = new Date("2026-09-12T08:00:00+08:00");
  const submittedAt = new Date("2026-09-12T04:50:00+08:00");

  const result = calculateAbsenceGap(shiftStart, submittedAt);
  assert.equal(result.gapMinutes, 190);
  assert.equal(result.isCompliant, true);
  assert.equal(result.status, "green");
});

test("calculateAbsenceGap: exactly 120 minutes before shift yields green status", () => {
  const shiftStart = new Date("2026-09-12T08:00:00+08:00");
  const submittedAt = new Date("2026-09-12T06:00:00+08:00");

  const result = calculateAbsenceGap(shiftStart, submittedAt);
  assert.equal(result.gapMinutes, 120);
  assert.equal(result.isCompliant, true);
  assert.equal(result.status, "green");
});

test("calculateAbsenceGap: < 120 minutes before shift yields red status (late notice)", () => {
  // Submitted 45 minutes before shift
  const shiftStart = new Date("2026-09-12T08:00:00+08:00");
  const submittedAt = new Date("2026-09-12T07:15:00+08:00");

  const result = calculateAbsenceGap(shiftStart, submittedAt);
  assert.equal(result.gapMinutes, 45);
  assert.equal(result.isCompliant, false);
  assert.equal(result.status, "red");
});

test("calculateAbsenceGap: 119 minutes before shift yields red status", () => {
  const shiftStart = new Date("2026-09-12T08:00:00+08:00");
  const submittedAt = new Date("2026-09-12T06:01:00+08:00");

  const result = calculateAbsenceGap(shiftStart, submittedAt);
  assert.equal(result.gapMinutes, 119);
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
  // Spec examples:
  // "Requested 3h 10m before shift" (green)
  assert.equal(formatAbsenceGap(190), "Requested 3h 10m before shift");

  // "Requested 45m before shift" (red)
  assert.equal(formatAbsenceGap(45), "Requested 45m before shift");

  // "Requested 1h 20m after shift start" (red)
  assert.equal(formatAbsenceGap(-80), "Requested 1h 20m after shift start");

  // Exact hours
  assert.equal(formatAbsenceGap(120), "Requested 2h before shift");
  assert.equal(formatAbsenceGap(60), "Requested 1h before shift");

  // Single minute
  assert.equal(formatAbsenceGap(1), "Requested 1m before shift");
  assert.equal(formatAbsenceGap(-1), "Requested 1m after shift start");

  // Exact 0
  assert.equal(formatAbsenceGap(0), "Requested at exact shift start");
});

test("COMPLIANT_NOTICE_MINUTES constant equals 120 (2 hours)", () => {
  assert.equal(COMPLIANT_NOTICE_MINUTES, 120);
});
