import type { AuthUser } from "./types";

/**
 * Placeholder for Phase 2's claims contract (AUTH-CONTRACT.md): the
 * single source of truth guards.ts will read role/team/station/staff_id/
 * vendor_id from once user_claims exists in Supabase and both provider
 * adapters normalise to it.
 *
 * For now this is a pass-through — role/status resolution is unchanged
 * and still lives in each app's own profile table lookup
 * (lib/icms/auth.ts, lib/avsec/auth.ts).
 */
export function normalizeUser(user: AuthUser | null): AuthUser | null {
  return user;
}
