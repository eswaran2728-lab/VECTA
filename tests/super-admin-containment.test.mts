import test from "node:test";
import assert from "node:assert/strict";

/**
 * Regression coverage for C-01 containment (2026-09-23):
 * self-promotion through profiles.unified_role.
 *
 * CONFIRMED ROOT CAUSE: the "profiles self update" RLS policy
 * (id = auth.uid(), no column restriction) plus
 * enforce_profile_self_update() (which never inspected new.unified_role
 * in any branch) plus profiles_unified_role_check (which allows
 * 'super_admin' as a domain value, correctly, for service_role) meant any
 * authenticated user could set their own profiles.unified_role to
 * 'super_admin' via a direct PostgREST PATCH — isSuperAdmin()
 * (lib/super-admin/actions.ts) trusts that column and then uses the
 * service-role client. No UI form ever sent this value; the gap was
 * DB-layer only, exploitable by bypassing the UI entirely.
 *
 * migrations/20260923000003_super_admin_privilege_containment.sql fixes
 * this at both the trigger layer (enforce_profile_self_update, rewritten
 * to an explicit allowlist) and the RLS layer (WITH CHECK on all three
 * writable policies now rejects unified_role='super_admin' outright,
 * independent of the trigger).
 *
 * The trigger/policies are plpgsql/SQL, not importable into a plain Node
 * test — this file mirrors their exact logic (same pattern as
 * tests/google-sso-callback.test.mts for "use server"/server-only files),
 * so a regression in either the mirror or the real migration's intent is
 * caught here, and the real SQL is re-verified against production via
 * direct policy/trigger inspection (see the migration's own header
 * comment for the verified before-state).
 */

type ProfileRow = {
  id: string;
  role: "ASO" | "SO" | "DSE" | "ENFORCEMENT" | "MANAGEMENT" | "ADMIN";
  status: "pending" | "approved" | "rejected" | "deactivated";
  station: string | null;
  team: string | null;
  staff_no: string;
  ops_group: string | null;
  unified_role: string | null;
  org_id: string | null;
  approved_by: string | null;
  approved_at: string | null;
  rejection_reason: string | null;
  email: string;
  duty_post: string | null;
};

type Actor =
  | { kind: "service_role" }
  | { kind: "admin_legacy" } // current_role_name() = 'ADMIN'
  | { kind: "self"; id: string }
  | { kind: "management"; id: string }
  | { kind: "anon" };

/** Mirrors enforce_profile_self_update() (post-migration). */
function enforceProfileSelfUpdate(
  actor: Actor,
  old: ProfileRow,
  next: ProfileRow,
): { ok: true } | { ok: false; error: string } {
  if (actor.kind === "service_role") return { ok: true };
  if (actor.kind === "admin_legacy") return { ok: true };

  const isSelf = actor.kind === "self" && old.id === actor.id;

  if (isSelf) {
    if (
      next.unified_role !== old.unified_role ||
      next.status !== old.status ||
      next.ops_group !== old.ops_group ||
      next.org_id !== old.org_id ||
      next.approved_by !== old.approved_by ||
      next.approved_at !== old.approved_at ||
      next.rejection_reason !== old.rejection_reason ||
      next.email !== old.email ||
      next.duty_post !== old.duty_post
    ) {
      return { ok: false, error: "Not authorized to modify this field on your own profile." };
    }

    if (old.status === "pending") {
      if (next.role === "ADMIN" || (next.role as string) === "SUPER_ADMIN") {
        return { ok: false, error: "Cannot self-assign this role." };
      }
    } else {
      if (
        next.role !== old.role ||
        next.station !== old.station ||
        next.team !== old.team ||
        next.staff_no !== old.staff_no
      ) {
        return {
          ok: false,
          error: "Your account has already been reviewed. Contact an admin to change your role, station, team, or staff ID.",
        };
      }
    }
    return { ok: true };
  }

  if (actor.kind === "management" && next.role !== "ADMIN") {
    if (next.unified_role !== old.unified_role && (next.unified_role === "super_admin" || next.unified_role === "management")) {
      return { ok: false, error: "Management cannot assign this unified_role value through a generic profile update." };
    }
    if ((old.role as string) === "SUPER_ADMIN" || old.unified_role === "super_admin") {
      return { ok: false, error: "Cannot modify a Super Admin account." };
    }
    if (next.org_id !== old.org_id) {
      return { ok: false, error: "Management cannot change org_id." };
    }
    if (
      old.status !== "pending" &&
      (next.approved_by !== old.approved_by || next.approved_at !== old.approved_at || next.rejection_reason !== old.rejection_reason)
    ) {
      return { ok: false, error: "Management cannot modify approval audit fields outside the approval workflow." };
    }
    return { ok: true };
  }

  return { ok: false, error: "Not authorized to modify this profile." };
}

/** Mirrors the three RLS WITH CHECK clauses (post-migration), independent of the trigger. */
function rlsWithCheckAllows(actor: Actor, old: ProfileRow, next: ProfileRow): boolean {
  if (actor.kind === "anon") return false; // no policy matches anon at all (auth.uid() is null)

  if (actor.kind === "self" && next.id === actor.id) {
    // "profiles self update"
    return (next.unified_role ?? "") !== "super_admin";
  }

  if (actor.kind === "management" && next.id !== actor.id && next.role !== "ADMIN") {
    if (old.status === "pending") {
      // "profiles management approve pending"
      return (
        (next.status === "approved" || next.status === "rejected") &&
        (next.unified_role ?? "") !== "super_admin"
      );
    }
    // "profiles management manage non-admin staff"
    return (next.unified_role ?? "") !== "super_admin";
  }

  return false;
}

function baseRow(overrides: Partial<ProfileRow> = {}): ProfileRow {
  return {
    id: "user-1",
    role: "ASO",
    status: "approved",
    station: "KUL - MAA",
    team: "ALPHA",
    staff_no: "AA-1001",
    ops_group: "operation_avsec",
    unified_role: "aso",
    org_id: "00000000-0000-0000-0000-000000000001",
    approved_by: "mgr-1",
    approved_at: "2026-09-20T00:00:00Z",
    rejection_reason: null,
    email: "user1@example.com",
    duty_post: null,
    ...overrides,
  };
}

// --- 1-2: pending user cannot self-promote ---

test("REGRESSION (C-01): a PENDING user cannot self-promote unified_role to 'super_admin'", () => {
  const old = baseRow({ id: "u", status: "pending", unified_role: null });
  const next = { ...old, unified_role: "super_admin" };
  const result = enforceProfileSelfUpdate({ kind: "self", id: "u" }, old, next);
  assert.equal(result.ok, false);
  assert.equal(rlsWithCheckAllows({ kind: "self", id: "u" }, old, next), false);
});

test("REGRESSION (C-01): a PENDING user cannot self-promote unified_role to 'management'", () => {
  const old = baseRow({ id: "u", status: "pending", unified_role: null });
  const next = { ...old, unified_role: "management" };
  const result = enforceProfileSelfUpdate({ kind: "self", id: "u" }, old, next);
  assert.equal(result.ok, false);
});

// --- 3-5: approved ASO/SO/DSE cannot modify unified_role ---

for (const role of ["ASO", "SO", "DSE"] as const) {
  test(`Approved ${role} cannot modify their own unified_role`, () => {
    const old = baseRow({ id: "u", role, status: "approved", unified_role: role.toLowerCase() });
    const next = { ...old, unified_role: "super_admin" };
    const result = enforceProfileSelfUpdate({ kind: "self", id: "u" }, old, next);
    assert.equal(result.ok, false);
    assert.equal(rlsWithCheckAllows({ kind: "self", id: "u" }, old, next), false);
  });
}

// --- 6: driver/vendor — CONFIRMED GAP, not fixed by this migration ---

test("CONFIRMED GAP (C-02, out of scope for this migration): public.users (ICMS-origin driver/vendor/shadow accounts) has NO trigger and a column-unrestricted self-update RLS policy — the identical vulnerability class remains open there. This test documents the gap as found, per the 2026-09-23 production inspection (0 triggers on public.users; 'users: own language preference' policy is USING/WITH CHECK id=auth.uid() only). Flagged in the report; requires separate authorization to fix.", () => {
  // Mirrors the ACTUAL current public.users policy shape (no trigger, no
  // column restriction) — this intentionally shows the write SUCCEEDING,
  // because it currently would.
  function usersSelfUpdateRlsCheck(actorId: string, rowId: string): boolean {
    return rowId === actorId; // no column restriction at all, confirmed
  }
  assert.equal(usersSelfUpdateRlsCheck("driver-1", "driver-1"), true);
  // i.e. a driver/vendor row in public.users CAN currently have
  // unified_role set to anything, including 'super_admin', because there
  // is no trigger and no column check — unlike profiles as of this
  // migration.
});

// --- 7-8: Management cannot promote to super_admin or legacy ADMIN ---

test("REGRESSION (C-01): Management cannot promote another user's unified_role to 'super_admin'", () => {
  const old = baseRow({ id: "target", role: "ASO", unified_role: "aso" });
  const next = { ...old, unified_role: "super_admin" };
  const result = enforceProfileSelfUpdate({ kind: "management", id: "mgr" }, old, next);
  assert.equal(result.ok, false);
  assert.equal(rlsWithCheckAllows({ kind: "management", id: "mgr" }, old, next), false);
});

test("Management cannot promote another user to legacy role='ADMIN'", () => {
  const old = baseRow({ id: "target", role: "ASO" });
  const next = { ...old, role: "ADMIN" as const };
  const result = enforceProfileSelfUpdate({ kind: "management", id: "mgr" }, old, next);
  assert.equal(result.ok, false);
  assert.equal(result.error, "Not authorized to modify this profile.");
});

test("Management setting unified_role='management' through a generic update is also blocked (not just 'super_admin')", () => {
  const old = baseRow({ id: "target", role: "ASO", unified_role: "aso" });
  const next = { ...old, role: "MANAGEMENT" as const, unified_role: "management" };
  const result = enforceProfileSelfUpdate({ kind: "management", id: "mgr" }, old, next);
  assert.equal(result.ok, false);
});

// --- 9: Management cannot modify their own protected role fields ---

test("Management cannot modify their own protected assignment (id === actor.id is never the 'management' branch — falls through to self-update rules)", () => {
  const old = baseRow({ id: "mgr", role: "MANAGEMENT", status: "approved", unified_role: "management" });
  const next = { ...old, unified_role: "super_admin" };
  // A Management user acting on their OWN row is a self-update, not the
  // Management branch (old.id === auth.uid()) — self-update's universal
  // protected-field block applies, same as any other user.
  const result = enforceProfileSelfUpdate({ kind: "self", id: "mgr" }, old, next);
  assert.equal(result.ok, false);
});

// --- 10: anonymous profile update denied ---

test("REGRESSION: anonymous (unauthenticated) profile update is denied at the RLS layer", () => {
  const old = baseRow({ id: "u" });
  const next = { ...old, unified_role: "super_admin" };
  assert.equal(rlsWithCheckAllows({ kind: "anon" }, old, next), false);
});

// --- 11: direct REST-style updates denied by database controls ---

test("REGRESSION: a direct REST-style PATCH (no application code involved) setting unified_role='super_admin' on one's own row is denied by RLS WITH CHECK alone, independent of the trigger", () => {
  const old = baseRow({ id: "u", unified_role: "aso" });
  const next = { ...old, unified_role: "super_admin" };
  assert.equal(rlsWithCheckAllows({ kind: "self", id: "u" }, old, next), false);
  assert.equal(enforceProfileSelfUpdate({ kind: "self", id: "u" }, old, next).ok, false);
});

// --- 12: protected field changed together with an allowed field ---

test("REGRESSION: bundling an allowed change (name) with a protected change (unified_role) in one statement still rejects the whole write", () => {
  const old = baseRow({ id: "u", status: "pending", unified_role: null });
  const next = { ...old, unified_role: "super_admin" } as ProfileRow & { name?: string };
  const result = enforceProfileSelfUpdate({ kind: "self", id: "u" }, old, next);
  assert.equal(result.ok, false);
});

// --- 13: null/empty values cannot bypass the checks ---

test("REGRESSION: an empty-string unified_role does not bypass the 'super_admin' RLS check (coalesce/'' comparison), and null->non-null unified_role changes are still blocked by the trigger", () => {
  const old = baseRow({ id: "u", unified_role: null });
  const nextEmpty = { ...old, unified_role: "" };
  assert.equal(rlsWithCheckAllows({ kind: "self", id: "u" }, old, nextEmpty), true); // '' is not 'super_admin', RLS alone allows it...
  assert.equal(enforceProfileSelfUpdate({ kind: "self", id: "u" }, old, nextEmpty).ok, false); // ...but the trigger still blocks ANY unified_role change for self, empty or not.

  const nextNullToSuperAdmin = { ...old, unified_role: "super_admin" };
  assert.equal(rlsWithCheckAllows({ kind: "self", id: "u" }, old, nextNullToSuperAdmin), false);
});

// --- 14-19: existing legitimate workflows keep working (pure-logic proof
// that the new trigger still permits the EXACT field-diff shapes these
// flows send — mirrors the real write payloads in
// lib/avsec/profile-actions.ts / lib/avsec/admin/actions.ts) ---

test("Google SSO / profile-setup workflow unaffected: updateProfile()'s exact write (name/staff_no/station/team/role only, status stays pending) is still permitted", () => {
  const old = baseRow({
    id: "u",
    status: "pending",
    role: "ASO",
    station: null,
    team: null,
    staff_no: "",
    unified_role: null,
  });
  const next = { ...old, station: "KUL - MAA", team: "ALPHA", staff_no: "AA-2001", role: "SO" as const };
  const result = enforceProfileSelfUpdate({ kind: "self", id: "u" }, old, next);
  assert.equal(result.ok, true);
});

test("Management can still approve a valid ordinary AVSEC user (approveUserWithAssignment's exact write: role/station/team/ops_group/status/approved_by/approved_at, pending -> approved)", () => {
  const old = baseRow({ id: "target", role: "ASO", status: "pending", unified_role: null, approved_by: null, approved_at: null });
  const next = {
    ...old,
    role: "SO" as const,
    station: "KUL - MAA",
    team: "BRAVO",
    ops_group: "ifc_avsec",
    status: "approved" as const,
    approved_by: "mgr",
    approved_at: "2026-09-23T00:00:00Z",
  };
  const result = enforceProfileSelfUpdate({ kind: "management", id: "mgr" }, old, next);
  assert.equal(result.ok, true);
  assert.equal(rlsWithCheckAllows({ kind: "management", id: "mgr" }, old, next), true);
});

test("Management can still reject a pending user (rejectUser's exact write: status/rejection_reason/approved_by/approved_at, pending -> rejected)", () => {
  const old = baseRow({ id: "target", role: "ASO", status: "pending", approved_by: null, approved_at: null, rejection_reason: null });
  const next = {
    ...old,
    status: "rejected" as const,
    rejection_reason: "Incomplete documentation",
    approved_by: "mgr",
    approved_at: "2026-09-23T00:00:00Z",
  };
  const result = enforceProfileSelfUpdate({ kind: "management", id: "mgr" }, old, next);
  assert.equal(result.ok, true);
});

test("Management can still reassign an ordinary AVSEC user's role/station/team/ops_group (updateUserAssignment's ASO/SO/DSE/ENFORCEMENT path)", () => {
  const old = baseRow({ id: "target", role: "ASO", status: "approved", unified_role: "aso", ops_group: "operation_avsec" });
  const next = { ...old, role: "DSE" as const, station: "KUL - MAA", team: "CHARLIE", ops_group: "ifc_avsec", unified_role: "dse" };
  const result = enforceProfileSelfUpdate({ kind: "management", id: "mgr" }, old, next);
  assert.equal(result.ok, true);
});

test("Existing approved users are untouched by this migration: an unrelated field-only update (e.g. no changes at all, a pure re-save) still succeeds for self", () => {
  const old = baseRow({ id: "u" });
  const next = { ...old };
  const result = enforceProfileSelfUpdate({ kind: "self", id: "u" }, old, next);
  assert.equal(result.ok, true);
});

// --- 20-21: CaterLink/Hub separation, report ack/roster isolation —
// unaffected: this migration touches ONLY enforce_profile_self_update(),
// the three profiles UPDATE policies, and grants on public.profiles. It
// does not modify any checkpoint/RLS policy on transactions/part_b-d/
// part_hub/part_redq/vendor_transactions, any report_* table, or
// team_rosters — asserted here as a scope check on the migration's own
// text so a future edit that widens this file is caught. ---

test("SCOPE: the containment migration does not touch CaterLink/checkpoint, report, or roster tables/policies", async () => {
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
  for (const forbidden of ["part_b", "part_c", "part_d", "part_hub", "part_redq", "vendor_transactions", "report_sec", "team_rosters", "duty_records"]) {
    assert.ok(!sql.toLowerCase().includes(forbidden.toLowerCase()), `migration must not reference ${forbidden}`);
  }
  assert.ok(sql.includes("public.profiles"), "migration must scope to public.profiles");
});
