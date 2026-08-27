import test from "node:test";
import assert from "node:assert/strict";
import { opsGroupForCheckpointRole, opsGroupForTransaction } from "../lib/icms/ops-group.ts";

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
