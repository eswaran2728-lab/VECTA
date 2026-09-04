import type { AuthProvider } from "../types";

/**
 * Phase 3 stub. Implemented once Firebase Auth (Google Workspace sign-in)
 * is wired up — see the master migration plan's Phase 3. Selecting
 * AUTH_PROVIDER=firebase before then is a configuration error, not a
 * silent fallback.
 */
function notImplemented(): never {
  throw new Error(
    "AUTH_PROVIDER=firebase is not implemented yet — Firebase Auth lands in Phase 3."
  );
}

export const firebaseAuthProvider: AuthProvider = {
  signIn: notImplemented,
  signOut: notImplemented,
  getSession: notImplemented,
  getUser: notImplemented,
  getAccessToken: notImplemented,
  onAuthStateChange: notImplemented,
  refresh: notImplemented,
};
