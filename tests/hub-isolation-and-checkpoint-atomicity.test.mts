import test from "node:test";
import assert from "node:assert/strict";
import type { HubDestination, TransactionRoute, TransactionStatus } from "../lib/icms/database.types.ts";

/**
 * Pure model of the Hub Destination Station Isolation logic
 * implemented in completePartHub(), scanTransaction(), and enforce_part_hub_sequence().
 */
function canHubOfficerProcessTransaction(
  officer: { role: string; ops_group: string | null; station: string | null },
  transaction: { route: TransactionRoute; status: TransactionStatus; hub_destination: HubDestination | null }
): { allowed: boolean; reason?: string } {
  if (transaction.route !== "HUB") {
    return { allowed: false, reason: "NOT_HUB_ROUTE" };
  }
  if (transaction.status !== "INFLIGHT_POST_APPROVED") {
    return { allowed: false, reason: "OUT_OF_ORDER" };
  }
  if (!transaction.hub_destination) {
    return { allowed: false, reason: "MISSING_DESTINATION" };
  }
  if (officer.role !== "hub_avsec" && officer.ops_group !== "hub_avsec") {
    return { allowed: false, reason: "UNAUTHORIZED_ROLE" };
  }

  // Station isolation: If officer is stationed at a regional hub (PEN/JHB/NILAI),
  // they CANNOT process deliveries for a different hub destination.
  const hubStations: HubDestination[] = ["PEN", "JHB", "NILAI"];
  if (officer.station && hubStations.includes(officer.station as HubDestination)) {
    if (officer.station !== transaction.hub_destination) {
      return { allowed: false, reason: "HUB_STATION_MISMATCH" };
    }
  }

  return { allowed: true };
}

/**
 * Pure model of the enforce_part_sequence() atomic status transition logic.
 */
function evaluateCheckpointStatusTransition(
  currentStatus: TransactionStatus,
  direction: "OUTBOUND" | "INBOUND",
  part: "part_b" | "part_c" | "part_d",
  route: TransactionRoute,
  result: "PASS" | "ESCALATE"
): { nextStatus: TransactionStatus; success: boolean; error?: string } {
  if (currentStatus === "ESCALATED") {
    return { nextStatus: currentStatus, success: false, error: "TRANSACTION_ESCALATED" };
  }

  // Atomic escalation: If officer reports ESCALATE, the status must transition
  // directly and atomically to ESCALATED.
  if (result === "ESCALATE") {
    return { nextStatus: "ESCALATED", success: true };
  }

  if (part === "part_b") {
    if (direction === "OUTBOUND") {
      if (currentStatus !== "CREATED") {
        return { nextStatus: currentStatus, success: false, error: "OUT_OF_ORDER" };
      }
      return { nextStatus: "INFLIGHT_POST_APPROVED", success: true };
    } else {
      if (currentStatus !== "AIRPORT_POST_APPROVED") {
        return { nextStatus: currentStatus, success: false, error: "OUT_OF_ORDER" };
      }
      return { nextStatus: "COMPLETED", success: true };
    }
  }

  if (part === "part_c") {
    if (route === "HUB") {
      return { nextStatus: currentStatus, success: false, error: "PART_C_NOT_APPLICABLE_TO_HUB" };
    }
    if (direction === "OUTBOUND") {
      if (route === "REDQ") {
        if (currentStatus !== "REDQ_RESEALED") return { nextStatus: currentStatus, success: false, error: "OUT_OF_ORDER" };
      } else {
        if (currentStatus !== "INFLIGHT_POST_APPROVED") return { nextStatus: currentStatus, success: false, error: "OUT_OF_ORDER" };
      }
    } else {
      if (currentStatus !== "CREATED") return { nextStatus: currentStatus, success: false, error: "OUT_OF_ORDER" };
    }

    if (route === "MAINTENANCE") {
      return { nextStatus: "COMPLETED", success: true };
    }
    return { nextStatus: "AIRPORT_POST_APPROVED", success: true };
  }

  if (part === "part_d") {
    if (route === "HUB" || route === "MAINTENANCE" || direction === "INBOUND") {
      return { nextStatus: currentStatus, success: false, error: "PART_D_NOT_APPLICABLE" };
    }
    if (currentStatus !== "AIRPORT_POST_APPROVED") {
      return { nextStatus: currentStatus, success: false, error: "OUT_OF_ORDER" };
    }
    return { nextStatus: "COMPLETED", success: true };
  }

  return { nextStatus: currentStatus, success: false, error: "UNKNOWN_PART" };
}

// -------------------------------------------------------------------------
// Hub Station Isolation Tests (PEN, JHB, NILAI)
// -------------------------------------------------------------------------

test("Hub Isolation: PEN account -> PEN operation ALLOWED", () => {
  const penOfficer = { role: "hub_avsec", ops_group: "hub_avsec", station: "PEN" };
  const penTx = { route: "HUB" as const, status: "INFLIGHT_POST_APPROVED" as const, hub_destination: "PEN" as const };
  const res = canHubOfficerProcessTransaction(penOfficer, penTx);
  assert.equal(res.allowed, true);
});

test("Hub Isolation: PEN account -> JHB operation DENIED", () => {
  const penOfficer = { role: "hub_avsec", ops_group: "hub_avsec", station: "PEN" };
  const jhbTx = { route: "HUB" as const, status: "INFLIGHT_POST_APPROVED" as const, hub_destination: "JHB" as const };
  const res = canHubOfficerProcessTransaction(penOfficer, jhbTx);
  assert.equal(res.allowed, false);
  assert.equal(res.reason, "HUB_STATION_MISMATCH");
});

test("Hub Isolation: PEN account -> NILAI operation DENIED", () => {
  const penOfficer = { role: "hub_avsec", ops_group: "hub_avsec", station: "PEN" };
  const nilaiTx = { route: "HUB" as const, status: "INFLIGHT_POST_APPROVED" as const, hub_destination: "NILAI" as const };
  const res = canHubOfficerProcessTransaction(penOfficer, nilaiTx);
  assert.equal(res.allowed, false);
  assert.equal(res.reason, "HUB_STATION_MISMATCH");
});

test("Hub Isolation: JHB account -> JHB operation ALLOWED", () => {
  const jhbOfficer = { role: "hub_avsec", ops_group: "hub_avsec", station: "JHB" };
  const jhbTx = { route: "HUB" as const, status: "INFLIGHT_POST_APPROVED" as const, hub_destination: "JHB" as const };
  const res = canHubOfficerProcessTransaction(jhbOfficer, jhbTx);
  assert.equal(res.allowed, true);
});

test("Hub Isolation: JHB account -> PEN operation DENIED", () => {
  const jhbOfficer = { role: "hub_avsec", ops_group: "hub_avsec", station: "JHB" };
  const penTx = { route: "HUB" as const, status: "INFLIGHT_POST_APPROVED" as const, hub_destination: "PEN" as const };
  const res = canHubOfficerProcessTransaction(jhbOfficer, penTx);
  assert.equal(res.allowed, false);
  assert.equal(res.reason, "HUB_STATION_MISMATCH");
});

test("Hub Isolation: JHB account -> NILAI operation DENIED", () => {
  const jhbOfficer = { role: "hub_avsec", ops_group: "hub_avsec", station: "JHB" };
  const nilaiTx = { route: "HUB" as const, status: "INFLIGHT_POST_APPROVED" as const, hub_destination: "NILAI" as const };
  const res = canHubOfficerProcessTransaction(jhbOfficer, nilaiTx);
  assert.equal(res.allowed, false);
  assert.equal(res.reason, "HUB_STATION_MISMATCH");
});

test("Hub Isolation: NILAI account -> NILAI operation ALLOWED", () => {
  const nilaiOfficer = { role: "hub_avsec", ops_group: "hub_avsec", station: "NILAI" };
  const nilaiTx = { route: "HUB" as const, status: "INFLIGHT_POST_APPROVED" as const, hub_destination: "NILAI" as const };
  const res = canHubOfficerProcessTransaction(nilaiOfficer, nilaiTx);
  assert.equal(res.allowed, true);
});

test("Hub Isolation: NILAI account -> PEN operation DENIED", () => {
  const nilaiOfficer = { role: "hub_avsec", ops_group: "hub_avsec", station: "NILAI" };
  const penTx = { route: "HUB" as const, status: "INFLIGHT_POST_APPROVED" as const, hub_destination: "PEN" as const };
  const res = canHubOfficerProcessTransaction(nilaiOfficer, penTx);
  assert.equal(res.allowed, false);
  assert.equal(res.reason, "HUB_STATION_MISMATCH");
});

test("Hub Isolation: NILAI account -> JHB operation DENIED", () => {
  const nilaiOfficer = { role: "hub_avsec", ops_group: "hub_avsec", station: "NILAI" };
  const jhbTx = { route: "HUB" as const, status: "INFLIGHT_POST_APPROVED" as const, hub_destination: "JHB" as const };
  const res = canHubOfficerProcessTransaction(nilaiOfficer, jhbTx);
  assert.equal(res.allowed, false);
  assert.equal(res.reason, "HUB_STATION_MISMATCH");
});

// -------------------------------------------------------------------------
// Checkpoint Atomicity & Escalation Tests
// -------------------------------------------------------------------------

test("Checkpoint Atomicity: Part B PASS advances CREATED to INFLIGHT_POST_APPROVED", () => {
  const res = evaluateCheckpointStatusTransition("CREATED", "OUTBOUND", "part_b", "AIRCRAFT", "PASS");
  assert.equal(res.success, true);
  assert.equal(res.nextStatus, "INFLIGHT_POST_APPROVED");
});

test("Checkpoint Atomicity: Part B ESCALATE directly transitions CREATED to ESCALATED", () => {
  const res = evaluateCheckpointStatusTransition("CREATED", "OUTBOUND", "part_b", "AIRCRAFT", "ESCALATE");
  assert.equal(res.success, true);
  assert.equal(res.nextStatus, "ESCALATED");
});

test("Checkpoint Atomicity: Part C ESCALATE directly transitions INFLIGHT_POST_APPROVED to ESCALATED", () => {
  const res = evaluateCheckpointStatusTransition("INFLIGHT_POST_APPROVED", "OUTBOUND", "part_c", "AIRCRAFT", "ESCALATE");
  assert.equal(res.success, true);
  assert.equal(res.nextStatus, "ESCALATED");
});

test("Checkpoint Atomicity: Part D ESCALATE directly transitions AIRPORT_POST_APPROVED to ESCALATED (not COMPLETED)", () => {
  const res = evaluateCheckpointStatusTransition("AIRPORT_POST_APPROVED", "OUTBOUND", "part_d", "AIRCRAFT", "ESCALATE");
  assert.equal(res.success, true);
  assert.equal(res.nextStatus, "ESCALATED");
});

test("Checkpoint Atomicity: Out of order checkpoint submission is rejected without status change", () => {
  const res = evaluateCheckpointStatusTransition("CREATED", "OUTBOUND", "part_c", "AIRCRAFT", "PASS");
  assert.equal(res.success, false);
  assert.equal(res.error, "OUT_OF_ORDER");
  assert.equal(res.nextStatus, "CREATED");
});

test("Checkpoint Atomicity: Escalated transaction freezes all further checkpoint transitions", () => {
  const res = evaluateCheckpointStatusTransition("ESCALATED", "OUTBOUND", "part_b", "AIRCRAFT", "PASS");
  assert.equal(res.success, false);
  assert.equal(res.error, "TRANSACTION_ESCALATED");
});
