// Pure canonical operational-access derivation. No server or framework
// imports so it is directly unit-testable.
//
// Input is ALWAYS the caller's own active Phase 3 assignments as returned
// by get_my_active_role_assignments() (auth.uid() identity, approved
// profile, active role definition, non-revoked, effective dates -- all
// enforced inside that SECURITY DEFINER function). Nothing here reads a
// legacy profile column, user metadata or an email string.
import type { RoleAssignmentContext } from "@/lib/dashboard/tiers";
import { COMPAT_ROLE_BY_CANONICAL as COMPAT_MAP } from "./compat-role-map.mjs";

// Legacy AVSEC rank vocabulary still used by the pre-Phase-3 pages' role
// arrays. It is a COMPATIBILITY OUTPUT derived from canonical assignments,
// never an input to any decision.
export type CompatRole = "ASO" | "SO" | "DSE" | "ENFORCEMENT" | "MANAGEMENT";

export const COMPAT_ROLE_BY_CANONICAL: Readonly<Record<string, CompatRole | null>> = COMPAT_MAP as Readonly<Record<string, CompatRole | null>>;

const RANK: Record<CompatRole, number> = { ASO: 1, SO: 2, DSE: 3, ENFORCEMENT: 4, MANAGEMENT: 5 };

export interface CanonicalAccess {
  hasAssignment: boolean;
  isSuperAdmin: boolean;
  roleCodes: string[];
  compatRoles: CompatRole[];
  primaryCompatRole: CompatRole | null;
  orgWide: boolean;
  /** The single station assignment's display scope, when exactly one exists. */
  stationCode: string | null;
  teamName: string | null;
}

export const NO_CANONICAL_ACCESS: CanonicalAccess = {
  hasAssignment: false,
  isSuperAdmin: false,
  roleCodes: [],
  compatRoles: [],
  primaryCompatRole: null,
  orgWide: false,
  stationCode: null,
  teamName: null,
};

export function deriveCanonicalAccess(assignments: readonly RoleAssignmentContext[]): CanonicalAccess {
  if (assignments.length === 0) return NO_CANONICAL_ACCESS;
  const roleCodes = [...new Set(assignments.map((a) => a.roleCode))];
  const compat = new Set<CompatRole>();
  for (const code of roleCodes) {
    const mapped = COMPAT_ROLE_BY_CANONICAL[code];
    if (mapped) compat.add(mapped);
  }
  const compatRoles = [...compat].sort((a, b) => RANK[b] - RANK[a]);
  const stationAssignments = assignments.filter((a) => a.stationCode);
  const single = stationAssignments.length === 1 ? stationAssignments[0] : null;
  return {
    hasAssignment: true,
    isSuperAdmin: roleCodes.includes("super_admin"),
    roleCodes,
    compatRoles,
    primaryCompatRole: compatRoles[0] ?? null,
    orgWide: compatRoles.includes("MANAGEMENT") || compatRoles.includes("ENFORCEMENT"),
    stationCode: single?.stationCode ?? null,
    teamName: single?.teamName ?? null,
  };
}

/** Whether canonical access satisfies a legacy-page role list (ADMIN counts as MANAGEMENT, as in lib/avsec/auth). */
export function accessSatisfiesRoles(access: CanonicalAccess, roles: readonly string[]): boolean {
  if (!access.hasAssignment || access.isSuperAdmin) return false;
  const wanted = new Set(roles.map((r) => (r === "ADMIN" ? "MANAGEMENT" : r)));
  return access.compatRoles.some((r) => wanted.has(r));
}

/** Maps get_my_active_role_assignments() rows to assignment contexts. */
export function assignmentsFromRpcRows(rows: unknown): RoleAssignmentContext[] {
  if (!Array.isArray(rows)) return [];
  return (rows as Array<Record<string, unknown>>).map((row) => ({
    roleCode: row.role_code as string,
    roleCategory: row.role_category as string,
    aocCode: (row.aoc_code as string) ?? null,
    operatingEntityCode: (row.operating_entity_code as string) ?? null,
    departmentCode: (row.department_code as string) ?? null,
    unitCode: (row.unit_code as string) ?? null,
    hubCode: (row.hub_code as string) ?? null,
    stationCode: (row.station_code as string) ?? null,
    teamName: (row.team_name as string) ?? null,
    startsAt: row.starts_at as string,
    endsAt: (row.ends_at as string) ?? null,
  }));
}

// ICMS-origin (public.users) org-wide viewers, in ICMS's own role vocabulary.
// Used ONLY when the caller holds no canonical assignment.
export const ICMS_ORG_WIDE_ROLES = ["supervisor", "management", "enforcement"] as const;

export type OperatorScopeSource = "canonical" | "icms" | null;

export interface OperatorScope {
  source: OperatorScopeSource;
  /** Canonical role codes held (empty for ICMS-origin identities). */
  roleCodes: string[];
  orgWide: boolean;
  /** Legacy workflow attribute (CaterLink checkpoint ownership); never an access decision on its own. */
  opsGroup: string | null;
  station: string | null;
}

/** Pure derivation of operator scope from canonical access plus the legacy rows' non-authorising attributes. */
export function deriveOperatorScope(
  access: CanonicalAccess,
  avsec: { ops_group?: string | null; station?: string | null } | null,
  icms: { role?: string | null; ops_group?: string | null } | null,
): OperatorScope {
  if (access.hasAssignment && !access.isSuperAdmin) {
    return {
      source: "canonical",
      roleCodes: access.roleCodes,
      orgWide: access.orgWide,
      opsGroup: avsec?.ops_group ?? icms?.ops_group ?? null,
      station: access.stationCode ?? avsec?.station ?? null,
    };
  }
  if (!access.hasAssignment && icms) {
    return {
      source: "icms",
      roleCodes: [],
      orgWide: (ICMS_ORG_WIDE_ROLES as readonly string[]).includes(icms.role ?? ""),
      opsGroup: icms.ops_group ?? null,
      station: null,
    };
  }
  return { source: null, roleCodes: [], orgWide: false, opsGroup: null, station: null };
}

/** Org-wide viewer decision for ICMS surfaces: canonical when assigned, else the ICMS users-table role. */
export function isOrgWideOperator(access: CanonicalAccess, icmsRole: string | null | undefined): boolean {
  if (access.hasAssignment) return !access.isSuperAdmin && access.orgWide;
  return (ICMS_ORG_WIDE_ROLES as readonly string[]).includes(icmsRole ?? "");
}

/** Display tier for an ICMS-origin (no-assignment) account, from the ICMS users-table role. */
export function icmsDisplayTier(icmsRole: string | null | undefined): "management" | "enforcement" | "aso" {
  if (icmsRole === "supervisor" || icmsRole === "management") return "management";
  if (icmsRole === "enforcement") return "enforcement";
  return "aso";
}
