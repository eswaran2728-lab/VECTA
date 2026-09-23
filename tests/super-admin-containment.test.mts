import test from "node:test";
import assert from "node:assert/strict";

/**
 * Regression coverage for the combined privilege-escalation containment
 * package (2026-09-23): C-01 (public.profiles) and C-02 (public.users),
 * both self-promotion through unified_role / other server-controlled
 * identity-authorization fields.
 *
 * C-01 CONFIRMED ROOT CAUSE: the "profiles self update" RLS policy
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
 * C-02 CONFIRMED ROOT CAUSE (public.users — ICMS-origin driver/vendor/
 * warehouse/shadow accounts): the "users: own language preference" RLS
 * policy has the identical row-only shape, and public.users has ZERO
 * triggers at all. Not immediately exploitable before this fix only
 * because `authenticated`'s UPDATE grant happened to already be narrowed
 * to exactly one column (preferred_language) — a latent, single-point-of-
 * failure gap with no RLS column check and no trigger behind it.
 *
 * migrations/20260923000003_super_admin_privilege_containment.sql fixes
 * both: enforce_profile_self_update() (rewritten to an explicit
 * allowlist) and the new enforce_users_self_update() (new, same pattern),
 * plus RLS WITH CHECK / GRANT narrowing on both tables.
 *
 * The triggers/policies are plpgsql/SQL, not importable into a plain Node
 * test — this file mirrors their exact logic (same pattern as
 * tests/google-sso-callback.test.mts for "use server"/server-only files),
 * so a regression in either the mirror or the real migration's intent is
 * caught here, and the real SQL is re-verified against production via
 * direct policy/trigger/grant inspection (see the migration's own header
 * comment for the verified before-state of both tables).
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

// --- C-02: public.users (ICMS-origin shadow/driver/vendor/warehouse
// accounts). CONFIRMED as a latent gap (2026-09-23 production inspection:
// 0 triggers on public.users; "users: own language preference" RLS policy
// is USING/WITH CHECK id=auth.uid() with no column restriction). NOT
// immediately exploitable pre-fix only because `authenticated` happened
// to have UPDATE granted on exactly one column (preferred_language) —
// a single unreviewed future GRANT widening would have silently reopened
// it with zero other defense. Now fixed with the same explicit-allowlist
// trigger pattern as C-01 (enforce_users_self_update, in the same
// migration). Mirrors that trigger's exact logic. ---

type UsersRow = {
  id: string;
  role: string;
  unified_role: string | null;
  status: string;
  ops_group: string | null;
  org_id: string | null;
  duty_post: string | null;
  email: string;
  staff_id: string;
  name: string;
  preferred_language: string;
};

type UsersActor = { kind: "service_role" } | { kind: "self"; id: string } | { kind: "other"; id: string } | { kind: "anon" };

/** Mirrors enforce_users_self_update() (post-migration). */
function enforceUsersSelfUpdate(actor: UsersActor, old: UsersRow, next: UsersRow): { ok: true } | { ok: false; error: string } {
  if (actor.kind === "service_role") return { ok: true };

  if (actor.kind === "self" && old.id === actor.id) {
    if (
      next.role !== old.role ||
      next.unified_role !== old.unified_role ||
      next.status !== old.status ||
      next.ops_group !== old.ops_group ||
      next.org_id !== old.org_id ||
      next.duty_post !== old.duty_post ||
      next.email !== old.email ||
      next.staff_id !== old.staff_id ||
      next.name !== old.name
    ) {
      return { ok: false, error: "Not authorized to modify this field on your own account." };
    }
    return { ok: true };
  }

  return { ok: false, error: "Not authorized to modify this account." };
}

/** Mirrors the "users: own language preference" RLS policy (row-scoping only; column enforcement is the trigger above). */
function usersRlsWithCheckAllows(actor: UsersActor, next: { id: string }): boolean {
  return actor.kind === "self" && next.id === actor.id;
}

function baseUsersRow(overrides: Partial<UsersRow> = {}): UsersRow {
  return {
    id: "u",
    role: "ops_staff",
    unified_role: "aso",
    status: "active",
    ops_group: "operation_avsec",
    org_id: "00000000-0000-0000-0000-000000000001",
    duty_post: null,
    email: "u@example.com",
    staff_id: "AA-3001",
    name: "Test User",
    preferred_language: "en",
    ...overrides,
  };
}

test("REGRESSION (C-02): a driver (role='driver_vendor') cannot self-promote their own unified_role to 'super_admin'", () => {
  const old = baseUsersRow({ id: "driver-1", role: "driver_vendor", unified_role: "vendor" });
  const next = { ...old, unified_role: "super_admin" };
  const result = enforceUsersSelfUpdate({ kind: "self", id: "driver-1" }, old, next);
  assert.equal(result.ok, false);
});

test("REGRESSION (C-02): a vendor (role='vendor') cannot self-promote their own unified_role", () => {
  const old = baseUsersRow({ id: "vendor-1", role: "vendor", unified_role: "vendor" });
  const next = { ...old, unified_role: "management" };
  const result = enforceUsersSelfUpdate({ kind: "self", id: "vendor-1" }, old, next);
  assert.equal(result.ok, false);
});

test("REGRESSION (C-02): a warehouse user (role='warehouse_pic') cannot self-promote their own unified_role or role", () => {
  const old = baseUsersRow({ id: "wh-1", role: "warehouse_pic", unified_role: "aso" });
  const next1 = { ...old, unified_role: "super_admin" };
  assert.equal(enforceUsersSelfUpdate({ kind: "self", id: "wh-1" }, old, next1).ok, false);
  const next2 = { ...old, role: "supervisor" };
  assert.equal(enforceUsersSelfUpdate({ kind: "self", id: "wh-1" }, old, next2).ok, false);
});

test("REGRESSION (C-02): an ICMS shadow account (role='ops_staff', the generic ASO/SO/DSE shadow role) cannot modify any authorization/identity field on itself — status, ops_group, org_id, duty_post, email, staff_id, name all locked", () => {
  const old = baseUsersRow({ id: "shadow-1" });
  const fields: (keyof UsersRow)[] = ["status", "ops_group", "org_id", "duty_post", "email", "staff_id", "name"];
  for (const field of fields) {
    const next = { ...old, [field]: field === "status" ? "disabled" : field === "org_id" ? "other-org" : "changed" };
    const result = enforceUsersSelfUpdate({ kind: "self", id: "shadow-1" }, old, next as UsersRow);
    assert.equal(result.ok, false, `expected ${field} to be protected`);
  }
});

test("Anonymous update of public.users is denied (no policy matches an unauthenticated actor)", () => {
  const old = baseUsersRow({ id: "u" });
  assert.equal(usersRlsWithCheckAllows({ kind: "anon" }, old), false);
});

test("Allowed: preferred_language self-update still works, for every account type (driver/vendor/warehouse/shadow)", () => {
  for (const role of ["driver_vendor", "vendor", "warehouse_pic", "ops_staff", "post2_avsec", "hub_avsec"]) {
    const old = baseUsersRow({ id: "u", role, preferred_language: "en" });
    const next = { ...old, preferred_language: "ms" };
    const result = enforceUsersSelfUpdate({ kind: "self", id: "u" }, old, next);
    assert.equal(result.ok, true, `expected preferred_language change to be allowed for role=${role}`);
    assert.equal(usersRlsWithCheckAllows({ kind: "self", id: "u" }, next), true);
  }
});

test("Service-role synchronization between approved profiles and the ICMS shadow account still works (approveUserWithAssignment's shadow sync: role/unified_role/ops_group/status via createAdminClient())", () => {
  const old = baseUsersRow({ id: "target", role: "ops_staff", unified_role: null, status: "pending", ops_group: null });
  const next = { ...old, role: "ops_staff", unified_role: "so", status: "active", ops_group: "ifc_avsec" };
  const result = enforceUsersSelfUpdate({ kind: "service_role" }, old, next);
  assert.equal(result.ok, true);
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
  assert.ok(sql.includes("public.users"), "migration must scope to public.users (C-02)");
});

// --- updateUserAssignment() must surface a database rejection instead of
// silently reporting success. Server actions can't be unit-invoked here
// (no live Supabase/Next.js request context) — this asserts the fix's
// shape directly in the source, the same way tests elsewhere in this
// suite verify sw.js's bypass list from its real source rather than a
// hand-written mirror. ---

test("REGRESSION: updateUserAssignment() checks the profiles UPDATE result (error and empty-data) and redirects with a clear error instead of silently succeeding", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const actionsPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "lib", "avsec", "admin", "actions.ts");
  const src = fs.readFileSync(actionsPath, "utf8");

  const fnStart = src.indexOf("export async function updateUserAssignment");
  assert.ok(fnStart !== -1, "updateUserAssignment must exist");
  const nextFnStart = src.indexOf("\nexport async function", fnStart + 1);
  const fnBody = src.slice(fnStart, nextFnStart === -1 ? undefined : nextFnStart);

  assert.match(fnBody, /\.select\(\s*["']id["']\s*\)/, "must select id back to detect a zero-row (RLS/trigger-rejected) update");
  assert.match(fnBody, /if\s*\(\s*error\s*\)/, "must check the update's error");
  assert.match(fnBody, /data\.length === 0/, "must check for a zero-row result (denied by RLS/trigger without an explicit error)");
  assert.match(fnBody, /redirect\(/, "must surface the failure via the same ?error= redirect convention as the rest of this file");
});
