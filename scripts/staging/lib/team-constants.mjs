// Shared team constants (no imports -- breaks the role-matrix/team-plan cycle).
// RULE: no team name is invented; see team-plan.mjs.
// Established teams. Sources:
//  - supabase/migrations/avsec/0001_init_schema.sql:44-49 seeds legacy
//    public.teams with ALPHA, BRAVO, CHARLIE, DELTA.
//  - supabase/migrations/20260928000001_phase2_org_foundation.sql:122-123
//    defines org_teams as station-scoped and writes the name as "ALPHA".
//  - Live staging (read-only discovery): public.station_teams has exactly
//    four rows, all at station 'KUL - MAA' (ALPHA, BRAVO, CHARLIE, DELTA).
//  - supabase/PHASE8_ACTIVATION_PLAN.md: SAT staff at KUL across 4 teams
//    (Alpha/Bravo/Charlie/Delta).
export const ESTABLISHED_TEAMS = [
  { station: "KUL - MAA", name: "ALPHA" },
  { station: "KUL - MAA", name: "BRAVO" },
  { station: "KUL - MAA", name: "CHARLIE" },
  { station: "KUL - MAA", name: "DELTA" },
];

// The single team each test account is placed in at a station (a role
// assignment carries exactly one team_id).
export const DEFAULT_TEAM_BY_STATION = { "KUL - MAA": "ALPHA" };

export class TeamNotEstablishedError extends Error {
  constructor(roleCode, stationCode, teamName) {
    super(
      teamName
        ? `Team '${teamName}' at station '${stationCode}' (role ${roleCode}) is established but its org_teams row does not exist yet -- run seed-org-teams.mjs after approval.`
        : `No team is established for station '${stationCode}' (role ${roleCode}). Refusing to invent one; a user decision is required.`
    );
    this.name = "TeamNotEstablishedError";
    this.roleCode = roleCode;
    this.stationCode = stationCode;
  }
}

export function teamNameForStation(stationCode) {
  return DEFAULT_TEAM_BY_STATION[stationCode] ?? null;
}

