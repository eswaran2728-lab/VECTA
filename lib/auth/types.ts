/**
 * Provider-agnostic auth types. See lib/auth/provider.ts for how the
 * active provider is selected, and AUTH-CONTRACT.md (Phase 2) for the
 * full role/team/station claim shape once it lands.
 */

export interface AuthUser {
  id: string;
  email: string | null;
}

export interface AuthSession {
  user: AuthUser;
  accessToken: string;
}

/**
 * Placeholder for the normalised app_role/team/station/staff_id/vendor_id
 * claim shape defined in AUTH-CONTRACT.md (Phase 2). Not used yet — role
 * and status resolution still goes through each app's own profile table
 * (lib/icms/auth.ts, lib/avsec/auth.ts) until that phase lands.
 */
export type AuthRole = string;

export interface SignInResult {
  user: AuthUser | null;
  error: string | null;
}

/**
 * The one surface every provider adapter must implement. Kept intentionally
 * small — anything role/claim-shaped belongs to Phase 2's claims contract,
 * not this interface.
 */
export interface AuthProvider {
  signIn(email: string, password: string): Promise<SignInResult>;
  signOut(): Promise<void>;
  getSession(): Promise<AuthSession | null>;
  getUser(): Promise<AuthUser | null>;
  getAccessToken(): Promise<string | null>;
  onAuthStateChange(callback: (user: AuthUser | null) => void): () => void;
  refresh(): Promise<AuthSession | null>;
}
