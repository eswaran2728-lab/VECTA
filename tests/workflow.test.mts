import test from "node:test";
import assert from "node:assert/strict";
import {
  checkpointOrderError,
  getStep,
  nextStepFor,
  partsDoneFromStatus,
  resolveEscalatedStatus,
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

test("resolveEscalatedStatus: outbound AIRCRAFT route resumes correctly at each stage", () => {
  // Escalated right after Part A
  assert.equal(resolveEscalatedStatus("OUTBOUND", "AIRCRAFT", {}), "CREATED");

  // Part B was recorded as ESCALATE -> returns CREATED
  assert.equal(
    resolveEscalatedStatus("OUTBOUND", "AIRCRAFT", {
      part_b: { result: "ESCALATE" },
    }),
    "CREATED"
  );

  // Part B passed -> returns INFLIGHT_POST_APPROVED
  assert.equal(
    resolveEscalatedStatus("OUTBOUND", "AIRCRAFT", {
      part_b: { result: "PASS" },
    }),
    "INFLIGHT_POST_APPROVED"
  );

  // Part B passed, Part C passed -> returns AIRPORT_POST_APPROVED
  assert.equal(
    resolveEscalatedStatus("OUTBOUND", "AIRCRAFT", {
      part_b: { result: "PASS" },
      part_c: { result: "PASS" },
    }),
    "AIRPORT_POST_APPROVED"
  );

  // Part B passed, Part C passed, Part D passed -> returns COMPLETED
  assert.equal(
    resolveEscalatedStatus("OUTBOUND", "AIRCRAFT", {
      part_b: { result: "PASS" },
      part_c: { result: "PASS" },
      part_d: { result: "PASS" },
    }),
    "COMPLETED"
  );

  // Part B passed, Part C passed, Part D skipped -> returns COMPLETED
  assert.equal(
    resolveEscalatedStatus("OUTBOUND", "AIRCRAFT", {
      part_b: { result: "PASS" },
      part_c: { result: "PASS" },
      part_d_skipped: true,
    }),
    "COMPLETED"
  );
});

test("resolveEscalatedStatus: outbound HUB and MAINTENANCE routes resume correctly", () => {
  // HUB: A -> B -> Hub (final)
  assert.equal(resolveEscalatedStatus("OUTBOUND", "HUB", {}), "CREATED");
  assert.equal(
    resolveEscalatedStatus("OUTBOUND", "HUB", { part_b: { result: "PASS" } }),
    "INFLIGHT_POST_APPROVED"
  );
  assert.equal(
    resolveEscalatedStatus("OUTBOUND", "HUB", {
      part_b: { result: "PASS" },
      part_hub: { result: "PASS" },
    }),
    "COMPLETED"
  );

  // MAINTENANCE: A -> B -> C (final)
  assert.equal(resolveEscalatedStatus("OUTBOUND", "MAINTENANCE", {}), "CREATED");
  assert.equal(
    resolveEscalatedStatus("OUTBOUND", "MAINTENANCE", { part_b: { result: "PASS" } }),
    "INFLIGHT_POST_APPROVED"
  );
  assert.equal(
    resolveEscalatedStatus("OUTBOUND", "MAINTENANCE", {
      part_b: { result: "PASS" },
      part_c: { result: "PASS" },
    }),
    "COMPLETED"
  );
});

test("resolveEscalatedStatus: outbound REDQ route resumes correctly", () => {
  // REDQ: A -> B -> REDQ -> C -> D
  assert.equal(resolveEscalatedStatus("OUTBOUND", "REDQ", {}), "CREATED");
  assert.equal(
    resolveEscalatedStatus("OUTBOUND", "REDQ", { part_b: { result: "PASS" } }),
    "INFLIGHT_POST_APPROVED"
  );
  assert.equal(
    resolveEscalatedStatus("OUTBOUND", "REDQ", {
      part_b: { result: "PASS" },
      part_redq: { result: "PASS" },
    }),
    "REDQ_RESEALED"
  );
  assert.equal(
    resolveEscalatedStatus("OUTBOUND", "REDQ", {
      part_b: { result: "PASS" },
      part_redq: { result: "PASS" },
      part_c: { result: "PASS" },
    }),
    "AIRPORT_POST_APPROVED"
  );
  assert.equal(
    resolveEscalatedStatus("OUTBOUND", "REDQ", {
      part_b: { result: "PASS" },
      part_redq: { result: "PASS" },
      part_c: { result: "PASS" },
      part_d: { result: "PASS" },
    }),
    "COMPLETED"
  );
});

test("resolveEscalatedStatus: inbound route resumes correctly", () => {
  // INBOUND: A -> C (Airport Post) -> B (In-flight Post, final)
  assert.equal(resolveEscalatedStatus("INBOUND", "AIRCRAFT", {}), "CREATED");
  assert.equal(
    resolveEscalatedStatus("INBOUND", "AIRCRAFT", { part_c: { result: "PASS" } }),
    "AIRPORT_POST_APPROVED"
  );
  assert.equal(
    resolveEscalatedStatus("INBOUND", "AIRCRAFT", {
      part_c: { result: "PASS" },
      part_b: { result: "PASS" },
    }),
    "COMPLETED"
  );
});

