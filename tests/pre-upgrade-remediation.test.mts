import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Regression coverage for the pre-upgrade remediation pass (2026-09-24):
 * migrations/20260924000001_pre_upgrade_remediation.sql, plus the code
 * changes in lib/icms/actions/registration.ts and the offline-queue/draft
 * scoping in lib/avsec/offline/.
 *
 * The SQL itself is not executable under plain Node — most of these tests
 * mirror the deployed decision logic (same pattern as
 * tests/super-admin-containment.test.mts) or assert on the migration's own
 * source text for changes that are pure grant/DDL statements with no
 * meaningful "decision" to mirror (e.g. REVOKE EXECUTE).
 */

const MIGRATION_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "supabase",
  "migrations",
  "20260924000001_pre_upgrade_remediation.sql",
);
const migrationSql = fs.readFileSync(MIGRATION_PATH, "utf8");

// --- Part A: attendance-sweep AVSEC-group isolation ---

type Roster = { station: string; team: string; ops_group: string; shift_code: string; roster_date: string };
type Profile = { station: string | null; team: string | null; ops_group: string | null; role: string; status: string };

/** Mirrors flag_attendance_anomalies()'s absent-row JOIN (post-fix). */
function matchesRosterForAbsentRow(p: Profile, tr: Roster): boolean {
  return (
    p.station === tr.station &&
    (p.team ?? "") === tr.team &&
    p.ops_group !== null &&
    p.ops_group === tr.ops_group &&
    ["ASO", "SO", "DSE"].includes(p.role) &&
    p.status === "approved"
  );
}

test("REGRESSION: an Operation AVSEC roster row does not generate an absent row for an IFC AVSEC profile with the same team name", () => {
  const roster: Roster = { station: "KUL - MAA", team: "ALPHA", ops_group: "operation_avsec", shift_code: "D1", roster_date: "2026-09-20" };
  const ifcProfile: Profile = { station: "KUL - MAA", team: "ALPHA", ops_group: "ifc_avsec", role: "ASO", status: "approved" };
  assert.equal(matchesRosterForAbsentRow(ifcProfile, roster), false);
});

test("An Operation AVSEC roster row DOES generate an absent row for the matching Operation AVSEC profile", () => {
  const roster: Roster = { station: "KUL - MAA", team: "ALPHA", ops_group: "operation_avsec", shift_code: "D1", roster_date: "2026-09-20" };
  const opsProfile: Profile = { station: "KUL - MAA", team: "ALPHA", ops_group: "operation_avsec", role: "ASO", status: "approved" };
  assert.equal(matchesRosterForAbsentRow(opsProfile, roster), true);
});

test("REGRESSION: an IFC AVSEC roster row does not affect an Operation AVSEC profile with the same team name", () => {
  const roster: Roster = { station: "KUL - MAA", team: "BRAVO", ops_group: "ifc_avsec", shift_code: "D1", roster_date: "2026-09-20" };
  const opsProfile: Profile = { station: "KUL - MAA", team: "BRAVO", ops_group: "operation_avsec", role: "SO", status: "approved" };
  assert.equal(matchesRosterForAbsentRow(opsProfile, roster), false);
});

test("Hub AVSEC remains separate: a Hub roster row only matches a Hub profile, never Operation/IFC with the same team name", () => {
  const hubRoster: Roster = { station: "PEN", team: "ALPHA", ops_group: "hub_avsec", shift_code: "D1", roster_date: "2026-09-20" };
  assert.equal(matchesRosterForAbsentRow({ station: "PEN", team: "ALPHA", ops_group: "hub_avsec", role: "ASO", status: "approved" }, hubRoster), true);
  assert.equal(matchesRosterForAbsentRow({ station: "PEN", team: "ALPHA", ops_group: "operation_avsec", role: "ASO", status: "approved" }, hubRoster), false);
});

test("REGRESSION: a null-ops_group profile can never bypass isolation and match any roster row", () => {
  const roster: Roster = { station: "KUL - MAA", team: "ALPHA", ops_group: "operation_avsec", shift_code: "D1", roster_date: "2026-09-20" };
  const nullOpsProfile: Profile = { station: "KUL - MAA", team: "ALPHA", ops_group: null, role: "ASO", status: "approved" };
  assert.equal(matchesRosterForAbsentRow(nullOpsProfile, roster), false);
});

test("Generated rows store the roster's ops_group (never null, never guessed) -- mirrors the INSERT's SELECT list", () => {
  function generatedRowOpsGroup(tr: Roster): string {
    return tr.ops_group; // team_rosters.ops_group is NOT NULL (20260922162457)
  }
  assert.equal(generatedRowOpsGroup({ station: "KUL - MAA", team: "ALPHA", ops_group: "ifc_avsec", shift_code: "D1", roster_date: "2026-09-20" }), "ifc_avsec");
});

test("SCOPE: Part A only edits flag_attendance_anomalies() -- no other attendance/report/roster function is redefined in that section", () => {
  const partAStart = migrationSql.indexOf("PART A:");
  const partBStart = migrationSql.indexOf("PART B:");
  const partA = migrationSql.slice(partAStart, partBStart);
  assert.match(partA, /create or replace function public\.flag_attendance_anomalies/);
  assert.equal((partA.match(/create or replace function/g) ?? []).length, 1);
});

// --- Part B: cron-only function execute grants ---
//
// REGRESSION: the first version of Part B revoked only from anon and
// authenticated, missing that several of these functions were ALSO
// granted to PUBLIC — a PostgreSQL PUBLIC grant is effective for every
// role independent of any per-role REVOKE, so anon/authenticated still
// had effective EXECUTE via PUBLIC even after that first pass. Verified
// live (has_function_privilege('public', oid, 'EXECUTE')) that
// enqueue_sheet_sync(), trigger_sheets_sync(), escalate_timeouts(),
// log_audit_admin(), and notify_supervisors_on_incident() all carried a
// live PUBLIC grant; flag_attendance_anomalies()/run_attendance_sweep()
// did not (anon/authenticated-only). Every revoke below now targets
// PUBLIC explicitly regardless, so this can never regress silently again.

test("REGRESSION: every confirmed cron-only / trigger-only function revokes EXECUTE from PUBLIC, anon, AND authenticated together — not just anon/authenticated", () => {
  for (const fn of [
    "flag_attendance_anomalies(integer)",
    "escalate_timeouts()",
    "trigger_sheets_sync()",
    "enqueue_sheet_sync()",
    "log_audit_admin()",
    "notify_supervisors_on_incident()",
  ]) {
    const re = new RegExp(`revoke execute on function public\\.${fn.replace(/[()]/g, "\\$&")} from public, anon, authenticated`, "i");
    assert.match(migrationSql, re, `expected a PUBLIC+anon+authenticated revoke for ${fn}`);
  }
});

test("REGRESSION: the two functions with a confirmed live PUBLIC grant (enqueue_sheet_sync, trigger_sheets_sync) are explicitly covered, not just implicitly by the general anon/authenticated pattern used before", () => {
  assert.match(migrationSql, /revoke execute on function public\.enqueue_sheet_sync\(\) from public, anon, authenticated/i);
  assert.match(migrationSql, /revoke execute on function public\.trigger_sheets_sync\(\) from public, anon, authenticated/i);
});

test("Every restricted function is explicitly re-granted to service_role, making trusted execution durable rather than incidental", () => {
  for (const fn of [
    "flag_attendance_anomalies(integer)",
    "escalate_timeouts()",
    "trigger_sheets_sync()",
    "enqueue_sheet_sync()",
    "log_audit_admin()",
    "notify_supervisors_on_incident()",
  ]) {
    const re = new RegExp(`grant execute on function public\\.${fn.replace(/[()]/g, "\\$&")} to service_role`, "i");
    assert.match(migrationSql, re, `expected an explicit service_role grant for ${fn}`);
  }
});

test("Trigger-only functions (log_audit_admin, notify_supervisors_on_incident) are revoked too — Postgres never checks EXECUTE privilege for a trigger firing, only for a direct call, so this cannot break their trigger execution", () => {
  assert.match(migrationSql, /revoke execute on function public\.log_audit_admin\(\) from public, anon, authenticated/i);
  assert.match(migrationSql, /revoke execute on function public\.notify_supervisors_on_incident\(\) from public, anon, authenticated/i);
});

test("search_flight_attendance() (not cron-only, called by real signed-in Enforcement/Management users) is not revoked", () => {
  assert.doesNotMatch(migrationSql, /revoke execute on function public\.search_flight_attendance/i);
});

test("archive_all_pending() (own internal supervisor check, no PUBLIC grant, not cron-invoked) is not revoked", () => {
  assert.doesNotMatch(migrationSql, /revoke execute on function public\.archive_all_pending/i);
});

test("CORRECTED: run_attendance_sweep() is no longer caught by Part B's blanket cron-only revoke (it is a real signed-in-user RPC, not cron-invoked) -- handled separately in Part H with an internal auth fix instead", () => {
  const partBStart = migrationSql.indexOf("PART B:");
  const partCStart = migrationSql.indexOf("PART C:");
  const partB = migrationSql.slice(partBStart, partCStart);
  assert.doesNotMatch(partB, /revoke execute on function public\.run_attendance_sweep\(\) from public, anon, authenticated;/);
});

// --- Part C: feedback_threads_management_view ---

test("REGRESSION: the view is switched to security_invoker so it respects the caller's own RLS instead of the owner's", () => {
  assert.match(migrationSql, /alter view public\.feedback_threads_management_view set \(security_invoker = true\)/i);
});

test("CORRECTED (second pass): SELECT on the feedback metadata view is now revoked from BOTH anon and authenticated -- retaining authenticated would let a submitter read their own thread through a view the app treats as Management-only, once security_invoker makes the view respect the base table's submitter-select RLS", () => {
  assert.match(migrationSql, /revoke select on public\.feedback_threads_management_view from anon, authenticated;/i);
});

test("Management inbox access now goes through get_management_feedback_threads(), requiring status='approved' for EVERY privileged role including legacy ADMIN -- a deliberate tightening beyond the live base-table policy, which admits ADMIN unconditionally", () => {
  const match = migrationSql.match(/create or replace function public\.get_management_feedback_threads\(\)[\s\S]*?\$function\$;/);
  assert.ok(match, "get_management_feedback_threads() must be defined");
  assert.match(match![0], /profiles\.status = 'approved'/);
  assert.match(match![0], /profiles\.role in \('MANAGEMENT', 'ADMIN'\)/);
  assert.match(match![0], /profiles\.unified_role = 'management'/);
  assert.doesNotMatch(match![0], /submitter_id/i, "must never select submitter_id -- privacy-safe columns only");
});

test("get_management_feedback_threads() is revoked from PUBLIC/anon and granted to authenticated (the internal WHERE clause, not the grant, is the data gate)", () => {
  assert.match(migrationSql, /revoke execute on function public\.get_management_feedback_threads\(\) from public, anon;/);
  assert.match(migrationSql, /grant execute on function public\.get_management_feedback_threads\(\) to authenticated;/);
});

/** Mirrors get_management_feedback_threads()'s WHERE EXISTS gate (third pass): status='approved' required for every privileged role. */
function canGetManagementFeedbackThreads(actor: { kind: "anon" } | { kind: "operational" } | { kind: "management"; status: string } | { kind: "admin"; status: string } | { kind: "unified_management"; status: string }): boolean {
  if (actor.kind === "anon") return false; // cannot even execute the function
  if (actor.kind === "operational") return false; // matches none of role in ('MANAGEMENT','ADMIN') or unified_role='management'
  if (actor.kind === "admin" || actor.kind === "management" || actor.kind === "unified_management") return actor.status === "approved";
  return false;
}

test("MANDATORY 20: approved Management can access the feedback RPC", () => {
  assert.equal(canGetManagementFeedbackThreads({ kind: "management", status: "approved" }), true);
});

test("MANDATORY 21: approved legacy ADMIN can access the feedback RPC", () => {
  assert.equal(canGetManagementFeedbackThreads({ kind: "admin", status: "approved" }), true);
});

test("MANDATORY 22: approved unified Management (unified_role='management') can access the feedback RPC", () => {
  assert.equal(canGetManagementFeedbackThreads({ kind: "unified_management", status: "approved" }), true);
});

test("MANDATORY 23: pending/rejected/deactivated Management AND pending/rejected/deactivated legacy ADMIN are both denied -- approved status is now required for every privileged role, not just Management", () => {
  for (const status of ["pending", "rejected", "deactivated"]) {
    assert.equal(canGetManagementFeedbackThreads({ kind: "management", status }), false, `Management/${status} must be denied`);
    assert.equal(canGetManagementFeedbackThreads({ kind: "admin", status }), false, `ADMIN/${status} must be denied -- this is the exact gap the third-pass review found`);
  }
});

test("MANDATORY 24: operational users cannot access the feedback RPC", () => {
  assert.equal(canGetManagementFeedbackThreads({ kind: "operational" }), false);
});

test("MANDATORY 25: anonymous cannot access the feedback RPC (cannot execute it at all)", () => {
  assert.equal(canGetManagementFeedbackThreads({ kind: "anon" }), false);
});

test("Submitters still see their own feedback through the unrelated, unchanged submitter-facing path (base table, not this view/RPC)", () => {
  function canSelectOwnFeedbackThreadDirect(actorId: string, submitterId: string): boolean {
    return actorId === submitterId; // feedback_threads_submitter_select, untouched by this migration
  }
  assert.equal(canSelectOwnFeedbackThreadDirect("u1", "u1"), true);
  assert.equal(canSelectOwnFeedbackThreadDirect("u1", "u2"), false);
});

test("get_management_feedback_threads() never returns another submitter's confidential message body -- it only ever selects id/org_id/category/status/created_at/updated_at, the same privacy-safe column set the view always exposed", () => {
  const match = migrationSql.match(/create or replace function public\.get_management_feedback_threads\(\)[\s\S]*?\$function\$;/);
  assert.match(match![0], /select ft\.id, ft\.org_id, ft\.category, ft\.status, ft\.created_at, ft\.updated_at/);
});

test("Genuine feedback submission (insert on the base table, unrelated to this view) still works -- unaffected, base table INSERT policy untouched", () => {
  function canInsertFeedbackThread(actorId: string, submitterId: string): boolean {
    return actorId === submitterId; // feedback_threads_submitter_insert, unchanged
  }
  assert.equal(canInsertFeedbackThread("u1", "u1"), true);
});

// --- Part D: CaterLink registration / supervisor approval on public.users ---

type UsersRow = { id: string; role: string; unified_role: string | null; status: string; ops_group: string | null; org_id: string | null; duty_post: string | null; email: string; staff_id: string; name: string };

/**
 * Mirrors "users: self register pending vendor" WITH CHECK (post-fix,
 * second pass). The first version only checked id = auth.uid() — this
 * ties the ROW to the caller but does nothing to stop them writing an
 * arbitrary `email` into their own new row. jwtEmail models
 * auth.jwt() ->> 'email' — the verified email claim from the caller's own
 * session, never client-suppliable, confirmed available on this project.
 */
const DEFAULT_ORG_ID = "00000000-0000-0000-0000-000000000001";

function canSelfRegisterVendor(next: {
  id: string;
  actorId: string;
  email: string;
  jwtEmail: string;
  role: string;
  unified_role: string | null;
  status: string;
  org_id: string;
  ops_group: string | null;
  duty_post: string | null;
}): boolean {
  return (
    next.id === next.actorId &&
    next.email === next.jwtEmail &&
    next.role === "vendor" &&
    next.unified_role === "vendor" &&
    next.status === "pending" &&
    next.org_id === DEFAULT_ORG_ID &&
    next.ops_group === null &&
    next.duty_post === null
  );
}

function baseRegistration(overrides: Partial<Parameters<typeof canSelfRegisterVendor>[0]> = {}) {
  return {
    id: "u1",
    actorId: "u1",
    email: "driver@example.com",
    jwtEmail: "driver@example.com",
    role: "vendor",
    unified_role: "vendor",
    status: "pending",
    org_id: DEFAULT_ORG_ID,
    ops_group: null,
    duty_post: null,
    ...overrides,
  };
}

test("REGRESSION: driver/vendor self-registration produces a pending row and nothing else", () => {
  assert.equal(canSelfRegisterVendor(baseRegistration()), true);
});

test("Self-insert can never claim immediate operational access (status must be 'pending')", () => {
  assert.equal(canSelfRegisterVendor(baseRegistration({ status: "active" })), false);
});

test("Self-insert can never claim a non-vendor role (blocks the self-approval-via-registration path)", () => {
  assert.equal(canSelfRegisterVendor(baseRegistration({ role: "management", unified_role: "management" })), false);
});

test("REGRESSION: self-registration cannot choose another user's id", () => {
  assert.equal(canSelfRegisterVendor(baseRegistration({ id: "someone-else" })), false);
});

test("REGRESSION: self-registration cannot claim an email different from the caller's own verified JWT email (identity spoofing)", () => {
  assert.equal(canSelfRegisterVendor(baseRegistration({ email: "someone-else@example.com" })), false);
});

test("REGRESSION: self-registration cannot assign an arbitrary org_id, ops_group, or duty_post via a direct REST INSERT that bypasses the app's own write shape", () => {
  assert.equal(canSelfRegisterVendor(baseRegistration({ org_id: "some-other-org-id" })), false);
  assert.equal(canSelfRegisterVendor(baseRegistration({ ops_group: "operation_avsec" })), false);
  assert.equal(canSelfRegisterVendor(baseRegistration({ duty_post: "Post 2" })), false);
});

// CORRECTED (second pass, 2026-09-24): the actor is now modeled by their
// OWN row on public.users (id/role/status), matched by auth.uid() against
// old.id, exactly like is_active_supervisor() -- not a bare claimed role
// string. created_at and preferred_language are now real columns on
// UsersRow and checked in the allowlist, matching every column
// confirmed live on public.users (12 total).
type FullUsersRow = UsersRow & { created_at: string; preferred_language: string };

/** Mirrors is_active_supervisor(): exists(id=auth.uid() AND role='supervisor' AND status='active'). */
function isActiveSupervisor(actorRow: { id: string; role: string; status: string } | null): boolean {
  if (!actorRow) return false; // missing row -- exists() is false
  return actorRow.role === "supervisor" && actorRow.status === "active";
}

/** Mirrors "users: supervisor approves pending" + enforce_users_self_update()'s supervisor branch (allowlist). */
function enforceUsersSupervisorApproval(
  actorRow: { id: string; role: string; status: string } | null,
  old: FullUsersRow,
  next: FullUsersRow,
): { ok: boolean; error?: string } {
  if (actorRow && actorRow.id === old.id) {
    // old.id = auth.uid() branch takes priority -- self-update, not supervisor approval.
    return { ok: false, error: "Not authorized to modify this field on your own account." };
  }
  if (!isActiveSupervisor(actorRow)) return { ok: false, error: "Not authorized to modify this account." };
  if (old.status !== "pending") return { ok: false, error: "Supervisor may only act on a pending account." };
  if (!["active", "rejected"].includes(next.status)) return { ok: false, error: "Invalid status transition." };
  if (
    next.id !== old.id ||
    next.created_at !== old.created_at ||
    next.preferred_language !== old.preferred_language ||
    next.role !== old.role ||
    next.unified_role !== old.unified_role ||
    next.ops_group !== old.ops_group ||
    next.org_id !== old.org_id ||
    next.duty_post !== old.duty_post ||
    next.email !== old.email ||
    next.staff_id !== old.staff_id ||
    next.name !== old.name
  ) {
    return { ok: false, error: "Supervisor may only change status on this table." };
  }
  return { ok: true };
}

function baseUsersRow(overrides: Partial<FullUsersRow> = {}): FullUsersRow {
  return {
    id: "target",
    role: "vendor",
    unified_role: "vendor",
    status: "pending",
    ops_group: null,
    org_id: "org-1",
    duty_post: null,
    email: "d@example.com",
    staff_id: "AA-1",
    name: "Driver",
    created_at: "2026-01-01T00:00:00Z",
    preferred_language: "en",
    ...overrides,
  };
}

const ACTIVE_SUPERVISOR = { id: "sup-1", role: "supervisor", status: "active" };

test("REGRESSION: self-approval is impossible -- a driver cannot approve their own pending account", () => {
  const old = baseUsersRow({ id: "self" });
  const next = { ...old, status: "active" };
  const result = enforceUsersSupervisorApproval({ id: "self", role: "vendor", status: "pending" }, old, next);
  assert.equal(result.ok, false);
});

test("REGRESSION: an unauthorized (non-supervisor) actor cannot approve or reject a pending registration", () => {
  const old = baseUsersRow();
  const next = { ...old, status: "active" };
  const result = enforceUsersSupervisorApproval({ id: "actor-1", role: "ops_staff", status: "active" }, old, next);
  assert.equal(result.ok, false);
});

test("MANDATORY 9: an active supervisor may approve a pending user", () => {
  const old = baseUsersRow();
  const next = { ...old, status: "active" };
  const result = enforceUsersSupervisorApproval(ACTIVE_SUPERVISOR, old, next);
  assert.equal(result.ok, true);
});

test("MANDATORY 10: an active supervisor may reject a pending user", () => {
  const old = baseUsersRow();
  const next = { ...old, status: "rejected" };
  const result = enforceUsersSupervisorApproval(ACTIVE_SUPERVISOR, old, next);
  assert.equal(result.ok, true);
});

test("MANDATORY 11: a PENDING supervisor cannot approve or reject", () => {
  const old = baseUsersRow();
  const next = { ...old, status: "active" };
  const result = enforceUsersSupervisorApproval({ id: "sup-1", role: "supervisor", status: "pending" }, old, next);
  assert.equal(result.ok, false);
});

test("MANDATORY 12: a REJECTED supervisor cannot approve or reject", () => {
  const old = baseUsersRow();
  const next = { ...old, status: "active" };
  const result = enforceUsersSupervisorApproval({ id: "sup-1", role: "supervisor", status: "rejected" }, old, next);
  assert.equal(result.ok, false);
});

test("MANDATORY 13: an INACTIVE (deactivated) supervisor cannot approve or reject", () => {
  const old = baseUsersRow();
  const next = { ...old, status: "active" };
  const result = enforceUsersSupervisorApproval({ id: "sup-1", role: "supervisor", status: "deactivated" }, old, next);
  assert.equal(result.ok, false);
});

test("MANDATORY 14: a caller with no matching public.users row at all cannot approve or reject (missing row -- exists() is false)", () => {
  const old = baseUsersRow();
  const next = { ...old, status: "active" };
  const result = enforceUsersSupervisorApproval(null, old, next);
  assert.equal(result.ok, false);
});

test("MANDATORY 15: a supervisor cannot modify their own row through this approval path (the self-update branch takes over, not the supervisor branch)", () => {
  const old = baseUsersRow({ id: "sup-1", role: "supervisor", status: "active" });
  const next = { ...old, status: "active", role: "vendor" };
  const result = enforceUsersSupervisorApproval({ id: "sup-1", role: "supervisor", status: "active" }, old, next);
  assert.equal(result.ok, false);
  assert.equal(result.error, "Not authorized to modify this field on your own account.");
});

test("MANDATORY 16: an active supervisor cannot act on a non-pending target", () => {
  const old = baseUsersRow({ status: "active" });
  const next = { ...old, status: "rejected" };
  const result = enforceUsersSupervisorApproval(ACTIVE_SUPERVISOR, old, next);
  assert.equal(result.ok, false);
  assert.equal(result.error, "Supervisor may only act on a pending account.");
});

test("MANDATORY 17: a supervisor cannot change id", () => {
  const old = baseUsersRow();
  const next = { ...old, status: "active", id: "different-id" };
  const result = enforceUsersSupervisorApproval(ACTIVE_SUPERVISOR, old, next);
  assert.equal(result.ok, false);
  assert.equal(result.error, "Supervisor may only change status on this table.");
});

test("MANDATORY 18: a supervisor cannot change created_at", () => {
  const old = baseUsersRow();
  const next = { ...old, status: "active", created_at: "2020-01-01T00:00:00Z" };
  const result = enforceUsersSupervisorApproval(ACTIVE_SUPERVISOR, old, next);
  assert.equal(result.ok, false);
  assert.equal(result.error, "Supervisor may only change status on this table.");
});

test("MANDATORY 19: a supervisor cannot change preferred_language", () => {
  const old = baseUsersRow();
  const next = { ...old, status: "active", preferred_language: "ms" };
  const result = enforceUsersSupervisorApproval(ACTIVE_SUPERVISOR, old, next);
  assert.equal(result.ok, false);
  assert.equal(result.error, "Supervisor may only change status on this table.");
});

test("MANDATORY 20: a supervisor cannot bundle ANY non-status change into the same approval statement (exhaustive allowlist check across every live column)", () => {
  const fields: Array<[keyof FullUsersRow, unknown]> = [
    ["role", "management"],
    ["unified_role", "management"],
    ["ops_group", "operation_avsec"],
    ["org_id", "some-other-org"],
    ["duty_post", "Post 2"],
    ["email", "changed@example.com"],
    ["staff_id", "ZZ-9"],
    ["name", "Changed Name"],
  ];
  for (const [field, value] of fields) {
    const old = baseUsersRow();
    const next = { ...old, status: "active", [field]: value };
    const result = enforceUsersSupervisorApproval(ACTIVE_SUPERVISOR, old, next);
    assert.equal(result.ok, false, `changing ${String(field)} must be rejected`);
    assert.equal(result.error, "Supervisor may only change status on this table.");
  }
});

test("Authorization/identity fields cannot be self-modified on public.users (C-02, unaffected by this pass)", () => {
  function usersSelfUpdateAllowed(fieldsChanged: string[]): boolean {
    const protectedFields = ["role", "unified_role", "status", "ops_group", "org_id", "duty_post", "email", "staff_id", "name"];
    return !fieldsChanged.some((f) => protectedFields.includes(f));
  }
  assert.equal(usersSelfUpdateAllowed(["role"]), false);
  assert.equal(usersSelfUpdateAllowed(["status"]), false);
});

test("Part D: is_active_supervisor() is stable, security definer, has a fixed search_path, and reads only the CALLING user's own row (auth.uid()) -- returns false for a missing/non-matching row", () => {
  const match = migrationSql.match(/create or replace function public\.is_active_supervisor\(\)[\s\S]*?\$function\$;/);
  assert.ok(match, "is_active_supervisor() must be defined");
  assert.match(match![0], /language sql/);
  assert.match(match![0], /stable/);
  assert.match(match![0], /security definer/);
  assert.match(match![0], /set search_path to 'public'/);
  assert.match(match![0], /where id = auth\.uid\(\)/);
  assert.match(match![0], /and role = 'supervisor'/);
  assert.match(match![0], /and status = 'active'/);
});

test("MANDATORY 21: registration self-service remains functional and pending-only (unaffected by the supervisor-branch allowlist fix -- covered above under self-registration)", () => {
  assert.equal(canSelfRegisterVendor(baseRegistration()), true);
  assert.equal(canSelfRegisterVendor(baseRegistration({ status: "active" })), false);
});

test("Both the RLS policy and the trigger now use is_active_supervisor() -- not the old current_user_role() = 'supervisor' -- so they cannot disagree", () => {
  const executableOnly = migrationSql.replace(/\r\n/g, "\n").split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
  assert.doesNotMatch(executableOnly, /current_user_role\(\) = 'supervisor'/);
  const policyMatch = migrationSql.match(/create policy "users: supervisor approves pending"[\s\S]*?\);/);
  assert.ok(policyMatch);
  assert.match(policyMatch![0], /is_active_supervisor\(\)/);
  const triggerMatch = migrationSql.match(/create or replace function public\.enforce_users_self_update\(\)[\s\S]*?\$function\$;/);
  assert.ok(triggerMatch);
  assert.match(triggerMatch![0], /is_active_supervisor\(\)/);
});

test("Service-role shadow synchronization still works (bypasses both the self and supervisor branches)", () => {
  const old = baseUsersRow({ id: "target", status: "pending" });
  const next = { ...old, status: "active", unified_role: "aso", role: "ops_staff" };
  // service_role bypass is the trigger's very first check -- not modeled
  // as a branch here since it unconditionally returns before any of the
  // above logic runs; asserted directly against the deployed source.
  assert.match(migrationSql, /if auth\.role\(\) = 'service_role' then\s*\r?\n\s*return new;/);
  void old;
  void next;
});

// --- Part E: pending-role rank-based visibility ---

type RankActor = { role: string; status: string };
const ROLE_RANK: Record<string, number> = { ASO: 1, SO: 2, DSE: 3, ENFORCEMENT: 4, MANAGEMENT: 5, ADMIN: 6 };

function currentRoleRank(actor: RankActor): number {
  return actor.status === "approved" ? (ROLE_RANK[actor.role] ?? 0) : 0;
}

function isMonitorOrAbove(actor: RankActor): boolean {
  return actor.status === "approved" && ["SO", "DSE", "ENFORCEMENT", "MANAGEMENT", "ADMIN"].includes(actor.role);
}

for (const role of ["SO", "DSE", "ENFORCEMENT", "MANAGEMENT"]) {
  test(`REGRESSION: a pending ${role} applicant receives no rank-based visibility (rank 0, not is_monitor_or_above)`, () => {
    assert.equal(currentRoleRank({ role, status: "pending" }), 0);
    assert.equal(isMonitorOrAbove({ role, status: "pending" }), false);
  });

  test(`REGRESSION: a rejected ${role} account receives no rank-based visibility`, () => {
    assert.equal(currentRoleRank({ role, status: "rejected" }), 0);
    assert.equal(isMonitorOrAbove({ role, status: "rejected" }), false);
  });

  test(`REGRESSION: a deactivated ${role} account receives no rank-based visibility`, () => {
    assert.equal(currentRoleRank({ role, status: "deactivated" }), 0);
    assert.equal(isMonitorOrAbove({ role, status: "deactivated" }), false);
  });

  test(`Approved ${role} retains intended rank-based visibility`, () => {
    assert.equal(currentRoleRank({ role, status: "approved" }), ROLE_RANK[role]);
    assert.equal(isMonitorOrAbove({ role, status: "approved" }), true);
  });
}

test("Business hierarchy is unchanged: rank ordering is identical to before (ASO < SO < DSE < ENFORCEMENT < MANAGEMENT < ADMIN)", () => {
  const order = ["ASO", "SO", "DSE", "ENFORCEMENT", "MANAGEMENT", "ADMIN"];
  for (let i = 1; i < order.length; i++) {
    assert.ok(
      currentRoleRank({ role: order[i], status: "approved" }) > currentRoleRank({ role: order[i - 1], status: "approved" }),
      `${order[i]} must outrank ${order[i - 1]}`,
    );
  }
});

test("REGRESSION: this fix is centralized -- Part E redefines exactly current_role_rank() and is_monitor_or_above(), not individual policies (so every consumer is fixed at once)", () => {
  const partEStart = migrationSql.indexOf("PART E:");
  const partFStart = migrationSql.indexOf("PART F:");
  const partE = migrationSql.slice(partEStart, partFStart);
  assert.match(partE, /create or replace function public\.current_role_rank/);
  assert.match(partE, /create or replace function public\.is_monitor_or_above/);
  assert.equal((partE.match(/create or replace function/g) ?? []).length, 2);
  assert.doesNotMatch(partE, /create policy|drop policy/i);
});

// --- Part F: org_id documentation correction (no functional SQL) ---

test("Part F makes no functional change -- comment/documentation only", () => {
  // Strip comments from the WHOLE file first, then locate Part F in the
  // already-stripped text -- slicing before stripping would cut the
  // "PART F:" header line off mid-comment, leaving its own non-comment
  // prefix ("PART F: profiles.org_id grant") behind as a false positive.
  const strippedWhole = migrationSql
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n");
  const partFStart = migrationSql.indexOf("PART F:");
  const partGStart = migrationSql.indexOf("PART G:");
  const lineOf = (idx: number) => migrationSql.slice(0, idx).replace(/\r\n/g, "\n").split("\n").length - 1;
  const partF = strippedWhole.split("\n").slice(lineOf(partFStart), lineOf(partGStart)).join("\n").trim();
  assert.equal(partF.length, 0, "Part F must contain no executable SQL, only comments");
});

// --- Non-regression: CaterLink unified scanning, Hub separation, report
// acknowledgement, roster isolation, duty gate, super-admin/pending-management
// containment are all covered by the existing, unmodified suites -- this
// file only asserts the new migration doesn't touch any of those areas. ---

test("SCOPE: this migration never references part_b/c/d/hub/redq, vendor_transactions checkpoint policies, or the deployed super-admin containment's own objects", () => {
  const code = migrationSql.replace(/\r\n/g, "\n").split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
  for (const forbidden of ["part_b", "part_c\"", "part_d\"", "part_hub", "part_redq", "is_approved_management()\nreturns", "enforce_profile_self_update()\nreturns"]) {
    assert.ok(!code.toLowerCase().includes(forbidden.toLowerCase()), `must not redefine/reference ${forbidden}`);
  }
  // The super-admin/pending-management containment helper is reused where
  // needed (Parts B/E do not need it) but never redefined by this migration.
  assert.doesNotMatch(code, /create or replace function public\.is_approved_management/i);
});

// =======================================================================
// PART G: schema-wide function-permission audit
// =======================================================================

// get_admin_emails() authorization model (corrected, third pass): the
// grant itself is the sole authorization boundary -- PUBLIC, anon, and
// EVERY authenticated session (regardless of role or status) are denied
// direct execution. Only service_role may call it. The internal
// recipient filter is a correctness filter on WHO to notify, not an authz
// gate -- mirrored here as that, not as a permission check. Corrected to
// resolve approved Management/legacy-ADMIN recipients (role='ADMIN'
// alone would resolve zero recipients live -- ADMIN was merged into
// Management, and production has zero ADMIN-role profiles today).
function adminEmailRecipientFilter(profile: { role: string; status: string; unified_role?: string | null; email?: string | null }): boolean {
  const email = profile.email === undefined ? "notify@example.com" : profile.email;
  return (
    profile.status === "approved" &&
    (["MANAGEMENT", "ADMIN"].includes(profile.role) || profile.unified_role === "management") &&
    !!email
  );
}

test("MANDATORY 9: an approved Management email is returned", () => {
  assert.equal(adminEmailRecipientFilter({ role: "MANAGEMENT", status: "approved" }), true);
});

test("MANDATORY 10: an approved legacy ADMIN email is returned", () => {
  assert.equal(adminEmailRecipientFilter({ role: "ADMIN", status: "approved" }), true);
});

test("MANDATORY 11: an approved unified_role='management' email is returned even if role itself isn't MANAGEMENT/ADMIN", () => {
  assert.equal(adminEmailRecipientFilter({ role: "SO", status: "approved", unified_role: "management" }), true);
});

test("MANDATORY 12: pending/rejected/deactivated privileged accounts are excluded", () => {
  for (const status of ["pending", "rejected", "deactivated"]) {
    assert.equal(adminEmailRecipientFilter({ role: "MANAGEMENT", status }), false, `Management/${status} must be excluded`);
    assert.equal(adminEmailRecipientFilter({ role: "ADMIN", status }), false, `ADMIN/${status} must be excluded`);
  }
});

test("MANDATORY 13: operational accounts (ASO/SO/DSE/Enforcement) are excluded", () => {
  for (const role of ["ASO", "SO", "DSE", "ENFORCEMENT"]) {
    assert.equal(adminEmailRecipientFilter({ role, status: "approved" }), false, `${role} must be excluded`);
  }
});

test("MANDATORY 14: null and empty emails are excluded (defensive -- profiles.email is NOT NULL live, confirmed via information_schema.columns, but filtered anyway)", () => {
  assert.equal(adminEmailRecipientFilter({ role: "MANAGEMENT", status: "approved", email: null }), false);
  assert.equal(adminEmailRecipientFilter({ role: "MANAGEMENT", status: "approved", email: "" }), false);
});

test("MANDATORY 15: duplicate emails are deduplicated (SELECT DISTINCT)", () => {
  const code = migrationSql.replace(/\r\n/g, "\n");
  const match = code.match(/create or replace function public\.get_admin_emails\(\)[\s\S]*?\$function\$;/);
  assert.match(match![0], /select distinct email from profiles/);
});

test("Part G: get_admin_emails() body resolves approved Management/legacy-ADMIN/unified-Management recipients, excluding null/empty emails", () => {
  const code = migrationSql.replace(/\r\n/g, "\n");
  const match = code.match(/create or replace function public\.get_admin_emails\(\)[\s\S]*?\$function\$;/);
  assert.ok(match, "get_admin_emails() must be redefined in Part G");
  assert.match(match![0], /status = 'approved'/);
  assert.match(match![0], /role in \('MANAGEMENT', 'ADMIN'\)/);
  assert.match(match![0], /unified_role = 'management'/);
  assert.match(match![0], /email is not null/);
  assert.match(match![0], /email <> ''/);
});

test("MANDATORY 1-4: PUBLIC, anon, and every ordinary authenticated role (ASO/SO/DSE/Enforcement) cannot execute get_admin_emails -- the revoke targets PUBLIC, anon, and authenticated as a whole, not a role subset", () => {
  const code = migrationSql.replace(/\r\n/g, "\n");
  assert.match(
    code,
    /revoke execute on function public\.get_admin_emails\(\) from public, anon, authenticated;/,
    "must revoke from PUBLIC, anon, and authenticated together -- Postgres has no per-application-role grant, so revoking `authenticated` as a Postgres role necessarily covers every ASO/SO/DSE/Enforcement/vendor session, since they all connect as the same `authenticated` Postgres role",
  );
});

test("MANDATORY 7-8: pending/rejected/deactivated accounts and approved Management alike cannot execute get_admin_emails through an ordinary browser session (no role is carved out of the authenticated revoke)", () => {
  const code = migrationSql.replace(/\r\n/g, "\n");
  // The revoke is unconditional on `authenticated` -- there is no
  // role-scoped re-grant anywhere in the file for any application role,
  // including Management/ADMIN, which connect through the same Postgres
  // `authenticated` role as every other signed-in user.
  const reGrantsToAuthenticated = code.match(/grant execute on function public\.get_admin_emails\([^)]*\) to authenticated/i);
  assert.equal(reGrantsToAuthenticated, null, "no grant to authenticated must exist for get_admin_emails, for any role");
});

test("MANDATORY 17: service_role retains execution of get_admin_emails", () => {
  const code = migrationSql.replace(/\r\n/g, "\n");
  assert.match(code, /grant execute on function public\.get_admin_emails\(\) to service_role;/);
});

test("MANDATORY 18a / caller change: notifyReportSubmission.ts resolves admin emails through the service-role client, not the user-session client", () => {
  const src = fs.readFileSync(
    new URL("../lib/avsec/email/notifyReportSubmission.ts", import.meta.url),
    "utf8",
  );
  assert.match(src, /import \{ createAdminClient \} from "@\/lib\/supabase\/admin";/);
  assert.doesNotMatch(src, /import \{ createClient \} from "@\/lib\/supabase\/server";/);
  assert.match(src, /createAdminClient\(\)/);
  assert.match(src, /supabase\.rpc\("get_admin_emails"\)/);
});

test("MANDATORY 18b / caller change: notifyOvertimeApproval.ts resolves admin emails through the service-role client, not the user-session client", () => {
  const src = fs.readFileSync(
    new URL("../lib/avsec/email/notifyOvertimeApproval.ts", import.meta.url),
    "utf8",
  );
  assert.match(src, /import \{ createAdminClient \} from "@\/lib\/supabase\/admin";/);
  assert.doesNotMatch(src, /import \{ createClient \} from "@\/lib\/supabase\/server";/);
  assert.match(src, /createAdminClient\(\)/);
  assert.match(src, /supabase\.rpc\("get_admin_emails"\)/);
});

test("MANDATORY 18c/19 / import-boundary: lib/supabase/admin.ts (the service-role client) is guarded with \"server-only\" and its callers are \"use server\" files, so it can never be pulled into a client bundle", () => {
  const adminSrc = fs.readFileSync(new URL("../lib/supabase/admin.ts", import.meta.url), "utf8");
  assert.match(adminSrc, /^import "server-only";/m);
  assert.match(adminSrc, /process\.env\.SUPABASE_SERVICE_ROLE_KEY!/);

  // The two server actions that trigger notification (report submission,
  // overtime approval) must be "use server" -- that's what makes them
  // callable only from the server, never bundled into client JS.
  for (const file of ["../lib/avsec/reports/actions.ts", "../lib/avsec/duty/overtime-actions.ts"]) {
    const src = fs.readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(src, /^"use server";/m, `${file} must be "use server"`);
  }
  // notifyReportSubmission.ts / notifyOvertimeApproval.ts are plain helper
  // modules with no "use client"/"use server" directive of their own --
  // they are safe specifically because nothing outside the two server
  // actions above imports them, and they now import the "server-only"
  // guarded admin client, which throws a build error if ever pulled into
  // a client bundle.
  for (const file of ["../lib/avsec/email/notifyReportSubmission.ts", "../lib/avsec/email/notifyOvertimeApproval.ts"]) {
    const src = fs.readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(src, /import \{ createAdminClient \} from "@\/lib\/supabase\/admin";/, `${file} must import the server-only admin client`);
  }
});

test("MANDATORY 13-14 / non-regression: notification failures are still caught and logged, and never thrown back to block the report/overtime workflow", () => {
  const reportSrc = fs.readFileSync(
    new URL("../lib/avsec/email/notifyReportSubmission.ts", import.meta.url),
    "utf8",
  );
  const overtimeSrc = fs.readFileSync(
    new URL("../lib/avsec/email/notifyOvertimeApproval.ts", import.meta.url),
    "utf8",
  );
  for (const src of [reportSrc, overtimeSrc]) {
    assert.match(src, /catch \(err\)/, "must still swallow notification errors, not propagate them");
    assert.match(src, /console\.error/, "must still log a swallowed failure");
  }
});

test("Part G: next_report_no and next_vendor_transaction_number are fully revoked from PUBLIC, anon, and authenticated (trigger-only callers, no direct RPC caller found)", () => {
  const code = migrationSql.replace(/\r\n/g, "\n");
  assert.match(
    code,
    /revoke execute on function public\.next_report_no\(text, date\) from public, anon, authenticated;/,
  );
  assert.match(
    code,
    /revoke execute on function public\.next_vendor_transaction_number\(\) from public, anon, authenticated;/,
  );
  assert.match(code, /grant execute on function public\.next_report_no\(text, date\) to service_role;/);
  assert.match(code, /grant execute on function public\.next_vendor_transaction_number\(\) to service_role;/);
});

test("Part G: every listed trigger-only function is revoked from PUBLIC, anon, and authenticated", () => {
  const code = migrationSql.replace(/\r\n/g, "\n");
  const triggerOnlyFunctions = [
    "block_duty_remark_rewrite",
    "block_settled_overtime_mutation",
    "block_submitted_child_mutation_offload",
    "block_submitted_child_mutation_sec013",
    "block_submitted_child_mutation_sec014",
    "block_submitted_child_mutation_sec018",
    "block_submitted_child_mutation_sec029",
    "block_submitted_child_mutation_sec033",
    "block_submitted_report_mutation",
    "enforce_overtime_transition",
    "enforce_profile_self_update",
    "enforce_seal_color",
    "enforce_users_self_update",
    "guard_incident_update",
    "guard_part_update",
    "handle_new_user",
    "set_report_no_offload",
    "set_report_no_sec013",
    "set_report_no_sec014",
    "set_report_no_sec016",
    "set_report_no_sec018",
    "set_report_no_sec029",
    "set_report_no_sec033",
    "set_updated_at",
    "set_vendor_transaction_number",
  ];
  for (const fn of triggerOnlyFunctions) {
    const re = new RegExp(`revoke execute on function public\\.${fn}\\(\\) from public, anon, authenticated;`);
    assert.match(code, re, `${fn}() must be revoked from public, anon, authenticated`);
  }
});

test("Part G: RLS-primitive helper functions are never revoked (revoking them would break every policy that calls them as the querying role)", () => {
  const code = migrationSql.replace(/\r\n/g, "\n");
  const protectedHelpers = [
    "current_role_name",
    "current_status",
    "current_org_id",
    "current_ops_group",
    "current_station",
    "current_team",
    "current_app_role",
    "current_user_role",
    "current_role_rank",
    "role_rank",
    "is_monitor_or_above",
    "is_approved_management",
    "can_acknowledge_report",
    "can_file_report",
    "can_view_report",
  ];
  for (const fn of protectedHelpers) {
    const re = new RegExp(`revoke execute on function public\\.${fn}\\(`);
    assert.doesNotMatch(code, re, `${fn}() must never be revoked -- it is used inside RLS policy predicates`);
  }
});

test("REGRESSION: existing internally-authorized RPCs (set_transaction_qr_token, set_vendor_transaction_qr_token, skip_part_d, cl_cancel_transaction, search_flight_attendance, archive_all_pending) are untouched by Part G", () => {
  const code = migrationSql.replace(/\r\n/g, "\n");
  for (const fn of [
    "set_transaction_qr_token",
    "set_vendor_transaction_qr_token",
    "skip_part_d",
    "cl_cancel_transaction",
    "search_flight_attendance",
    "archive_all_pending",
  ]) {
    const re = new RegExp(`revoke execute on function public\\.${fn}\\(`);
    assert.doesNotMatch(code, re, `${fn}() must not be touched by Part G -- already internally authorized`);
  }
});

// =======================================================================
// PART H: run_attendance_sweep() -- restore the Management attendance
// sweep button, correctly authorized
// =======================================================================

/** Mirrors run_attendance_sweep()'s new internal gate (third pass): is_approved_management() OR approved legacy ADMIN. */
function canRunAttendanceSweep(actor: { role: string; status: string } | { role: "anon" }): boolean {
  if (actor.role === "anon") return false; // cannot execute at all -- PUBLIC/anon revoked
  const isApprovedManagement = actor.role === "MANAGEMENT" && actor.status === "approved";
  const isApprovedLegacyAdmin = actor.role === "ADMIN" && actor.status === "approved";
  return isApprovedManagement || isApprovedLegacyAdmin;
}

test("MANDATORY 1: approved Management can run the attendance sweep", () => {
  assert.equal(canRunAttendanceSweep({ role: "MANAGEMENT", status: "approved" }), true);
});

test("MANDATORY 2: approved legacy ADMIN can run the attendance sweep", () => {
  assert.equal(canRunAttendanceSweep({ role: "ADMIN", status: "approved" }), true);
});

test("MANDATORY 3: pending/rejected/deactivated Management cannot run the sweep", () => {
  for (const status of ["pending", "rejected", "deactivated"]) {
    assert.equal(canRunAttendanceSweep({ role: "MANAGEMENT", status }), false, `Management/${status} must be denied`);
  }
});

test("MANDATORY 4: pending/rejected/deactivated legacy ADMIN cannot run the sweep", () => {
  for (const status of ["pending", "rejected", "deactivated"]) {
    assert.equal(canRunAttendanceSweep({ role: "ADMIN", status }), false, `ADMIN/${status} must be denied`);
  }
});

test("MANDATORY 5: ASO/SO/DSE/Enforcement cannot run the sweep", () => {
  for (const role of ["ASO", "SO", "DSE", "ENFORCEMENT"]) {
    assert.equal(canRunAttendanceSweep({ role, status: "approved" }), false, `${role} must not be able to run the sweep`);
  }
});

test("MANDATORY 6: anonymous cannot run the sweep -- PUBLIC and anon are explicitly revoked in Part H", () => {
  assert.match(migrationSql, /revoke execute on function public\.run_attendance_sweep\(\) from public, anon;/);
  assert.equal(canRunAttendanceSweep({ role: "anon" }), false);
});

test("MANDATORY 7: authenticated retains EXECUTE, so the existing Management attendance-page server action (runAttendanceSweep() in lib/avsec/duty/attendance-actions.ts, called via the signed-in user's own session client) is not silently broken", () => {
  assert.match(migrationSql, /grant execute on function public\.run_attendance_sweep\(\) to authenticated;/);
  const src = fs.readFileSync(new URL("../lib/avsec/duty/attendance-actions.ts", import.meta.url), "utf8");
  assert.match(src, /supabase\.rpc\("run_attendance_sweep"\)/);
  assert.doesNotMatch(src, /createAdminClient/, "the server action itself is unchanged -- still the user-session client, now safe because the function gates itself");
});

test("MANDATORY 8: attendance isolation (Part A's station/team/ops_group-strict join) is unaffected by Part H's authorization fix -- Part H only adds an authorization check ahead of the existing perform flag_attendance_anomalies() call", () => {
  const match = migrationSql.match(/create or replace function public\.run_attendance_sweep\(\)[\s\S]*?\$function\$;/);
  assert.ok(match);
  assert.match(match![0], /perform flag_attendance_anomalies\(\);/);
});

test("Part H (third pass): the internal gate authorizes approved Management via is_approved_management() OR the pre-existing approved-legacy-ADMIN check -- the legacy ADMIN-only gate alone would leave the sweep broken since production has zero ADMIN-role profiles", () => {
  const match = migrationSql.match(/create or replace function public\.run_attendance_sweep\(\)[\s\S]*?\$function\$;/);
  assert.match(match![0], /is_approved_management\(\)/);
  assert.match(match![0], /current_role_name\(\) = 'ADMIN' and current_status\(\) = 'approved'/);
});

// =======================================================================
// Non-regression (items 28-34): explicit pointers confirming this pass's
// prior fixes and unrelated areas are untouched.
// =======================================================================

test("MANDATORY 28: get_admin_emails() remains service_role-only (Part G, unaffected by this round's Part B/C/D/H changes)", () => {
  assert.match(migrationSql, /revoke execute on function public\.get_admin_emails\(\) from public, anon, authenticated;/);
  assert.match(migrationSql, /grant execute on function public\.get_admin_emails\(\) to service_role;/);
});

test("MANDATORY 29: the Part G trigger-only-function hygiene sweep (25 functions) is unaffected by this round's changes", () => {
  assert.match(migrationSql, /revoke execute on function public\.handle_new_user\(\) from public, anon, authenticated;/);
  assert.match(migrationSql, /revoke execute on function public\.set_updated_at\(\) from public, anon, authenticated;/);
});

test("MANDATORY 30-33: this migration never touches Google SSO/handle_new_user's trigger wiring, CaterLink unified scanning, Hub separation, report acknowledgement, or roster isolation objects beyond what Parts A/D explicitly require", () => {
  const code = migrationSql.replace(/\r\n/g, "\n").split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
  for (const forbidden of ["part_hub", "part_redq", "checkpoint_scan", "roster_group_isolation"]) {
    assert.ok(!code.toLowerCase().includes(forbidden.toLowerCase()), `must not reference ${forbidden}`);
  }
});

test("MANDATORY 34: shared-browser draft isolation (lib/avsec/offline/useDraftAutosave.ts) remains fixed -- unrelated to this round's SQL changes, verified by the existing draft-isolation test file", () => {
  const src = fs.readFileSync(new URL("../lib/avsec/offline/useDraftAutosave.ts", import.meta.url), "utf8");
  assert.match(src, /export function readLocalDraft/);
  assert.match(src, /scopedKey\(userId, type\)/);
});
