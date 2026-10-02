import test from "node:test";
import assert from "node:assert/strict";
import {
  ALL_ROLE_CODES,
  INTERNATIONAL_ROLES,
  ENTITY_LEADERSHIP_ROLES,
  DEPARTMENT_LEADERSHIP_ROLES,
  INVESTIGATION_ROLES,
  SAT_ROLES,
  PROFILING_ROLES,
  HUB_SE_ROLES,
  DSE_ROLES,
  STATION_ROLES,
} from "../scripts/staging/lib/role-matrix.mjs";

/**
 * Proves the staging provisioning role matrix (scripts/staging/lib/role-matrix.mjs)
 * covers exactly the 23 unique approved role codes seeded in
 * role_definitions (supabase/migrations/20260928000002_phase3_role_permission_foundation.sql)
 * -- no fewer (a missing role means that role never gets a staging
 * account for dashboard review), no more (a phantom role means
 * provisioning would fail against the real schema), no duplicates, and
 * no invented 'hod' role.
 */

const EXPECTED_ROLE_CODES = [
  "airasia_management",
  "ghod",
  "global_reporting_controller",
  "super_admin",
  "maa_boss",
  "maa_admin",
  "aax_boss",
  "aax_admin",
  "operation_manager",
  "main_enforcement",
  "compliance",
  "caterlink_management",
  "investigation_sso",
  "investigation_so",
  "investigation_aso",
  "sat_aso",
  "profiling_so",
  "profiling_aso",
  "hub_se",
  "dse",
  "sso",
  "so",
  "aso",
];

test("dashboard role matrix: ALL_ROLE_CODES contains exactly 23 unique approved role codes", () => {
  assert.equal(ALL_ROLE_CODES.length, 23, `Expected exactly 23 role codes, got ${ALL_ROLE_CODES.length}`);
  assert.equal(new Set(ALL_ROLE_CODES).size, 23, "ALL_ROLE_CODES must contain no duplicates");
});

test("dashboard role matrix: ALL_ROLE_CODES matches the authoritative Phase 3 seed list exactly (same set, order-independent)", () => {
  const actual = [...ALL_ROLE_CODES].sort();
  const expected = [...EXPECTED_ROLE_CODES].sort();
  assert.deepEqual(actual, expected);
});

test("dashboard role matrix: no generic 'hod' role is present anywhere in the matrix", () => {
  assert.ok(!ALL_ROLE_CODES.includes("hod"));
  assert.ok(!ALL_ROLE_CODES.some((code) => code === "hod"));
});

test("dashboard role matrix: every role-category group sums to the total with no overlap between groups", () => {
  const groups = [
    INTERNATIONAL_ROLES,
    ENTITY_LEADERSHIP_ROLES,
    DEPARTMENT_LEADERSHIP_ROLES,
    INVESTIGATION_ROLES,
    SAT_ROLES,
    PROFILING_ROLES,
    HUB_SE_ROLES,
    DSE_ROLES,
    STATION_ROLES,
  ];
  const totalAcrossGroups = groups.reduce((sum, g) => sum + g.length, 0);
  assert.equal(totalAcrossGroups, 23, "the role-category groups must partition ALL_ROLE_CODES exactly, with no role counted twice");

  const seen = new Set();
  for (const group of groups) {
    for (const code of group) {
      assert.ok(!seen.has(code), `role code '${code}' appears in more than one category group`);
      seen.add(code);
    }
  }
  assert.equal(seen.size, 23);
});
