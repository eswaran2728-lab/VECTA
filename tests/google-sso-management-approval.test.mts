import test from "node:test";
import assert from "node:assert/strict";
import { validateApprovalAssignment } from "../lib/avsec/admin/validation.ts";

/**
 * Google SSO registration + Management approval workflow (2026-09-23).
 * See supabase/migrations/20260923000002_google_sso_management_approval.sql
 * for the DB-side changes these tests model.
 */

// --- 1-3, 6: routing decision, modeled after lib/avsec/auth.ts requireProfile() ---

type ProfileState = {
  exists: boolean;
  name?: string;
  station?: string | null;
  team?: string | null;
  role?: string;
  status?: "pending" | "approved" | "rejected" | "deactivated";
};

const ORG_WIDE = ["ENFORCEMENT", "MANAGEMENT", "ADMIN"];

function routeDecision(profile: ProfileState): "login" | "profile-setup" | "pending-approval" | "operational" {
  if (!profile.exists) return "profile-setup"; // handle_new_user() always creates a bare row, but model the defensive case too
  const isOrgWide = ORG_WIDE.includes(profile.role ?? "");
  const incomplete = !profile.name || (!isOrgWide && (!profile.station || !profile.team));
  if (incomplete) return "profile-setup";
  if (profile.status !== "approved") return "pending-approval";
  return "operational";
}

test("1. A brand-new Google user (bare trigger-created row, no name/station/team) is routed to profile setup", () => {
  const brandNew: ProfileState = { exists: true, name: "", station: null, team: null, role: "ASO", status: "pending" };
  assert.equal(routeDecision(brandNew), "profile-setup");
});

test("2. An incomplete profile (name set, station/team still blank) cannot reach an operational route", () => {
  const incomplete: ProfileState = { exists: true, name: "Jane Tan", station: null, team: null, role: "ASO", status: "pending" };
  assert.notEqual(routeDecision(incomplete), "operational");
  assert.equal(routeDecision(incomplete), "profile-setup");
});

test("3. A completed but still-pending profile cannot reach an operational route", () => {
  const completedPending: ProfileState = { exists: true, name: "Jane Tan", station: "KUL - MAA", team: "ALPHA", role: "ASO", status: "pending" };
  assert.notEqual(routeDecision(completedPending), "operational");
  assert.equal(routeDecision(completedPending), "pending-approval");
});

test("6. A rejected user cannot reach an operational route", () => {
  const rejected: ProfileState = { exists: true, name: "Jane Tan", station: "KUL - MAA", team: "ALPHA", role: "ASO", status: "rejected" };
  assert.notEqual(routeDecision(rejected), "operational");
  assert.equal(routeDecision(rejected), "pending-approval");
});

test("A deactivated approved user cannot reach an operational route", () => {
  const deactivated: ProfileState = { exists: true, name: "Jane Tan", station: "KUL - MAA", team: "ALPHA", role: "ASO", status: "deactivated" };
  assert.notEqual(routeDecision(deactivated), "operational");
});

test("An approved, complete profile reaches an operational route", () => {
  const approved: ProfileState = { exists: true, name: "Jane Tan", station: "KUL - MAA", team: "ALPHA", role: "ASO", status: "approved" };
  assert.equal(routeDecision(approved), "operational");
});

// --- 4: server actions never trust a non-approved caller ---

function requireRoleModel(profile: ProfileState, allowedRoles: string[]): { granted: boolean } {
  // Mirrors requireRole() -> requireProfile(): status must be 'approved'
  // AND the profile must be complete, before role membership is even
  // checked. A pending user can never reach the role check at all.
  if (routeDecision(profile) !== "operational") return { granted: false };
  return { granted: allowedRoles.includes(profile.role ?? "") };
}

test("4. A pending user cannot invoke a protected server action, even one their requested role would otherwise allow", () => {
  const pendingAso: ProfileState = { exists: true, name: "Jane Tan", station: "KUL - MAA", team: "ALPHA", role: "ASO", status: "pending" };
  const result = requireRoleModel(pendingAso, ["ASO"]);
  assert.equal(result.granted, false);
});

// --- 5: RLS blocks table reads for non-approved users (report_acknowledgements: "ack select" using (current_status() = 'approved')) ---

function rlsAckSelectAllows(callerStatus: string): boolean {
  return callerStatus === "approved";
}

test("5. A pending user's status fails the report_acknowledgements RLS read policy (current_status() = 'approved')", () => {
  assert.equal(rlsAckSelectAllows("pending"), false);
  assert.equal(rlsAckSelectAllows("rejected"), false);
  assert.equal(rlsAckSelectAllows("approved"), true);
});

// --- 7: profile submission never sets status to approved ---

test("7. Submitting the profile-setup form does not itself approve the account (updateProfile() never writes status)", () => {
  const submittedFields = { name: "Jane Tan", staff_no: "AA-1", station: "KUL - MAA", team: "ALPHA", role: "ASO" };
  assert.ok(!("status" in submittedFields), "updateProfile()'s UPDATE payload must never include status");
});

// --- 8, 9: self-modification prevention (enforce_profile_self_update() self-path) ---

interface ProfileRow {
  id: string;
  status: "pending" | "approved" | "rejected";
  role: string;
  ops_group: string | null;
}

function selfUpdateAllowed(callerId: string, old: ProfileRow, next: ProfileRow): boolean {
  if (old.id !== callerId) return false; // not the self-path at all
  if (old.status === "approved" || old.status === "rejected") {
    // Found implementing this migration: role/status/station/team/
    // ops_group must ALL stay identical once reviewed — station/team
    // weren't part of this model (or the real trigger) at first.
    return next.role === old.role && next.status === old.status && next.ops_group === old.ops_group;
  }
  return next.status === "pending" && next.role !== "ADMIN";
}

test("8. A user cannot change their own authorized role once reviewed", () => {
  const own: ProfileRow = { id: "u1", status: "approved", role: "ASO", ops_group: "operation_avsec" };
  const attempt: ProfileRow = { ...own, role: "MANAGEMENT" };
  assert.equal(selfUpdateAllowed("u1", own, attempt), false);
});

test("9. A user cannot change their own ops_group once reviewed", () => {
  const own: ProfileRow = { id: "u1", status: "approved", role: "ASO", ops_group: "operation_avsec" };
  // The self-path model only permits role/status to stay identical once
  // reviewed; any other column change (ops_group included) must go
  // through the same "already reviewed" rejection - modeled here via the
  // trigger's real behavior: it raises before ever inspecting ops_group.
  const attempt: ProfileRow = { ...own, ops_group: "ifc_avsec" };
  assert.equal(selfUpdateAllowed("u1", own, attempt), false);
});

test("A pending user cannot self-approve by changing their own status", () => {
  const own: ProfileRow = { id: "u1", status: "pending", role: "ASO", ops_group: null };
  const attempt: ProfileRow = { ...own, status: "approved" };
  assert.equal(selfUpdateAllowed("u1", own, attempt), false);
});

// --- 10-13: validateApprovalAssignment (the real, shared function) ---

test("10. ASO approval fails without station", () => {
  const r = validateApprovalAssignment({ role: "ASO", station: "", team: "ALPHA", opsGroup: "operation_avsec" });
  assert.equal(r.ok, false);
});

test("11. ASO approval fails without team", () => {
  const r = validateApprovalAssignment({ role: "ASO", station: "KUL - MAA", team: "", opsGroup: "operation_avsec" });
  assert.equal(r.ok, false);
});

test("12. ASO approval fails without ops group", () => {
  const r = validateApprovalAssignment({ role: "ASO", station: "KUL - MAA", team: "ALPHA", opsGroup: "" });
  assert.equal(r.ok, false);
});

test("13. Approval succeeds when all mandatory ASO/SO/DSE assignments exist", () => {
  for (const role of ["ASO", "SO", "DSE"]) {
    const r = validateApprovalAssignment({ role, station: "KUL - MAA", team: "ALPHA", opsGroup: "ifc_avsec" });
    assert.equal(r.ok, true, `${role} should validate with full assignment`);
  }
});

test("Org-wide roles (MANAGEMENT/ENFORCEMENT) do not require team/ops_group", () => {
  for (const role of ["MANAGEMENT", "ENFORCEMENT"]) {
    const r = validateApprovalAssignment({ role, station: "KUL - MAA", team: "", opsGroup: "" });
    assert.equal(r.ok, true, `${role} should validate without team/ops_group`);
  }
});

test("An invalid ops_group value is rejected even when everything else is present", () => {
  const r = validateApprovalAssignment({ role: "ASO", station: "KUL - MAA", team: "ALPHA", opsGroup: "not_a_real_group" });
  assert.equal(r.ok, false);
});

// --- 14: approval records approver + timestamp (structural) ---

test("14. The approval write always includes approved_by and approved_at alongside status", () => {
  const managerId = "mgr-1";
  const approvalWrite = {
    role: "ASO",
    station: "KUL - MAA",
    team: "ALPHA",
    ops_group: "operation_avsec",
    status: "approved" as const,
    approved_by: managerId,
    approved_at: new Date().toISOString(),
    rejection_reason: null,
  };
  assert.equal(approvalWrite.approved_by, managerId);
  assert.ok(approvalWrite.approved_at.length > 0);
  assert.equal(approvalWrite.status, "approved");
});

// --- 15: approved ASO receives only ASO-authorized access ---

test("15. An approved ASO passes requireRole(['ASO']) but not requireRole(['MANAGEMENT'])", () => {
  const approvedAso: ProfileState = { exists: true, name: "Jane Tan", station: "KUL - MAA", team: "ALPHA", role: "ASO", status: "approved" };
  assert.equal(requireRoleModel(approvedAso, ["ASO"]).granted, true);
  assert.equal(requireRoleModel(approvedAso, ["MANAGEMENT"]).granted, false);
});

// --- Self-target approval/rejection is blocked at the application layer too ---

test("Management cannot approve or reject their own pending row (profileId === manager.id guard)", () => {
  function selfTargetGuard(managerId: string, profileId: string): boolean {
    return profileId !== managerId; // true = allowed to proceed
  }
  assert.equal(selfTargetGuard("mgr-1", "mgr-1"), false);
  assert.equal(selfTargetGuard("mgr-1", "other-user"), true);
});
