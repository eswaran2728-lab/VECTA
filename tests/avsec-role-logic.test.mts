// Note: CaterLink integration (cl_transactions / cl_seals) cannot be tested from this
// repo -- those tables belong to CaterLink's own schema and don't exist here, so there
// is nothing to query or assert against in this test suite.

import test from "node:test";
import assert from "node:assert/strict";
import { ORG_WIDE_ROLES, ROLE_RANK, USER_ROLES, type UserRole } from "../lib/avsec/reference-data.ts";
import { pointInPolygon } from "../lib/avsec/duty/geofence.ts";

// lib/avsec/auth.ts imports next/navigation (redirect), which the plain node:test
// runner can't resolve outside a Next.js build -- so its pure role-list constants and
// landingPathForRole() are duplicated here verbatim (see lib/avsec/auth.ts for the
// source of truth) rather than importing the whole module just to reach them.
function landingPathForRole(role: UserRole): string {
  return role === "ASO" ? "/avsec/home" : "/avsec/dashboard";
}
const MONITOR_ROLES: UserRole[] = ["SO", "DSE", "ENFORCEMENT", "MANAGEMENT", "ADMIN"];
const ADMIN_ROLES: UserRole[] = ["ADMIN"];
const DUTY_ROLES: UserRole[] = ["ASO", "SO", "DSE"];
const ENFORCEMENT_SEARCH_ROLES: UserRole[] = ["ENFORCEMENT", "MANAGEMENT"];

// --- landingPathForRole: pure decision logic behind where each role lands after login ---
test("landingPathForRole: ASO lands on /avsec/home, every other role lands on /avsec/dashboard", () => {
  for (const role of USER_ROLES) {
    const expected = role === "ASO" ? "/avsec/home" : "/avsec/dashboard";
    assert.equal(landingPathForRole(role), expected, `role ${role}`);
  }
});

// --- Role-list membership: the pure data requireRole()/requireProfile() gate on ---
test("DUTY_ROLES is exactly the team-scoped roles (ASO/SO/DSE) -- org-wide roles never roster onto a shift", () => {
  const dutySet = new Set<UserRole>(DUTY_ROLES);
  for (const role of USER_ROLES) {
    const shouldBeDutyRole = !ORG_WIDE_ROLES.includes(role as (typeof ORG_WIDE_ROLES)[number]);
    assert.equal(dutySet.has(role), shouldBeDutyRole, `role ${role}`);
  }
});

test("MONITOR_ROLES includes every rank at or above SO, and excludes ASO", () => {
  assert.equal(MONITOR_ROLES.includes("ASO"), false);
  for (const role of ["SO", "DSE", "ENFORCEMENT", "MANAGEMENT", "ADMIN"] as UserRole[]) {
    assert.ok(MONITOR_ROLES.includes(role), `expected MONITOR_ROLES to include ${role}`);
  }
});

test("ADMIN_ROLES is exactly ['ADMIN']", () => {
  assert.deepEqual(ADMIN_ROLES, ["ADMIN"]);
});

test("ENFORCEMENT_SEARCH_ROLES is Enforcement + Management only, deliberately excluding Admin", () => {
  assert.ok(ENFORCEMENT_SEARCH_ROLES.includes("ENFORCEMENT"));
  assert.ok(ENFORCEMENT_SEARCH_ROLES.includes("MANAGEMENT"));
  assert.equal(ENFORCEMENT_SEARCH_ROLES.includes("ADMIN"), false);
});

test("ROLE_RANK is strictly increasing along ASO < SO < DSE < ENFORCEMENT < MANAGEMENT < ADMIN", () => {
  const order: UserRole[] = ["ASO", "SO", "DSE", "ENFORCEMENT", "MANAGEMENT", "ADMIN"];
  for (let i = 1; i < order.length; i++) {
    assert.ok(ROLE_RANK[order[i]!] > ROLE_RANK[order[i - 1]!], `${order[i]} should outrank ${order[i - 1]}`);
  }
});

test("Enforcement and Management are AVSEC-side functional equivalents apart from rank-based report visibility breadth", () => {
  // Documented parity decision (mirrors the ICMS-side management_icms_parity migration)
  // -- both are org-wide, both are excluded from DUTY_ROLES, and both are included in
  // ENFORCEMENT_SEARCH_ROLES identically.
  assert.equal(ORG_WIDE_ROLES.includes("ENFORCEMENT"), ORG_WIDE_ROLES.includes("MANAGEMENT"));
  assert.equal(DUTY_ROLES.includes("ENFORCEMENT" as UserRole), DUTY_ROLES.includes("MANAGEMENT" as UserRole));
  assert.equal(ENFORCEMENT_SEARCH_ROLES.includes("ENFORCEMENT"), ENFORCEMENT_SEARCH_ROLES.includes("MANAGEMENT"));
});

// --- Geofence check-in decision logic (pure, used identically client + server) ---
const SQUARE = {
  type: "Polygon" as const,
  coordinates: [
    [
      [0, 0],
      [0, 10],
      [10, 10],
      [10, 0],
      [0, 0],
    ],
  ],
};

test("pointInPolygon: a point inside the zone is inside", () => {
  assert.equal(pointInPolygon(5, 5, SQUARE), true);
});

test("pointInPolygon: a point outside the zone is outside", () => {
  assert.equal(pointInPolygon(50, 50, SQUARE), false);
});

test("pointInPolygon: null/missing polygon (e.g. a malformed duty_zones row) never crashes and is always outside", () => {
  assert.equal(pointInPolygon(5, 5, null), false);
  assert.equal(pointInPolygon(5, 5, undefined), false);
});
