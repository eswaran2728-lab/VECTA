import "server-only";

import { redirect } from "next/navigation";
import { getAuthProvider } from "./provider";
import { getClaims, type Claims } from "./claims";
import type { AuthUser, AuthRole } from "./types";

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
 * Returns the signed-in user's full claim contract (AUTH-CONTRACT.md), or
 * redirects to /login. New code that only needs the coarse app_role/
 * team/station vocabulary should use this; existing per-app,
 * per-checkpoint role gating (lib/icms/auth.ts, lib/avsec/auth.ts's own
 * requireRole()) is unaffected and remains the real guard for that —
 * see AUTH-CONTRACT.md's caveat on why the two vocabularies don't mix.
 */
export async function requireClaims(): Promise<Claims> {
  const user = await requireAuth();
  const claims = await getClaims(user);
  if (!claims) redirect("/login?error=no-profile");
  return claims;
}

/** Requires one of the given coarse app_role values (unified_role
 *  vocabulary), using the claim contract — not each app's own
 *  per-checkpoint role list. Redirects to /login if signed out,
 *  "forbidden" if signed in with a different app_role. */
export async function requireAppRole(roles: AuthRole[]): Promise<Claims> {
  const claims = await requireClaims();
  if (!claims.appRole || !roles.includes(claims.appRole)) {
    redirect("/?error=forbidden");
  }
  return claims;
}

/** Requires one of the given AVSEC teams (operation/ifc/hub). Redirects to
 *  /login if signed out, "forbidden" if signed in with no team or a
 *  different one. */
export async function requireTeam(teams: Claims["team"][]): Promise<Claims> {
  const claims = await requireClaims();
  if (!claims.team || !teams.includes(claims.team)) {
    redirect("/?error=forbidden");
  }
  return claims;
}
