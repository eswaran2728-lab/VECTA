import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

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
        const [{ data: avsecProfile }, { data: icmsProfile }] = await Promise.all([
          supabase.from("profiles").select("unified_role, status").eq("id", user.id).maybeSingle(),
          supabase.from("users").select("unified_role, status").eq("id", user.id).maybeSingle(),
        ]);
        const profile = avsecProfile ?? icmsProfile;

        // Segregate access: Vendor / Driver accounts belong strictly in CaterLink
        if (profile?.unified_role === "vendor") {
          return NextResponse.redirect(`${origin}/login?error=caterlink-only`);
        }
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
