// Pure route-access policy for pages that the Phase 7 dashboards link to.
// The set of canonical role codes allowed on a route is DERIVED from
// lib/dashboard/linkHubConfig.ts (the same table that draws the dashboard
// links), so a dashboard link and the route it points at can never disagree.
// The legacy rank list a route already used is kept as an additional
// satisfier via the canonical compat mapping -- never via a legacy column.
import { LINK_HUB_CONFIG } from "../dashboard/linkHubConfig.ts";
import { accessSatisfiesRoles, type CanonicalAccess } from "./canonical-access.ts";

const CODES_BY_HREF: Map<string, Set<string>> = (() => {
  const map = new Map<string, Set<string>>();
  for (const [roleCode, cfg] of Object.entries(LINK_HUB_CONFIG)) {
    for (const link of cfg.links) {
      if (!map.has(link.href)) map.set(link.href, new Set());
      map.get(link.href)!.add(roleCode);
    }
  }
  return map;
})();

export function canonicalCodesForRoute(href: string): string[] {
  return [...(CODES_BY_HREF.get(href) ?? [])].sort();
}

export function routeAllows(href: string, access: CanonicalAccess, legacyRoles: readonly string[]): boolean {
  if (!access.hasAssignment || access.isSuperAdmin) return false;
  if (accessSatisfiesRoles(access, legacyRoles)) return true;
  const codes = CODES_BY_HREF.get(href);
  return Boolean(codes) && access.roleCodes.some((c) => codes!.has(c));
}
