import { NextRequest, NextResponse } from "next/server";
import { getFirebaseAdminAuth } from "@/lib/auth/providers/firebase-admin";
import { syncClaimsForUser } from "@/lib/auth/sync-claims";

export const dynamic = "force-dynamic";

/**
 * Runs on first Google sign-in (called by the client right after
 * establishing a session — see app/api/auth/session/route.ts and
 * components/auth/GoogleSignInButton.tsx) and can be re-run any time to
 * pick up a role change.
 *
 * The client MUST call getIdToken(true) to force a token refresh after
 * this returns — without it the browser keeps using the stale token from
 * before the claim change, and every Supabase RLS query silently returns
 * nothing. This is documented as the single most common failure in this
 * migration (see the master migration plan's Phase 3, step 6) — handled
 * explicitly in GoogleSignInButton.tsx.
 */
export async function POST(request: NextRequest) {
  const authHeader = request.headers.get("authorization") ?? "";
  const bearer = authHeader.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!bearer) {
    return NextResponse.json({ error: "Missing bearer token." }, { status: 401 });
  }

  let decoded;
  try {
    decoded = await getFirebaseAdminAuth().verifyIdToken(bearer);
  } catch {
    return NextResponse.json({ error: "Invalid or expired token." }, { status: 401 });
  }

  // The client-side `hd` hint on the Google provider is a UX convenience,
  // not a security control — a user can bypass it. This is the real check.
  const workspaceDomain = process.env.AVSEC_WORKSPACE_DOMAIN;
  if (!workspaceDomain) {
    return NextResponse.json({ error: "Server misconfigured: AVSEC_WORKSPACE_DOMAIN not set." }, { status: 500 });
  }
  const email = decoded.email ?? "";
  if (!decoded.email_verified || !email.toLowerCase().endsWith(`@${workspaceDomain.toLowerCase()}`)) {
    return NextResponse.json(
      { error: `Only verified @${workspaceDomain} accounts may sign in.` },
      { status: 403 }
    );
  }

  const claims = await syncClaimsForUser(decoded.uid);
  if (!claims) {
    return NextResponse.json(
      { error: "No VECTA account exists for this email yet — contact an admin." },
      { status: 403 }
    );
  }

  return NextResponse.json({ claims });
}
