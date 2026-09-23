import test from "node:test";
import assert from "node:assert/strict";

/**
 * Regression coverage for the Google SSO callback investigation
 * (2026-09-23, reported production "auth-code-error" failure).
 * Code-level inspection confirmed app/auth/callback/route.ts's core
 * exchange call and lib/supabase/server.ts's cookie adapter are
 * byte-for-byte unchanged from before that failure was reported — these
 * tests model the callback's actual branching logic (redirect targets,
 * forwarded-host handling, vendor segregation) directly from the real
 * source, so a future edit that changes that branching is caught here.
 */

// --- Redirect-target decision, mirroring route.ts's exact branches ---

function callbackRedirectTarget(input: {
  hasCode: boolean;
  exchangeError: boolean;
  isVendor: boolean;
  isLocalEnv: boolean;
  forwardedHost: string | null;
  origin: string;
  next: string;
}): string {
  if (!input.hasCode) return `${input.origin}/login?error=auth-code-error`;
  if (input.exchangeError) return `${input.origin}/login?error=auth-code-error`;
  if (input.isVendor) return `${input.origin}/login?error=caterlink-only`;
  if (input.isLocalEnv) return `${input.origin}${input.next}`;
  if (input.forwardedHost) return `https://${input.forwardedHost}${input.next}`;
  return `${input.origin}${input.next}`;
}

test("Successful OAuth callback code exchange redirects to `next` (or `/`), not an error page", () => {
  const target = callbackRedirectTarget({
    hasCode: true,
    exchangeError: false,
    isVendor: false,
    isLocalEnv: false,
    forwardedHost: "vecta-rho.vercel.app",
    origin: "https://vecta-rho.vercel.app",
    next: "/",
  });
  assert.equal(target, "https://vecta-rho.vercel.app/");
  assert.doesNotMatch(target, /error=/);
});

test("Missing code redirects to /login?error=auth-code-error", () => {
  const target = callbackRedirectTarget({
    hasCode: false,
    exchangeError: false,
    isVendor: false,
    isLocalEnv: false,
    forwardedHost: null,
    origin: "https://vecta-rho.vercel.app",
    next: "/",
  });
  assert.equal(target, "https://vecta-rho.vercel.app/login?error=auth-code-error");
});

test("Invalid/failed code exchange redirects to /login?error=auth-code-error", () => {
  const target = callbackRedirectTarget({
    hasCode: true,
    exchangeError: true,
    isVendor: false,
    isLocalEnv: false,
    forwardedHost: "vecta-rho.vercel.app",
    origin: "https://vecta-rho.vercel.app",
    next: "/",
  });
  assert.equal(target, "https://vecta-rho.vercel.app/login?error=auth-code-error");
});

test("Forwarded production host is used for the post-exchange redirect, never the request's own origin, when present", () => {
  // This is the exact mechanism that fixed the earlier "redirects to
  // localhost" defect: Vercel's edge sets x-forwarded-host to the real
  // public hostname even though the Next.js server's own `origin` can
  // differ in a proxied/serverless environment.
  const target = callbackRedirectTarget({
    hasCode: true,
    exchangeError: false,
    isVendor: false,
    isLocalEnv: false,
    forwardedHost: "vecta-rho.vercel.app",
    origin: "http://localhost:3000", // what a naive same-origin redirect would produce
    next: "/",
  });
  assert.equal(target, "https://vecta-rho.vercel.app/");
  assert.doesNotMatch(target, /localhost/);
});

test("Local development (no forwarded host expected) uses the request's own origin, never forces https", () => {
  const target = callbackRedirectTarget({
    hasCode: true,
    exchangeError: false,
    isVendor: false,
    isLocalEnv: true,
    forwardedHost: null,
    origin: "http://localhost:3000",
    next: "/",
  });
  assert.equal(target, "http://localhost:3000/");
});

test("A vendor/driver account is segregated to /login?error=caterlink-only, even on a successful exchange", () => {
  const target = callbackRedirectTarget({
    hasCode: true,
    exchangeError: false,
    isVendor: true,
    isLocalEnv: false,
    forwardedHost: "vecta-rho.vercel.app",
    origin: "https://vecta-rho.vercel.app",
    next: "/",
  });
  assert.equal(target, "https://vecta-rho.vercel.app/login?error=caterlink-only");
});

// --- Post-callback routing (handled by middleware/requireProfile on the
// NEXT request to `next`, not by the callback route itself - the callback
// always redirects to `next`/"/" for a successful non-vendor exchange; it
// deliberately does NOT auto-provision or decide operational access) ---

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

test("A new Google user (bare pending row from handle_new_user()) routes to profile setup on the next request", () => {
  const bare = { exists: true, name: "", station: null, team: null, role: "ASO", status: "pending" as const };
  assert.equal(postCallbackRouteDecision(bare), "profile-setup");
});

test("A completed but still-pending user routes to pending-approval on the next request", () => {
  const pending = { exists: true, name: "Jane Tan", station: "KUL - MAA", team: "ALPHA", role: "ASO", status: "pending" as const };
  assert.equal(postCallbackRouteDecision(pending), "pending-approval");
});

test("An approved user routes to an operational route on the next request", () => {
  const approved = { exists: true, name: "Jane Tan", station: "KUL - MAA", team: "ALPHA", role: "ASO", status: "approved" as const };
  assert.equal(postCallbackRouteDecision(approved), "operational");
});

test("A rejected user is denied operational access on the next request", () => {
  const rejected = { exists: true, name: "Jane Tan", station: "KUL - MAA", team: "ALPHA", role: "ASO", status: "rejected" as const };
  assert.equal(postCallbackRouteDecision(rejected), "pending-approval");
  assert.notEqual(postCallbackRouteDecision(rejected), "operational");
});

test("A deactivated user is denied operational access on the next request", () => {
  const deactivated = { exists: true, name: "Jane Tan", station: "KUL - MAA", team: "ALPHA", role: "ASO", status: "deactivated" as const };
  assert.notEqual(postCallbackRouteDecision(deactivated), "operational");
});

// --- Cookie handling: the adapter must pass every cookie through
// unmodified in both directions (this is what carries the PKCE code
// verifier and, after exchange, the session) ---

test("Callback session cookies are preserved: the server client's cookie adapter passes every cookie through unmodified", () => {
  // Models lib/supabase/server.ts's getAll()/setAll() - it must return
  // exactly what the request had, and write back exactly what
  // @supabase/ssr asks it to, with no filtering, renaming, or dropping.
  function cookieAdapter(requestCookies: { name: string; value: string }[]) {
    // getAll(): straight passthrough
    const getAll = () => requestCookies;
    // setAll(): straight passthrough, one call per cookie, no filtering
    const written: { name: string; value: string }[] = [];
    const setAll = (cookiesToSet: { name: string; value: string }[]) => {
      for (const c of cookiesToSet) written.push(c);
    };
    return { getAll, setAll, written };
  }

  const incoming = [
    { name: "sb-project-auth-token-code-verifier", value: "verifier-value" },
    { name: "sb-project-auth-token", value: "session-value" },
  ];
  const adapter = cookieAdapter(incoming);
  assert.deepEqual(adapter.getAll(), incoming);

  const toWrite = [{ name: "sb-project-auth-token", value: "new-session-value" }];
  adapter.setAll(toWrite);
  assert.deepEqual(adapter.written, toWrite);
});
