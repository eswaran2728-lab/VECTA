import test from "node:test";
import assert from "node:assert/strict";

/**
 * Pure model of the RLS policy "profiles management manage non-admin staff"
 * (see supabase/migrations/20260922000001_management_manage_non_admin_staff.sql).
 *
 * Found auditing MANAGEMENT/ADMIN feature parity after the approval-bug
 * investigation (2026-09-22): lib/avsec/admin/actions.ts gates
 * createStaffAccount(), deactivateUser(), and updateUserAssignment() on
 * MANAGEMENT_ROLES = ["MANAGEMENT", "ADMIN"], but only "profiles admin
 * manage" (role = 'ADMIN') and the narrow pending-approval policy existed
 * at the RLS layer — so MANAGEMENT calling any of these three would hit
 * the same silent no-op failure approveUser() did before its fix.
 */
function rlsAllowsManagementStaffUpdate(
  callerRole: string,
  targetOldRole: string,
  targetNewRole: string,
): boolean {
  if (callerRole !== "MANAGEMENT") return false;
  return targetOldRole !== "ADMIN" && targetNewRole !== "ADMIN";
}

test("MANAGEMENT can update a newly-created non-admin staff profile (createStaffAccount)", () => {
  assert.equal(rlsAllowsManagementStaffUpdate("MANAGEMENT", "ASO", "SO"), true);
});

test("MANAGEMENT can deactivate a non-admin staff account (deactivateUser)", () => {
  assert.equal(rlsAllowsManagementStaffUpdate("MANAGEMENT", "ASO", "ASO"), true);
});

test("MANAGEMENT can reassign a non-admin staff member's role/station (updateUserAssignment)", () => {
  assert.equal(rlsAllowsManagementStaffUpdate("MANAGEMENT", "SO", "DSE"), true);
});

test("MANAGEMENT can create/promote another MANAGEMENT-tier account", () => {
  assert.equal(rlsAllowsManagementStaffUpdate("MANAGEMENT", "ASO", "MANAGEMENT"), true);
});

test("MANAGEMENT cannot modify an existing ADMIN account", () => {
  assert.equal(rlsAllowsManagementStaffUpdate("MANAGEMENT", "ADMIN", "ADMIN"), false);
});

test("MANAGEMENT cannot promote anyone to ADMIN", () => {
  assert.equal(rlsAllowsManagementStaffUpdate("MANAGEMENT", "ASO", "ADMIN"), false);
});

test("A non-MANAGEMENT, non-ADMIN role (e.g. SO) still cannot manage other staff", () => {
  assert.equal(rlsAllowsManagementStaffUpdate("SO", "ASO", "SO"), false);
});
