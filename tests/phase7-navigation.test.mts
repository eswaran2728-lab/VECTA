import { test } from "node:test";
import assert from "node:assert/strict";
import { caterlinkNavAllowedForRole, phase7DashboardNavEntry, scannerNavAllowedForRole } from "../lib/dashboard/navigation.ts";

test("phase7DashboardNavEntry: no active assignment -> no entry (legacy UI compatibility, not authorization)", () => {
  assert.equal(phase7DashboardNavEntry(false), null);
  assert.equal(phase7DashboardNavEntry(false, "aso"), null);
});

test("phase7DashboardNavEntry: active assignment -> always the same context-resolving route", () => {
  const entry = phase7DashboardNavEntry(true);
  assert.equal(entry?.href, "/avsec/my-dashboard");
});

test("phase7DashboardNavEntry: role-flavored label for international vs operational tiers", () => {
  assert.equal(phase7DashboardNavEntry(true, "airasia_management")?.label, "Executive Dashboard");
  assert.equal(phase7DashboardNavEntry(true, "ghod")?.label, "Executive Dashboard");
  assert.equal(phase7DashboardNavEntry(true, "aso")?.label, "My Dashboard");
  assert.equal(phase7DashboardNavEntry(true, "operation_manager")?.label, "My Dashboard");
  // No role code (multi-assignment, not yet selected) -> generic label, still a real link.
  assert.equal(phase7DashboardNavEntry(true)?.label, "My Dashboard");
});

test("caterlinkNavAllowedForRole: only caterlink_management gets CaterLink nav from Phase 7 surfaces", () => {
  assert.equal(caterlinkNavAllowedForRole("caterlink_management"), true);
  for (const role of ["aso", "so", "dse", "hub_se", "main_enforcement", "operation_manager", "maa_boss", null]) {
    assert.equal(caterlinkNavAllowedForRole(role), false, `${role} must not get CaterLink nav`);
  }
});

test("scannerNavAllowedForRole: Profiling and Investigation are always denied", () => {
  for (const role of ["profiling_so", "profiling_aso", "investigation_sso", "investigation_so", "investigation_aso"]) {
    assert.equal(scannerNavAllowedForRole(role), false, `${role} must never get scanner nav`);
  }
});

test("scannerNavAllowedForRole: operational roles and legacy (null) accounts are unaffected", () => {
  for (const role of ["aso", "so", "dse", "hub_se", "sat_aso", null]) {
    assert.equal(scannerNavAllowedForRole(role), true);
  }
});
