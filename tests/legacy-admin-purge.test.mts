import test from "node:test";
import assert from "node:assert/strict";
import { mapAvsecRoleToIcmsRole, mapAvsecRoleToUnifiedRole } from "../lib/icms/shadow-user.ts";
import { ROLE_LABELS as AVSEC_ROLE_LABELS, USER_ROLES } from "../lib/avsec/reference-data.ts";
import { ROLE_LABELS as ICMS_ROLE_LABELS } from "../lib/icms/constants.ts";

function formatRoleChip(role: string | null): string | null {
  if (!role) return null;
  const normalized = role.toLowerCase();
  switch (normalized) {
    case "admin":
    case "management":
      return "Management";
    case "enforcement":
      return "Enforcement";
    case "dse":
      return "DSE";
    case "so":
      return "SO";
    case "aso":
      return "ASO";
    case "super_admin":
      return "Super Admin";
    case "vendor":
      return "Vendor";
    default:
      return role.charAt(0).toUpperCase() + role.slice(1);
  }
}

test("Legacy ADMIN mappings purge: mapAvsecRoleToUnifiedRole maps ADMIN to management", () => {
  assert.equal(mapAvsecRoleToUnifiedRole("ADMIN"), "management");
  assert.equal(mapAvsecRoleToUnifiedRole("MANAGEMENT"), "management");
  assert.equal(mapAvsecRoleToUnifiedRole("ENFORCEMENT"), "enforcement");
  assert.equal(mapAvsecRoleToUnifiedRole("SO"), "so");
  assert.equal(mapAvsecRoleToUnifiedRole("ASO"), "aso");
  assert.equal(mapAvsecRoleToUnifiedRole("DSE"), "dse");
});

test("Legacy ADMIN mappings purge: mapAvsecRoleToIcmsRole maps ADMIN to management", () => {
  assert.equal(mapAvsecRoleToIcmsRole("ADMIN"), "management");
  assert.equal(mapAvsecRoleToIcmsRole("MANAGEMENT"), "management");
  assert.equal(mapAvsecRoleToIcmsRole("ENFORCEMENT"), "enforcement");
});

test("UI Role Label purge: AVSEC and ICMS never render 'Admin' as a role label", () => {
  assert.notEqual(AVSEC_ROLE_LABELS["ADMIN"], "Admin");
  assert.equal(AVSEC_ROLE_LABELS["ADMIN"], "Management Team");
  assert.equal(AVSEC_ROLE_LABELS["MANAGEMENT"], "Management Team");

  assert.notEqual(ICMS_ROLE_LABELS["supervisor"], "Admin");
  assert.equal(ICMS_ROLE_LABELS["supervisor"], "Management");
  assert.equal(ICMS_ROLE_LABELS["management"], "Management");
});

test("Dashboard roleChip: legacy admin and management both format cleanly as 'Management'", () => {
  assert.equal(formatRoleChip("admin"), "Management");
  assert.equal(formatRoleChip("management"), "Management");
  assert.equal(formatRoleChip("ADMIN"), "Management");
  assert.equal(formatRoleChip("MANAGEMENT"), "Management");
  assert.equal(formatRoleChip("so"), "SO");
  assert.equal(formatRoleChip("aso"), "ASO");
  assert.equal(formatRoleChip("dse"), "DSE");
  assert.equal(formatRoleChip("enforcement"), "Enforcement");
  assert.equal(formatRoleChip("super_admin"), "Super Admin");
  assert.equal(formatRoleChip("vendor"), "Vendor");
  assert.equal(formatRoleChip(null), null);
});

test("USER_ROLES contains MANAGEMENT and SUPER_ADMIN but excludes bare ADMIN", () => {
  assert.ok(USER_ROLES.includes("MANAGEMENT"));
  assert.ok(USER_ROLES.includes("SUPER_ADMIN"));
  assert.ok(USER_ROLES.includes("ENFORCEMENT"));
  assert.ok(USER_ROLES.includes("DSE"));
  assert.ok(USER_ROLES.includes("SO"));
  assert.ok(USER_ROLES.includes("ASO"));
  assert.equal((USER_ROLES as readonly string[]).includes("ADMIN"), false);
});
