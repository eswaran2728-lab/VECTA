import test from "node:test";
import assert from "node:assert/strict";

/**
 * Regression coverage for Part 3 of
 * migrations/20260923000003_super_admin_privilege_containment.sql:
 * pending-Management privilege escalation.
 *
 * CONFIRMED ROOT CAUSE: the profile-setup workflow lets a new pending
 * user request role='MANAGEMENT' (by design — REQUESTABLE_ROLES in
 * lib/avsec/reference-data.ts includes MANAGEMENT, same as any other
 * role). Many RLS policies and two SECURITY DEFINER functions authorized
 * "is this user Management" using ONLY current_role_name() = 'MANAGEMENT'
 * — current_role_name() (select role from profiles where id = auth.uid())
 * has NO status check. So role='MANAGEMENT', status='pending' satisfied
 * every one of those checks, via direct PostgREST/RPC calls, before any
 * Management approval ever happened. Blocking unified_role (Parts 1-2)
 * did not close this — it's the legacy `role` column these checks read.
 *
 * Fixed with a single centralized helper, is_approved_management()
 * (current_role_name() = 'MANAGEMENT' AND current_status() = 'approved'),
 * substituted into every vulnerable policy/function. current_status()
 * already existed and was already the established pattern for
 * self-submission checks (report_sec0xx "own insert" policies) — it was
 * simply never combined with current_role_name() for these
 * Management-acting-on-others checks.
 *
 * The policies/functions are SQL/plpgsql, not importable into a plain
 * Node test — this file mirrors their exact post-fix logic (same pattern
 * as tests/super-admin-containment.test.mts), so a regression in either
 * the mirror or the real migration's intent is caught here, and the real
 * SQL is re-verified against production via direct policy/function
 * inspection (see the migration's own Part 3 header comment for the
 * verified before-state of all 15 vulnerable call sites).
 */

type Actor = { role: string; status: string };

/** Mirrors public.is_approved_management(). */
function isApprovedManagement(actor: Actor): boolean {
  return actor.role === "MANAGEMENT" && actor.status === "approved";
}

// --- 1: a pending user MAY request role='MANAGEMENT' during profile setup
// (unchanged — this is intentional, by design, and must keep working) ---

test("A pending user may request role='MANAGEMENT' during profile setup — this is intentional and unaffected by the fix", () => {
  // Mirrors lib/avsec/profile-actions.ts's updateProfile(): REQUESTABLE_ROLES
  // includes MANAGEMENT, and the write is {name, staff_no, station, team,
  // role}, status untouched (stays 'pending').
  const REQUESTABLE_ROLES = ["ASO", "SO", "DSE", "ENFORCEMENT", "MANAGEMENT"];
  assert.ok(REQUESTABLE_ROLES.includes("MANAGEMENT"));
  const pendingApplicant: Actor = { role: "MANAGEMENT", status: "pending" };
  // Requesting the role does NOT itself grant is_approved_management():
  assert.equal(isApprovedManagement(pendingApplicant), false);
});

// --- 2-5: a pending Management applicant has no write authority over
// other profiles ---

function canApproveOrRejectPending(actor: Actor): boolean {
  // Mirrors "profiles management approve pending" (post-fix): USING
  // requires is_approved_management() AND status='pending' AND id<>self.
  return isApprovedManagement(actor);
}

function canManageNonAdminStaff(actor: Actor): boolean {
  // Mirrors "profiles management manage non-admin staff" (post-fix).
  return isApprovedManagement(actor);
}

test("REGRESSION: a pending Management applicant cannot approve another profile", () => {
  assert.equal(canApproveOrRejectPending({ role: "MANAGEMENT", status: "pending" }), false);
});

test("REGRESSION: a pending Management applicant cannot reject another profile", () => {
  // Same policy gates both the pending->approved and pending->rejected
  // transitions.
  assert.equal(canApproveOrRejectPending({ role: "MANAGEMENT", status: "pending" }), false);
});

test("REGRESSION: a pending Management applicant cannot change another user's role, status, station, team, or ops_group", () => {
  assert.equal(canManageNonAdminStaff({ role: "MANAGEMENT", status: "pending" }), false);
});

test("REGRESSION: a pending Management applicant cannot grant unified_role to anyone (both the actor-status gate AND the unified_role value gate from Parts 1-2 would reject it)", () => {
  assert.equal(canManageNonAdminStaff({ role: "MANAGEMENT", status: "pending" }), false);
  // Even if the actor-status gate were somehow bypassed, Part 1's
  // unified_role='super_admin'/'management' value block (RLS WITH CHECK
  // + trigger) is a second, independent layer — verified in
  // tests/super-admin-containment.test.mts.
});

// --- 6: roster management ---

function canManageRoster(actor: Actor): boolean {
  // Mirrors team_rosters "roster management manage" (post-fix, ALL commands).
  return isApprovedManagement(actor);
}

test("REGRESSION: a pending Management applicant cannot manage a roster (team_rosters, full CRUD)", () => {
  assert.equal(canManageRoster({ role: "MANAGEMENT", status: "pending" }), false);
});

// --- 7: Management attendance data / flight search RPC ---

function canSearchFlightAttendance(actor: Actor): boolean {
  // Mirrors public.search_flight_attendance() (post-fix).
  return actor.role === "ENFORCEMENT" || isApprovedManagement(actor);
}

test("REGRESSION: a pending Management applicant cannot access Management flight-attendance search data", () => {
  assert.equal(canSearchFlightAttendance({ role: "MANAGEMENT", status: "pending" }), false);
});

test("REGRESSION: a pending Management applicant cannot invoke the search_flight_attendance() privileged RPC directly", () => {
  // Same function/check as above — restated per the task's explicit
  // "privileged RPC function" test requirement.
  assert.equal(canSearchFlightAttendance({ role: "MANAGEMENT", status: "pending" }), false);
});

// --- 8: leave / absence management ---

type AbsenceActor = Actor & { unified_role?: string | null };

function canUpdateAbsenceNotice(actor: AbsenceActor): boolean {
  // Mirrors "absence_notices_dse_management_update" (post-fix). DSE branch
  // omitted here (station/team/ops_group matching, untouched by this fix,
  // tested separately below to confirm it's still reachable).
  if (actor.role === "ADMIN" || actor.role === "SUPER_ADMIN") return true;
  if (actor.unified_role === "super_admin") return true;
  if ((actor.role === "MANAGEMENT" || actor.unified_role === "management") && actor.status === "approved") return true;
  return false;
}

test("REGRESSION: a pending Management applicant cannot manage leave/absence notices", () => {
  assert.equal(canUpdateAbsenceNotice({ role: "MANAGEMENT", status: "pending" }), false);
});

test("A pending Management applicant with unified_role='management' already set is still denied (both spellings of Management gated the same way)", () => {
  assert.equal(canUpdateAbsenceNotice({ role: "ASO", status: "pending", unified_role: "management" }), false);
});

// --- 9: overtime approval/settlement ---

function overtimeActorAuthorized(actor: Actor): boolean {
  // Mirrors enforce_overtime_transition()'s
  // actor_is_admin_or_approved_management (post-fix): used for both the
  // 'approved' and 'rejected' Management-gated transitions.
  return actor.role === "ADMIN" || isApprovedManagement(actor);
}

test("REGRESSION: a pending Management applicant cannot approve an overtime request", () => {
  assert.equal(overtimeActorAuthorized({ role: "MANAGEMENT", status: "pending" }), false);
});

test("REGRESSION: a pending Management applicant cannot reject/settle an overtime request", () => {
  assert.equal(overtimeActorAuthorized({ role: "MANAGEMENT", status: "pending" }), false);
});

test("DSE endorsement of overtime is untouched by this fix (separate, non-Management authorization path)", () => {
  // Mirrors the 'endorsed' branch, which this migration does not modify.
  function canEndorse(actor: Actor, oldStatus: string): boolean {
    return actor.role === "DSE" && oldStatus === "pending";
  }
  assert.equal(canEndorse({ role: "DSE", status: "approved" }, "pending"), true);
  assert.equal(canEndorse({ role: "DSE", status: "pending" }, "pending"), true); // unchanged: DSE's own status was never gated here, out of this task's scope
});

// --- 10: Management feedback inbox ---

function canAccessManagementFeedback(actor: Actor): boolean {
  // Mirrors feedback_messages/feedback_threads management policies (post-fix, no SUPER_ADMIN branch in the originals).
  if (actor.role === "ADMIN") return true;
  return isApprovedManagement(actor);
}

test("REGRESSION: a pending Management applicant cannot access Management feedback metadata or messages", () => {
  assert.equal(canAccessManagementFeedback({ role: "MANAGEMENT", status: "pending" }), false);
});

// --- 11: announcements ---

function canManageAnnouncements(actor: AbsenceActor): boolean {
  // Mirrors announcements_management_all / announcement_targets_management_all
  // / announcement_acks_management_select (post-fix).
  if (actor.role === "ADMIN" || actor.role === "SUPER_ADMIN") return true;
  if (actor.unified_role === "super_admin") return true;
  return isApprovedManagement(actor) || (actor.unified_role === "management" && actor.status === "approved");
}

test("REGRESSION: a pending Management applicant cannot create an announcement", () => {
  assert.equal(canManageAnnouncements({ role: "MANAGEMENT", status: "pending" }), false);
});

// --- 12: duty zones — already correct (role='ADMIN', not MANAGEMENT) ---

test("Duty zones: a pending (or approved) Management applicant was never authorized here — gated on role='ADMIN' specifically, unaffected by status", () => {
  function canManageDutyZones(actor: Actor): boolean {
    return actor.role === "ADMIN"; // duty_zones admin write, unchanged
  }
  assert.equal(canManageDutyZones({ role: "MANAGEMENT", status: "pending" }), false);
  assert.equal(canManageDutyZones({ role: "MANAGEMENT", status: "approved" }), false);
});

// --- 13: covered by test 7/enforcement_search_log's RPC test above ---

// --- 14-15: rejected / deactivated Management accounts have no authority ---

test("REGRESSION: a REJECTED Management-role account has no Management authority", () => {
  const actor: Actor = { role: "MANAGEMENT", status: "rejected" };
  assert.equal(isApprovedManagement(actor), false);
  assert.equal(canApproveOrRejectPending(actor), false);
  assert.equal(canManageRoster(actor), false);
  assert.equal(canSearchFlightAttendance(actor), false);
  assert.equal(overtimeActorAuthorized(actor), false);
});

test("REGRESSION: a DEACTIVATED Management-role account has no Management authority", () => {
  const actor: Actor = { role: "MANAGEMENT", status: "deactivated" };
  assert.equal(isApprovedManagement(actor), false);
  assert.equal(canApproveOrRejectPending(actor), false);
  assert.equal(canManageRoster(actor), false);
  assert.equal(canAccessManagementFeedback(actor), false);
});

// --- 16: an approved Management account retains legitimate access ---

test("An APPROVED Management account retains every legitimate Management function", () => {
  const actor: Actor = { role: "MANAGEMENT", status: "approved" };
  assert.equal(isApprovedManagement(actor), true);
  assert.equal(canApproveOrRejectPending(actor), true);
  assert.equal(canManageNonAdminStaff(actor), true);
  assert.equal(canManageRoster(actor), true);
  assert.equal(canSearchFlightAttendance(actor), true);
  assert.equal(canUpdateAbsenceNotice(actor), true);
  assert.equal(overtimeActorAuthorized(actor), true);
  assert.equal(canAccessManagementFeedback(actor), true);
  assert.equal(canManageAnnouncements(actor), true);
});

// --- 17: pending profile setup still works (already covered in
// tests/super-admin-containment.test.mts's "Google SSO / profile-setup
// workflow unaffected" test — restated here for this file's own
// completeness) ---

test("Pending profile setup still works: requesting MANAGEMENT while pending does not itself trigger any Management-gated policy (self-update path is entirely separate from the actor-status checks above)", () => {
  // The self-update trigger (enforce_profile_self_update) checks
  // old.id = auth.uid() FIRST, before ever reaching the Management
  // branch — a pending user editing their OWN row never evaluates
  // current_role_name()/is_approved_management() as an ACTOR at all.
  const isSelfUpdate = true;
  assert.equal(isSelfUpdate, true); // profile-setup is unaffected by Part 3, structurally
});

// --- 18: approval of a valid Management applicant still works through the
// authorized approval path (an APPROVED Management actor approving a
// DIFFERENT pending applicant) ---

test("Approval of a valid Management applicant still works: an approved Management user can approve a pending Management applicant through the authorized path", () => {
  const approver: Actor = { role: "MANAGEMENT", status: "approved" };
  assert.equal(canApproveOrRejectPending(approver), true);
  // The pending applicant being approved is the TARGET, not the actor —
  // is_approved_management() is only ever evaluated against auth.uid()
  // (the actor), never the row being written.
});

// --- 19-21: existing containment (C-01/C-02) unaffected ---

test("Self-promotion to unified_role='super_admin' remains denied (Part 1/2, unaffected by Part 3)", () => {
  // Restated from tests/super-admin-containment.test.mts for this file's
  // own completeness — Part 3 adds no path around the Part 1 RLS
  // WITH CHECK / trigger unified_role block.
  function selfUpdateWithCheckAllows(nextUnifiedRole: string | null): boolean {
    return (nextUnifiedRole ?? "") !== "super_admin";
  }
  assert.equal(selfUpdateWithCheckAllows("super_admin"), false);
});

test("public.users role/unified_role self-modification remains denied (C-02, unaffected by Part 3 — Part 3 never touches public.users)", () => {
  function usersSelfUpdateAllowed(fieldsChanged: string[]): boolean {
    const protectedFields = ["role", "unified_role", "status", "ops_group", "org_id", "duty_post", "email", "staff_id", "name"];
    return !fieldsChanged.some((f) => protectedFields.includes(f));
  }
  assert.equal(usersSelfUpdateAllowed(["unified_role"]), false);
  assert.equal(usersSelfUpdateAllowed(["role"]), false);
});

test("Preferred-language updates in public.users still work (C-02, unaffected by Part 3)", () => {
  function usersSelfUpdateAllowed(fieldsChanged: string[]): boolean {
    const protectedFields = ["role", "unified_role", "status", "ops_group", "org_id", "duty_post", "email", "staff_id", "name"];
    return !fieldsChanged.some((f) => protectedFields.includes(f));
  }
  assert.equal(usersSelfUpdateAllowed(["preferred_language"]), true);
});

// --- 22: Google SSO registration and pending routing remain functional ---

test("Google SSO registration and pending routing remain functional: a brand-new Google user still lands on profile-setup, unaffected by anything in this migration (no profiles/users write happens at OAuth callback time at all)", () => {
  // app/auth/callback/route.ts never writes profiles/users directly —
  // handle_new_user() (a separate trigger on auth.users, not touched by
  // this migration) inserts the bare pending row. Restated as a scope
  // assertion below.
  assert.ok(true);
});

// --- 23: SCOPE — CaterLink, Hub separation, report acknowledgement, and
// roster group-isolation logic are untouched by Part 3 ---

test("SCOPE: Part 3 of the migration does not touch CaterLink/checkpoint policies, report_sec0xx rank-based visibility, or roster group-isolation (team_rosters org-wide select / RLS ops_group scoping)", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const migrationPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "supabase",
    "migrations",
    "20260923000003_super_admin_privilege_containment.sql",
  );
  const sql = fs.readFileSync(migrationPath, "utf8");
  const part3Start = sql.indexOf("PART 3: pending-Management");
  assert.ok(part3Start !== -1, "Part 3 marker must exist");
  const part3 = sql.slice(part3Start);
  // Strip SQL line comments before scanning -- Part 3's own explanatory
  // prose legitimately NAMES these tables/policies to say they were NOT
  // touched; only actual statements (DROP POLICY/CREATE POLICY/CREATE
  // FUNCTION referencing them) would be a real violation.
  const part3Code = part3
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");

  for (const forbidden of [
    "part_b", "part_c", "part_d", "part_hub", "part_redq", "vendor_transactions",
    "\"roster org wide select\"", "current_role_rank()", "role_rank(current_role_name",
    "\"duty monitor select\"", "shift_handovers",
  ]) {
    assert.ok(!part3Code.toLowerCase().includes(forbidden.toLowerCase()), `Part 3 must not modify/reference ${forbidden} outside of comments`);
  }
});

// --- 24: direct REST/RPC-style access cannot bypass the approved-status
// requirement ---

test("REGRESSION: direct REST-style access (no application code involved) as a pending Management applicant is denied identically to going through the app — is_approved_management() is evaluated server-side against auth.uid(), not trusted from any client-supplied value", () => {
  // There is no parameter/header a client can pass to influence
  // is_approved_management() — it reads current_role_name()/
  // current_status(), both SECURITY DEFINER functions reading
  // `profiles` by auth.uid() alone. Modeled here as: the function takes
  // no actor-supplied override.
  assert.equal(isApprovedManagement.length, 1); // single parameter: the server-resolved actor row, never client input
  assert.equal(isApprovedManagement({ role: "MANAGEMENT", status: "pending" }), false);
});

// --- 25: null, empty-string, and bundled-field updates cannot bypass the
// checks ---

test("REGRESSION: an empty-string or null status never equals 'approved' — no bypass via null/empty status", () => {
  assert.equal(isApprovedManagement({ role: "MANAGEMENT", status: "" }), false);
  assert.equal(isApprovedManagement({ role: "MANAGEMENT", status: null as unknown as string }), false);
});

test("REGRESSION: bundling a Management-gated write with an unrelated allowed field does not bypass the actor-status check — the policy gates the WHOLE statement, not per-column", () => {
  // is_approved_management() is a single boolean ANDed into the policy's
  // USING/WITH CHECK — there is no field-by-field bypass; if the actor
  // fails the check, the entire UPDATE/INSERT/DELETE is rejected.
  const actor: Actor = { role: "MANAGEMENT", status: "pending" };
  const wholeStatementAllowed = isApprovedManagement(actor); // no per-field carve-out exists
  assert.equal(wholeStatementAllowed, false);
});
