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
