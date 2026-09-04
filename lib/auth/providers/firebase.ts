import "server-only";

import { cookies } from "next/headers";
import { getFirebaseAdminAuth } from "./firebase-admin";
import { SESSION_COOKIE, ID_TOKEN_COOKIE } from "./firebase-cookies";
import type { AuthProvider, AuthSession, AuthUser, SignInResult } from "../types";

function toAuthUser(decoded: { uid: string; email?: string }): AuthUser {
  return { id: decoded.uid, email: decoded.email ?? null };
}

export const firebaseAuthProvider: AuthProvider = {
  async signIn(): Promise<SignInResult> {
    // Google sign-in is inherently a browser operation (signInWithPopup),
    // not something a server-side password call can do — there is no
    // Firebase equivalent of Supabase's signInWithPassword() to call here.
    // The real flow: components/auth/GoogleSignInButton.tsx runs
    // signInWithPopup client-side, then POSTs the resulting ID token to
    // /api/auth/session (which this adapter's getUser()/getSession() then
    // read back via the fb-session cookie it sets).
    return {
      user: null,
      error:
        "Firebase auth uses Google sign-in (see GoogleSignInButton), not email/password.",
    };
  },

  async signOut(): Promise<void> {
    const store = await cookies();
    const sessionCookie = store.get(SESSION_COOKIE)?.value;
    if (sessionCookie) {
      try {
        const decoded = await getFirebaseAdminAuth().verifySessionCookie(sessionCookie);
        // Best-effort: invalidates the session server-side too, not just
        // the cookie, so a copied cookie can't keep working after sign-out.
        await getFirebaseAdminAuth().revokeRefreshTokens(decoded.uid);
      } catch {
        // Already invalid/expired — nothing to revoke.
      }
    }
    store.set(SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
    store.set(ID_TOKEN_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  },

  async getSession(): Promise<AuthSession | null> {
    const store = await cookies();
    const sessionCookie = store.get(SESSION_COOKIE)?.value;
    if (!sessionCookie) return null;
    try {
      const decoded = await getFirebaseAdminAuth().verifySessionCookie(sessionCookie, true);
      const accessToken = store.get(ID_TOKEN_COOKIE)?.value ?? "";
      return { user: toAuthUser(decoded), accessToken };
    } catch {
      return null;
    }
  },

  async getUser(): Promise<AuthUser | null> {
    const store = await cookies();
    const sessionCookie = store.get(SESSION_COOKIE)?.value;
    if (!sessionCookie) return null;
    try {
      const decoded = await getFirebaseAdminAuth().verifySessionCookie(sessionCookie, true);
      return toAuthUser(decoded);
    } catch {
      return null;
    }
  },

  async getAccessToken(): Promise<string | null> {
    // Returns the raw ID token cookie set at session-establishment time —
    // NOT re-minted here. Known limitation for the CaterLink -> VECTA QR
    // mint bearer-token flow (lib/actions/transactions.ts,
    // vendor-transactions.ts in CATERLINK): this token is only valid for
    // ~1 hour and there's no server-side refresh path the way Supabase's
    // session refresh has one, since Firebase ID token minting requires
    // the client SDK's refresh-token exchange. If a user's session outlives
    // that window without a page load that re-establishes it (which calls
    // /api/auth/session again), getAccessToken() here can return a stale
    // token that VECTA's getBearerAuth() rejects as expired. Flagged for
    // Phase 4 cutover: either add a client-side onIdTokenChanged listener
    // that periodically re-POSTs to /api/auth/session, or redesign the
    // cross-app QR mint call to not depend on a bearer token's freshness
    // matching the browser session's.
    const store = await cookies();
    return store.get(ID_TOKEN_COOKIE)?.value ?? null;
  },

  onAuthStateChange(): () => void {
    // Server-side only adapter — no live subscription here, same as the
    // Supabase adapter. Firebase's client SDK has its own
    // onAuthStateChanged/onIdTokenChanged for client components.
    return () => {};
  },

  async refresh(): Promise<AuthSession | null> {
    // Session cookies don't need active refreshing the way Supabase JWTs
    // do — they're valid for the duration set at creation
    // (createSessionCookie's expiresIn, up to 14 days). This just
    // re-verifies the current one.
    return this.getSession();
  },
};
