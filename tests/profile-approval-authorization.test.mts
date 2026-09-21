import test from "node:test";
import assert from "node:assert/strict";

/**
 * Pure model of public.enforce_profile_self_update() (see
 * supabase/migrations/20260921000001_management_can_approve_pending_staff.sql).
 *
 * Found during VECTA production certification (2026-09-21): the app's
 * approveUser()/rejectUser() actions (lib/avsec/admin/actions.ts) are gated
 * on MANAGEMENT_ROLES = ["MANAGEMENT", "ADMIN"] (lib/avsec/auth.ts), but the
 * DB trigger only special-cased role === "ADMIN", so a real MANAGEMENT user
 * approving a pending registration would be rejected by the trigger with
 * "Not authorized to modify this profile." — a functional defect (fails
 * safe, not a security hole) fixed by this migration.
 */
interface ProfileRow {
  id: string;
  status: "pending" | "approved" | "rejected";
  role: string;
  name: string | null;
  staff_no: string | null;
  station: string | null;
  team: string | null;
  ops_group: string | null;
}

function enforceProfileSelfUpdate(
  callerId: string,
  callerRole: string,
  old: ProfileRow,
  next: ProfileRow,
): { allowed: boolean; error?: string } {
  if (callerRole === "ADMIN") return { allowed: true };

  if (old.id !== callerId) {
    const onlyStatusChanged =
      next.role === old.role &&
      next.role !== "ADMIN" &&
      next.name === old.name &&
      next.staff_no === old.staff_no &&
      next.station === old.station &&
      next.team === old.team &&
      next.ops_group === old.ops_group;

    if (
      callerRole === "MANAGEMENT" &&
      old.status === "pending" &&
      (next.status === "approved" || next.status === "rejected") &&
      onlyStatusChanged
    ) {
      return { allowed: true };
    }
    return { allowed: false, error: "Not authorized to modify this profile." };
  }

  if (old.status === "approved" || old.status === "rejected") {
    if (next.role !== old.role || next.status !== old.status) {
      return { allowed: false, error: "Your account has already been reviewed. Contact an admin to change your role." };
    }
  } else {
    if (next.status !== "pending") {
      return { allowed: false, error: "Cannot change your own approval status." };
    }
    if (next.role === "ADMIN") {
      return { allowed: false, error: "Cannot self-assign the ADMIN role." };
    }
  }
  return { allowed: true };
}

const pendingAso: ProfileRow = {
  id: "aso-1",
  status: "pending",
  role: "ASO",
  name: "ASO Test",
  staff_no: "AA-1",
  station: "KUL - MAA",
  team: "ALPHA",
  ops_group: "operation_avsec",
};

test("MANAGEMENT can approve a pending staff registration (the fixed defect)", () => {
  const next = { ...pendingAso, status: "approved" as const };
  const result = enforceProfileSelfUpdate("mgmt-1", "MANAGEMENT", pendingAso, next);
  assert.equal(result.allowed, true);
});

test("MANAGEMENT can reject a pending staff registration", () => {
  const next = { ...pendingAso, status: "rejected" as const };
  const result = enforceProfileSelfUpdate("mgmt-1", "MANAGEMENT", pendingAso, next);
  assert.equal(result.allowed, true);
});

test("ADMIN can still approve a pending staff registration (unchanged)", () => {
  const next = { ...pendingAso, status: "approved" as const };
  const result = enforceProfileSelfUpdate("admin-1", "ADMIN", pendingAso, next);
  assert.equal(result.allowed, true);
});

test("MANAGEMENT cannot approve their own pending account (self-approval still blocked)", () => {
  const own = { ...pendingAso, id: "mgmt-1" };
  const next = { ...own, status: "approved" as const };
  const result = enforceProfileSelfUpdate("mgmt-1", "MANAGEMENT", own, next);
  assert.equal(result.allowed, false);
  assert.equal(result.error, "Cannot change your own approval status.");
});

test("MANAGEMENT cannot promote a pending user directly to ADMIN while approving", () => {
  const next = { ...pendingAso, status: "approved" as const, role: "ADMIN" };
  const result = enforceProfileSelfUpdate("mgmt-1", "MANAGEMENT", pendingAso, next);
  assert.equal(result.allowed, false);
  assert.equal(result.error, "Not authorized to modify this profile.");
});

test("MANAGEMENT cannot sneak in other field changes alongside an approval", () => {
  const next = { ...pendingAso, status: "approved" as const, station: "PEN" };
  const result = enforceProfileSelfUpdate("mgmt-1", "MANAGEMENT", pendingAso, next);
  assert.equal(result.allowed, false);
  assert.equal(result.error, "Not authorized to modify this profile.");
});

test("MANAGEMENT cannot modify an already-reviewed profile", () => {
  const approved: ProfileRow = { ...pendingAso, status: "approved" };
  const next = { ...approved, status: "rejected" as const };
  const result = enforceProfileSelfUpdate("mgmt-1", "MANAGEMENT", approved, next);
  assert.equal(result.allowed, false);
  assert.equal(result.error, "Not authorized to modify this profile.");
});

test("A non-ADMIN, non-MANAGEMENT role (e.g. SO) cannot approve anyone", () => {
  const next = { ...pendingAso, status: "approved" as const };
  const result = enforceProfileSelfUpdate("so-1", "SO", pendingAso, next);
  assert.equal(result.allowed, false);
  assert.equal(result.error, "Not authorized to modify this profile.");
});
