import test, { mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { assignmentsFromRpcRows, deriveCanonicalAccess, NO_CANONICAL_ACCESS } from "../lib/auth/canonical-access.ts";
import {
  decideCheckpointAccess, hubDestinationError, icmsDisplayRole, isExternalIcmsRole, isStationOperator, satisfiesIcmsRoles,
} from "../lib/icms/canonical.ts";
import { ALL_ROLE_CODES } from "../scripts/staging/lib/role-matrix.mjs";
import { LINK_HUB_CONFIG } from "../lib/dashboard/linkHubConfig.ts";
import type { Role } from "../lib/icms/database.types.ts";

const REPO = path.resolve(import.meta.dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");

const asg = (roleCode: string, station: string | null = null) => ({
  role_code: roleCode, role_category: "x", aoc_code: null, operating_entity_code: null, department_code: null, unit_code: null,
  hub_code: null, station_code: station, team_name: station ? "ALPHA" : null, starts_at: "2026-01-01T00:00:00Z", ends_at: null,
});
const accessFor = (code: string, station: string | null = null) => deriveCanonicalAccess(assignmentsFromRpcRows([asg(code, station)]));

// ---------- pure canonical rules ----------
test("checkpoint authority: only station operators (aso/so/sso/dse) at a single scan-capable station may complete checkpoints", () => {
  for (const code of ALL_ROLE_CODES) {
    const isOperator = ["aso", "so", "sso", "dse"].includes(code);
    const decision = decideCheckpointAccess(accessFor(code, isOperator ? "KUL - MAA" : null), true);
    assert.equal(decision.allowed, isOperator, `${code}`);
  }
});

test("checkpoint authority: fails closed when the station lacks the scan capability or none is assigned", () => {
  for (const cap of [false, null, undefined] as const) {
    assert.equal(decideCheckpointAccess(accessFor("aso", "BTU"), cap).reason, "station_cannot_scan");
  }
  assert.equal(decideCheckpointAccess(accessFor("so", null), true).reason, "no_station");
  assert.equal(decideCheckpointAccess(NO_CANONICAL_ACCESS, true).allowed, false);
  assert.equal(decideCheckpointAccess(accessFor("super_admin"), true).allowed, false);
});

test("checkpoint authority: Staff Profiling is always excluded, even alongside a station role", () => {
  const both = deriveCanonicalAccess(assignmentsFromRpcRows([asg("aso", "KUL - MAA"), asg("profiling_aso", "KUL - MAA")]));
  assert.equal(decideCheckpointAccess(both, true).reason, "profiling_excluded");
  assert.equal(decideCheckpointAccess(accessFor("profiling_so", "PEN"), true).allowed, false);
});

test("CaterLink Management has administration access but NO checkpoint authority", () => {
  const clm = accessFor("caterlink_management");
  assert.equal(satisfiesIcmsRoles(clm, ["supervisor"]), true);
  assert.equal(satisfiesIcmsRoles(clm, ["post2_avsec", "post6_avsec", "redq_avsec", "receiver", "hub_avsec"]), false);
  assert.equal(decideCheckpointAccess(clm, true).allowed, false);
  assert.equal(isStationOperator(clm), false);
});

test("legacy ICMS role names map to canonical decisions; external roles are never satisfied canonically", () => {
  assert.equal(satisfiesIcmsRoles(accessFor("operation_manager"), ["management"]), true);
  assert.equal(satisfiesIcmsRoles(accessFor("operation_manager"), ["supervisor"]), false);
  assert.equal(satisfiesIcmsRoles(accessFor("main_enforcement"), ["enforcement"]), true);
  assert.equal(satisfiesIcmsRoles(accessFor("aso", "KUL - MAA"), ["supervisor", "enforcement", "management"]), false);
  assert.equal(satisfiesIcmsRoles(accessFor("aso", "KUL - MAA"), ["post2_avsec"]), true);
  for (const code of ALL_ROLE_CODES) assert.equal(satisfiesIcmsRoles(accessFor(code, "KUL - MAA"), ["vendor", "warehouse_pic"]), false, code);
  assert.equal(satisfiesIcmsRoles(NO_CANONICAL_ACCESS, ["supervisor", "management", "enforcement", "post2_avsec"]), false);
  assert.equal(isExternalIcmsRole("vendor"), true);
  assert.equal(isExternalIcmsRole("supervisor"), false);
});

test("a forged ICMS display role cannot grant access: display role is derived FROM canonical access and decides nothing", () => {
  assert.equal(icmsDisplayRole(accessFor("caterlink_management")), "supervisor");
  assert.equal(icmsDisplayRole(accessFor("aso", "PEN")), "ops_staff");
  // Authorization functions take the canonical access, never a role string supplied by a profile.
  assert.equal(satisfiesIcmsRoles(accessFor("aso", "PEN"), ["supervisor"]), false);
});

test("hub destination rule: only the destination station may proceed at the Part Hub step; other steps are unaffected", () => {
  const base = { route: "HUB", hubDestination: "JHB" };
  assert.equal(hubDestinationError({ ...base, nextStepPart: "part_hub", userStation: "JHB" }), null);
  assert.match(hubDestinationError({ ...base, nextStepPart: "part_hub", userStation: "PEN" }) ?? "", /destined for JHB, not your station \(PEN\)/);
  assert.equal(hubDestinationError({ ...base, nextStepPart: "part_b", userStation: "PEN" }), null);
  assert.equal(hubDestinationError({ route: "AIRCRAFT", hubDestination: null, nextStepPart: "part_hub", userStation: "PEN" }), null);
});

// ---------- dashboard link reachability (ICMS targets) ----------
test("every ICMS link on the caterlink_management dashboard is reachable by canonical caterlink_management", () => {
  const clm = accessFor("caterlink_management");
  const gates: Record<string, { roles: Role[] | null }> = {
    "/icms/dashboard": { roles: null },
    "/icms/transactions": { roles: null },
    "/icms/incidents": { roles: null },
    "/icms/admin/whitelists": { roles: null },
    "/icms/admin/archive": { roles: ["supervisor"] },
  };
  for (const link of LINK_HUB_CONFIG.caterlink_management.links) {
    assert.ok(link.href in gates, `unclassified ICMS link ${link.href}`);
    const g = gates[link.href];
    if (g.roles) assert.equal(satisfiesIcmsRoles(clm, g.roles), true, link.href);
  }
  // the page sources actually use those gates
  assert.match(read("app/(icms)/icms/admin/archive/page.tsx"), /requireRole\(\["supervisor"\]\)/);
  for (const f of ["app/(icms)/icms/dashboard/page.tsx", "app/(icms)/icms/transactions/page.tsx", "app/(icms)/icms/incidents/page.tsx"]) {
    assert.match(read(f), /requireProfile\(\)/, f);
  }
});

// ---------- requireProfile / requireRole / requireCheckpointRole (real code, mocked boundary) ----------
type State = {
  user: { id: string } | null;
  rows: unknown[];
  capability: boolean | null;
  profile: Record<string, unknown> | null;
  legacyUser: Record<string, unknown> | null;
  onDuty: boolean;
  legacyUsersQueried: number;
};
const st: State = { user: { id: "u1" }, rows: [], capability: true, profile: null, legacyUser: null, onDuty: true, legacyUsersQueried: 0 };

mock.module("next/navigation", { namedExports: { redirect: (url: string) => { throw new Error(`REDIRECT:${url}`); } } });
mock.module("@/lib/supabase/server", {
  namedExports: {
    createClient: async () => ({
      auth: { getUser: async () => ({ data: { user: st.user } }), signOut: async () => ({}) },
      rpc: async (name: string) => {
        if (name === "get_my_active_role_assignments") return { data: st.rows, error: null };
        if (name === "can_user_scan_caterlink") return { data: st.capability, error: null };
        return { data: null, error: null };
      },
      from: (table: string) => {
        const q: Record<string, unknown> = {};
        q.select = () => q;
        q.eq = () => q;
        const result = async () => {
          if (table === "profiles") return { data: st.profile, error: null };
          if (table === "users") { st.legacyUsersQueried += 1; return { data: st.legacyUser, error: null }; }
          return { data: null, error: null };
        };
        q.maybeSingle = result;
        q.single = result;
        return q;
      },
    }),
  },
});
mock.module("@/lib/avsec/duty/checkin-queries", { namedExports: { hasOpenDutyCheckIn: async () => st.onDuty } });

const auth = await import("../lib/icms/auth.ts");

const baseProfile = { id: "u1", name: "T", staff_no: "S1", email: "t@example.test", status: "approved", created_at: "2026-01-01T00:00:00Z" };
function setup(over: Partial<State>) {
  Object.assign(st, { user: { id: "u1" }, rows: [], capability: true, profile: { ...baseProfile }, legacyUser: null, onDuty: true, legacyUsersQueried: 0 }, over);
}
async function redirectOf(fn: () => Promise<unknown>): Promise<string | null> {
  try { await fn(); return null; } catch (e) { const m = /REDIRECT:(.*)/.exec((e as Error).message); if (m) return m[1]; throw e; }
}

test("ICMS requireProfile: canonical staff get an adapter profile built from profiles + assignments (same UUID; the users row is never authority)", async () => {
  setup({ rows: [asg("aso", "KUL - MAA")] });
  const p = await auth.requireProfile();
  assert.equal(p.id, "u1");
  assert.equal(p.identity, "canonical");
  assert.equal(p.role, "ops_staff");
  assert.equal(p.ops_group, null);
  assert.ok(st.legacyUsersQueried <= 1, "the users-table row is read at most once, only to detect a mixed VECTA/CaterLink conflict -- never for authority");
});

test("ICMS requireProfile: anonymous, super admin and unassigned/unknown accounts are redirected", async () => {
  setup({ user: null });
  assert.equal(await redirectOf(() => auth.requireProfile()), "/login");
  setup({ rows: [asg("super_admin")] });
  assert.equal(await redirectOf(() => auth.requireProfile()), "/super-admin");
  setup({ rows: [], legacyUser: null });
  assert.equal(await redirectOf(() => auth.requireProfile()), "/login?error=no-profile");
  setup({ rows: [asg("aso", "KUL - MAA")], profile: { ...baseProfile, status: "pending" } });
  assert.equal(await redirectOf(() => auth.requireProfile()), "/login?error=pending");
});

test("ICMS requireProfile: a legacy users row for an INTERNAL role (forged supervisor / checkpoint account) grants nothing without an assignment", async () => {
  for (const role of ["supervisor", "management", "enforcement", "post2_avsec", "post6_avsec", "hub_avsec", "redq_avsec", "receiver", "ops_staff"]) {
    setup({ rows: [], legacyUser: { id: "u1", role, status: "active", name: "x", staff_id: "1" } });
    assert.equal(await redirectOf(() => auth.requireProfile()), "/login?error=no-profile", role);
  }
});

test("ICMS external parties (vendor / warehouse_pic) keep the external identity path, but only for external gates", async () => {
  setup({ rows: [], legacyUser: { id: "u1", role: "vendor", status: "active", name: "V", staff_id: "1" } });
  const p = await auth.requireRole(["vendor"]);
  assert.equal(p.identity, "external");
  for (const roles of [["supervisor"], ["management"], ["post2_avsec"], ["warehouse_pic"]] as Role[][]) {
    setup({ rows: [], legacyUser: { id: "u1", role: "vendor", status: "active", name: "V", staff_id: "1" } });
    assert.equal(await redirectOf(() => auth.requireRole(roles)), "/icms/dashboard?error=forbidden", roles.join());
  }
  setup({ rows: [], legacyUser: { id: "u1", role: "vendor", status: "active", name: "V", staff_id: "1" } });
  assert.equal(await redirectOf(() => auth.requireCheckpointRole("post2_avsec")), "/icms/dashboard?error=forbidden", "an external party never completes a checkpoint");
});

test("ICMS requireRole: canonical leadership gates", async () => {
  setup({ rows: [asg("caterlink_management")] });
  assert.equal((await auth.requireRole(["supervisor"])).role, "supervisor");
  assert.equal(await redirectOf(() => auth.requireRole(["management"])), "/icms/dashboard?error=forbidden");
  setup({ rows: [asg("operation_manager")] });
  assert.equal((await auth.requireRole(["supervisor", "management"])).role, "management");
  setup({ rows: [asg("ghod")] });
  assert.equal(await redirectOf(() => auth.requireRole(["supervisor", "enforcement", "management"])), "/icms/dashboard?error=forbidden");
});

test("ICMS requireCheckpointRole: capable station + on duty is allowed", async () => {
  setup({ rows: [asg("sso", "PEN")], capability: true, onDuty: true });
  assert.equal((await auth.requireCheckpointRole("post6_avsec")).identity, "canonical");
});

test("ICMS requireCheckpointRole: non-CaterLink station (BTU), unknown capability, off duty, Profiling, leadership, CaterLink Management are all denied", async () => {
  setup({ rows: [asg("aso", "BTU")], capability: false });
  assert.equal(await redirectOf(() => auth.requireCheckpointRole("post2_avsec")), "/icms/dashboard?error=forbidden");
  setup({ rows: [asg("aso", "BTU")], capability: null });
  assert.equal(await redirectOf(() => auth.requireCheckpointRole("post2_avsec")), "/icms/dashboard?error=forbidden");
  setup({ rows: [asg("aso", "KUL - MAA")], capability: true, onDuty: false });
  assert.equal(await redirectOf(() => auth.requireCheckpointRole("post2_avsec")), "/icms/dashboard?error=not-on-duty");
  for (const code of ["profiling_so", "profiling_aso", "operation_manager", "main_enforcement", "caterlink_management", "hub_se", "sat_aso", "compliance"]) {
    setup({ rows: [asg(code, "KUL - MAA")], capability: true, onDuty: true });
    assert.equal(await redirectOf(() => auth.requireCheckpointRole("post2_avsec")), "/icms/dashboard?error=forbidden", code);
  }
});

test("ICMS requireCheckpointRole: the capability is evaluated for the CANONICAL station, so a forged profile station cannot borrow PEN's capability", async () => {
  setup({ rows: [asg("aso", "BTU")], capability: false, profile: { ...baseProfile, station: "PEN" } });
  assert.equal(await redirectOf(() => auth.requireCheckpointRole("post2_avsec")), "/icms/dashboard?error=forbidden");
});

// ---------- closure ----------
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

test("closure: ICMS auth and the scan/QR paths never read ops_group or the legacy users.role for internal staff", () => {
  for (const f of ["lib/icms/auth.ts", "lib/icms/actions/scan.ts", "app/api/icms/qr/validate/route.ts", "lib/icms/canonical.ts"]) {
    const code = strip(read(f));
    assert.ok(!/\.ops_group\b|\bopsGroup\b|ifc_avsec|operation_avsec/.test(code.replace(/ops_group: null,?/g, "")), `${f} must not read ops_group`);
  }
  assert.ok(!fs.existsSync(path.join(REPO, "lib/icms/ops-group.ts")), "the ops_group authority module must stay deleted");
  const qr = strip(read("app/api/icms/qr/validate/route.ts"));
  assert.match(qr, /get_my_active_role_assignments/);
  assert.match(qr, /can_user_scan_caterlink/);
  assert.match(strip(read("lib/icms/actions/scan.ts")), /can_user_scan_caterlink/);
});

test("closure: the external users-table path is confined to external roles (vendor / warehouse_pic)", () => {
  const code = strip(read("lib/icms/auth.ts"));
  assert.match(code, /isExternalIcmsRole\(\(legacy as \{ role\?: string \}\)\.role\)/);
  const qr = strip(read("app/api/icms/qr/validate/route.ts"));
  assert.match(qr, /isExternalIcmsRole\(legacy\?\.role as string \| undefined\)/);
});
