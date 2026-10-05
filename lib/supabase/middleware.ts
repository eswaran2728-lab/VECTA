import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import {
  isCheckinGateExempt,
  isAdminPathForbiddenFor,
  isSuperAdminPathForbidden,
  isOperationalPathForbiddenForSuperAdmin,
  isReadinessPath,
  effectiveGateRole,
  isExternalCaterLinkRole,
  isShiftBasedAccess,
} from "./middleware-gate-logic";
import { deriveCanonicalAccess, assignmentsFromRpcRows } from "../auth/canonical-access";


// Unified role vocabulary (see supabase/migrations/unified_role_model and
// the merge report): admin, management, enforcement, so, aso, dse, vendor.
// Values live in the `unified_role` column on both public.profiles
// (AVSEC-origin) and public.users (ICMS-origin) — the original per-app
// role columns/enums are untouched, see that migration's header comment
// for why a rename-in-place was too risky to do live.

// Seniority/vendor check-in exemptions and the admin-path gate now live in
// ./middleware-gate-logic (pure, framework-free — see that module and
// tests/middleware-gate-logic.test.mts).

// so / aso / dse are all subject to the check-in gate regardless of
// duty_post/station — there is no station-based exemption.

// No self-registration: accounts are admin/management-created only, via
// the Admin panel (/avsec/admin/users, app/(icms)/icms/admin/users) —
// there is no public sign-up route, so /login is the only public path.
// Full SSO via AirAsia's Google Workspace domain is planned as a future
// replacement for Supabase email/password auth, but that's a later
// migration — for now Supabase auth continues, just without any
const PUBLIC_PATHS = [
  "/login",
  "/register",
  "/forgot-password",
  "/reset-password",
  "/auth/callback",
  "/auth",
  "/manifest.json",
  "/favicon.ico",
];

export function sanitizeNextPath(next: string | null): string | null {
  if (!next) return null;
  const trimmed = next.trim();
  if (
    trimmed.startsWith("/") &&
    !trimmed.startsWith("//") &&
    !trimmed.startsWith("/\\") &&
    !trimmed.includes(":")
  ) {
    return trimmed;
  }
  return null;
}



export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // IMPORTANT: do not add logic between createServerClient and getUser();
  // it can cause session refresh race conditions.
  let user = null;
  try {
    const {
      data: { user: fetchedUser },
    } = await supabase.auth.getUser();
    user = fetchedUser;
  } catch {
    // Stale/invalid refresh token cookie: treat as signed out.
    user = null;
  }

  const path = request.nextUrl.pathname;
  const isPublic = PUBLIC_PATHS.some((p) => path.startsWith(p));
  const isGated = path.startsWith("/icms") || path.startsWith("/avsec") || path.startsWith("/caterlink") || path.startsWith("/super-admin");
  // API routes authenticate themselves (requireRole()/auth.getUser() per
  // route — see app/api/**) and some, like /api/icms/qr/mint, are meant to
  // be called server-to-server with a Bearer token and no cookies at all.
  // Without this exclusion every such call hit the cookie-based "no user"
  // redirect below before its own route logic ever ran: the caller got a
  // 200 with the /login page's HTML (a followed redirect), never JSON.
  const isApi = path.startsWith("/api/");

  if (!user && !isPublic && !isApi) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", path);
    const redirectResponse = NextResponse.redirect(url);
    request.cookies.getAll().forEach(({ name }) => {
      if (name.startsWith("sb-")) redirectResponse.cookies.delete(name);
    });
    return redirectResponse;
  }

  // Absorb and neutralize any stale POST /login requests from older cached clients
  if (request.method === "POST" && path === "/login") {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    return NextResponse.redirect(url, { status: 303 });
  }

  if (user && path === "/login") {
    if (request.nextUrl.searchParams.has("error")) {
      return supabaseResponse;
    }

    // Canonical decision only: active Phase 3 assignments.
    const { data: loginRows } = await supabase.rpc("get_my_active_role_assignments");
    const loginAccess = deriveCanonicalAccess(assignmentsFromRpcRows(loginRows));
    if (loginAccess.isSuperAdmin) {
      const url = request.nextUrl.clone();
      url.pathname = "/super-admin";
      url.search = "";
      return NextResponse.redirect(url);
    }

    // External CaterLink identity = the ICMS users-table role, never an email/metadata string.
    let landing = "/";
    if (!loginAccess.hasAssignment) {
      const { data: loginIcms } = await supabase.from("users").select("role").eq("id", user.id).maybeSingle();
      if (isExternalCaterLinkRole(loginIcms?.role as string | undefined)) landing = "/caterlink/dashboard";
    }

    const url = request.nextUrl.clone();
    url.pathname = landing;
    url.search = "";
    return NextResponse.redirect(url);
  }

  // Phase 13 readiness portal: canonical Phase 3 role-assignment gate only.
  // Runs before the legacy profile lookup below, which selects
  // profiles.unified_role (absent on the staging baseline).
  if (user && isReadinessPath(path)) {
    const { data: isActiveSuperAdmin } = await supabase.rpc("has_active_role", { p_role_code: "super_admin" });
    if (isActiveSuperAdmin !== true) {
      const url = request.nextUrl.clone();
      url.pathname = "/";
      url.search = "";
      url.searchParams.set("error", "forbidden");
      return NextResponse.redirect(url);
    }
    return supabaseResponse;
  }

  // --- Role + check-in gate ---
  if (user && (isGated || path === "/")) {
    // Canonical access: the caller's own active Phase 3 assignments
    // (auth.uid() identity, approved profile, active role definition,
    // non-revoked, effective dates all enforced inside the RPC).
    const { data: assignmentRows } = await supabase.rpc("get_my_active_role_assignments");
    const access = deriveCanonicalAccess(assignmentsFromRpcRows(assignmentRows));

    // Legacy tables are read ONLY for account status and to recognise
    // ICMS-origin external CaterLink identities -- never to grant anything.
    const [{ data: avsecProfile }, { data: icmsProfile }] = await Promise.all([
      supabase.from("profiles").select("status").eq("id", user.id).maybeSingle(),
      supabase.from("users").select("role, status").eq("id", user.id).maybeSingle(),
    ]);
    const icmsRole = (icmsProfile?.role ?? null) as string | null;
    const isCaterLinkUser = !access.hasAssignment && isExternalCaterLinkRole(icmsRole);

    // Seamless URL remapping: redirect drivers visiting /icms to /caterlink --
    // but only for the paths next.config.ts actually rewrites back
    // (dashboard, transactions, vendor-transactions). A driver hitting an
    // unmapped ICMS path must NOT be remapped to a /caterlink/* URL with no
    // matching rewrite; falling through lets the page's own requireRole()
    // check redirect to /icms/dashboard?error=forbidden.
    const CATERLINK_REMAPPED_PREFIXES = ["/icms/dashboard", "/icms/transactions", "/icms/vendor-transactions"];
    if (isCaterLinkUser && CATERLINK_REMAPPED_PREFIXES.some((p) => path === p || path.startsWith(p + "/"))) {
      const url = request.nextUrl.clone();
      url.pathname = path.replace(/^\/icms/, "/caterlink");
      return NextResponse.redirect(url);
    }

    // Boundary Gate: external CaterLink accounts trying to access AVSEC go to CaterLink
    if (isCaterLinkUser && path.startsWith("/avsec")) {
      const url = request.nextUrl.clone();
      url.pathname = "/caterlink/dashboard";
      return NextResponse.redirect(url);
    }

    // Pending/rejected/deactivated users are routed to profile setup / the
    // "awaiting approval" page -- never to an operational route.
    const activeStatuses = ["approved", "active"];
    const onOwnStatusPages = path.startsWith("/avsec/profile-setup") || path.startsWith("/avsec/pending-approval");
    if (avsecProfile && avsecProfile.status && !activeStatuses.includes(avsecProfile.status as string) && !onOwnStatusPages) {
      const url = request.nextUrl.clone();
      url.pathname = "/avsec/profile-setup";
      url.search = "";
      return NextResponse.redirect(url);
    }
    if (!avsecProfile && icmsProfile && icmsProfile.status && !activeStatuses.includes(icmsProfile.status as string)) {
      const url = request.nextUrl.clone();
      url.pathname = "/login";
      url.searchParams.set("error", String(icmsProfile.status));
      return NextResponse.redirect(url);
    }

    // An approved AVSEC profile with no active assignment has no operational access.
    if (avsecProfile && !access.hasAssignment && path.startsWith("/avsec") && !onOwnStatusPages) {
      const url = request.nextUrl.clone();
      url.pathname = "/avsec/pending-approval";
      url.search = "";
      return NextResponse.redirect(url);
    }

    const role = effectiveGateRole(access, icmsRole);

    // Super Admin: platform portal only. Forbidden from operational routes.
    if (isOperationalPathForbiddenForSuperAdmin(path, role) || (path === "/" && role === "super_admin")) {
      const url = request.nextUrl.clone();
      url.pathname = "/super-admin";
      url.search = "";
      return NextResponse.redirect(url);
    }

    // Non-super-admins forbidden from /super-admin
    if (isSuperAdminPathForbidden(path, role)) {
      const url = request.nextUrl.clone();
      url.pathname = "/";
      url.search = "";
      url.searchParams.set("error", "forbidden");
      return NextResponse.redirect(url);
    }

    // Boundary Gate: external CaterLink accounts are restricted from AVSEC
    if (role === "vendor" && path.startsWith("/avsec")) {
      const url = request.nextUrl.clone();
      url.pathname = "/caterlink/dashboard";
      return NextResponse.redirect(url);
    }

    // ICMS-origin accounts (public.users, no profiles row) have no duty
    // check-in concept. Canonical accounts are subject to the check-in gate
    // only when they hold a shift-based (ASO/SO/DSE rank) role.
    const icmsOnlyExempt = !avsecProfile && Boolean(icmsProfile);
    const checkinRequired = access.hasAssignment ? isShiftBasedAccess(access) : false;
    const exempt = !checkinRequired || icmsOnlyExempt || path.startsWith("/icms") || path.startsWith("/caterlink") || path.startsWith("/super-admin");
    const alreadyOnCheckin =
      path.startsWith("/avsec/duty") ||
      path.startsWith("/avsec/profile-setup") ||
      path.startsWith("/avsec/pending-approval");

    // Coarse edge-level defense-in-depth for the admin section:
    if (isAdminPathForbiddenFor(path, role, access)) {
      const url = request.nextUrl.clone();
      url.pathname = "/";
      url.search = "";
      url.searchParams.set("error", "forbidden");
      return NextResponse.redirect(url);
    }

    if (!exempt && !alreadyOnCheckin && path.startsWith("/avsec")) {
      const today = new Date().toISOString().slice(0, 10);
      const { data: dutyRecord, error } = await supabase
        .from("duty_records")
        .select("check_in_at, check_out_at")
        .eq("profile_id", user.id)
        .eq("duty_date", today)
        .not("check_in_at", "is", null)
        .order("check_in_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      // duty_records now exists in this shared project (migrated from
      // ICMS/created by AVSEC — see the merge report), so a query error
      // here is a real failure, not "table doesn't exist yet". Fail
      // CLOSED: block access and log, rather than silently letting a
      // non-exempt user through with no check-in record.
      if (error) {
        console.error("[middleware] duty_records check-in gate query failed", {
          userId: user.id,
          path,
          error: error.message,
        });
        const url = request.nextUrl.clone();
        url.pathname = "/login";
        url.searchParams.set("error", "checkin-gate-unavailable");
        return NextResponse.redirect(url);
      }

      if (!dutyRecord) {
        const url = request.nextUrl.clone();
        url.pathname = "/avsec/duty";
        url.searchParams.set("next", path);
        return NextResponse.redirect(url);
      }
    }
  }

  return supabaseResponse;
}
