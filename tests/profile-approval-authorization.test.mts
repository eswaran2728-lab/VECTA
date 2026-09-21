import test from "node:test";
import assert from "node:assert/strict";

/**
 * Pure model of public.enforce_profile_self_update() (see
 * supabase/migrations/20260921000001_management_can_approve_pending_staff.sql)
 * PLUS the RLS UPDATE policy that gates whether a row even reaches that
 * trigger (see supabase/migrations/20260921000002_management_approve_pending_rls_policy.sql).
 *
 * Found during VECTA production certification (2026-09-21), in two stages:
 *
 * Stage 1: the app's approveUser()/rejectUser() actions
 * (lib/avsec/admin/actions.ts) are gated on MANAGEMENT_ROLES = ["MANAGEMENT",
 * "ADMIN"] (lib/avsec/auth.ts), but the enforce_profile_self_update trigger
 * only special-cased role === "ADMIN" — fixed by migration ...000001.
 *
 * Stage 2 (found by a real live production E2E test after Stage 1 shipped):
 * even with the trigger fixed, no RLS UPDATE policy on public.profiles
 * permitted a MANAGEMENT user to update a DIFFERENT user's row at all
 * ("profiles admin manage" requires role = ADMIN; "profiles self update"
 * requires id = auth.uid()). PostgreSQL RLS silently excludes non-matching
 * rows from an UPDATE's target set (0 rows affected, no exception raised),
 * and approveUser()/rejectUser() didn't check the Supabase response, so the
 * live UI showed no error when Management clicked Approve. Fixed by
 * migration ...000002 (RLS policy) plus checking the update response here.
 */

/** Models the RLS UPDATE policy gate (must pass before the trigger even runs). */
function rlsAllowsUpdate(callerRole: string, old: { id: string }, callerId: string, newStatus: string): boolean {
  if (callerRole === "ADMIN") return true; // "profiles admin manage"
  if (old.id === callerId) return true; // "profiles self update"
  if (callerRole === "MANAGEMENT" && (newStatus === "approved" || newStatus === "rejected")) {
    return true; // "profiles management approve pending" (USING requires old.status='pending', checked by caller)
  }
  return false;
}
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

/**
 * Full pipeline model: RLS gate first (row must be in the UPDATE target set
 * at all), then the trigger's exact rule. Mirrors what actually happens in
 * Postgres for `supabase.from("profiles").update(...).eq("id", profileId)`.
 */
function attemptApproveOrReject(
  callerId: string,
  callerRole: string,
  old: ProfileRow,
  newStatus: "approved" | "rejected",
): { rowsAffected: number; error?: string } {
  if (!rlsAllowsUpdate(callerRole, old, callerId, newStatus) || (callerRole === "MANAGEMENT" && old.status !== "pending" && old.id !== callerId)) {
    return { rowsAffected: 0 }; // RLS silently excludes the row - no exception, this was the real production bug
  }
  const next = { ...old, status: newStatus };
  const result = enforceProfileSelfUpdate(callerId, callerRole, old, next);
  if (!result.allowed) {
    return { rowsAffected: 0, error: result.error };
  }
  return { rowsAffected: 1 };
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

// Reproduces the exact live production failure reported 2026-09-21:
// Management logged in, clicked Approve on a real pending cert account,
// and nothing happened - no error, no state change - because the RLS
// policy (not the trigger) silently excluded the row from the UPDATE.
test("REGRESSION: end-to-end approval succeeds for MANAGEMENT once both the RLS policy and trigger permit it", () => {
  const result = attemptApproveOrReject("mgmt-1", "MANAGEMENT", pendingAso, "approved");
  assert.equal(result.rowsAffected, 1);
  assert.equal(result.error, undefined);
});

test("REGRESSION: end-to-end rejection succeeds for MANAGEMENT", () => {
  const result = attemptApproveOrReject("mgmt-1", "MANAGEMENT", pendingAso, "rejected");
  assert.equal(result.rowsAffected, 1);
});

test("REGRESSION: without the RLS policy fix, MANAGEMENT approval would silently affect 0 rows (documents the original bug shape)", () => {
  // Simulates the pre-fix state: RLS has no MANAGEMENT-approve policy at all.
  function rlsAllowsUpdatePreFix(callerRole: string, old: { id: string }, callerId: string): boolean {
    if (callerRole === "ADMIN") return true;
    if (old.id === callerId) return true;
    return false;
  }
  const allowed = rlsAllowsUpdatePreFix("MANAGEMENT", pendingAso, "mgmt-1");
  assert.equal(allowed, false, "this is the exact defect: RLS silently blocked the row before the trigger even ran");
});

test("MANAGEMENT still cannot approve a non-pending (already reviewed) row end-to-end", () => {
  const approved: ProfileRow = { ...pendingAso, status: "approved" };
  const result = attemptApproveOrReject("mgmt-1", "MANAGEMENT", approved, "rejected");
  assert.equal(result.rowsAffected, 0);
});

test("MANAGEMENT still cannot approve their own pending account end-to-end (self-approval blocked)", () => {
  const own = { ...pendingAso, id: "mgmt-1" };
  const result = attemptApproveOrReject("mgmt-1", "MANAGEMENT", own, "approved");
  assert.equal(result.rowsAffected, 0);
  assert.equal(result.error, "Cannot change your own approval status.");
});
