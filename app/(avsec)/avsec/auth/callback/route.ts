import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

// Password reset via Supabase email will be phased out once Google Workspace
// SSO is implemented — login will go through Google entirely, so this flow
// becomes unused. No fix needed now or later (the emailed ?next= link still
// points at the pre-merge /auth/update-password path, not /avsec/auth/...).
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  // Password reset links pass ?next=/auth/update-password so this route can land the
  // recovered session on the "set a new password" screen instead of the app home.
  const next = searchParams.get("next") || "/";

  if (code) {
    const supabase = await createClient();
    await supabase.auth.exchangeCodeForSession(code);
  }

  return NextResponse.redirect(`${origin}${next}`);
}
