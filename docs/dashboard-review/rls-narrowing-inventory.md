# RLS narrowing inventory — `20261020000001_canonical_operations_compatibility.sql`

Decisions applied (2026-10-05): merged IFC/Operation AVSEC; `ops_group` authorizes nothing;
`operation_manager → MANAGEMENT` is display/compat only and grants nothing in the database, routes or
workflows; Hub SE is hub-wide with no station and no scanning; the 16 staging users are disposable
legacy accounts expected to hold no canonical assignment.

All evidence below comes from read-only staging inspection (`scripts/staging/inspect-rls-surface.mjs`,
`dump-table-surface.mjs`, `dump-legacy-policies.mjs`, `check-data-api.mjs`) and the disposable PGlite /
native PostgreSQL 17 databases.

## 1. Broad access found on staging (before this migration)

| Table | Operation | Role | Row predicate (before) | Sensitivity | Callers | Outcome |
|---|---|---|---|---|---|---|
| catering_companies | SELECT | authenticated | `true` (`*_bootstrap_read`) | CaterLink admin data (pass expiry, audit cols) | ICMS new-transaction form, whitelist admin | **Narrowed**: station operators, CaterLink Mgmt, Operation Mgr with an active AOC assignment; column grant `id,name,code,is_active,pass_expiry_date,aoc_id,status` |
| drivers | SELECT | authenticated | `true` | **Personnel** (IC numbers, airport pass number) | transaction form, part B/C, transaction actions | **Narrowed**: same roles; columns `id,name,staff_id,catering_company_id,pass_expiry_date,is_active,aoc_id,status`. `staff_ic_number`, `swap_to_staff_ic`, `airport_pass_number`, audit fields no longer selectable |
| vehicles | SELECT | authenticated | `true` | CaterLink operational | same | **Narrowed**: same roles; columns `id,vehicle_number,catering_company_id,pass_expiry_date,truck_type,is_active,aoc_id,status` |
| aircraft_types, stations, teams | SELECT | authenticated | `auth.role()='authenticated'` | non-sensitive reference | none in app code (RPC/definer use) | **Narrowed** to `canon_is_active()` |
| duty_zones, shifts, station_teams | SELECT | authenticated | approved profile only | operational reference | duty check-in, roster | zones: `canon_station_visible(station)`; shifts/station_teams: `canon_is_active()` |
| 17 `FOR ALL` policies (roles `public`) | ALL | public | legacy `ADMIN` rank or parent-owner | administrative | — | ADMIN-rank ones **dropped**; zones/shifts re-created as canonical operation-specific policies; remaining owner-scoped ones split per operation and moved to `authenticated` |
| 39 policies reading the compat rank / `profiles.role` | various | public | `current_role_name()`, `current_role_rank()`, `is_monitor_or_above()`, `profiles.role` | personnel / operational | many | **All rewritten** to canonical `canon_*` predicates (section 6d); any stragglers are dropped by a generic closure (6e) |
| 44 tables / 48 functions | ALL / EXECUTE | anon | table & function grants | — | none | **Revoked** (tables, sequences, functions, default privileges); PUBLIC execute revoked on definers |
| 13 internal helpers (`get_report_submitter`, `submitter_role_rank`, `current_role_name`, …) | EXECUTE | authenticated | callable by any signed-in user | reveal others' ownership/rank/whitelist | none directly | **Revoked** from clients (service_role only) |

Created-by-this-migration broad access: the earlier draft's safety-net `*_authenticated_read` `using (true)`
policy is **removed**. RLS is still enabled on any table found without it (none on staging) but no read policy
is added. `sec029_checklist_items` (5 non-sensitive checklist columns) gets `canon_is_active()`.

## 2. Canonical scope helpers (all `SECURITY DEFINER`, `search_path = public`)

`canon_assignments`, `canon_is_active`, `canon_has_role`, `canon_my_level`, `canon_station_visible`,
`canon_team_visible`, `canon_same_team`, `canon_has_role_at_station`, `canon_can_admin_station`,
`canon_oversees`, `canon_can_view_profile` (EXECUTE: authenticated + service_role) and
`canon_profile_level` (internal, service_role only). Each reads only the caller's **active** assignments in the
legacy (Malaysia) AOC, with an approved profile and active role definition; revoked, expired, future-dated,
inactive, pending and rejected states return nothing. They never read `profiles.role`, the compat rank or
`ops_group`.

## 3. Remaining global reference reads

None. No `using (true)` or `with check (true)` policy remains (asserted by the verifier and a static test).

## 4. Data API exposure (staging, verified over HTTPS with the publishable key)

- `public` is exposed; `auth` is not (406). OpenAPI listing is disabled for anon (401).
- Before the migration anon still held table grants: `drivers` and `report_sec014` answered 200 with 0 rows
  (RLS only). After the migration anon holds no grant, so every table answers 401.
- Grants and RLS are both required: authenticated keeps only operations that have a matching policy
  (grant alignment loop), plus explicit column grants on the three whitelist tables.

## 5. ICMS absent-module behaviour

Staging lacks `users`, `incidents`, `incident_photos`, `segment_timeouts`, `part_a/d/hub/redq`,
`vendor_transactions`, `vendor_parts`. Pages that read them (`/icms/incidents`, `/icms/vendor-transactions`,
`/icms/admin/audit`, `/icms/admin/users`) now render `ModuleNotActivated` via `isModuleMissing()` (PGRST205 /
42P01 / PGRST200); a permission error is not treated as "missing". No placeholder tables or fixtures are
created, and an authorised canonical user is never redirected as unauthorised. CaterLink station-capability
authorization is unchanged. Still unavailable because the data module is absent: legacy incident log and
timeouts, vendor movement, legacy ICMS user admin, legacy `part_*` forms (`/icms/reports` incident/timeout
sections show empty data).

## 6. Legacy staging users

16 Auth users / 16 profiles, 0 canonical assignments. The migration performs no profile or Auth write; those
accounts lose operational access by design and are replaced by the 36 canonical test accounts.
