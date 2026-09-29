import { test } from "node:test";
import assert from "node:assert/strict";
import { assignmentKey, tierForRoleCode, type RoleAssignmentContext } from "../lib/dashboard/tiers.ts";

function assignment(overrides: Partial<RoleAssignmentContext> = {}): RoleAssignmentContext {
  return {
    roleCode: "aso",
    roleCategory: "operation",
    aocCode: "MY",
    operatingEntityCode: null,
    departmentCode: "operation",
    unitCode: null,
    hubCode: null,
    stationCode: "PEN",
    teamName: "Alpha",
    startsAt: "2026-01-01T00:00:00Z",
    endsAt: null,
    ...overrides,
  };
}

test("tierForRoleCode classifies every Phase 3 role into the correct dashboard tier", () => {
  assert.equal(tierForRoleCode("airasia_management"), "international");
  assert.equal(tierForRoleCode("ghod"), "international");
  assert.equal(tierForRoleCode("global_reporting_controller"), "international");
  assert.equal(tierForRoleCode("super_admin"), "international");

  assert.equal(tierForRoleCode("maa_boss"), "malaysia_leadership");
  assert.equal(tierForRoleCode("aax_boss"), "malaysia_leadership");
  assert.equal(tierForRoleCode("maa_admin"), "malaysia_leadership");
  assert.equal(tierForRoleCode("aax_admin"), "malaysia_leadership");
  assert.equal(tierForRoleCode("operation_manager"), "malaysia_leadership");
  assert.equal(tierForRoleCode("main_enforcement"), "malaysia_leadership");
  assert.equal(tierForRoleCode("compliance"), "malaysia_leadership");
  assert.equal(tierForRoleCode("caterlink_management"), "malaysia_leadership");

  assert.equal(tierForRoleCode("investigation_sso"), "enforcement");
  assert.equal(tierForRoleCode("investigation_so"), "enforcement");
  assert.equal(tierForRoleCode("investigation_aso"), "enforcement");
  assert.equal(tierForRoleCode("sat_aso"), "enforcement");
  assert.equal(tierForRoleCode("profiling_so"), "enforcement");
  assert.equal(tierForRoleCode("profiling_aso"), "enforcement");

  assert.equal(tierForRoleCode("hub_se"), "operation");
  assert.equal(tierForRoleCode("dse"), "operation");
  assert.equal(tierForRoleCode("sso"), "operation");
  assert.equal(tierForRoleCode("so"), "operation");
  assert.equal(tierForRoleCode("aso"), "operation");

  assert.equal(tierForRoleCode("not_a_real_role"), "unknown");
});

test("assignmentKey is unique per distinct scope, even for the same role code", () => {
  const penAlpha = assignment({ stationCode: "PEN", teamName: "Alpha" });
  const penBravo = assignment({ stationCode: "PEN", teamName: "Bravo" });
  const kulAlpha = assignment({ stationCode: "KUL - MAA", teamName: "Alpha" });

  assert.notEqual(assignmentKey(penAlpha), assignmentKey(penBravo));
  assert.notEqual(assignmentKey(penAlpha), assignmentKey(kulAlpha));
  assert.equal(assignmentKey(penAlpha), assignmentKey(assignment({ stationCode: "PEN", teamName: "Alpha" })));
});

test("assignmentKey distinguishes assignments that differ only by role code", () => {
  const aso = assignment({ roleCode: "aso" });
  const so = assignment({ roleCode: "so" });
  assert.notEqual(assignmentKey(aso), assignmentKey(so));
});
