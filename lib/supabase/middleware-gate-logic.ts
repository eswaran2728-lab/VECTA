// Pure decision logic used by updateSession() in middleware.ts, split into its own
// framework-free module (no next/server or @supabase/ssr imports) purely so it's
// unit-testable with the plain node:test runner outside a Next.js build.

// Seniority-based exemptions: super_admin/management/admin/enforcement are not shift-based staff,
// so the check-in gate doesn't apply to them at all.
const SENIORITY_EXEMPT_ROLES = ["super_admin", "management", "admin", "enforcement"];

// Vendor is a SEPARATE exemption: third-party/external, not AirAsia staff.
const VENDOR_EXEMPT_ROLE = "vendor";

export function isCheckinGateExempt(role: string | null): boolean {
  const seniorityExempt = role ? SENIORITY_EXEMPT_ROLES.includes(role) : false;
  const vendorExempt = role === VENDOR_EXEMPT_ROLE;
  return seniorityExempt || vendorExempt;
}

// AVSEC roles permitted in VECTA
export const VECTA_ALLOWED_ROLES = ["super_admin", "management", "admin", "enforcement", "so", "aso", "dse"];

export function isVectaRoleAllowed(role: string | null): boolean {
  if (!role) return false;
  return VECTA_ALLOWED_ROLES.includes(role);
}

// Management user-management admin section: accessible by Management & Admin
export function isAdminPathForbidden(path: string, role: string | null): boolean {
  return path.startsWith("/avsec/admin") && role !== "management" && role !== "admin";
}

import type { CanonicalAccess } from "../auth/canonical-access";
import { canonicalCodesForRoute, routeAllows } from "../auth/route-access.ts";

// The canonical roles whose workspace includes the duty terminal / check-in.
const DUTY_CODES = new Set(canonicalCodesForRoute("/avsec/duty"));

// ICMS-origin external identities (public.users.role) routed to CaterLink. The single definition lives in
// lib/auth/caterlink-access.ts; recognised ONLY from that table's role -- never from an email or metadata.
import { isExternalCaterLinkRole, EXTERNAL_CATERLINK_ROLES } from "../auth/caterlink-access.ts";
export { isExternalCaterLinkRole };
export const EXTERNAL_CATERLINK_ICMS_ROLES = EXTERNAL_CATERLINK_ROLES;

// Edge-gate role from CANONICAL access (plus the ICMS external-identity
// table for CaterLink vendors/drivers, who hold no Phase 3 assignment).
// A canonical role with no legacy-page rank yields null: it is not shift
// staff, not management/admin, and reaches its workspace via Phase 7.
export function effectiveGateRole(access: CanonicalAccess, icmsRole: string | null | undefined): string | null {
  if (access.isSuperAdmin) return "super_admin";
  if (access.primaryCompatRole) return access.primaryCompatRole.toLowerCase();
  if (access.hasAssignment) return null;
  return isExternalCaterLinkRole(icmsRole) ? "vendor" : null;
}

// Only canonical roles whose workspace includes the duty terminal are subject to the
// duty check-in gate; every other canonical account is exempt.
export function isShiftBasedAccess(access: CanonicalAccess): boolean {
  return access.roleCodes.some((c) => DUTY_CODES.has(c));
}

// /avsec/admin is the management section, EXCEPT the roster, which dashboards link
// to for dse / hub_se. Roster access is decided by the same canonical route policy
// the page uses (and the roster RPCs enforce station/team/hub scope in the database).
export function isAdminPathForbiddenFor(path: string, role: string | null, access: CanonicalAccess): boolean {
  if (path === "/avsec/admin/roster" || path.startsWith("/avsec/admin/roster/")) {
    if (routeAllows("/avsec/admin/roster", access, ["MANAGEMENT", "ADMIN"])) return false;
  }
  return isAdminPathForbidden(path, role);
}

// Effective role for edge gating. Super Admin comes ONLY from the canonical
// Phase 3 active-assignment decision; a legacy "super_admin" value in any
// profile/user column never confers it (it is discarded to null).
export function resolveEffectiveRole(legacyRole: string | null, canonicalSuperAdmin: boolean): string | null {
  if (canonicalSuperAdmin) return "super_admin";
  return legacyRole === "super_admin" ? null : legacyRole;
}

// Super Admin platform portal: strictly for super_admin
export function isSuperAdminPathForbidden(path: string, role: string | null): boolean {
  return path.startsWith("/super-admin") && role !== "super_admin";
}

// Phase 13 readiness portal: authorised by the canonical Phase 3 role
// assignment (has_active_role('super_admin')), never by profiles.unified_role
// or a legacy profiles.role value.
export function isReadinessPath(path: string): boolean {
  return path === "/super-admin/readiness" || path.startsWith("/super-admin/readiness/");
}

// Super Admin must NOT participate in any tenant's operational workflows
export function isOperationalPathForbiddenForSuperAdmin(path: string, role: string | null): boolean {
  if (role !== "super_admin") return false;
  return path.startsWith("/avsec") || path.startsWith("/icms") || path.startsWith("/caterlink");
}
