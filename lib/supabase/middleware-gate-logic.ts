// Pure decision logic used by updateSession() in middleware.ts, split into its own
// framework-free module (no next/server or @supabase/ssr imports) purely so it's
// unit-testable with the plain node:test runner outside a Next.js build. Behavior is
// unchanged from what was previously inlined in middleware.ts.

// Seniority-based exemptions: admin/management/enforcement are not shift-based staff,
// so the check-in gate doesn't apply to them at all.
const SENIORITY_EXEMPT_ROLES = ["admin", "management", "enforcement"];

// Vendor is a SEPARATE exemption, kept apart from the seniority list on purpose:
// vendors are third-party/external, not AirAsia staff, so the AirAsia
// attendance/check-in concept doesn't apply to them at all — a different reason than
// "senior enough to skip it".
const VENDOR_EXEMPT_ROLE = "vendor";

export function isCheckinGateExempt(role: string | null): boolean {
  const seniorityExempt = role ? SENIORITY_EXEMPT_ROLES.includes(role) : false;
  const vendorExempt = role === VENDOR_EXEMPT_ROLE;
  return seniorityExempt || vendorExempt;
}

// Coarse edge-level defense-in-depth for the admin section (item 6): additive to, never
// a replacement for, RLS + requireRole(["ADMIN"]) in the actual page/action code.
export function isAdminPathForbidden(path: string, role: string | null): boolean {
  return path.startsWith("/avsec/admin") && role !== "admin";
}
