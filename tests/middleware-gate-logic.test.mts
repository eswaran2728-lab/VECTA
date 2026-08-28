import test from "node:test";
import assert from "node:assert/strict";
import { isCheckinGateExempt, isAdminPathForbidden } from "../lib/supabase/middleware-gate-logic.ts";

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
