// Canonical organizational hierarchy for the Super Admin view: AOC -> operating entities, departments and hubs (with station counts).
// Pure shaping only: no database access, no authorization (the caller has already required the canonical Super Admin authority), and no invented
// scope -- rows whose parent AOC / hub is unknown are ignored rather than attached anywhere.

/**
 * Creating or changing an AOC or operating entity is NOT activated. Role scopes and entity-admin checks are bound to the existing entity codes
 * (MAA, AAX), so a new AOC / entity needs an owner decision about its scopes, roles, hubs and stations first. The retired public.organizations
 * table is not recreated.
 */
export const HIERARCHY_CREATION_ACTIVE = false;

export interface AocRow { id: string; code: string; name: string; is_active: boolean }
export interface EntityRow { id: string; aoc_id: string; code: string; name: string; flight_prefix: string }
export interface DepartmentRow { id: string; aoc_id: string; code: string; name: string }
export interface HubRow { id: string; aoc_id: string; code: string; name: string }
export interface StationRow { id: string; hub_id: string }

export interface AocNode {
  code: string;
  name: string;
  isActive: boolean;
  entities: Array<{ code: string; name: string; flightPrefix: string }>;
  departments: Array<{ code: string; name: string }>;
  hubs: Array<{ code: string; name: string; stationCount: number }>;
}

const byCode = <T extends { code: string }>(a: T, b: T) => a.code.localeCompare(b.code);

export function buildHierarchy(input: { aocs: AocRow[]; entities: EntityRow[]; departments: DepartmentRow[]; hubs: HubRow[]; stations: StationRow[] }): AocNode[] {
  const stationsPerHub = new Map<string, number>();
  for (const s of input.stations) stationsPerHub.set(s.hub_id, (stationsPerHub.get(s.hub_id) ?? 0) + 1);
  return [...input.aocs].sort(byCode).map((aoc) => ({
    code: aoc.code,
    name: aoc.name,
    isActive: aoc.is_active,
    entities: input.entities.filter((e) => e.aoc_id === aoc.id).sort(byCode).map((e) => ({ code: e.code, name: e.name, flightPrefix: e.flight_prefix })),
    departments: input.departments.filter((d) => d.aoc_id === aoc.id).sort(byCode).map((d) => ({ code: d.code, name: d.name })),
    hubs: input.hubs.filter((h) => h.aoc_id === aoc.id).sort(byCode).map((h) => ({ code: h.code, name: h.name, stationCount: stationsPerHub.get(h.id) ?? 0 })),
  }));
}
