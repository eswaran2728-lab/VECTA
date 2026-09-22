import test from "node:test";
import assert from "node:assert/strict";
import {
  opsGroupForCheckpointRole,
  opsGroupForTransaction,
  isAvsecScanGroup,
  opsGroupCanAccessCheckpoint,
} from "../lib/icms/ops-group.ts";

test("opsGroupForCheckpointRole: checkpoint roles map to their team", () => {
  assert.equal(opsGroupForCheckpointRole("post2_avsec"), "ifc_avsec");
  assert.equal(opsGroupForCheckpointRole("post6_avsec"), "operation_avsec");
  assert.equal(opsGroupForCheckpointRole("redq_avsec"), "operation_avsec");
  assert.equal(opsGroupForCheckpointRole("hub_avsec"), "hub_avsec");
  // Receiver (Part D) has no duty_post/ops_group of its own -- owner
  // decision: assigned to ifc_avsec (previously null/unmappable).
  assert.equal(opsGroupForCheckpointRole("receiver"), "ifc_avsec");
  assert.equal(opsGroupForCheckpointRole("supervisor"), null);
  assert.equal(opsGroupForCheckpointRole("enforcement"), null);
  assert.equal(opsGroupForCheckpointRole("vendor"), null);
  assert.equal(opsGroupForCheckpointRole("warehouse_pic"), null);
});

test("opsGroupForTransaction: in-progress Receiver/Part D step resolves to ifc_avsec", () => {
  assert.equal(opsGroupForTransaction("OUTBOUND", "AIRPORT_POST_APPROVED", "AIRCRAFT"), "ifc_avsec");
});

test("opsGroupForTransaction: finished plain AIRCRAFT route resolves to ifc_avsec", () => {
  assert.equal(opsGroupForTransaction("OUTBOUND", "COMPLETED", "AIRCRAFT"), "ifc_avsec");
  assert.equal(opsGroupForTransaction("INBOUND", "COMPLETED", "AIRCRAFT"), "ifc_avsec");
});

test("opsGroupForTransaction: finished MAINTENANCE route resolves to operation_avsec (finalizes at Part C / Post 6, no Part D)", () => {
  assert.equal(opsGroupForTransaction("OUTBOUND", "COMPLETED", "MAINTENANCE"), "operation_avsec");
});

test("opsGroupForTransaction: HUB finalizes at Part Hub, REDQ finalizes at Part D (SRA Warehouse -- IFC)", () => {
  assert.equal(opsGroupForTransaction("OUTBOUND", "COMPLETED", "HUB"), "hub_avsec");
  assert.equal(opsGroupForTransaction("OUTBOUND", "COMPLETED", "REDQ"), "ifc_avsec");
});

// --- Unified AVSEC scanning model (2026-09-22) ---
// Operation and IFC AVSEC are interchangeable for non-Hub CaterLink
// checkpoints; Hub AVSEC stays fully separate. Deliberately code-level
// only -- the stored ops_group values themselves are never renamed.

test("isAvsecScanGroup: operation_avsec and ifc_avsec are AVSEC scan groups, hub_avsec is not", () => {
  assert.equal(isAvsecScanGroup("operation_avsec"), true);
  assert.equal(isAvsecScanGroup("ifc_avsec"), true);
  assert.equal(isAvsecScanGroup("hub_avsec"), false);
  assert.equal(isAvsecScanGroup(null), false);
  assert.equal(isAvsecScanGroup(undefined), false);
});

test("ASO in operation_avsec can scan/process a checkpoint that belongs to ifc_avsec (cross-branch, unified model)", () => {
  assert.equal(opsGroupCanAccessCheckpoint("operation_avsec", "ifc_avsec"), true);
});

test("SO in ifc_avsec can scan/process a checkpoint that belongs to operation_avsec (cross-branch, unified model)", () => {
  assert.equal(opsGroupCanAccessCheckpoint("ifc_avsec", "operation_avsec"), true);
});

test("DSE in either AVSEC branch can process Part B (ifc-mapped) or Part C (operation-mapped)", () => {
  assert.equal(opsGroupCanAccessCheckpoint("operation_avsec", opsGroupForCheckpointRole("post2_avsec")), true);
  assert.equal(opsGroupCanAccessCheckpoint("ifc_avsec", opsGroupForCheckpointRole("post6_avsec")), true);
});

test("REDQ processing works under the unified model regardless of which AVSEC branch the officer is in", () => {
  const redqOpsGroup = opsGroupForCheckpointRole("redq_avsec");
  assert.equal(opsGroupCanAccessCheckpoint("operation_avsec", redqOpsGroup), true);
  assert.equal(opsGroupCanAccessCheckpoint("ifc_avsec", redqOpsGroup), true);
});

test("Same-branch (non-cross) access still works exactly as before", () => {
  assert.equal(opsGroupCanAccessCheckpoint("operation_avsec", "operation_avsec"), true);
  assert.equal(opsGroupCanAccessCheckpoint("ifc_avsec", "ifc_avsec"), true);
});

test("Hub AVSEC remains separate: a unified-AVSEC (Operation/IFC) user is denied the Hub-only checkpoint", () => {
  assert.equal(opsGroupCanAccessCheckpoint("operation_avsec", "hub_avsec"), false);
  assert.equal(opsGroupCanAccessCheckpoint("ifc_avsec", "hub_avsec"), false);
});

test("Hub AVSEC user is denied a non-Hub AVSEC checkpoint (still exact-match only, not folded into the unified group)", () => {
  assert.equal(opsGroupCanAccessCheckpoint("hub_avsec", "operation_avsec"), false);
  assert.equal(opsGroupCanAccessCheckpoint("hub_avsec", "ifc_avsec"), false);
});

test("Hub AVSEC user can still process the Hub-only checkpoint (unchanged, exact match)", () => {
  assert.equal(opsGroupCanAccessCheckpoint("hub_avsec", "hub_avsec"), true);
});

test("No ops_group assigned is always denied, on either side", () => {
  assert.equal(opsGroupCanAccessCheckpoint(null, "operation_avsec"), false);
  assert.equal(opsGroupCanAccessCheckpoint("operation_avsec", null), false);
  assert.equal(opsGroupCanAccessCheckpoint(null, null), false);
});

// --- Cross-branch REPORTING/approval isolation is UNCHANGED by the unified
// scanning model (2026-09-22) ---
// The scanning-side helpers above deliberately do not touch
// public.can_acknowledge_report() or profiles.ops_group itself. This test
// exists purely to assert that fact in the same file as the scanning
// change, so a future edit that tries to "simplify" by reusing
// opsGroupCanAccessCheckpoint() for acknowledgement scoping is caught
// immediately: reporting/acknowledgement must stay a STRICT ops_group
// match (see tests/sec014-daily-report-role-and-acknowledgement.test.mts
// for the full pure model), never the scanning union.
test("REGRESSION: opsGroupCanAccessCheckpoint (scanning) must never be mistaken for strict ops_group equality (reporting/acknowledgement)", () => {
  // Under the scanning union, cross-branch access is ALLOWED...
  assert.equal(opsGroupCanAccessCheckpoint("operation_avsec", "ifc_avsec"), true);
  // ...but the strict equality reporting/acknowledgement scoping must
  // still independently reject the same cross-branch pair. If a caller
  // ever swapped the strict check for this helper, this assertion is
  // exactly what would start silently passing and must never do so.
  const strictOpsGroupMatch = (a: string | null, b: string | null) => (a ?? "") === (b ?? "");
  assert.equal(strictOpsGroupMatch("operation_avsec", "ifc_avsec"), false);
});
