import { NextRequest, NextResponse } from "next/server";
import { getFirebaseAdminAuth } from "@/lib/auth/providers/firebase-admin";
import { syncClaimsForUser } from "@/lib/auth/sync-claims";

export const dynamic = "force-dynamic";

/**
 * CaterLink is a separately deployed app on its own origin (same pattern
 * as the existing /api/icms/qr/mint cross-app endpoint) — its
 * GoogleSignInButton calls this route directly rather than VECTA hosting
 * a second copy, since public.user_claims/setCustomUserClaims should
 * have exactly one caller. CORS is scoped to a single configured origin,
 * never a wildcard — a token-bearing endpoint has no business accepting
 * requests from arbitrary origins.
 */
const ALLOWED_ORIGIN = process.env.CATERLINK_APP_URL;

function withCors(response: NextResponse, origin: string | null): NextResponse {
  if (ALLOWED_ORIGIN && origin === ALLOWED_ORIGIN) {
    response.headers.set("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
    response.headers.set("Vary", "Origin");
  }
  return response;
}

export async function OPTIONS(request: NextRequest) {
  const response = new NextResponse(null, { status: 204 });
  response.headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  response.headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  return withCors(response, request.headers.get("origin"));
}

/**
 * Runs on first Google sign-in (called by the client right after
 * establishing a session — see app/api/auth/session/route.ts and
 * components/auth/GoogleSignInButton.tsx, in both this repo and
 * CATERLINK's) and can be re-run any time to pick up a role change.
 *
 * The client MUST call getIdToken(true) to force a token refresh after
 * this returns — without it the browser keeps using the stale token from
 * before the claim change, and every Supabase RLS query silently returns
 * nothing. This is documented as the single most common failure in this
 * migration (see the master migration plan's Phase 3, step 6) — handled
 * explicitly in GoogleSignInButton.tsx.
 */
export async function POST(request: NextRequest) {
  const origin = request.headers.get("origin");

  const authHeader = request.headers.get("authorization") ?? "";
  const bearer = authHeader.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!bearer) {
    return withCors(NextResponse.json({ error: "Missing bearer token." }, { status: 401 }), origin);
  }

  let decoded;
  try {
    decoded = await getFirebaseAdminAuth().verifyIdToken(bearer);
  } catch {
    return withCors(NextResponse.json({ error: "Invalid or expired token." }, { status: 401 }), origin);
  }

  // The client-side `hd` hint on the Google provider is a UX convenience,
  // not a security control — a user can bypass it. This is the real check.
  const workspaceDomain = process.env.AVSEC_WORKSPACE_DOMAIN;
  if (!workspaceDomain) {
    return withCors(
      NextResponse.json({ error: "Server misconfigured: AVSEC_WORKSPACE_DOMAIN not set." }, { status: 500 }),
      origin
    );
  }
  const email = decoded.email ?? "";
  if (!decoded.email_verified || !email.toLowerCase().endsWith(`@${workspaceDomain.toLowerCase()}`)) {
    return withCors(
      NextResponse.json({ error: `Only verified @${workspaceDomain} accounts may sign in.` }, { status: 403 }),
      origin
    );
  }

  const claims = await syncClaimsForUser(decoded.uid);
  if (!claims) {
    return withCors(
      NextResponse.json(
        { error: "No VECTA account exists for this email yet — contact an admin." },
        { status: 403 }
      ),
      origin
    );
  }

  return withCors(NextResponse.json({ claims }), origin);
}
