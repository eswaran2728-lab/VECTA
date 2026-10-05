import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { classifyPortalAccess, isCaterLinkOnly } from "@/lib/auth/caterlink-access";
import { deriveCanonicalAccess, assignmentsFromRpcRows } from "@/lib/auth/canonical-access";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/";

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);

    if (error) {
      // Diagnostic only — server-side log, never exposed to the client
      // or the redirect URL. Message/status only, no code/token/secret
      // values. Without this, "auth-code-error" gives no signal at all
      // about WHY the exchange failed (missing/expired code, PKCE
      // verifier cookie mismatch, provider misconfiguration, etc.) —
      // added while investigating a reported production OAuth failure
      // (2026-09-23) that could not be root-caused from code inspection
      // alone, pending log access.
      console.error("[auth/callback] exchangeCodeForSession failed", {
        message: error.message,
        status: error.status,
        name: error.name,
      });
    }

    if (!error) {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (user) {
        // NOTE: no profile auto-provisioning happens here, deliberately.
        // handle_new_user() (a DB trigger on auth.users AFTER INSERT,
        // fires for every sign-up regardless of provider — email/password
        // or Google OAuth) already inserts a bare (id, email) row into
        // public.profiles with its column defaults: status = 'pending',
        // role = 'ASO'. A brand-new Google user therefore always already
        // has a real, unapproved, unprivileged profile row by the time
        // this callback runs — there is nothing to auto-create, and
        // critically nothing here ever sets status='approved' or guesses
        // a role from the email address. Every non-approved AVSEC user is
        // then routed to profile setup / awaiting-approval by
        // lib/supabase/middleware.ts and lib/avsec/auth.ts requireProfile()
        // — never an operational route, not even briefly.
        const { data: icmsProfile } = await supabase.from("users").select("role, status").eq("id", user.id).maybeSingle();

        // One portal decision from the trusted sources only (canonical assignments + the users-table account
        // row) -- never email or metadata. CaterLink-only identities land in CaterLink; mixed or non-active
        // identities fail closed.
        const { data: cbRows } = await supabase.rpc("get_my_active_role_assignments");
        const portal = classifyPortalAccess(deriveCanonicalAccess(assignmentsFromRpcRows(cbRows)), icmsProfile);
        if (portal.kind === "conflict") return NextResponse.redirect(`${origin}/login?error=conflicting-access`);
        if (portal.kind === "blocked") return NextResponse.redirect(`${origin}/login?error=${encodeURIComponent(portal.status ?? "pending")}`);
        if (isCaterLinkOnly(portal.kind)) return NextResponse.redirect(`${origin}/caterlink/dashboard`);
      }

      const forwardedHost = request.headers.get("x-forwarded-host");
      const isLocalEnv = process.env.NODE_ENV === "development";
      if (isLocalEnv) {
        return NextResponse.redirect(`${origin}${next}`);
      } else if (forwardedHost) {
        return NextResponse.redirect(`https://${forwardedHost}${next}`);
      } else {
        return NextResponse.redirect(`${origin}${next}`);
      }
    }
  }

  return NextResponse.redirect(`${origin}/login?error=auth-code-error`);
}
