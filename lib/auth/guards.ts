import "server-only";

import { redirect } from "next/navigation";
import { getAuthProvider } from "./provider";
import type { AuthUser } from "./types";

/** Provider-agnostic replacement for the Supabase SDK's getUser() call —
 *  identity only, returns null when signed out. Role/status/team still come from
 *  each app's own profile table via lib/icms/auth.ts / lib/avsec/auth.ts
 *  until Phase 2's claims contract lands. */
export async function getAuthUser(): Promise<AuthUser | null> {
  return getAuthProvider().getUser();
}

/** Returns the signed-in user, or redirects to /login. */
export async function requireAuth(): Promise<AuthUser> {
  const user = await getAuthUser();
  if (!user) redirect("/login");
  return user;
}

/**
 * requireRole()/requireTeam() are deferred to Phase 2 (AUTH-CONTRACT.md):
 * AuthUser carries no role/team/station yet, so there is nothing
 * provider-agnostic to check here. Each app's own requireRole()
 * (lib/icms/auth.ts, lib/avsec/auth.ts) remains the real guard until then.
 */
export function requireRole(): never {
  throw new Error("requireRole() lands in Phase 2 once claims carry app_role.");
}
export function requireTeam(): never {
  throw new Error("requireTeam() lands in Phase 2 once claims carry team/station.");
}
