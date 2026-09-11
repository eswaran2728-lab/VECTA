import test from "node:test";
import assert from "node:assert/strict";
import {
  isCheckinGateExempt,
  isAdminPathForbidden,
  isVectaRoleAllowed,
  isSuperAdminPathForbidden,
  isOperationalPathForbiddenForSuperAdmin,
} from "../lib/supabase/middleware-gate-logic.ts";

// --- Check-in gate exemption ---
test("isCheckinGateExempt: super_admin/management/enforcement are seniority-exempt", () => {
  assert.equal(isCheckinGateExempt("super_admin"), true);
  assert.equal(isCheckinGateExempt("management"), true);
  assert.equal(isCheckinGateExempt("admin"), true);
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

// --- Admin-path edge gate ---
test("isAdminPathForbidden: management and admin roles are allowed through", () => {
  assert.equal(isAdminPathForbidden("/avsec/admin/users", "management"), false);
  assert.equal(isAdminPathForbidden("/avsec/admin/users", "admin"), false);
});

test("isAdminPathForbidden: non-management roles are forbidden from /avsec/admin/*", () => {
  for (const role of ["so", "aso", "dse", "enforcement", "vendor", null]) {
    assert.equal(isAdminPathForbidden("/avsec/admin/users", role), true, `role ${role}`);
  }
});

// --- Super Admin portal & isolation gates ---
test("isSuperAdminPathForbidden: only super_admin can access /super-admin", () => {
  assert.equal(isSuperAdminPathForbidden("/super-admin", "super_admin"), false);
  for (const role of ["management", "admin", "enforcement", "so", "aso", "dse", "vendor", null]) {
    assert.equal(isSuperAdminPathForbidden("/super-admin", role), true, `role ${role}`);
  }
});

test("isOperationalPathForbiddenForSuperAdmin: super_admin cannot participate in tenant operational workflows", () => {
  assert.equal(isOperationalPathForbiddenForSuperAdmin("/avsec/duty", "super_admin"), true);
  assert.equal(isOperationalPathForbiddenForSuperAdmin("/avsec/reports/sec014", "super_admin"), true);
  assert.equal(isOperationalPathForbiddenForSuperAdmin("/icms/transactions", "super_admin"), true);
  assert.equal(isOperationalPathForbiddenForSuperAdmin("/caterlink/dashboard", "super_admin"), true);
  assert.equal(isOperationalPathForbiddenForSuperAdmin("/avsec/duty", "management"), false);
});

// --- VECTA vs CaterLink role boundary segregation ---
test("isVectaRoleAllowed: AVSEC operation roles are allowed in VECTA", () => {
  for (const role of ["super_admin", "admin", "management", "enforcement", "so", "aso", "dse"]) {
    assert.equal(isVectaRoleAllowed(role), true, `role ${role} should have VECTA access`);
  }
});

test("isVectaRoleAllowed: Vendor/Driver roles are not allowed in VECTA (segregated to CaterLink)", () => {
  for (const role of ["vendor", "ifc_driver", "vendor_driver", null]) {
    assert.equal(isVectaRoleAllowed(role), false, `role ${role} should be restricted from VECTA`);
  }
});

