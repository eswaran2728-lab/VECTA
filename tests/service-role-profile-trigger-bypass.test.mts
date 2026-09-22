import test from "node:test";
import assert from "node:assert/strict";

/**
 * Pure model of public.enforce_profile_self_update() after
 * supabase/migrations/20260922000002_service_role_bypasses_profile_trigger.sql.
 *
 * Found retesting registration end-to-end (2026-09-22): a freshly
 * registered, approved account could log in (the email-confirmation fix
 * worked) but its profile still showed empty name/station/team. Root
 * cause: app/api/auth/register/route.ts writes the full profile via the
 * service-role admin client, which bypasses RLS POLICIES (service_role
 * has BYPASSRLS) but NOT this table's BEFORE UPDATE trigger — triggers
 * always run regardless of RLS bypass — and the trigger only ever checked
 * auth.uid()/current_role_name(), both null for a genuine backend
 * request, so it had no path recognizing a trusted service-role write.
 *
 * This model mirrors the real trigger source directly (see the migration)
 * rather than re-deriving it, so a future edit to one that isn't mirrored
 * here is easy to catch by comparing the two files.
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

type AuthRole = "service_role" | "authenticated" | null;

function enforceProfileSelfUpdate(
  authRole: AuthRole,
  callerId: string | null,
  callerProfileRole: string | null,
  old: ProfileRow,
  next: ProfileRow,
): { allowed: boolean; error?: string } {
  if (authRole === "service_role") return { allowed: true };

  if (callerProfileRole === "ADMIN") return { allowed: true };

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
      callerProfileRole === "MANAGEMENT" &&
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

const barePendingProfile: ProfileRow = {
  id: "reg-1",
  status: "pending",
  role: "ASO",
  name: "",
  staff_no: "",
  station: null,
  team: null,
  ops_group: null,
};

test("REGRESSION: service_role can write the full profile details on a self-registered account (the actual reported bug)", () => {
  const next: ProfileRow = {
    ...barePendingProfile,
    name: "ASO Test Officer",
    staff_no: "AA-1234",
    station: "KUL - MAA",
    team: "ALPHA",
    ops_group: "operation_avsec",
  };
  const result = enforceProfileSelfUpdate("service_role", null, null, barePendingProfile, next);
  assert.equal(result.allowed, true);
});

test("service_role can approve/reject any profile (createStaffAccount's own approved-on-creation write)", () => {
  const next: ProfileRow = { ...barePendingProfile, status: "approved" };
  const result = enforceProfileSelfUpdate("service_role", null, null, barePendingProfile, next);
  assert.equal(result.allowed, true);
});

test("An ordinary authenticated user (not service_role) is completely unaffected by this change", () => {
  const next: ProfileRow = { ...barePendingProfile, status: "approved" };
  const result = enforceProfileSelfUpdate("authenticated", "so-1", "SO", barePendingProfile, next);
  assert.equal(result.allowed, false);
  assert.equal(result.error, "Not authorized to modify this profile.");
});

test("MANAGEMENT approval behavior (fixed in the prior migration) is unchanged by this fix", () => {
  const next: ProfileRow = { ...barePendingProfile, status: "approved" };
  const result = enforceProfileSelfUpdate("authenticated", "mgmt-1", "MANAGEMENT", barePendingProfile, next);
  assert.equal(result.allowed, true);
});

test("Self-approval remains blocked even for service_role misuse would still require calling with the right context - a real end-user session cannot claim service_role", () => {
  // service_role is only ever set for requests authenticated with the
  // server-only SUPABASE_SERVICE_ROLE_KEY, never reachable from a browser
  // session - this test just documents that authRole is not user input.
  const next: ProfileRow = { ...barePendingProfile, id: "so-1", status: "approved" };
  const own: ProfileRow = { ...barePendingProfile, id: "so-1" };
  const result = enforceProfileSelfUpdate("authenticated", "so-1", "SO", own, next);
  assert.equal(result.allowed, false);
});
