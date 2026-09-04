import { NextResponse, type NextRequest } from "next/server";
import { isCheckinGateExempt, isAdminPathForbidden } from "./middleware-gate-logic";
import { resolveMiddlewareUser } from "@/lib/auth/providers/supabase";

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
const PUBLIC_PATHS = ["/login"];

export async function updateSession(request: NextRequest) {
  // KNOWN LIMITATION (Phase 3): this middleware runs on the Edge runtime,
  // but Firebase Admin SDK's session-cookie verification needs Node.js —
  // it isn't Edge-compatible. Rather than attempt broken verification
  // here, AUTH_PROVIDER=firebase skips this entire cookie-based gate and
  // passes every request through untouched. This is NOT a security
  // regression: every page/action's own requireProfile()/requireRole()
  // (lib/icms/auth.ts, lib/avsec/auth.ts) and RLS remain the authoritative
  // checks regardless of what middleware does — this file's checks
  // (check-in gate, admin-path forbidding) are explicitly documented
  // elsewhere as additive UX/defense-in-depth, not the real boundary. Fix
  // before relying on the check-in gate under Firebase: verify the
  // fb-id-token cookie statelessly with `jose` against Google's JWKS
  // (Edge-compatible), rather than the Admin SDK's verifySessionCookie().
  if (process.env.AUTH_PROVIDER === "firebase") {
    return NextResponse.next({ request });
  }

  const { user, response: supabaseResponse, client: supabase } = await resolveMiddlewareUser(
    request
  );

  const path = request.nextUrl.pathname;
  const isPublic = PUBLIC_PATHS.some((p) => path.startsWith(p));
  const isGated = path.startsWith("/icms") || path.startsWith("/avsec");
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

  if (user && path === "/login") {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    url.search = "";
    return NextResponse.redirect(url);
  }

  // --- Role + check-in gate ---
  if (user && isGated) {
    // Unified profile lives in whichever app's table the account was
    // created through — AVSEC's public.profiles or ICMS's public.users —
    // both now carry the same unified_role vocabulary in this shared project.
    const [{ data: avsecProfile }, { data: icmsProfile }] = await Promise.all([
      supabase
        .from("profiles")
        .select("unified_role, status")
        .eq("id", user.id)
        .maybeSingle(),
      supabase
        .from("users")
        .select("unified_role, status")
        .eq("id", user.id)
        .maybeSingle(),
    ]);
    const profile = avsecProfile ?? icmsProfile;

    const activeStatuses = ["approved", "active"];
    if (!profile || !activeStatuses.includes(profile.status as string)) {
      const url = request.nextUrl.clone();
      url.pathname = "/login";
      url.searchParams.set("error", profile ? String(profile.status) : "no-profile");
      return NextResponse.redirect(url);
    }

    const role = profile.unified_role as string | null;
    // ICMS-origin checkpoint accounts (post2_avsec/post6_avsec/hub_avsec/
    // redq_avsec — no row in public.profiles) have no way to ever satisfy
    // this gate: check-in/duty_records/team_rosters are entirely AVSEC-side
    // concepts keyed to a profiles row. Without this exemption, clicking
    // into any gated route sent them to /avsec/duty, whose own
    // requireProfile() (profiles-table only) found nothing and bounced them
    // to /login, which — since they're still authenticated — immediately
    // redirected back to "/", i.e. every click looped back to the
    // dashboard. Same underlying reason as the vendor exemption: the
    // AirAsia attendance/check-in concept doesn't apply to accounts that
    // don't live in AVSEC's own tables.
    const icmsOnlyExempt = !avsecProfile && Boolean(icmsProfile);
    const exempt = isCheckinGateExempt(role) || icmsOnlyExempt;
    const alreadyOnCheckin = path.startsWith("/avsec/duty");

    // Coarse edge-level defense-in-depth for the admin section: additive to,
    // not a replacement for, RLS and requireRole(["ADMIN"]) in the page/
    // action code. A non-admin unified_role hitting /avsec/admin/* is
    // bounced straight back to "/" here, before any admin-only query runs.
    if (isAdminPathForbidden(path, role)) {
      const url = request.nextUrl.clone();
      url.pathname = "/";
      url.search = "";
      url.searchParams.set("error", "forbidden");
      return NextResponse.redirect(url);
    }

    if (!exempt && !alreadyOnCheckin) {
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
