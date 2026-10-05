// Shared team constants (no imports -- breaks the role-matrix/team-plan cycle).
//
// RULE: no team name is invented. The four operational team names below are
// the legacy vocabulary (supabase/migrations/avsec/0001_init_schema.sql:44-49
// seeds public.teams with ALPHA/BRAVO/CHARLIE/DELTA; Phase 2 writes
// org_teams names as "ALPHA"; live station_teams holds them at 'KUL - MAA').
// By explicit user decision (2026-10-05) the same four names are seeded
// SEPARATELY within each of four selected stations. No QA team, no generic
// UAT team, and no other station.
export const OPERATIONAL_TEAM_NAMES = ["ALPHA", "BRAVO", "CHARLIE", "DELTA"];
export const SEEDED_STATIONS = ["KUL - MAA", "PEN", "JHB", "BTU"];

export const APPROVED_TEAMS = SEEDED_STATIONS.flatMap((station) => OPERATIONAL_TEAM_NAMES.map((name) => ({ station, name })));
// Back-compat alias used by older imports.
export const ESTABLISHED_TEAMS = APPROVED_TEAMS;

// The single team each test account is placed in at a station (a role
// assignment carries exactly one team_id).
export const DEFAULT_TEAM_BY_STATION = Object.fromEntries(SEEDED_STATIONS.map((s) => [s, "ALPHA"]));

export class TeamNotEstablishedError extends Error {
  constructor(roleCode, stationCode, teamName) {
    super(
      teamName
        ? `Team '${teamName}' at station '${stationCode}' (role ${roleCode}) is approved but its org_teams row does not exist yet -- run seed-org-teams.mjs after authorization.`
        : `No team is approved for station '${stationCode}' (role ${roleCode}). Refusing to invent one; a user decision is required.`
    );
    this.name = "TeamNotEstablishedError";
    this.roleCode = roleCode;
    this.stationCode = stationCode;
  }
}

export function teamNameForStation(stationCode) {
  return DEFAULT_TEAM_BY_STATION[stationCode] ?? null;
}
