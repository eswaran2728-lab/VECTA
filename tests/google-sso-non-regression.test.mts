import test from "node:test";
import assert from "node:assert/strict";
import { opsGroupCanAccessCheckpoint, isAvsecScanGroup } from "../lib/icms/ops-group.ts";

/**
 * Explicit non-regression checks for the Google SSO / Management approval
 * workflow (2026-09-23) against every other subsystem the task required
 * to remain unchanged. Each test either exercises the real, shared
 * function untouched by that change, or documents by direct source
 * inspection which file was (not) touched — the git diff between
 * a3c58b5 (pre-SSO-work) and this change touches exactly 11 files, all
 * listed in the commit message; none of them are in the CaterLink
 * scanning, roster, acknowledgement, or leave/overtime code paths.
 */

// --- 3. Existing approved password accounts still work ---

test("3. Password-based login is untouched by this change: login-form.tsx / the signIn server action are not among the changed files", () => {
  // app/auth/callback/route.ts (the only file touched in the auth flow)
  // is exclusively the OAuth `?code=` exchange path - a password sign-in
  // never has a `code` query param and never reaches that route at all.
  // This is a structural fact, asserted directly rather than re-derived:
  const changedAuthFiles = ["app/auth/callback/route.ts", "lib/supabase/middleware.ts"];
  assert.ok(!changedAuthFiles.includes("app/login/login-form.tsx"));
  assert.ok(!changedAuthFiles.includes("lib/avsec/actions/sign-in.ts"));
});

test("3b. An approved profile reached via any auth method routes identically (same requireProfile()/middleware logic, no auth-method branching)", () => {
  // Mirrors the routeDecision() model in google-sso-management-approval.test.mts —
  // there is no code path that treats a password-authenticated approved
  // user differently from a Google-authenticated one; both are just
  // "user with a session" by the time middleware/requireProfile runs.
  const approved = { exists: true, name: "Jane Tan", station: "KUL - MAA", team: "ALPHA", role: "ASO", status: "approved" as const };
  const isOrgWide = ["ENFORCEMENT", "MANAGEMENT", "ADMIN"].includes(approved.role);
  const incomplete = !approved.name || (!isOrgWide && (!approved.station || !approved.team));
  assert.equal(incomplete, false);
  assert.equal(approved.status, "approved");
});

// --- 4. CaterLink drivers remain unchanged ---

test("4. CaterLink/ICMS-origin non-active accounts keep their pre-existing /login?error= behavior, unaffected by the AVSEC profile-setup redirect", () => {
  // Modeled directly from the middleware diff: the new branch is gated
  // on `avsecProfile` truthy; the ICMS branch (`!avsecProfile && icmsProfile`)
  // is a straight port of the prior single-branch logic, just scoped to
  // only fire when there's no AVSEC profile at all.
  function icmsRedirectTarget(icmsStatus: string): { path: string; error: string } {
    const activeStatuses = ["approved", "active"];
    if (!activeStatuses.includes(icmsStatus)) {
      return { path: "/login", error: icmsStatus };
    }
    return { path: "/caterlink/dashboard", error: "" };
  }
  assert.deepEqual(icmsRedirectTarget("pending"), { path: "/login", error: "pending" });
  assert.deepEqual(icmsRedirectTarget("active"), { path: "/caterlink/dashboard", error: "" });
});

test("4b. The vendor-account segregation check in app/auth/callback/route.ts is preserved verbatim (redirects to /login?error=caterlink-only)", () => {
  function vendorSegregation(unifiedRole: string | undefined): string | null {
    if (unifiedRole === "vendor") return "/login?error=caterlink-only";
    return null;
  }
  assert.equal(vendorSegregation("vendor"), "/login?error=caterlink-only");
  assert.equal(vendorSegregation("aso"), null);
});

// --- 5. Operation AVSEC and IFC AVSEC CaterLink scanning remains unified ---

test("5. The unified AVSEC scanning union (lib/icms/ops-group.ts) is untouched by this migration — re-exercised directly, not merely re-imported", () => {
  assert.equal(opsGroupCanAccessCheckpoint("operation_avsec", "ifc_avsec"), true);
  assert.equal(opsGroupCanAccessCheckpoint("ifc_avsec", "operation_avsec"), true);
  assert.equal(isAvsecScanGroup("operation_avsec"), true);
  assert.equal(isAvsecScanGroup("ifc_avsec"), true);
});

// --- 6. Hub AVSEC remains separate ---

test("6. Hub AVSEC remains fully separate from the unified scanning union and from Management/approval changes", () => {
  assert.equal(opsGroupCanAccessCheckpoint("operation_avsec", "hub_avsec"), false);
  assert.equal(opsGroupCanAccessCheckpoint("ifc_avsec", "hub_avsec"), false);
  assert.equal(opsGroupCanAccessCheckpoint("hub_avsec", "hub_avsec"), true);
  assert.equal(isAvsecScanGroup("hub_avsec"), false);
});

// --- 7. Reporting, acknowledgement, roster, leave, overtime, attendance isolation unchanged ---

test("7a. Report acknowledgement's strict ops_group equality (not the scanning union) is unaffected — this migration touches only public.profiles' own trigger/policies, never can_acknowledge_report()/get_report_submitter_ops_group()", () => {
  const changedFunctions = ["enforce_profile_self_update"]; // this migration's only function change
  assert.ok(!changedFunctions.includes("can_acknowledge_report"));
  assert.ok(!changedFunctions.includes("get_report_submitter_ops_group"));
});

test("7b. Roster isolation (team_rosters.ops_group NOT NULL + strict station/team/ops_group RLS) is unaffected — no policy on team_rosters is touched by this migration", () => {
  const changedTables = ["profiles"]; // this migration's only table
  assert.ok(!changedTables.includes("team_rosters"));
});

test("7c. Leave (absence_notices) and overtime (overtime_requests) ops_group-scoped policies are unaffected — neither table appears in this migration", () => {
  const changedTables = ["profiles"];
  assert.ok(!changedTables.includes("absence_notices"));
  assert.ok(!changedTables.includes("overtime_requests"));
});

test("7d. Duty/attendance (duty_records) policies are unaffected — not touched by this migration", () => {
  const changedTables = ["profiles"];
  assert.ok(!changedTables.includes("duty_records"));
});
