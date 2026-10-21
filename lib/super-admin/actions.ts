"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { hasActiveSuperAdminRole } from "./authority";
import { buildHierarchy, type AocNode } from "./hierarchy";

// Canonical authority only (active Phase 3 super_admin assignment) -- see
// lib/super-admin/authority.ts. Legacy profile/user role columns are never read.
export async function isSuperAdmin(): Promise<boolean> {
  return hasActiveSuperAdminRole();
}

/**
 * Read-only view of the canonical organizational hierarchy (AOC -> operating entities, departments, hubs). The retired multi-tenant
 * public.organizations table is neither read nor written; creating or changing an AOC / operating entity is not activated (see
 * lib/super-admin/hierarchy.ts). Returns [] for anyone who is not an active Super Admin -- the check precedes any service-key read.
 */
export async function getOrganizationHierarchy(): Promise<AocNode[]> {
  const isSuper = await isSuperAdmin();
  if (!isSuper) return [];

  const admin = createAdminClient();
  const [aocs, entities, departments, hubs, stations] = await Promise.all([
    admin.from("aocs").select("id, code, name, is_active"),
    admin.from("operating_entities").select("id, aoc_id, code, name, flight_prefix"),
    admin.from("departments").select("id, aoc_id, code, name"),
    admin.from("hubs").select("id, aoc_id, code, name"),
    admin.from("org_stations").select("id, hub_id"),
  ]);
  const failed = [aocs, entities, departments, hubs, stations].find((r) => r.error);
  if (failed?.error) {
    console.error("[super-admin] hierarchy read failed:", failed.error.code ?? "unknown");
    return [];
  }
  return buildHierarchy({
    aocs: aocs.data ?? [],
    entities: entities.data ?? [],
    departments: departments.data ?? [],
    hubs: hubs.data ?? [],
    stations: stations.data ?? [],
  });
}
