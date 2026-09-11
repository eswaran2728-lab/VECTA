import test from "node:test";
import assert from "node:assert/strict";

interface OtRequest {
  id: string;
  requester_id: string;
  requester_role: "ASO" | "SO" | "DSE";
  branch: "operation_avsec" | "ifc_avsec" | "hub_avsec";
  hours: number;
  reason: string;
  status: "pending" | "approved" | "rejected";
}

interface UserProfile {
  id: string;
  role: "ASO" | "SO" | "DSE" | "MANAGEMENT" | "ENFORCEMENT";
  ops_group: "operation_avsec" | "ifc_avsec" | "hub_avsec" | null;
}

function canSubmitOt(profile: UserProfile, hours: number, reason: string): { allowed: boolean; error?: string } {
  if (profile.role !== "ASO") {
    return { allowed: false, error: "Only ASO staff can submit OT requests." };
  }
  if (!profile.ops_group) {
    return { allowed: false, error: "Profile has no assigned branch." };
  }
  if (hours <= 0 || hours > 24) {
    return { allowed: false, error: "Invalid hours." };
  }
  if (!reason || reason.trim().length < 5) {
    return { allowed: false, error: "Reason required." };
  }
  return { allowed: true };
}

function canReviewOt(approver: UserProfile, req: OtRequest): { allowed: boolean; error?: string } {
  if (approver.role === "SO") {
    return { allowed: false, error: "SO cannot approve OT requests (bypassed to DSE)." };
  }
  if (approver.role === "DSE") {
    if (approver.ops_group !== req.branch) {
      return { allowed: false, error: "DSE can only approve OT for their matching branch." };
    }
    return { allowed: true };
  }
  if (approver.role === "MANAGEMENT") {
    return { allowed: true };
  }
  return { allowed: false, error: "Unauthorized." };
}

test("OT Submission: ASO with branch can submit valid OT", () => {
  const asoOp: UserProfile = { id: "aso-1", role: "ASO", ops_group: "operation_avsec" };
  assert.equal(canSubmitOt(asoOp, 2.5, "Flight delay coverage").allowed, true);

  const asoIfc: UserProfile = { id: "aso-2", role: "ASO", ops_group: "ifc_avsec" };
  assert.equal(canSubmitOt(asoIfc, 3, "Warehouse extra sorting").allowed, true);
});

test("OT Submission: Non-ASO cannot submit OT", () => {
  const so: UserProfile = { id: "so-1", role: "SO", ops_group: "operation_avsec" };
  assert.equal(canSubmitOt(so, 2, "Patrol").allowed, false);

  const dse: UserProfile = { id: "dse-1", role: "DSE", ops_group: "operation_avsec" };
  assert.equal(canSubmitOt(dse, 2, "Patrol").allowed, false);
});

test("OT Approval: DSE of matching branch can approve", () => {
  const dseOp: UserProfile = { id: "dse-op", role: "DSE", ops_group: "operation_avsec" };
  const dseIfc: UserProfile = { id: "dse-ifc", role: "DSE", ops_group: "ifc_avsec" };

  const reqOp: OtRequest = {
    id: "req-1",
    requester_id: "aso-1",
    requester_role: "ASO",
    branch: "operation_avsec",
    hours: 2,
    reason: "Delayed arrival",
    status: "pending",
  };

  const reqIfc: OtRequest = {
    id: "req-2",
    requester_id: "aso-2",
    requester_role: "ASO",
    branch: "ifc_avsec",
    hours: 2,
    reason: "Late catering truck",
    status: "pending",
  };

  // Matching branch: approved
  assert.equal(canReviewOt(dseOp, reqOp).allowed, true);
  assert.equal(canReviewOt(dseIfc, reqIfc).allowed, true);

  // Cross branch: rejected
  assert.equal(canReviewOt(dseOp, reqIfc).allowed, false);
  assert.equal(canReviewOt(dseIfc, reqOp).allowed, false);
});

test("OT Approval: SO is bypassed and cannot review OT", () => {
  const soOp: UserProfile = { id: "so-op", role: "SO", ops_group: "operation_avsec" };
  const reqOp: OtRequest = {
    id: "req-1",
    requester_id: "aso-1",
    requester_role: "ASO",
    branch: "operation_avsec",
    hours: 2,
    reason: "Delayed arrival",
    status: "pending",
  };
  assert.equal(canReviewOt(soOp, reqOp).allowed, false);
});
