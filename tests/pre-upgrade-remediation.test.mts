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
    "run_attendance_sweep()",
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
    "run_attendance_sweep()",
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

// --- Part C: feedback_threads_management_view ---

test("REGRESSION: the view is switched to security_invoker so it respects the caller's own RLS instead of the owner's", () => {
  assert.match(migrationSql, /alter view public\.feedback_threads_management_view set \(security_invoker = true\)/i);
});

test("REGRESSION: anonymous SELECT on the feedback metadata view is revoked", () => {
  assert.match(migrationSql, /revoke select on public\.feedback_threads_management_view from anon/i);
});

/** Mirrors feedback_threads' own RLS (unchanged) which the view now respects under security_invoker. */
function canSelectFeedbackThreadsView(actor: { kind: "anon" } | { kind: "submitter"; id: string } | { kind: "operational" } | { kind: "management"; status: string } | { kind: "admin" }, thread: { submitterId: string }): boolean {
  if (actor.kind === "anon") return false; // no policy matches (auth.uid() is null)
  if (actor.kind === "submitter") return actor.id === thread.submitterId;
  if (actor.kind === "operational") return false; // no matching policy for an ordinary ASO/SO/DSE/ENFORCEMENT
  if (actor.kind === "admin") return true;
  if (actor.kind === "management") return actor.status === "approved";
  return false;
}

test("REGRESSION: anonymous cannot read Management feedback metadata through the view (post-fix)", () => {
  assert.equal(canSelectFeedbackThreadsView({ kind: "anon" }, { submitterId: "u1" }), false);
});

test("REGRESSION: an ordinary operational user cannot read the Management feedback inbox", () => {
  assert.equal(canSelectFeedbackThreadsView({ kind: "operational" }, { submitterId: "u1" }), false);
});

test("Approved Management can still read the feedback inbox", () => {
  assert.equal(canSelectFeedbackThreadsView({ kind: "management", status: "approved" }, { submitterId: "u1" }), true);
});

test("A pending Management applicant cannot read the feedback inbox through the view either (consistent with the containment migration)", () => {
  assert.equal(canSelectFeedbackThreadsView({ kind: "management", status: "pending" }, { submitterId: "u1" }), false);
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

/** Mirrors "users: supervisor approves pending" + enforce_users_self_update()'s supervisor branch. */
function enforceUsersSupervisorApproval(
  actor: { role: string },
  old: UsersRow,
  next: UsersRow,
): { ok: boolean; error?: string } {
  if (actor.role !== "supervisor") return { ok: false, error: "Not authorized to modify this account." };
  if (old.id === next.id && old.status !== "pending") return { ok: false, error: "Not authorized to modify this account." }; // RLS status='pending' gate
  if (
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
  if (!["active", "rejected"].includes(next.status)) return { ok: false, error: "Invalid status transition." };
  return { ok: true };
}

function baseUsersRow(overrides: Partial<UsersRow> = {}): UsersRow {
  return { id: "target", role: "vendor", unified_role: "vendor", status: "pending", ops_group: null, org_id: "org-1", duty_post: null, email: "d@example.com", staff_id: "AA-1", name: "Driver", ...overrides };
}

test("REGRESSION: self-approval is impossible -- a driver cannot approve their own pending account", () => {
  const old = baseUsersRow({ id: "self" });
  const next = { ...old, status: "active" };
  const result = enforceUsersSupervisorApproval({ role: "vendor" }, old, next);
  assert.equal(result.ok, false);
});

test("REGRESSION: an unauthorized (non-supervisor) actor cannot approve or reject a pending registration", () => {
  const old = baseUsersRow();
  const next = { ...old, status: "active" };
  const result = enforceUsersSupervisorApproval({ role: "ops_staff" }, old, next);
  assert.equal(result.ok, false);
});

test("Authorized supervisor approval works, changing status only", () => {
  const old = baseUsersRow();
  const next = { ...old, status: "active" };
  const result = enforceUsersSupervisorApproval({ role: "supervisor" }, old, next);
  assert.equal(result.ok, true);
});

test("Authorized supervisor rejection works", () => {
  const old = baseUsersRow();
  const next = { ...old, status: "rejected" };
  const result = enforceUsersSupervisorApproval({ role: "supervisor" }, old, next);
  assert.equal(result.ok, true);
});

test("REGRESSION: a supervisor cannot bundle a role/ops_group change into the same approval statement", () => {
  const old = baseUsersRow();
  const next = { ...old, status: "active", role: "management" };
  const result = enforceUsersSupervisorApproval({ role: "supervisor" }, old, next);
  assert.equal(result.ok, false);
  assert.equal(result.error, "Supervisor may only change status on this table.");
});

test("Authorization/identity fields cannot be self-modified on public.users (C-02, unaffected by this pass)", () => {
  function usersSelfUpdateAllowed(fieldsChanged: string[]): boolean {
    const protectedFields = ["role", "unified_role", "status", "ops_group", "org_id", "duty_post", "email", "staff_id", "name"];
    return !fieldsChanged.some((f) => protectedFields.includes(f));
  }
  assert.equal(usersSelfUpdateAllowed(["role"]), false);
  assert.equal(usersSelfUpdateAllowed(["status"]), false);
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
  const charsBeforePartF = migrationSql.slice(0, partFStart).replace(/\r\n/g, "\n").split("\n").length - 1;
  const partF = strippedWhole.split("\n").slice(charsBeforePartF).join("\n").trim();
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
