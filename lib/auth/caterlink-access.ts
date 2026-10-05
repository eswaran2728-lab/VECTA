// CaterLink-only access decision (pure; no framework imports) -- the ONE definition used by login routing,
// middleware, pages, server actions and API gates.
//
// Display role -> existing role code (no new roles are created):
//   CaterLink Management  -> canonical Phase 3 role `caterlink_management` (active assignment)
//   CaterLink Driver      -> ICMS account role `warehouse_pic`  (legacy aliases driver_ifc / driver_vendor)
//   Third-Party Vendor    -> ICMS account role `vendor`
// External (Driver / Vendor) identities are rows of the trusted `public.users` account table with an active
// status. Email addresses, user-editable auth metadata and display names are NEVER consulted.
//
// Fail-closed rules: a caller who combines CaterLink with any VECTA role (canonical or external-plus-canonical),
// or who holds more than one conflicting external role, is classified `conflict` and receives no access until
// the conflict is resolved. Access is never silently merged.
import type { CanonicalAccess } from "./canonical-access.ts";

export const CATERLINK_MANAGEMENT_CODE = "caterlink_management";
export const EXTERNAL_DRIVER_ROLES = ["warehouse_pic", "driver_ifc", "driver_vendor"] as const;
export const EXTERNAL_VENDOR_ROLES = ["vendor"] as const;
export const EXTERNAL_CATERLINK_ROLES = [...EXTERNAL_DRIVER_ROLES, ...EXTERNAL_VENDOR_ROLES] as const;

export interface ExternalAccountRow {
  role?: string | null;
  status?: string | null;
}

export type PortalKind =
  | "caterlink_management"
  | "caterlink_driver"
  | "caterlink_vendor"
  | "vecta"
  | "super_admin"
  | "blocked" // an external account whose status is not active (pending / rejected / deactivated ...)
  | "conflict" // mixed VECTA / CaterLink identity: fail closed
  | "none"; // no assignment and no external account

export interface PortalIdentity {
  kind: PortalKind;
  /** the status string for `blocked` (used for the sign-in error) */
  status?: string;
}

export function isExternalCaterLinkRole(role: string | null | undefined): boolean {
  return Boolean(role) && (EXTERNAL_CATERLINK_ROLES as readonly string[]).includes(role as string);
}

export function classifyPortalAccess(access: CanonicalAccess, external: ExternalAccountRow | null | undefined): PortalIdentity {
  const externalRole = isExternalCaterLinkRole(external?.role) ? (external!.role as string) : null;
  const codes = access.roleCodes;
  const hasCl = codes.includes(CATERLINK_MANAGEMENT_CODE);
  const hasOther = codes.some((c) => c !== CATERLINK_MANAGEMENT_CODE);

  if (access.isSuperAdmin) return { kind: externalRole ? "conflict" : "super_admin" };

  if (externalRole) {
    // An external account must hold NO canonical assignment at all.
    if (access.hasAssignment) return { kind: "conflict" };
    const status = String(external?.status ?? "");
    if (status !== "active") return { kind: "blocked", status: status || "pending" };
    return { kind: (EXTERNAL_VENDOR_ROLES as readonly string[]).includes(externalRole) ? "caterlink_vendor" : "caterlink_driver" };
  }

  if (hasCl) return { kind: hasOther ? "conflict" : "caterlink_management" };
  if (access.hasAssignment) return { kind: "vecta" };
  return { kind: "none" };
}

export function isCaterLinkOnly(kind: PortalKind): boolean {
  return kind === "caterlink_management" || kind === "caterlink_driver" || kind === "caterlink_vendor";
}

/** Where a signed-in identity lands. `/` lets VECTA identities resolve their own workspace. */
export function landingForIdentity(identity: PortalIdentity): string {
  if (isCaterLinkOnly(identity.kind)) return "/caterlink/dashboard";
  if (identity.kind === "super_admin") return "/super-admin";
  return "/";
}

// Paths a CaterLink-only identity may reach. Everything else is denied server-side (pages redirect to the
// CaterLink dashboard; API routes answer 403) -- hiding navigation is not the control.
const CATERLINK_PAGE_PREFIXES = ["/caterlink", "/icms", "/login", "/register", "/forgot-password", "/reset-password", "/auth"];
const CATERLINK_API_PREFIXES = ["/api/icms", "/api/auth", "/api/health"];

export function isCaterLinkPagePath(path: string): boolean {
  return CATERLINK_PAGE_PREFIXES.some((p) => path === p || path.startsWith(p + "/"));
}
export function isCaterLinkApiPath(path: string): boolean {
  return CATERLINK_API_PREFIXES.some((p) => path === p || path.startsWith(p + "/"));
}

export type PortalDecision =
  | { action: "allow" }
  | { action: "redirect"; to: string; error?: string }
  | { action: "deny_api" };

/**
 * The single request-level decision for an authenticated caller. `isApi` distinguishes JSON endpoints (403)
 * from pages (redirect).
 */
export function decidePortalRequest(identity: PortalIdentity, path: string, isApi: boolean): PortalDecision {
  if (identity.kind === "conflict") {
    if (isApi) return isCaterLinkApiPath(path) && path.startsWith("/api/auth") ? { action: "allow" } : { action: "deny_api" };
    if (path === "/login" || path.startsWith("/auth")) return { action: "allow" };
    return { action: "redirect", to: "/login", error: "conflicting-access" };
  }
  if (identity.kind === "blocked") {
    if (isApi) return path.startsWith("/api/auth") ? { action: "allow" } : { action: "deny_api" };
    if (path === "/login" || path.startsWith("/auth")) return { action: "allow" };
    return { action: "redirect", to: "/login", error: identity.status ?? "pending" };
  }
  if (isCaterLinkOnly(identity.kind)) {
    if (isApi) return isCaterLinkApiPath(path) ? { action: "allow" } : { action: "deny_api" };
    if (isCaterLinkPagePath(path)) return { action: "allow" };
    return { action: "redirect", to: "/caterlink/dashboard" };
  }
  return { action: "allow" };
}
