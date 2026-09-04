import { NextRequest, NextResponse } from "next/server";
import { getFirebaseAdminAuth } from "@/lib/auth/providers/firebase-admin";
import { SESSION_COOKIE, ID_TOKEN_COOKIE, SESSION_MAX_AGE_S, ID_TOKEN_MAX_AGE_S } from "@/lib/auth/providers/firebase-cookies";

export const dynamic = "force-dynamic";

/**
 * Establishes a server-readable session from a client-obtained Firebase ID
 * token (see components/auth/GoogleSignInButton.tsx — Google sign-in
 * itself is inherently a browser operation, done via signInWithPopup, not
 * something a Server Action can do). Sets two httpOnly cookies:
 *   - fb-session: a long-lived Firebase session cookie, what
 *     lib/auth/providers/firebase.ts's getUser()/getSession() verify.
 *   - fb-id-token: the raw ID token, refreshed on every call to this route
 *     — used only for getAccessToken() (the cross-app bearer-token flow to
 *     CaterLink's QR mint endpoint). This cookie goes stale after ~1 hour
 *     if the client doesn't re-establish the session; see
 *     lib/auth/providers/firebase.ts's header comment for the known
 *     limitation this leaves for Phase 4.
 *
 * Does NOT re-check the workspace domain — /api/auth/sync-claims does
 * that and is always called immediately after this by
 * GoogleSignInButton.tsx. This route only establishes the session; it
 * does not decide who's allowed to have one.
 */
export async function POST(request: NextRequest) {
  let body: { idToken?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const idToken = body.idToken;
  if (!idToken) {
    return NextResponse.json({ error: "Missing idToken." }, { status: 400 });
  }

  const auth = getFirebaseAdminAuth();
  try {
    await auth.verifyIdToken(idToken);
  } catch {
    return NextResponse.json({ error: "Invalid or expired token." }, { status: 401 });
  }

  const sessionCookie = await auth.createSessionCookie(idToken, {
    expiresIn: SESSION_MAX_AGE_S * 1000,
  });

  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, sessionCookie, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_S,
  });
  response.cookies.set(ID_TOKEN_COOKIE, idToken, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: ID_TOKEN_MAX_AGE_S,
  });
  return response;
}
