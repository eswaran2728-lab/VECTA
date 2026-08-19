import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// Roles stored on ICMS's `users.role` column (see lib/icms/database.types.ts).
// "supervisor" is labeled "Admin" in the UI; there is currently no ICMS-side
// equivalent of AVSEC's "MANAGEMENT" role — flagged in the merge report.
const EXEMPT_FROM_CHECKIN: string[] = ["supervisor", "enforcement"];

const PUBLIC_PATHS = ["/login", "/icms/register"];

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
  const isGated = path.startsWith("/icms") || path.startsWith("/avsec");

  if (!user && !isPublic) {
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

  // --- Role + check-in gate (Phase 6) ---
  if (user && isGated) {
    const { data: profile } = await supabase
      .from("users")
      .select("role, status")
      .eq("id", user.id)
      .single();

    const role = profile?.role as string | undefined;

    if (!profile || profile.status !== "active") {
      const url = request.nextUrl.clone();
      url.pathname = "/login";
      url.searchParams.set("error", profile ? profile.status : "no-profile");
      return NextResponse.redirect(url);
    }

    const exempt = role ? EXEMPT_FROM_CHECKIN.includes(role) : false;
    const alreadyOnCheckin = path.startsWith("/avsec/duty");

    if (!exempt && !alreadyOnCheckin) {
      const today = new Date().toISOString().slice(0, 10);
      // duty_records lives in AVSEC's schema (profile_id, duty_date,
      // check_in_at, check_out_at). Until the two Supabase projects are
      // merged this table may not exist under the single ICMS project —
      // in that case we fail open (skip the gate) rather than lock every
      // non-exempt user out, and this is called out in the merge report.
      const { data: dutyRecord, error } = await supabase
        .from("duty_records")
        .select("check_in_at, check_out_at")
        .eq("profile_id", user.id)
        .eq("duty_date", today)
        .not("check_in_at", "is", null)
        .order("check_in_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!error && !dutyRecord) {
        const url = request.nextUrl.clone();
        url.pathname = "/avsec/duty";
        url.searchParams.set("next", path);
        return NextResponse.redirect(url);
      }
    }
  }

  return supabaseResponse;
}
