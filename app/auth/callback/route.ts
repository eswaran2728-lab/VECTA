import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// Primary designated administrators
const ADMIN_EMAILS = [
  "eswaranp@airasia.com",
];

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/";

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);

    if (!error) {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (user) {
        const userEmail = (user.email ?? "").toLowerCase().trim();

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

        let profile = avsecProfile ?? icmsProfile;

        // Auto-provision profile if signing in for the first time
        if (!profile) {
          const isAdmin =
            ADMIN_EMAILS.includes(userEmail) ||
            userEmail.startsWith("eswaran") ||
            userEmail.includes("admin");

          const assignedRole = isAdmin ? "ADMIN" : "SO";
          const assignedUnifiedRole = isAdmin ? "admin" : "so";
          const fullName =
            user.user_metadata?.full_name ??
            user.user_metadata?.name ??
            userEmail.split("@")[0] ??
            "AirAsia User";

          // Create/update AVSEC profile
          const { error: profileErr } = await supabase.from("profiles").upsert(
            {
              id: user.id,
              email: userEmail,
              name: fullName,
              role: assignedRole,
              unified_role: assignedUnifiedRole,
              status: "active",
              staff_no: "AA001",
              station: "KUL",
              ops_group: "operation_avsec",
            },
            { onConflict: "id" }
          );

          if (profileErr) {
            console.error("[auth/callback] profile auto-provisioning note:", profileErr.message);
          }

          // Create/update ICMS user record
          await supabase.from("users").upsert(
            {
              id: user.id,
              email: userEmail,
              name: fullName,
              role: isAdmin ? "supervisor" : "hub_avsec",
              unified_role: assignedUnifiedRole,
              status: "active",
            },
            { onConflict: "id" }
          );

          profile = { unified_role: assignedUnifiedRole, status: "active" };
        }

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
