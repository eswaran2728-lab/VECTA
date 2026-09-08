import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { ID_TOKEN_COOKIE } from "@/lib/auth/providers/firebase-cookies";

export const dynamic = "force-dynamic";

/**
 * TEMPORARY Phase 3 diagnostic — delete alongside dev-migrate-user before
 * Phase 4. Surfaces the actual Supabase error (not swallowed the way
 * app/page.tsx's `const { data } = await ...` does) for the signed-in
 * caller's own profile lookup, plus a decoded (NOT verified — just
 * base64, for shape inspection only) view of the fb-id-token cookie's
 * payload. Only ever reflects the caller's own cookies/rows back to them.
 */
export async function GET(_request: NextRequest) {
  const cookieStore = await cookies();
  const rawToken = cookieStore.get(ID_TOKEN_COOKIE)?.value ?? null;

  let decodedPayload: unknown = null;
  if (rawToken) {
    try {
      const parts = rawToken.split(".");
      decodedPayload = JSON.parse(Buffer.from(parts[1], "base64").toString("utf8"));
    } catch {
      decodedPayload = "decode-failed";
    }
  }

  const supabase = await createClient();
  const [profilesRes, usersRes] = await Promise.all([
    supabase.from("profiles").select("id, unified_role").limit(5),
    supabase.from("users").select("id, unified_role").limit(5),
  ]);

  return NextResponse.json({
    hasIdTokenCookie: Boolean(rawToken),
    decodedTokenSub: (decodedPayload as { sub?: string } | null)?.sub ?? null,
    decodedTokenAud: (decodedPayload as { aud?: string } | null)?.aud ?? null,
    decodedTokenIss: (decodedPayload as { iss?: string } | null)?.iss ?? null,
    decodedTokenExp: (decodedPayload as { exp?: number } | null)?.exp ?? null,
    nowUnix: Math.floor(Date.now() / 1000),
    profiles: { data: profilesRes.data, error: profilesRes.error },
    users: { data: usersRes.data, error: usersRes.error },
  });
}
