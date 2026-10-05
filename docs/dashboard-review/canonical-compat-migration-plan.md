# Canonical operations compatibility migration — hosted application plan

Status: **prepared, validated on disposable databases only. NOT applied to any hosted database.**
Applying it to `vecta-staging` (`ddlctzbnqewubltcavkh`) needs separate, explicit authorization.
`vecta-prod` (`zsxneokqulktgnccxgkz`) is out of scope and must not be contacted.

Migration file: `supabase/migrations/20261020000001_canonical_operations_compatibility.sql`
(forward-only, idempotent — a second application leaves the policy set unchanged, proven by
`verify_canonical_compat.mjs` section 9).

## Merged operations model (decision recorded 2026-10-05)

IFC AVSEC and Operation AVSEC are one operational structure. `profiles.ops_group` is **deprecated for
authorization**: it may stay readable for history, never grants or denies, and is never written with a
non-null value by application code. Authority is the Phase 3 assignment plus scope (AOC, department, unit,
hub, station, team, role code, assignment dates/state). CaterLink scanning/movement additionally needs the
approved station capability (`can_user_scan_caterlink`).

## What the migration changes

1. `canonical_compat_role_for(profile)` — maps canonical roles to the legacy compatibility rank
   (aso→ASO; so, sso→SO; dse, hub_se→DSE; operation_manager→MANAGEMENT; main_enforcement→ENFORCEMENT).
   Only assignments **inside the Malaysia (MY) AOC** map, because the legacy tables are Malaysia-only and
   their RLS is not AOC-scoped (found by `verify_phase8_multi_aoc`: without this a ZZ-AOC operation manager
   could update an MY overtime request). Every other role returns NULL and fails closed. EXECUTE is
   service_role only.
2. `current_role_name / current_status / current_station / current_team / is_monitor_or_above /
   submitter_role_rank` — same signatures, redefined to read canonical assignments only. Revoked, expired,
   future-dated, inactive-role, pending and rejected states fail closed (`current_status()` is `pending`
   without an active assignment).
3. `can_acknowledge_report` — canonical ranks; keeps the SEC014 SO-or-DSE rule; same station/team scoping.
4. `needs_your_action_secure`, `apply_compatibility_profile_fields` — no `ops_group`.
5. `list_eligible_supervising_officers_secure`, `is_eligible_supervising_officer_secure` — officer eligibility
   from the officer's own canonical assignment, never another user's legacy rank.
6. Roster: `can_manage_roster_secure`, `clear_roster_cell_secure`, `list_roster_officers_secure`,
   `list_roster_teams_secure`, policy `roster_canonical_scope_select` — operation_manager (any station),
   hub_se (stations of the assigned hub), dse (own station AND team). Fixes the DSE/Hub SE roster-link vs
   page-gate mismatch.
7. `absence_notices` policies replaced with canonical, scope-limited ones; SEC013 insert policy for Staff
   Profiling.
8. Every `FOR ALL` policy in `public` is split into operation-specific policies with identical predicates.
9. RLS safety net: any public table found without RLS gets RLS enabled; where clients could already
   SELECT it, a select-only `*_authenticated_read` policy preserves that read (e.g. reference tables such as
   `sec029_checklist_items`). All write paths on such tables become deny-by-default.
10. `anon` loses all table/sequence/function privileges in `public`; `authenticated`/`service_role`
    grants are preserved.

## Local validation (all green)

- PGlite: `npm test` in `supabase/tests/integration` (fresh golden DB), including
  `verify_canonical_compat.mjs`, `verify_phase8_multi_aoc.mjs`, `verify_export_isolation.mjs`.
- Native PostgreSQL 17.11: `npm run test:native` (port 55433), same chain.
- Harness fixtures were updated: legacy-only fixture users now also hold the matching canonical assignment
  (as real provisioning does), and scenario 27 expects the queued report of a fully scoped submitter to
  complete.

## Risks to review before authorizing

- **Legacy-only users lose access.** Any real account whose only authority is `profiles.role` (no active
  Phase 3 assignment) is treated as unassigned by legacy RLS after this migration. Staging has 16 profiles,
  all expected to hold assignments — verify with a read-only query before applying.
- The `anon` revoke and `FOR ALL` split are production-affecting if this migration is ever promoted.
- Reference-table read policies are deliberately permissive (`using (true)`, authenticated only) to keep
  existing behaviour; tighten later if any such table should not be globally readable.
- Operation-manager → MANAGEMENT is a policy mapping that needs the owner's review.
- Legacy ICMS tables (`public.users`, `incidents`, `part_*`, `vendor_*`) do not exist on staging; some ICMS
  page data parity remains unresolved and is not addressed by this migration.

## Required hosted action (separate authorization)

1. Read-only (verified TLS, `BEGIN READ ONLY`): confirm each of the 16 staging profiles holds an active
   assignment; list public tables without RLS (they will gain a deny-by-default posture).
2. Apply `20261020000001_canonical_operations_compatibility.sql` to **staging only** through the hardened
   runner `scripts/staging/apply-migrations.mjs`, in one transaction, with a recorded pre-state snapshot of
   policy and grant names.
3. Re-run the read-only authorization-surface inspector and compare with the snapshot.
4. Only after that, ask for authorization to provision the 36 test accounts.
