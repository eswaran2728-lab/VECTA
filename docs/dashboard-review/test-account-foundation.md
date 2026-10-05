# Test-account foundation: Super Admin gates, organisational teams, account inventory

Staging project `ddlctzbnqewubltcavkh` only. Nothing in this document has been applied.

## 1. Super Admin gate inventory

Canonical rule everywhere: an active, non-revoked, currently effective Phase 3 `super_admin`
assignment on an approved profile with an active role definition, decided from `auth.uid()` by
`has_active_role('super_admin')`. Legacy `ADMIN`, `MANAGEMENT`, `profiles.role`, `users.*`, user metadata
and a missing `unified_role` never confer it.

### Migrated to the canonical model
| Location | Before | Now |
|---|---|---|
| `lib/super-admin/actions.ts` `isSuperAdmin()` (page + 3 org actions) | read `profiles/users.role, unified_role` | delegates to `hasActiveSuperAdminRole()` (RPC) |
| `app/super-admin/readiness/page.tsx` | legacy | `hasActiveSuperAdminRole()` |
| `lib/supabase/middleware.ts` login redirect | `unified_role`/`role` lookup | `has_active_role` RPC |
| `lib/supabase/middleware.ts` gated-route role | `unified_role` or `role === SUPER_ADMIN` | `resolveEffectiveRole(legacyRole, canonicalSuperAdmin)`; a legacy `super_admin` value is discarded |
| `lib/supabase/middleware.ts` `/super-admin/readiness` | n/a | canonical RPC before the legacy lookup |
| `lib/avsec/auth.ts` `requireProfile()` | `profile.role === "SUPER_ADMIN"` | `hasActiveSuperAdminRole()` |
| `lib/avsec/admin/actions.ts` deactivate / delete / reassign target guard (3) | target `role`/`unified_role` | `isProfileActiveSuperAdmin(target)` (service read + same rule as the DB) |
| `app/(avsec)/avsec/admin/users/page.tsx` + `UsersTable` "Protected" row | `p.role === "SUPER_ADMIN"` | `protectedProfileIds` from the canonical check |
| `components/layout/AppSidebar.tsx` org-wide nav | listed `super_admin` | removed |
| `lib/avsec/announcements/queries.ts` management visibility | included `SUPER_ADMIN` | removed |
| `app/page.tsx` role chip | labelled legacy `super_admin` | removed |
| `app/super-admin/page.tsx` navigation | no readiness link | link added (page is already canonically gated) |
| `lib/supabase/admin.ts` | `SUPABASE_SERVICE_ROLE_KEY` only | prefers `SUPABASE_SECRET_KEY`, falls back to the legacy name |

### Already canonical (no change)
`app/(avsec)/avsec/my-dashboard/page.tsx`, `lib/dashboard/aggregates.ts`
(`get_super_admin_technical_status_secure`), `lib/dashboard/tiers.ts`, all Phase 3-13 SQL.

### Legitimate legacy compatibility (kept, documented)
These read `unified_role` for the pre-Phase-3 ASO/SO/DSE/management/vendor routing. None decides Super
Admin. **The column does not exist on staging, so each such select errors and returns no profile.**
`app/page.tsx`, `app/(avsec)/avsec/layout.tsx`, `app/(avsec)/avsec/scan/page.tsx`,
`app/(icms)/icms/layout.tsx`, `app/(icms)/icms/transactions/page.tsx`, `app/auth/callback/route.ts`,
`app/api/auth/register/route.ts`, `lib/avsec/admin/actions.ts` (account creation), `lib/icms/actions/*`,
`lib/icms/shadow-user.ts`, `lib/icms/constants.ts`, `lib/supabase/middleware.ts` (non-Super-Admin routing),
`components/layout/AppSidebar.tsx`, and generated/type files. `tests/super-admin-canonical-gates.test.mts`
keeps this list complete: a new file naming `unified_role` fails the build until reviewed.

`lib/avsec/auth.ts` `landingPathForRole("SUPER_ADMIN")` and `reference-data.ts` `USER_ROLES` keep the
legacy enum string; `/super-admin` itself is canonically gated, so this grants nothing.

## 2. Organisational discovery (read-only, staging)
Counts: 1 AOC (`MY`, active), 2 operating entities (`AAX`, `MAA`), 4 departments (`caterlink`, `compliance`,
`enforcement`, `operation`), 3 units (`investigation`, `profiling`, `sat`, all under `enforcement`), 6 hubs
(`kul`, `northern`, `sabah`, `sarawak`, `southern_east_coast`, `unclassified`), 20 `org_stations`,
**0 `org_teams`**, legacy `teams` 4, legacy `station_teams` 4, legacy `stations` 20.

Legacy teams: `teams` = ALPHA, BRAVO, CHARLIE, DELTA (`supabase/migrations/avsec/0001_init_schema.sql:44-49`).
`station_teams` = those four, all at `KUL - MAA`. The 16 profiles are all at `KUL - MAA`
(Alpha 3, Bravo 3, Charlie 3, Delta 3, none 3, `QA` 1). No profile has `org_team_id`; no assignment has `team_id`.

Why `org_teams` is empty: Phase 2 creates the table and states that `org_team_id` is not backfilled and
seeds no teams (`20260928000001_phase2_org_foundation.sql:122-123, 274`). Teams are station-scoped
(`unique (station_id, name)`), and Phase 3 rejects a `team_id` that does not belong to the assignment's own
station (`20260928000002...:277-281`), so each station needs its own rows.

CaterLink capability (`caterlink_station_capabilities`, 9 rows): `AOR, BKI, IPH, JHB, KCH, KUL - AAX, KUL - MAA,
LGK, PEN`. Without it (11): `BTU, KBR, KUA, LBU, MKZ, MYY, SBW, SDK, SZB, TGG, TWU`.

## 3. Roles that require `team_id`
`sat_aso`, `profiling_so`, `profiling_aso`, `dse`, `sso`, `so`, `aso` (7 of 23). `hub_se` is hub-wide (no station
or team); investigation roles have no hub/station/team; all other roles have no team.
`sat_aso` and `dse` must be at a KUL-hub station. Profiling and station roles accept any hub.

## 4. Proposed idempotent `org_teams` seed (not applied)
`scripts/staging/seed-org-teams.mjs` (dry-run by default; `--apply --confirm=seed-established-teams`):

| station | team |
|---|---|
| KUL - MAA | ALPHA |
| KUL - MAA | BRAVO |
| KUL - MAA | CHARLIE |
| KUL - MAA | DELTA |

Only rows already established by the repository and live legacy data. Existing rows are never modified.
No team is established for PEN, JHB, BTU or any other station, and none is invented.

## 5. Exact account inventory (37 planned, 36 creatable with current data)
23 base + 7 station variants (KUL x3, JHB x3, one no-CaterLink station `BTU`) + 7 negative-state.
The foreign-AOC account is impossible today (one AOC only). Negative-state accounts use `KUL - MAA / ALPHA`
because they test authorization state, not geography. Availability:

* **Ready now (16):** `airasia_management, ghod, global_reporting_controller, super_admin, maa_boss, maa_admin,
  aax_boss, aax_admin, operation_manager, main_enforcement, compliance, caterlink_management,
  investigation_sso, investigation_so, investigation_aso, hub_se`
* **Need the KUL team seed (11):** `sat_aso, dse, sso-kul, so-kul, aso-kul` and the 6 creatable negatives
  (`neg-pending, neg-rejected, neg-deactivated, neg-revoked, neg-expired, neg-future-dated`), all `KUL - MAA / ALPHA`
* **Blocked, team not established (9):** `profiling_so, profiling_aso, sso, so, aso` (PEN),
  `sso-jhb, so-jhb, aso-jhb` (JHB), `aso-no-caterlink` (BTU)
* **Impossible (1):** `neg-foreign-aoc`

The full per-account scope matrix is printed by `node scripts/staging/provision-test-accounts.mjs --dry-run`.

## 6. Decisions needed from the user
1. Approve the four KUL - MAA team rows above.
2. Names for PEN and JHB (and BTU) teams, or approval to move those accounts to `KUL - MAA`.
3. Whether the no-CaterLink station should be `BTU` (alphabetical default) or another of the 11.
4. Whether to add a second AOC (needed only for the foreign-AOC negative account).
5. How to resolve the staging-wide `unified_role` dependency in the legacy operational routes before any
   test-account login is attempted (every select naming the column currently fails).
6. The one `QA` team label on a legacy profile is not a legacy team; confirm it is not meant for `org_teams`.
