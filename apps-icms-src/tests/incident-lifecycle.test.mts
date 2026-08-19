import test from "node:test";
import assert from "node:assert/strict";
import { lifecycleFor } from "../src/lib/constants.ts";

test("lifecycleFor: SEGMENT_TIMEOUT gets the lighter OPEN -> RESOLVED path", () => {
  assert.deepEqual(lifecycleFor("SEGMENT_TIMEOUT"), ["OPEN", "RESOLVED"]);
});

test("lifecycleFor: every other incident type keeps the full 4-stage lifecycle", () => {
  const full = ["OPEN", "UNDER_REVIEW", "RESOLVED", "CLOSED"];
  for (const type of [
    "BROKEN_SEAL",
    "SEAL_MISMATCH",
    "UNAUTHORIZED_DRIVER",
    "UNAUTHORIZED_VEHICLE",
    "EXPIRED_PASS",
    "WRONG_SEAL_COLOR",
    "TIMEOUT",
    "OTHER",
    "WHITELIST_VIOLATION",
  ] as const) {
    assert.deepEqual(lifecycleFor(type), full, `${type} should use the full lifecycle`);
  }
});
