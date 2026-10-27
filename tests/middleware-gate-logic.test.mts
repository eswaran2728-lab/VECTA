import test from "node:test";
import assert from "node:assert/strict";
import {
  isCheckinGateExempt,
  isAdminPathForbidden,
  isVectaRoleAllowed,
  isSuperAdminPathForbidden,
  isOperationalPathForbiddenForSuperAdmin,
  todayISODateMY,
} from "../lib/supabase/middleware-gate-logic.ts";
import fs from "node:fs";

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

// --- Malaysia midnight duty-date calculation (UTC+8) ---
test("todayISODateMY: calculates correct Malaysia duty-date across midnight boundaries (23:59, 00:01, 07:59 MYT)", () => {
  // 1. 23:59 MYT on 2026-10-27 is 15:59 UTC on 2026-10-27
  const t2359 = new Date("2026-10-27T15:59:00.000Z");
  assert.equal(todayISODateMY(t2359), "2026-10-27", "23:59 MYT resolves to 2026-10-27");

  // 2. 00:01 MYT on 2026-10-28 is 16:01 UTC on 2026-10-27
  const t0001 = new Date("2026-10-27T16:01:00.000Z");
  assert.equal(todayISODateMY(t0001), "2026-10-28", "00:01 MYT resolves to 2026-10-28");

  // 3. 07:59 MYT on 2026-10-28 is 23:59 UTC on 2026-10-27
  const t0759 = new Date("2026-10-27T23:59:00.000Z");
  assert.equal(todayISODateMY(t0759), "2026-10-28", "07:59 MYT resolves to 2026-10-28");

  // Demonstrate that UTC date calculation (the defect in middleware) fails between 00:00 and 08:00 MYT:
  const defectiveDateAt0001 = t0001.toISOString().slice(0, 10);
  assert.equal(defectiveDateAt0001, "2026-10-27", "defective UTC calculation produces yesterday's date");
  assert.notEqual(defectiveDateAt0001, todayISODateMY(t0001), "UTC calculation diverges from Malaysia date at 00:01 MYT");

  const defectiveDateAt0759 = t0759.toISOString().slice(0, 10);
  assert.equal(defectiveDateAt0759, "2026-10-27", "defective UTC calculation produces yesterday's date");
  assert.notEqual(defectiveDateAt0759, todayISODateMY(t0759), "UTC calculation diverges from Malaysia date at 07:59 MYT");
});

test("middleware check-in gate uses todayISODateMY() instead of raw UTC date", () => {
  const code = fs.readFileSync(new URL("../lib/supabase/middleware.ts", import.meta.url), "utf8");
  assert.match(code, /const today = todayISODateMY\(\);/, "middleware uses established Malaysia-date helper");
  assert.doesNotMatch(code, /const today = new Date\(\)\.toISOString\(\)\.slice\(0, 10\);/, "middleware does not use raw UTC date");
});


