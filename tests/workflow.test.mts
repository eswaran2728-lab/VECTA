import test from "node:test";
import assert from "node:assert/strict";
import {
  checkpointOrderError,
  getStep,
  nextStepFor,
  partsDoneFromStatus,
} from "../lib/icms/workflow.ts";

test("nextStepFor: outbound sequence is A -> B(post2) -> C(post6) -> D(receiver)", () => {
  assert.equal(nextStepFor("OUTBOUND", "CREATED")?.role, "post2_avsec");
  assert.equal(nextStepFor("OUTBOUND", "INFLIGHT_POST_APPROVED")?.role, "post6_avsec");
  assert.equal(nextStepFor("OUTBOUND", "AIRPORT_POST_APPROVED")?.role, "receiver");
  assert.equal(nextStepFor("OUTBOUND", "COMPLETED"), null);
  assert.equal(nextStepFor("OUTBOUND", "ESCALATED"), null);
});

test("nextStepFor: inbound sequence is A -> C(post6) -> B(post2, final) -- no Part D", () => {
  assert.equal(nextStepFor("INBOUND", "CREATED")?.role, "post6_avsec");
  assert.equal(nextStepFor("INBOUND", "AIRPORT_POST_APPROVED")?.role, "post2_avsec");
  assert.equal(nextStepFor("INBOUND", "AIRPORT_POST_APPROVED")?.finalizes, true);
  assert.equal(nextStepFor("INBOUND", "COMPLETED"), null);
});

test("getStep: part_d does not exist for inbound", () => {
  assert.equal(getStep("INBOUND", "part_d"), null);
  assert.notEqual(getStep("OUTBOUND", "part_d"), null);
});

test("checkpointOrderError: null when status matches the required step", () => {
  assert.equal(checkpointOrderError("OUTBOUND", "part_b", "CREATED"), null);
  assert.equal(checkpointOrderError("INBOUND", "part_c", "CREATED"), null);
});

test("checkpointOrderError: bilingual error when out of order", () => {
  const err = checkpointOrderError("OUTBOUND", "part_c", "CREATED");
  assert.ok(err && err.includes("Out of order"));
  assert.ok(err && err.includes("/"), "message includes a Bahasa Melayu half after '/'");
});

test("checkpointOrderError: escalated transactions block every part", () => {
  const err = checkpointOrderError("OUTBOUND", "part_b", "ESCALATED");
  assert.ok(err && /escalated/i.test(err));
});

test("checkpointOrderError: part_d does not apply to inbound", () => {
  const err = checkpointOrderError("INBOUND", "part_d", "AIRPORT_POST_APPROVED");
  assert.ok(err && /does not apply to inbound/.test(err));
});

test("partsDoneFromStatus: outbound marks earlier parts done, later parts pending", () => {
  const done = partsDoneFromStatus("OUTBOUND", "AIRPORT_POST_APPROVED");
  assert.deepEqual(done, { part_b: true, part_c: true, part_d: false, part_hub: false, part_redq: false });
});

test("partsDoneFromStatus: inbound marks part_c done once airport post approved, part_b (final) not yet", () => {
  const done = partsDoneFromStatus("INBOUND", "AIRPORT_POST_APPROVED");
  assert.deepEqual(done, { part_b: false, part_c: true, part_d: false, part_hub: false, part_redq: false });
});

test("partsDoneFromStatus: escalated yields all-false regardless of direction", () => {
  assert.deepEqual(partsDoneFromStatus("OUTBOUND", "ESCALATED"), {
    part_b: false,
    part_c: false,
    part_d: false,
    part_hub: false,
    part_redq: false,
  });
});
