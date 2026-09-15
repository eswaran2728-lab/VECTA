import test from "node:test";
import assert from "node:assert/strict";
import {
  isCheckinGateExempt,
  isAdminPathForbidden,
  isSuperAdminPathForbidden,
  isOperationalPathForbiddenForSuperAdmin,
} from "../lib/supabase/middleware-gate-logic.ts";
import { opsGroupForCheckpointRole } from "../lib/icms/ops-group.ts";
import { checkpointOrderError } from "../lib/icms/workflow.ts";

test("Workflow Gate Logic: Check-in gate exemptions adhere to role hierarchy", () => {
  // Seniority / platform exempt roles (lowercase unified_role)
  assert.equal(isCheckinGateExempt("admin"), true);
  assert.equal(isCheckinGateExempt("management"), true);
  assert.equal(isCheckinGateExempt("enforcement"), true);
  assert.equal(isCheckinGateExempt("super_admin"), true);
  assert.equal(isCheckinGateExempt("vendor"), true);

  // Operational shift roles subject to mandatory checkin gate
  assert.equal(isCheckinGateExempt("aso"), false);
  assert.equal(isCheckinGateExempt("so"), false);
  assert.equal(isCheckinGateExempt("dse"), false);
  assert.equal(isCheckinGateExempt(null), false);
});

test("Workflow Gate Logic: Admin path access is restricted strictly to ADMIN and MANAGEMENT", () => {
  // Allowed for admin & management
  assert.equal(isAdminPathForbidden("/avsec/admin/users", "admin"), false);
  assert.equal(isAdminPathForbidden("/avsec/admin/users", "management"), false);

  // Forbidden for others
  assert.equal(isAdminPathForbidden("/avsec/admin/users", "enforcement"), true);
  assert.equal(isAdminPathForbidden("/avsec/admin/users", "dse"), true);
  assert.equal(isAdminPathForbidden("/avsec/admin/users", "so"), true);
  assert.equal(isAdminPathForbidden("/avsec/admin/users", "aso"), true);
  assert.equal(isAdminPathForbidden("/avsec/admin/users", "vendor"), true);
  assert.equal(isAdminPathForbidden("/avsec/admin/users", null), true);
});

test("Workflow Gate Logic: Super Admin portal access is strictly gated", () => {
  assert.equal(isSuperAdminPathForbidden("/super-admin", "super_admin"), false);
  assert.equal(isSuperAdminPathForbidden("/super-admin", "admin"), true);
  assert.equal(isSuperAdminPathForbidden("/super-admin", "management"), true);
  assert.equal(isSuperAdminPathForbidden("/super-admin", "dse"), true);
  assert.equal(isSuperAdminPathForbidden("/super-admin", "vendor"), true);
});

test("Workflow Gate Logic: Super Admin is barred from daily operational routes to prevent accidental mutation", () => {
  assert.equal(isOperationalPathForbiddenForSuperAdmin("/avsec/duty", "super_admin"), true);
  assert.equal(isOperationalPathForbiddenForSuperAdmin("/avsec/reports/sec014", "super_admin"), true);
  assert.equal(isOperationalPathForbiddenForSuperAdmin("/icms/transactions/new", "super_admin"), true);

  // Non-super-admin can access operational routes
  assert.equal(isOperationalPathForbiddenForSuperAdmin("/avsec/duty", "aso"), false);
  assert.equal(isOperationalPathForbiddenForSuperAdmin("/avsec/duty", "dse"), false);
});

test("ICMS Workflow State Machine: Checkpoint progression error detection", () => {
  // Signature: checkpointOrderError(direction, part, status, route)

  // Escalated transaction blocks all normal checkpoint submissions
  assert.notEqual(
    checkpointOrderError("OUTBOUND", "part_b", "ESCALATED", "AIRCRAFT"),
    null,
    "Escalated transactions must block checkpoints"
  );

  // Out-of-order checkpoint rejected (e.g. attempting Part C when still at CREATED)
  assert.notEqual(
    checkpointOrderError("OUTBOUND", "part_c", "CREATED", "AIRCRAFT"),
    null,
    "Submitting Part C when CREATED must return an out-of-order error"
  );

  // In-order checkpoint accepted (Part B requires CREATED for outbound)
  assert.equal(
    checkpointOrderError("OUTBOUND", "part_b", "CREATED", "AIRCRAFT"),
    null,
    "Submitting Part B when status is CREATED must be allowed"
  );

  // In-order checkpoint accepted (Part C requires INFLIGHT_POST_APPROVED for outbound)
  assert.equal(
    checkpointOrderError("OUTBOUND", "part_c", "INFLIGHT_POST_APPROVED", "AIRCRAFT"),
    null,
    "Submitting Part C when status is INFLIGHT_POST_APPROVED must be allowed"
  );
});

test("ICMS Ops Group Mapping: Correct branch assignment for each checkpoint", () => {
  assert.equal(opsGroupForCheckpointRole("post2_avsec"), "ifc_avsec");
  assert.equal(opsGroupForCheckpointRole("post6_avsec"), "operation_avsec");
  assert.equal(opsGroupForCheckpointRole("redq_avsec"), "operation_avsec");
  assert.equal(opsGroupForCheckpointRole("hub_avsec"), "hub_avsec");
  assert.equal(opsGroupForCheckpointRole("receiver"), "ifc_avsec");
});
