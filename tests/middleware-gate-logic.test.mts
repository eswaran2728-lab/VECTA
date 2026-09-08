import test from "node:test";
import assert from "node:assert/strict";
import { isCheckinGateExempt, isAdminPathForbidden, isVectaRoleAllowed } from "../lib/supabase/middleware-gate-logic.ts";


// --- Check-in gate exemption (item 3/6 context, item 7 pure-logic coverage) ---
test("isCheckinGateExempt: admin/management/enforcement are seniority-exempt", () => {
  assert.equal(isCheckinGateExempt("admin"), true);
  assert.equal(isCheckinGateExempt("management"), true);
  assert.equal(isCheckinGateExempt("enforcement"), true);
});

test("isCheckinGateExempt: vendor is exempt for a different reason (not AirAsia staff)", () => {
  assert.equal(isCheckinGateExempt("vendor"), true);
});

test("isCheckinGateExempt: so/aso/dse are NOT exempt -- they're the roles the gate exists for", () => {
  assert.equal(isCheckinGateExempt("so"), false);
  assert.equal(isCheckinGateExempt("aso"), false);
  assert.equal(isCheckinGateExempt("dse"), false);
});

test("isCheckinGateExempt: null role (no profile row matched) is not exempt -- fails closed", () => {
  assert.equal(isCheckinGateExempt(null), false);
});

// --- Admin-path edge gate (item 6) ---
test("isAdminPathForbidden: non-admin roles are forbidden from /avsec/admin/*", () => {
  for (const role of ["so", "aso", "dse", "enforcement", "management", "vendor", null]) {
    assert.equal(isAdminPathForbidden("/avsec/admin/users", role), true, `role ${role}`);
  }
});

test("isAdminPathForbidden: admin role is allowed through", () => {
  assert.equal(isAdminPathForbidden("/avsec/admin/users", "admin"), false);
  assert.equal(isAdminPathForbidden("/avsec/admin", "admin"), false);
});

test("isAdminPathForbidden: non-admin paths are never forbidden by this check regardless of role", () => {
  assert.equal(isAdminPathForbidden("/avsec/dashboard", "so"), false);
  assert.equal(isAdminPathForbidden("/avsec/duty", null), false);
});

// --- VECTA vs CaterLink role boundary segregation ---
test("isVectaRoleAllowed: AVSEC operation roles are allowed in VECTA", () => {
  for (const role of ["admin", "management", "enforcement", "so", "aso", "dse"]) {
    assert.equal(isVectaRoleAllowed(role), true, `role ${role} should have VECTA access`);
  }
});

test("isVectaRoleAllowed: Vendor/Driver roles are not allowed in VECTA (segregated to CaterLink)", () => {
  for (const role of ["vendor", "ifc_driver", "vendor_driver", null]) {
    assert.equal(isVectaRoleAllowed(role), false, `role ${role} should be restricted from VECTA`);
  }
});

