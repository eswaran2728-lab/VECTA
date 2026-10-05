# Test-account foundation: Super Admin gates, organisational teams, account inventory

Staging project `ddlctzbnqewubltcavkh` only. See [operational-authorization.md](operational-authorization.md)
for the gate inventory. User decisions of 2026-10-05 are applied below.

## 1. Organisation (live staging, read-only discovery)
1 AOC (`MY`), 2 entities (`AAX`, `MAA`), 4 departments (`caterlink`, `compliance`, `enforcement`, `operation`),
3 units (`investigation`, `profiling`, `sat`), 6 hubs, 20 `org_stations`. Legacy `teams` = ALPHA/BRAVO/CHARLIE/DELTA
(`supabase/migrations/avsec/0001_init_schema.sql:44-49`); `station_teams` has them at `KUL - MAA` only.
Teams are station-scoped (`unique (station_id, name)`) and Phase 3 rejects a team that does not belong to the
assignment's station (`phase3_role_permission_foundation.sql:277-281`), so each station needs its own rows.
`org_teams` was empty because Phase 2 deliberately seeds none (`phase2_org_foundation.sql:122-123, 274`).

## 2. Approved `org_teams` seed: exactly 16 rows
ALPHA, BRAVO, CHARLIE, DELTA separately at each of `KUL - MAA`, `PEN`, `JHB`, `BTU`.
No QA team (the legacy `QA` profile label is not an operational team), no generic UAT team, no second AOC.
`scripts/staging/seed-org-teams.mjs`: dry-run by default; `--preflight` is read-only against staging;
`--apply --confirm=seed-approved-teams` runs one transaction over verified TLS after: staging identity,
production-ref absence, both backups authenticating, exactly 59 migrations ending at Phase 13, each station
resolving exactly once, and `org_teams` holding 0 rows (or exactly the 16 on a re-run). It verifies the 16 rows,
their station links, uniqueness, and that Auth users, profiles, legacy teams and assignments are unchanged, and
rolls back on any mismatch. Station ids come from `org_stations.code`; no UUID is hardcoded.

## 3. Final account matrix: 36 accounts
23 base + 7 station variants (KUL x3, JHB x3, `aso-no-caterlink` at `BTU`) + 6 negative states
(pending, rejected, deactivated, revoked, expired, future-dated). No foreign-AOC account.
Base `sso/so/aso/profiling_*` use `PEN`; negatives use `KUL - MAA / ALPHA`; every team-scoped account uses `ALPHA`
at its own station. 16 accounts need no team; 20 need the seed (`needTeamId` = 20).
`node scripts/staging/provision-test-accounts.mjs --dry-run` prints the full per-account scope, membership
requirement, login state, workspace, and allowed/denied features.

Provisioning fix found this round: the auth trigger pre-creates a bare profile, and the tool only updated its
status, leaving `name` empty. Every account would have been sent to profile-setup. The tool now sets the
identity and compatibility fields explicitly.

## 4. Open decisions
See "Retained compatibility reads and unresolved items" in operational-authorization.md. The two that block
a full login test of every workspace: the `ops_group` mapping and the ICMS identity bridge for
`caterlink_management`. Review the canonical -> legacy-rank mapping as well.
