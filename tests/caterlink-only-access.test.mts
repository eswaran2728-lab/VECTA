import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { assignmentsFromRpcRows, deriveCanonicalAccess, NO_CANONICAL_ACCESS } from "../lib/auth/canonical-access.ts";
import {
  classifyPortalAccess, decidePortalRequest, isCaterLinkOnly, landingForIdentity, isExternalCaterLinkRole,
  EXTERNAL_CATERLINK_ROLES,
} from "../lib/auth/caterlink-access.ts";
import { caterLinkNavFor, CATERLINK_ROLE_LABELS } from "../lib/caterlink/portal-nav.ts";
import { ALL_ROLE_CODES } from "../scripts/staging/lib/role-matrix.mjs";

const REPO = path.resolve(import.meta.dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const row = (code: string, station: string | null = null) => ({
  role_code: code, role_category: "x", aoc_code: null, operating_entity_code: null, department_code: null, unit_code: null,
  hub_code: null, station_code: station, team_name: station ? "ALPHA" : null, starts_at: "2026-01-01T00:00:00Z", ends_at: null,
});
const acc = (...codes: string[]) => deriveCanonicalAccess(assignmentsFromRpcRows(codes.map((c) => row(c))));

// ---------------- identity classification ----------------
test("the three CaterLink identities map to existing role codes (no new roles)", () => {
  assert.equal(classifyPortalAccess(acc("caterlink_management"), null).kind, "caterlink_management");
  assert.equal(classifyPortalAccess(NO_CANONICAL_ACCESS, { role: "warehouse_pic", status: "active" }).kind, "caterlink_driver");
  assert.equal(classifyPortalAccess(NO_CANONICAL_ACCESS, { role: "vendor", status: "active" }).kind, "caterlink_vendor");
  assert.deepEqual([...EXTERNAL_CATERLINK_ROLES].sort(), ["driver_ifc", "driver_vendor", "vendor", "warehouse_pic"]);
  assert.equal(CATERLINK_ROLE_LABELS.caterlink_driver, "CaterLink Driver");
  assert.equal(CATERLINK_ROLE_LABELS.caterlink_vendor, "Third-Party Vendor");
});

test("external accounts that are not active fail closed (pending / rejected / deactivated / unknown)", () => {
  for (const status of ["pending", "rejected", "deactivated", "", null, undefined, "ACTIVE ", "suspended"]) {
    const id = classifyPortalAccess(NO_CANONICAL_ACCESS, { role: "vendor", status: status as string });
    assert.equal(id.kind, "blocked", String(status));
  }
});

test("mixed VECTA / CaterLink identities fail closed and are never silently combined", () => {
  for (const code of ALL_ROLE_CODES.filter((c) => c !== "caterlink_management" && c !== "super_admin")) {
    assert.equal(classifyPortalAccess(acc("caterlink_management", code), null).kind, "conflict", `caterlink_management + ${code}`);
    assert.equal(classifyPortalAccess(acc(code), { role: "vendor", status: "active" }).kind, "conflict", `${code} + external vendor`);
  }
  assert.equal(classifyPortalAccess(acc("caterlink_management"), { role: "warehouse_pic", status: "active" }).kind, "conflict");
  assert.equal(classifyPortalAccess(acc("super_admin"), { role: "vendor", status: "active" }).kind, "conflict");
});

test("VECTA identities, super admin and unassigned accounts are not CaterLink-only", () => {
  for (const code of ALL_ROLE_CODES.filter((c) => c !== "caterlink_management" && c !== "super_admin")) {
    const k = classifyPortalAccess(acc(code, ["aso", "so", "sso", "dse", "sat_aso", "profiling_so", "profiling_aso"].includes(code) ? "PEN" : null as never), null).kind;
    assert.equal(k, "vecta", code);
    assert.equal(isCaterLinkOnly(k), false);
  }
  assert.equal(classifyPortalAccess(acc("super_admin"), null).kind, "super_admin");
  assert.equal(classifyPortalAccess(NO_CANONICAL_ACCESS, null).kind, "none");
  assert.equal(classifyPortalAccess(NO_CANONICAL_ACCESS, { role: "supervisor", status: "active" }).kind, "none", "a non-external users-table role grants no CaterLink identity");
});

test("a forged role string, display name or auth-metadata-like value never creates an identity", () => {
  for (const role of ["CATERLINK_MANAGEMENT", "caterlink_management", "driver", "Vendor", " vendor", "admin", "management", "warehouse_pic ", "catering"]) {
    const k = classifyPortalAccess(NO_CANONICAL_ACCESS, { role, status: "active" }).kind;
    assert.equal(k, "none", `'${role}' must not match`);
  }
  assert.equal(isExternalCaterLinkRole("vendor"), true);
  assert.equal(isExternalCaterLinkRole("VENDOR"), false);
});

test("landing: CaterLink identities -> /caterlink/dashboard; VECTA -> /; super admin -> /super-admin", () => {
  assert.equal(landingForIdentity({ kind: "caterlink_management" }), "/caterlink/dashboard");
  assert.equal(landingForIdentity({ kind: "caterlink_driver" }), "/caterlink/dashboard");
  assert.equal(landingForIdentity({ kind: "caterlink_vendor" }), "/caterlink/dashboard");
  assert.equal(landingForIdentity({ kind: "vecta" }), "/");
  assert.equal(landingForIdentity({ kind: "super_admin" }), "/super-admin");
});

// ---------------- request-level decisions (direct URLs and API calls) ----------------
const FORBIDDEN_PAGES = ["/", "/avsec/home", "/avsec/dashboard", "/avsec/my-dashboard", "/avsec/admin/users", "/avsec/reports/sec014", "/avsec/duty", "/avsec/roster", "/super-admin", "/super-admin/readiness", "/avsec/profile-setup", "/avsec/pending-approval"];
const ALLOWED_PAGES = ["/caterlink/dashboard", "/caterlink/transactions", "/icms/dashboard", "/icms/admin/whitelists", "/icms/incidents", "/login", "/auth/callback"];
const FORBIDDEN_APIS = ["/api/avsec/export", "/api/wois/chat", "/api/anything-else"];
const ALLOWED_APIS = ["/api/icms/qr/validate", "/api/auth/register", "/api/health"];

test("CaterLink-only identities: every VECTA / AVSEC / Super Admin page redirects to CaterLink, every non-CaterLink API answers 403", () => {
  for (const kind of ["caterlink_management", "caterlink_driver", "caterlink_vendor"] as const) {
    for (const p of FORBIDDEN_PAGES) assert.deepEqual(decidePortalRequest({ kind }, p, false), { action: "redirect", to: "/caterlink/dashboard" }, `${kind} ${p}`);
    for (const p of ALLOWED_PAGES) assert.deepEqual(decidePortalRequest({ kind }, p, false), { action: "allow" }, `${kind} ${p}`);
    for (const p of FORBIDDEN_APIS) assert.deepEqual(decidePortalRequest({ kind }, p, true), { action: "deny_api" }, `${kind} ${p}`);
    for (const p of ALLOWED_APIS) assert.deepEqual(decidePortalRequest({ kind }, p, true), { action: "allow" }, `${kind} ${p}`);
  }
});

test("conflicting and blocked identities reach nothing but the sign-in pages", () => {
  for (const identity of [{ kind: "conflict" as const }, { kind: "blocked" as const, status: "pending" }]) {
    for (const p of [...FORBIDDEN_PAGES, "/caterlink/dashboard", "/icms/dashboard"]) {
      const d = decidePortalRequest(identity, p, false);
      assert.equal(d.action, "redirect", `${identity.kind} ${p}`);
      assert.equal((d as { to: string }).to, "/login");
    }
    assert.equal(decidePortalRequest(identity, "/api/avsec/export", true).action, "deny_api");
    assert.equal(decidePortalRequest(identity, "/api/icms/qr/validate", true).action, "deny_api");
    assert.equal(decidePortalRequest(identity, "/login", false).action, "allow");
  }
});

test("VECTA identities (AVSEC officers keep scanning / receipt through ICMS) are not restricted by the CaterLink gate", () => {
  for (const kind of ["vecta", "super_admin", "none"] as const) {
    for (const p of [...FORBIDDEN_PAGES, ...ALLOWED_PAGES]) assert.deepEqual(decidePortalRequest({ kind }, p, false), { action: "allow" }, `${kind} ${p}`);
    for (const p of [...FORBIDDEN_APIS, ...ALLOWED_APIS]) assert.deepEqual(decidePortalRequest({ kind }, p, true), { action: "allow" }, `${kind} ${p}`);
  }
});

// ---------------- navigation ----------------
test("CaterLink navigation contains only CaterLink destinations for all three identities", () => {
  for (const kind of ["caterlink_management", "caterlink_driver", "caterlink_vendor"] as const) {
    const nav = caterLinkNavFor(kind);
    assert.ok(nav.length >= 3, kind);
    for (const n of nav) assert.match(n.href, /^\/icms\//, `${kind}: ${n.href}`);
    assert.ok(!nav.some((n) => /avsec|super-admin|^\/$|scan/i.test(n.href)), `${kind}: no VECTA/AVSEC/scan link`);
  }
  const mgmt = caterLinkNavFor("caterlink_management").map((n) => n.href);
  for (const h of ["/icms/dashboard", "/icms/transactions", "/icms/incidents", "/icms/reports", "/icms/admin/whitelists", "/icms/admin/archive"]) assert.ok(mgmt.includes(h), h);
  assert.ok(!mgmt.some((h) => /new/.test(h)), "Management gains no driver transaction-creation entry");
  assert.deepEqual(caterLinkNavFor("caterlink_driver").map((n) => n.href), ["/icms/transactions/new", "/icms/transactions", "/icms/dashboard"]);
  assert.deepEqual(caterLinkNavFor("caterlink_vendor").map((n) => n.href), ["/icms/vendor-transactions/new", "/icms/vendor-transactions", "/icms/dashboard"]);
  assert.deepEqual(caterLinkNavFor("vecta"), []);
});

test("the CaterLink shell has CaterLink branding, sign-out and no VECTA cross-links", () => {
  const shell = strip(read("components/caterlink/CaterLinkShell.tsx"));
  assert.match(shell, /CaterLink/);
  assert.match(shell, /signOutAction/);
  assert.ok(!/\/avsec|super-admin|AppSidebar|TeamBottomNav|VECTA/.test(shell), "no app-switch, AVSEC or VECTA link");
  const layout = read("app/(icms)/icms/layout.tsx");
  assert.match(layout, /isCaterLinkOnly\(portalKind\)/);
  assert.match(layout, /<CaterLinkShell/);
});

// ---------------- closure: no email / metadata decisions anywhere ----------------
function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(path.join(REPO, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(rel, out); else if (/\.(ts|tsx)$/.test(e.name)) out.push(rel);
  }
  return out;
}

test("closure: no authorization or landing decision is made from an email string or user-editable metadata", () => {
  const offenders: string[] = [];
  for (const f of ["app", "lib", "components"].flatMap((d) => walk(d))) {
    if (f.includes("database.types")) continue;
    const code = strip(read(f));
    if (/(userEmail|\.email|email)\b[^\n;]{0,60}\.(includes|endsWith|startsWith|match|test)\(\s*["'`/]?(caterlink|driver|warehouse|vendor|@caterlink)/i.test(code)) offenders.push(`${f}: email heuristic`);
    if (/["']caterlink["'\s]*\)?\s*&&[^\n]*email|email[^\n]*includes\(["']caterlink/i.test(code)) offenders.push(`${f}: email caterlink`);
    if (/user_metadata[^\n]{0,80}(system_type|role|driver_type)/.test(code) && !/register/.test(f)) offenders.push(`${f}: metadata decision`);
    if (/meta\.(system_type|role|driver_type)/.test(code)) offenders.push(`${f}: meta.*`);
  }
  assert.deepEqual(offenders, []);
  const login = read("app/login/login-form.tsx");
  assert.ok(!/isCaterLinkUser|includes\("caterlink"\)|includes\("driver"\)|includes\("warehouse"\)|includes\("vendor"\)/.test(login), "the login form no longer inspects the email");
});

test("closure: login, callback, root page, middleware, AVSEC auth and ICMS auth all use the single portal decision", () => {
  for (const f of ["lib/supabase/middleware.ts", "app/page.tsx", "app/auth/callback/route.ts", "lib/icms/actions/auth.ts", "lib/avsec/auth.ts", "lib/icms/auth.ts"]) {
    assert.match(read(f), /classifyPortalAccess/, f);
  }
  const mw = read("lib/supabase/middleware.ts");
  assert.match(mw, /decidePortalRequest/);
  assert.match(mw, /deny_api/);
  assert.match(mw, /status: 403/);
  const avsec = read("lib/avsec/auth.ts");
  assert.match(avsec, /redirectIfNotVecta/);
  assert.match(avsec, /isCaterLinkOnly\(identity\.kind\) \|\| identity\.kind === "conflict"/, "server actions reached directly are denied for CaterLink identities");
});

test("the three identities keep their approved boundaries: Management gains no scanning, receipt or driver action", () => {
  const nav = caterLinkNavFor("caterlink_management");
  assert.ok(!nav.some((n) => /scan|receipt|new/i.test(n.href + n.label)));
  const canonical = read("lib/icms/canonical.ts");
  assert.ok(!/caterlink_management/.test(canonical.slice(canonical.indexOf("STATION_OPERATOR_CODES"), canonical.indexOf("STATION_OPERATOR_CODES") + 120)));
  assert.equal(CATERLINK_ROLE_LABELS.caterlink_management, "CaterLink Management");
});

test("closure: the VECTA assistant widget is not offered to CaterLink-only identities and the whitelist page is role-gated", () => {
  const layout = read("app/layout.tsx");
  assert.match(layout, /isCaterLinkOnly\(portal\.kind\)/);
  assert.match(layout, /\{showWois && <WoisFloatingTrigger/);
  const wl = read("app/(icms)/icms/admin/whitelists/page.tsx");
  assert.ok(wl.indexOf('requireRole(["supervisor"])') > 0 && wl.indexOf('requireRole(["supervisor"])') < wl.indexOf("listWhitelistEntries({ entryType"), "the role gate precedes any data call");
});
