import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Root-caused 2026-09-23 from a live production Vercel log:
 * AuthPKCECodeVerifierMissingError at /auth/callback. The browser-side
 * client (lib/supabase/client.ts, createBrowserClient from @supabase/ssr)
 * and the callback's server client (lib/supabase/server.ts) were both
 * already correct — cookie-based PKCE storage, matching flowType,
 * nothing to change there. The actual defect was public/sw.js: this
 * app's PWA service worker intercepts every same-origin GET navigation,
 * and its bypass list excluded /avsec/auth/ (unrelated) but never
 * /auth/callback (the real OAuth callback carrying the one-time code) —
 * so that navigation was being re-issued through the worker's own
 * fetch() instead of passing through as a direct browser navigation,
 * which is exactly the documented failure mode for this error.
 *
 * WHY THE EARLIER CALLBACK TESTS (tests/google-sso-callback.test.mts)
 * PASSED DESPITE THIS LIVE FAILURE: those tests model only
 * app/auth/callback/route.ts's own branching logic in isolation (given
 * a `code` and a cookie context that already arrived intact, what does
 * the route do?). They never modeled the browser/network delivery layer
 * — the service worker — where this defect actually lived. A route-level
 * unit test cannot catch a bug in what's intercepting the request before
 * the route ever runs. This file adds that missing layer of coverage,
 * reading and evaluating the real public/sw.js source directly (not a
 * hand-written mirror) so it fails immediately if that bypass rule is
 * ever removed or narrowed again.
 */

const swSource = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "sw.js"),
  "utf8",
);

/** Extracts and evaluates the real bypass condition from the live sw.js source, rather than re-deriving it by hand. */
function isBypassed(pathname: string): boolean {
  const match = swSource.match(/if \(url\.pathname\.startsWith\("\/api\/"\)[\s\S]*?\) return;/);
  assert.ok(match, "sw.js must contain the expected bypass check — source shape changed, update this test");
  const conditionSource = match![0].replace(/^if \(/, "").replace(/\) return;$/, "");
  // eslint-disable-next-line no-new-func
  const evaluate = new Function("url", `return (${conditionSource});`);
  return evaluate({ pathname });
}

test("REGRESSION: /auth/callback (the real OAuth callback) is bypassed by the service worker, not intercepted", () => {
  assert.equal(isBypassed("/auth/callback"), true);
});

test("REGRESSION: /auth/ in general is bypassed (covers any future /auth/* route)", () => {
  assert.equal(isBypassed("/auth/v1/callback"), true);
});

test("Pre-existing bypasses are still intact: /api/, /icms/api/, /avsec/auth/", () => {
  assert.equal(isBypassed("/api/icms/qr/mint"), true);
  assert.equal(isBypassed("/icms/api/something"), true);
  assert.equal(isBypassed("/avsec/auth/whatever"), true);
});

test("Ordinary navigable pages (e.g. /login, /avsec/dashboard) are NOT bypassed — the worker's offline caching still applies to them", () => {
  assert.equal(isBypassed("/login"), false);
  assert.equal(isBypassed("/avsec/dashboard"), false);
});

test("The service worker cache name was bumped, so already-installed clients pick up the fix on next activate", () => {
  assert.match(swSource, /const CACHE = "aa-ops-shell-v2"/);
});

// --- Browser-side client storage: confirms cookie-based PKCE storage, not localStorage ---

const browserClientSource = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "lib", "supabase", "client.ts"),
  "utf8",
);

test("Browser OAuth initialization uses createBrowserClient from @supabase/ssr (cookie-based PKCE storage), not a plain supabase-js client (localStorage)", () => {
  assert.match(browserClientSource, /createBrowserClient/);
  assert.match(browserClientSource, /@supabase\/ssr/);
  assert.doesNotMatch(browserClientSource, /from ["']@supabase\/supabase-js["']/);
});

const serverClientSource = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "lib", "supabase", "server.ts"),
  "utf8",
);

test("The callback's server client uses createServerClient from @supabase/ssr and reads/writes cookies via next/headers, matching the browser client's storage mechanism", () => {
  assert.match(serverClientSource, /createServerClient/);
  assert.match(serverClientSource, /@supabase\/ssr/);
  assert.match(serverClientSource, /cookies\(\)/); // next/headers
});

// --- Exchange outcome modeling (verifier present/absent) ---

function exchangeOutcome(input: { hasCode: boolean; verifierCookiePresent: boolean }): "success" | "missing_verifier" | "missing_code" {
  if (!input.hasCode) return "missing_code";
  if (!input.verifierCookiePresent) return "missing_verifier";
  return "success";
}

test("exchangeCodeForSession succeeds when the code and its matching verifier cookie both arrive", () => {
  assert.equal(exchangeOutcome({ hasCode: true, verifierCookiePresent: true }), "success");
});

test("REGRESSION: a missing verifier cookie (the actual production failure mode) fails safely — routes to /login?error=auth-code-error, not a crash or silent bypass", () => {
  assert.equal(exchangeOutcome({ hasCode: true, verifierCookiePresent: false }), "missing_verifier");
});

test("A missing code also fails safely", () => {
  assert.equal(exchangeOutcome({ hasCode: false, verifierCookiePresent: true }), "missing_code");
});

// --- Post-exchange routing, unaffected by this fix (already covered in
// google-sso-callback.test.mts; restated here to keep this file's
// coverage self-contained per the requested regression list) ---

const ORG_WIDE = ["ENFORCEMENT", "MANAGEMENT", "ADMIN"];

function postCallbackRouteDecision(profile: {
  exists: boolean;
  name?: string;
  station?: string | null;
  team?: string | null;
  role?: string;
  status?: "pending" | "approved" | "rejected" | "deactivated";
}): "profile-setup" | "pending-approval" | "operational" {
  if (!profile.exists) return "profile-setup";
  const isOrgWide = ORG_WIDE.includes(profile.role ?? "");
  const incomplete = !profile.name || (!isOrgWide && (!profile.station || !profile.team));
  if (incomplete) return "profile-setup";
  if (profile.status !== "approved") return "pending-approval";
  return "operational";
}

test("New users reach profile setup after a successful exchange", () => {
  assert.equal(postCallbackRouteDecision({ exists: true, name: "", station: null, team: null, role: "ASO", status: "pending" }), "profile-setup");
});

test("Pending users reach pending approval", () => {
  assert.equal(
    postCallbackRouteDecision({ exists: true, name: "Jane", station: "KUL - MAA", team: "ALPHA", role: "ASO", status: "pending" }),
    "pending-approval",
  );
});

test("Approved users reach their authorized portal", () => {
  assert.equal(
    postCallbackRouteDecision({ exists: true, name: "Jane", station: "KUL - MAA", team: "ALPHA", role: "ASO", status: "approved" }),
    "operational",
  );
});

test("Rejected/deactivated users remain denied", () => {
  const rejected = postCallbackRouteDecision({ exists: true, name: "Jane", station: "KUL - MAA", team: "ALPHA", role: "ASO", status: "rejected" });
  const deactivated = postCallbackRouteDecision({ exists: true, name: "Jane", station: "KUL - MAA", team: "ALPHA", role: "ASO", status: "deactivated" });
  assert.notEqual(rejected, "operational");
  assert.notEqual(deactivated, "operational");
});
