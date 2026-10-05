import test, { mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  COMPAT_ROLE_BY_CANONICAL, deriveCanonicalAccess, accessSatisfiesRoles, assignmentsFromRpcRows, deriveOperatorScope,
  isOrgWideOperator, NO_CANONICAL_ACCESS,
} from "../lib/auth/canonical-access.ts";
import { effectiveGateRole, isShiftBasedAccess, isExternalCaterLinkRole, isAdminPathForbidden, isSuperAdminPathForbidden } from "../lib/supabase/middleware-gate-logic.ts";
import { ALL_ROLE_CODES } from "../scripts/staging/lib/role-matrix.mjs";
import { routeAllows, canonicalCodesForRoute } from "../lib/auth/route-access.ts";
import { LINK_HUB_CONFIG } from "../lib/dashboard/linkHubConfig.ts";

const REPO = path.resolve(import.meta.dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");

const asg = (roleCode: string, extra: Record<string, unknown> = {}) => ({
  role_code: roleCode, role_category: "x", aoc_code: null, operating_entity_code: null, department_code: null, unit_code: null,
  hub_code: null, station_code: null, team_name: null, starts_at: "2026-01-01T00:00:00Z", ends_at: null, ...extra,
});
const accessFor = (...codes: string[]) => deriveCanonicalAccess(assignmentsFromRpcRows(codes.map((c) => asg(c))));

// ---------- mapping table ----------
test("compat mapping covers exactly the 23 canonical roles and only valid legacy ranks", () => {
  assert.deepEqual(Object.keys(COMPAT_ROLE_BY_CANONICAL).sort(), [...ALL_ROLE_CODES].sort());
  for (const v of Object.values(COMPAT_ROLE_BY_CANONICAL)) assert.ok(v === null || ["ASO", "SO", "DSE", "ENFORCEMENT", "MANAGEMENT"].includes(v));
});

// Expected workspace per canonical role (single assignment):
// [compat rank, legacy-page access, checkin-gated shift staff, org-wide]
const EXPECTED: Record<string, [string | null, boolean, boolean]> = {
  airasia_management: [null, false, false], ghod: [null, false, false], global_reporting_controller: [null, false, false],
  super_admin: [null, false, false],
  maa_boss: [null, false, false], maa_admin: [null, false, false], aax_boss: [null, false, false], aax_admin: [null, false, false],
  operation_manager: ["MANAGEMENT", true, false], main_enforcement: ["ENFORCEMENT", true, false], compliance: [null, false, false],
  caterlink_management: [null, false, false],
  investigation_sso: [null, false, false], investigation_so: [null, false, false], investigation_aso: [null, false, false],
  sat_aso: [null, false, true], profiling_so: [null, false, true], profiling_aso: [null, false, true],
  hub_se: ["DSE", true, false], dse: ["DSE", true, true], sso: ["SO", true, true], so: ["SO", true, true], aso: ["ASO", true, true],
};

for (const code of ALL_ROLE_CODES) {
  test(`workspace expectation: ${code}`, () => {
    const [compat, legacyAccess, shift] = EXPECTED[code];
    const a = accessFor(code);
    assert.equal(a.hasAssignment, true);
    assert.equal(a.primaryCompatRole, compat);
    assert.equal(a.isSuperAdmin, code === "super_admin");
    assert.equal(isShiftBasedAccess(a), shift, "check-in gate applies only to shift staff");
    // legacy-page access: satisfies its own rank list, never a higher/other one
    if (legacyAccess) assert.equal(accessSatisfiesRoles(a, [compat as string]), true);
    else assert.equal(accessSatisfiesRoles(a, ["ASO", "SO", "DSE", "ENFORCEMENT", "MANAGEMENT", "ADMIN"]), false, `${code} has no legacy-page role`);
    const gate = effectiveGateRole(a, null);
    assert.equal(gate, code === "super_admin" ? "super_admin" : compat ? compat.toLowerCase() : null);
    // Super Admin is the only role allowed into /super-admin
    assert.equal(isSuperAdminPathForbidden("/super-admin", gate), code !== "super_admin");
    // /avsec/admin is forbidden to everyone except the management rank
    assert.equal(isAdminPathForbidden("/avsec/admin/users", gate), code !== "operation_manager");
  });
}

test("least privilege: lower ranks never satisfy higher-rank gates; ADMIN alias counts as MANAGEMENT", () => {
  assert.equal(accessSatisfiesRoles(accessFor("aso"), ["MANAGEMENT", "ADMIN"]), false);
  assert.equal(accessSatisfiesRoles(accessFor("so"), ["DSE"]), false);
  assert.equal(accessSatisfiesRoles(accessFor("dse"), ["ASO"]), false);
  assert.equal(accessSatisfiesRoles(accessFor("operation_manager"), ["ADMIN"]), true);
  assert.equal(accessSatisfiesRoles(accessFor("main_enforcement"), ["MANAGEMENT"]), false);
});

test("no assignment, super admin and anonymous-equivalent access satisfy nothing", () => {
  for (const a of [NO_CANONICAL_ACCESS, accessFor("super_admin"), deriveCanonicalAccess([])]) {
    assert.equal(accessSatisfiesRoles(a, ["ASO", "SO", "DSE", "ENFORCEMENT", "MANAGEMENT", "ADMIN"]), false);
  }
  assert.equal(effectiveGateRole(NO_CANONICAL_ACCESS, null), null);
});

test("external CaterLink identity is recognised only from the ICMS users-table role", () => {
  for (const r of ["vendor", "warehouse_pic", "driver_ifc", "driver_vendor"]) {
    assert.equal(isExternalCaterLinkRole(r), true);
    assert.equal(effectiveGateRole(NO_CANONICAL_ACCESS, r), "vendor");
  }
  assert.equal(isExternalCaterLinkRole("supervisor"), false);
  assert.equal(isExternalCaterLinkRole(null), false);
  // a canonical assignment always wins over an ICMS external role
  assert.equal(effectiveGateRole(accessFor("aso"), "vendor"), "aso");
});

test("operator scope: derived from canonical assignments ONLY (no ops_group, no legacy row, no ICMS source)", () => {
  const station = deriveCanonicalAccess(assignmentsFromRpcRows([asg("aso", { station_code: "KUL - MAA", team_name: "ALPHA" })]));
  const s = deriveOperatorScope(station);
  assert.deepEqual([s.source, s.orgWide, s.station, s.roleCodes], ["canonical", false, "KUL - MAA", ["aso"]]);
  assert.equal(deriveOperatorScope(accessFor("operation_manager")).orgWide, true);
  assert.equal(deriveOperatorScope(NO_CANONICAL_ACCESS).source, null, "no assignment means no scope, whatever legacy rows say");
  assert.equal(deriveOperatorScope(accessFor("super_admin")).source, null);
  assert.equal(isOrgWideOperator(accessFor("aso")), false);
  assert.equal(isOrgWideOperator(accessFor("main_enforcement")), true);
  assert.equal(isOrgWideOperator(NO_CANONICAL_ACCESS), false);
  assert.ok(!("opsGroup" in s), "operator scope carries no ops_group");
});

// ---------- requireProfile / requireRole through a mocked Supabase boundary ----------
type State = {
  user: { id: string } | null;
  profile: Record<string, unknown> | null;
  rows: unknown[];
};
const state: State = { user: { id: "u1" }, profile: null, rows: [] };

mock.module("next/navigation", {
  namedExports: { redirect: (url: string) => { throw new Error(`REDIRECT:${url}`); } },
});
mock.module("@/lib/supabase/server", {
  namedExports: {
    createClient: async () => ({
      auth: { getUser: async () => ({ data: { user: state.user } }) },
      rpc: async (name: string) => (name === "get_my_active_role_assignments" ? { data: state.rows, error: null } : { data: null, error: null }),
      from: () => {
        const q: Record<string, unknown> = {};
        q.select = () => q;
        q.eq = () => q;
        q.single = async () => ({ data: state.profile, error: null });
        q.maybeSingle = async () => ({ data: state.profile, error: null });
        return q;
      },
    }),
  },
});

const auth = await import("../lib/avsec/auth.ts");

const profileRow = (over: Record<string, unknown> = {}) => ({
  id: "u1", email: "x@example.test", name: "Test", staff_no: "S1", station: null, team: null, role: "ASO", status: "approved", ops_group: null, ...over,
});
async function redirectOf(fn: () => Promise<unknown>): Promise<string | null> {
  try { await fn(); return null; } catch (e) { const m = /REDIRECT:(.*)/.exec((e as Error).message); if (m) return m[1]; throw e; }
}
function setup(over: Partial<State> & { profile?: Record<string, unknown> | null }) {
  state.user = over.user === undefined ? { id: "u1" } : over.user;
  state.profile = over.profile === undefined ? profileRow() : over.profile;
  state.rows = over.rows ?? [];
}

test("requireProfile: anonymous -> /login", async () => {
  setup({ user: null, profile: null });
  assert.equal(await redirectOf(() => auth.requireProfile()), "/login");
});
test("requireProfile: missing name -> profile setup; pending/rejected profile -> pending page", async () => {
  setup({ profile: profileRow({ name: "" }), rows: [asg("aso")] });
  assert.equal(await redirectOf(() => auth.requireProfile()), "/avsec/profile-setup");
  for (const status of ["pending", "rejected", "deactivated"]) {
    setup({ profile: profileRow({ status }), rows: [asg("aso")] });
    assert.equal(await redirectOf(() => auth.requireProfile()), "/avsec/pending-approval", status);
  }
});
test("requireProfile: approved profile with NO active assignment is denied, whatever its legacy role says", async () => {
  for (const role of ["ASO", "SO", "DSE", "ENFORCEMENT", "MANAGEMENT", "ADMIN"]) {
    setup({ profile: profileRow({ role }), rows: [] });
    assert.equal(await redirectOf(() => auth.requireProfile()), "/avsec/pending-approval", role);
    assert.equal(await redirectOf(() => auth.requireRole(["MANAGEMENT", "ADMIN", "ASO", "SO", "DSE", "ENFORCEMENT"])), "/avsec/pending-approval", role);
  }
});
test("requireProfile: canonical super_admin is sent to the Super Admin portal", async () => {
  setup({ rows: [asg("super_admin")] });
  assert.equal(await redirectOf(() => auth.requireProfile()), "/super-admin");
});
test("requireRole: legacy ADMIN/MANAGEMENT profile role grants nothing when the canonical role is lower", async () => {
  setup({ profile: profileRow({ role: "ADMIN" }), rows: [asg("aso")] });
  assert.equal(await redirectOf(() => auth.requireRole(["MANAGEMENT", "ADMIN"])), "/avsec/home");
  setup({ profile: profileRow({ role: "MANAGEMENT" }), rows: [asg("dse")] });
  assert.equal(await redirectOf(() => auth.requireRole(["MANAGEMENT"])), "/avsec/dashboard");
});
test("requireRole: a legacy ASO row with a canonical operation_manager assignment gets management access", async () => {
  setup({ profile: profileRow({ role: "ASO" }), rows: [asg("operation_manager")] });
  const p = (await auth.requireRole(["MANAGEMENT", "ADMIN"])) as { role: string; canonical?: { orgWide: boolean } };
  assert.equal(p.role, "MANAGEMENT");
  assert.equal(p.canonical?.orgWide, true);
});
test("requireRole: roles with no legacy-page rank land on the Phase 7 dashboard, never loop", async () => {
  for (const code of ["ghod", "airasia_management", "maa_admin", "sat_aso", "profiling_so", "investigation_so", "compliance"]) {
    setup({ profile: profileRow({ role: "MANAGEMENT" }), rows: [asg(code)] });
    assert.equal(await redirectOf(() => auth.requireRole(["ASO"])), "/avsec/my-dashboard", code);
    assert.equal(await redirectOf(() => auth.requireRole(["MANAGEMENT", "ADMIN"])), "/avsec/my-dashboard", code);
    // ... but may reach identity-only pages (e.g. the dashboard entry itself)
    const p = (await auth.requireProfile()) as { role: string };
    assert.equal(p.role, "ASO", "least-privilege placeholder, not the raw legacy MANAGEMENT");
  }
});
test("requireProfile: CaterLink Management is CaterLink-only and never works a VECTA/AVSEC page", async () => {
  setup({ profile: profileRow({ role: "MANAGEMENT" }), rows: [asg("caterlink_management")] });
  assert.equal(await redirectOf(() => auth.requireProfile()), "/caterlink/dashboard");
  assert.equal(await redirectOf(() => auth.requireRole(["MANAGEMENT", "ADMIN"])), "/caterlink/dashboard");
});
test("requireProfile: station/team display scope is filled from the canonical assignment, not required in the legacy columns", async () => {
  setup({ profile: profileRow({ station: null, team: null }), rows: [asg("aso", { station_code: "KUL - MAA", team_name: "ALPHA" })] });
  const p = (await auth.requireRole(["ASO"])) as { station: string; team: string };
  assert.deepEqual([p.station, p.team], ["KUL - MAA", "ALPHA"]);
});
test("a transiently failing assignments call fails closed (no assignment -> no access)", async () => {
  setup({ rows: [] });
  assert.equal(await redirectOf(() => auth.requireRole(["ASO"])), "/avsec/pending-approval");
});

// ---------- closure: no authorization from email text / metadata / legacy columns ----------
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("closure: login/landing/callback/ICMS login never route or authorize from email text or user metadata", () => {
  for (const f of ["app/page.tsx", "app/auth/callback/route.ts", "lib/icms/actions/auth.ts", "lib/supabase/middleware.ts"]) {
    const code = strip(read(f));
    assert.ok(!/\.includes\("(driver|warehouse|vendor|caterlink)"\)/.test(code), `${f} must not infer identity from email substrings`);
    assert.ok(!/user_metadata/.test(code), `${f} must not read user-editable metadata`);
    assert.ok(!/endsWith\("@caterlink/.test(code), `${f} must not infer identity from an email domain`);
  }
});

test("closure: ICMS/scan surfaces use the shared canonical operator scope, not per-file org-wide constants", () => {
  for (const f of ["app/(avsec)/avsec/scan/page.tsx", "lib/icms/actions/scan.ts"]) {
    const code = strip(read(f));
    assert.match(code, /resolveOperatorScope\(/, f);
    assert.ok(!/ORG_WIDE_UNIFIED_ROLES/.test(code), f);
  }
  const layout = strip(read("app/(icms)/icms/layout.tsx"));
  assert.match(layout, /isOrgWideOperator\(/);
  assert.ok(!/ORG_WIDE_UNIFIED_ROLES/.test(layout));
});

test("closure: AVSEC auth chokepoints decide only from canonical access", () => {
  const code = strip(read("lib/avsec/auth.ts"));
  assert.match(code, /accessSatisfiesRoles\(access, roles\)/);
  assert.ok(!/roles\.includes\(profile\.role\)/.test(code), "requireRole must not compare the legacy profile role");
  assert.ok(!/profile\.role === "SUPER_ADMIN"/.test(code));
  assert.match(code, /if \(!access\.hasAssignment\) redirect\("\/avsec\/pending-approval"\)/);
  const layout = strip(read("app/(avsec)/avsec/layout.tsx"));
  assert.ok(!/ORG_WIDE_ROLES/.test(layout), "layout org-wide must come from canonical access");
});

// ---------- dashboard link reachability ----------
// Routes gated through requireRouteAccess (canonical role codes derived from LINK_HUB_CONFIG + legacy rank satisfiers).
const ROUTE_GATED: Record<string, string[]> = {
  "/avsec/admin/roster": ["MANAGEMENT", "ADMIN"],
  "/avsec/reports/lookup": ["ENFORCEMENT", "MANAGEMENT"],
  "/avsec/enforcement/search": ["ENFORCEMENT", "MANAGEMENT", "ADMIN"],
  "/avsec/duty": ["ASO", "SO", "DSE"],
  "/avsec/reports/sec013": ["ASO"],
  "/avsec/dashboard": ["SO", "DSE", "ENFORCEMENT", "MANAGEMENT", "ADMIN"],
};
// Routes that only require an approved profile with any active assignment.
const OPEN_TO_ANY_ASSIGNMENT = ["/avsec/bay-board", "/avsec/duty/absences", "/avsec/duty/overtime"];
// Known gaps, documented in docs/dashboard-review/operational-authorization.md.
const KNOWN_GAPS = ["/icms/dashboard", "/icms/transactions", "/icms/incidents", "/icms/admin/whitelists", "/icms/admin/archive"];

test("every dashboard link is classified: gated, open-to-assignment, or a documented known gap", () => {
  const hrefs = new Set(Object.values(LINK_HUB_CONFIG).flatMap((c) => c.links.map((l) => l.href)));
  const classified = new Set([...Object.keys(ROUTE_GATED), ...OPEN_TO_ANY_ASSIGNMENT, ...KNOWN_GAPS]);
  const unclassified = [...hrefs].filter((h) => !classified.has(h));
  assert.deepEqual(unclassified, [], `dashboard link(s) with no reviewed gate decision: ${unclassified.join(", ")}`);
});

for (const [roleCode, cfg] of Object.entries(LINK_HUB_CONFIG)) {
  test(`dashboard reachability: every gated link on the ${roleCode} dashboard is reachable by ${roleCode}`, () => {
    const access = accessFor(roleCode);
    for (const link of cfg.links) {
      if (link.href in ROUTE_GATED) assert.equal(routeAllows(link.href, access, ROUTE_GATED[link.href]), true, `${roleCode} -> ${link.href}`);
      else if (OPEN_TO_ANY_ASSIGNMENT.includes(link.href)) assert.equal(access.hasAssignment, true);
    }
  });
}

test("route access denies roles whose dashboard does not link to the route and whose rank does not satisfy it", () => {
  assert.equal(routeAllows("/avsec/enforcement/search", accessFor("aso"), ROUTE_GATED["/avsec/enforcement/search"]), false);
  assert.equal(routeAllows("/avsec/enforcement/search", accessFor("compliance"), ROUTE_GATED["/avsec/enforcement/search"]), false);
  assert.equal(routeAllows("/avsec/duty", accessFor("ghod"), ROUTE_GATED["/avsec/duty"]), false);
  assert.equal(routeAllows("/avsec/duty", accessFor("maa_boss"), ROUTE_GATED["/avsec/duty"]), false);
  assert.equal(routeAllows("/avsec/reports/lookup", accessFor("aso"), ROUTE_GATED["/avsec/reports/lookup"]), false);
  assert.equal(routeAllows("/avsec/reports/lookup", NO_CANONICAL_ACCESS, ROUTE_GATED["/avsec/reports/lookup"]), false);
  assert.equal(routeAllows("/avsec/reports/lookup", accessFor("super_admin"), ROUTE_GATED["/avsec/reports/lookup"]), false);
  assert.deepEqual(canonicalCodesForRoute("/avsec/duty"), ["aso", "dse", "profiling_aso", "profiling_so", "sat_aso", "so", "sso"]);
});

test("closure: dashboard-link target pages are gated through requireRouteAccess with the same href the dashboards use", () => {
  const pages: Record<string, string> = {
    "/avsec/reports/lookup": "app/(avsec)/avsec/reports/lookup/page.tsx",
    "/avsec/enforcement/search": "app/(avsec)/avsec/enforcement/search/page.tsx",
    "/avsec/duty": "app/(avsec)/avsec/duty/page.tsx",
    "/avsec/reports/sec013": "app/(avsec)/avsec/reports/sec013/page.tsx",
    "/avsec/dashboard": "app/(avsec)/avsec/dashboard/page.tsx",
  };
  for (const [href, file] of Object.entries(pages)) assert.ok(read(file).includes(`requireRouteAccess("${href}"`), file);
});
