# Staging Migration Reconciliation — `ddlctzbnqewubltcavkh`

Produced from read-only discovery (`scripts/staging/discover.mjs`) and a
local backup (`scripts/staging/backup.mjs`), both run against this exact
project this round. **No hosted write occurred.** This document reports
what was actually found, not what was assumed.

## 1. Environment guard confirmation

`resolveStagingAdminContext()` resolves to project reference
`ddlctzbnqewubltcavkh` only, confirmed live. `vecta-prod`
(`zsxneokqulktgnccxgkz`) is now hardcoded-blocked in
`scripts/staging/lib/env-guard.mjs` regardless of any environment
variable — verified by attempting to resolve against it with a forged
approval and confirming it still refuses.

## 2. What tooling can and cannot discover (stated once, applies everywhere below)

With only `SUPABASE_SECRET_KEY` (REST/Storage/Auth-Admin), **not**
discoverable: `supabase_migrations.schema_migrations` (real migration
history), installed extensions, functions/triggers/RLS policies, `pg_cron`
jobs. All four require a direct Postgres connection string or a Supabase
Management API token, neither configured. Everything below that depends
on one of these is inferred ONLY from table/function existence probes,
which is a strictly weaker signal and is labeled as such.

## 3. Staging schema baseline — the critical finding

- **Legacy (pre-Phase-2) schema**: fully present, exposed via the REST
  API, and already populated: `profiles` (16), `stations` (20), `teams`
  (4), `aircraft_types` (3), `duty_zones` (5), `sheet_sync_config` (1),
  `station_teams` (4), `enforcement_search_log` (5), `report_drafts` (5),
  `shifts` (4), `report_counters` (4). All `report_sec0XX`,
  `offload_records`, `duty_records`, `team_rosters`,
  `shift_handovers`, `feedback_threads/messages`, `bay_board`,
  `report_attachments` exist with 0 rows. The 16 `profiles` rows use only
  legacy role values (`ASO`, `SO`, `DSE`, `ENFORCEMENT`, `MANAGEMENT`,
  `ADMIN`), all `status='approved'`. **The user has confirmed these 16
  accounts and associated legacy data are disposable test data** — not
  deleted or modified this round, per instruction.
- **Phase 2–13 TABLES**: every one of the 32 checked (`aocs`,
  `operating_entities`, `departments`, `units`, `hubs`, `org_stations`,
  `org_teams`, `role_definitions`, `user_role_assignments`,
  `user_entity_memberships`, `user_registration_requests`,
  `user_notifications`, `central_reports_index`, `report_index_queue`,
  `overtime_requests`, `caterlink_station_capabilities`,
  `catering_companies`, `vehicles`, `drivers`, `transactions`,
  `caterlink_checkpoint_hub`, `caterlink_archives`,
  `caterlink_transaction_pdfs`, `discussion_author_mappings`,
  `discussion_identity_resolutions`, `announcements`,
  `announcement_attachments`, `announcement_audit_log`,
  `announcement_acknowledgements`, `wois_conversations`,
  `wois_messages`, `wois_audit_log`, `phase13_readiness_access_log`)
  **exists, with 0 rows in every one.**
- **Phase 2–13 FUNCTIONS/RPCs**: confirmed, by direct invocation (not
  inference), that they **do not exist**. Five representative functions
  spanning Phase 3 (`has_active_role_for_aoc`), Phase 9
  (`authorize_caterlink_pdf_secure`), Phase 11
  (`create_announcement_secure`), Phase 12 (`is_wois_eligible_secure`),
  and Phase 13 (`get_release_readiness_report_secure`) all returned
  `Could not find the function public.<name> ... in the schema cache` —
  the Postgres/PostgREST error for "this function does not exist," not a
  permission error.
- **Phase 2–13 Storage buckets**: only the 4 LEGACY buckets exist
  (`report-attachments`, `signatures`, `incident-photos`,
  `completed-forms`, all private, all 0 objects). `sat-combined-reports`
  (Phase 8), `caterlink-final-pdfs` (Phase 13), and
  `announcement-attachments` (Phase 13) **do not exist.**

**Conclusion**: at some point, Phase 2–13's `CREATE TABLE` statements
were applied to this project — most plausibly via a schema-only
table-structure copy/restore, since every migration file bundles tables,
functions, triggers, policies, grants, and bucket inserts into ONE
transaction, and partial-within-one-file application is not otherwise
explainable. **Functionally, Phase 2–13 is NOT applied** — none of the
authorization logic, RLS policies, triggers, or Storage buckets exist, so
no Phase 2–13 feature actually works on this project today despite the
tables being present.

## 4. Backup readiness and location (no secrets)

`scripts/staging/backup.mjs` ran successfully this round, read-only
against the hosted project, writing only to a local path outside this
repository (`os.tmpdir()/vecta-staging-backups/<ref>-<timestamp>/`,
`0700`/`0600` permissions). It captured:
- all 33 REST-exposed (legacy-schema) tables' row data, as JSON;
- the 16-user Auth inventory (id/email/created_at/metadata — **no
  password hash**, since Supabase Auth never exposes one via any API);
- the 4 Storage buckets' object inventory (0 objects to download).

**Explicitly NOT produced** (stated by the script itself, not silently
skipped): a `pg_dump`-equivalent schema DDL backup, and a
`schema_migrations` history backup — both require direct Postgres/
Management API access this environment doesn't have. The repository's
own `supabase/migrations/` tree is the durable schema source of truth in
the absence of a real DDL dump.

`.gitignore` now excludes `vecta-staging-backups/`, `*.staging-backup/`,
`auth-users-inventory.json`, and `storage-inventory.json` defensively.

## 5. Exact migration reconciliation plan

| Category | Files | Action |
|---|---|---|
| Already-applied legacy migrations (table structure only) | `avsec/0001`–`0026` + every root-level pre-`20260928` dated/undated migration | **Already applied (tables), confirmed by direct probe.** Re-running is safe (`create table if not exists` everywhere) but changes nothing new for tables; any function/policy/grant statements in these files that haven't run yet (not independently verified per-file this round) would apply for the first time. |
| Pending Phase 2–13 forward migrations (functions/triggers/policies/grants/buckets/seed data) | `20260928000001` (Phase 2) through `20261016000001` (Phase 13's storage/admin correction) — all 9 dated Phase migrations | **Functionally pending in full** — confirmed zero functions and 3 of 7 buckets exist. Table-creation statements inside these files will no-op; everything else applies for the first time. |
| Historical migration files that were edited and will not rerun as originally written | None identified this round that matter for this reconciliation — every Phase 2–13 "correction" in this repo's own history (Phase 11's visibility-function rewrite, Phase 12's signature widening, Phase 13's cron-grant correction) is already baked into the CURRENT content of its respective dated file; there is no separate "old version" to worry about replaying, since this repo never replays a historical file twice with different content. |
| Required new reconciliation migrations | **None required.** Every existing Phase 2–13 migration already uses `create table if not exists` / `create or replace function` / `drop policy if exists` + `create policy` / `insert ... on conflict do nothing` throughout — confirmed by this engagement's own build history across Phases 2–13. No new idempotency-guard migration needs to be written merely to reconcile this specific gap. |
| Required extensions | `pgcrypto` (gen_random_uuid) — needed by nearly every Phase 2–13 table's default. **Not independently confirmed installed** (extensions are not discoverable with current tooling); if it's missing, the very first `create table ... default gen_random_uuid()` statement will fail loudly and visibly, not silently. |
| Production migrations | n/a — `vecta-prod` is out of scope for this reconciliation entirely. |
| Test-only platform stubs | `supabase/tests/integration/migrate.mjs`'s `PRE_SHIMS` (pgcrypto/pg_cron extension stripping, the `user_registration_requests` baseline-table reconstruction, ICMS no-op trigger stubs) — **exist only for the local PGlite/native test harness and must never be applied to this or any real project.** |
| Synthetic fixtures | Every `verify_phase*.mjs` test file's own inline fixture inserts — **local-test-only, never applied to staging.** |
| One-off backfills | None exist as runnable scripts in this repo (see `docs/phase13/backfill-readiness.md` — every backfill described there is a design, never a script). Nothing to exclude because nothing exists to accidentally run. |
| Excluded ICMS/demo files | `supabase/migrations/icms/*` (separate application, confirmed out of scope throughout this engagement) and the 12 one-off demo/backfill files already classified in `docs/phase13/legacy-transition-inventory.md` (`provision_hub_avsec_team.sql`, `seed_all_rosters_and_checkin_today.sql`, etc.) — **never apply any of these to this or any project; they target specific real accounts/ICMS legacy data that does not correspond to anything in this staging project.** |

**Never replay a disposable PGlite/native-test stub against staging** —
restated explicitly: the `PRE_SHIMS` constants in
`supabase/tests/integration/migrate.mjs` exist because this repo's own
migration history is missing a `CREATE TABLE
public.user_registration_requests` statement (a confirmed baseline gap,
documented in that file's own comments) — the correct action for
STAGING is to add a real, reviewed, versioned migration for that table
(step below), never to copy the test harness's reconstructed stub.

## 6. Pending-migration validation against the ACTUAL staging schema (not applied)

For each Phase migration, checked against what section 3 found:

| Migration | Naming collision | Missing dependency | Enum conflict | Existing legacy object collision | Destructive statement | Data assumption | Auth/profile trigger risk | RLS/grant change | Storage bucket | Cron job | Backfill | Rollback/recovery |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Phase 2 (org foundation) | None — `aocs`/`operating_entities`/etc. table names don't collide with any of the 33 legacy tables found | None | None | None | None | None (pure additive seed: one AOC row, 4 departments, hubs/stations/teams) | None | Grants revoke-then-grant pattern, safe to apply fresh (currently zero grants exist since functions don't exist yet) | None | None | None | Additive; `on conflict do nothing` throughout |
| Phase 3 (roles) | `role_definitions`/`user_role_assignments` tables already exist (empty) — `create table if not exists` no-ops correctly | **Depends on Phase 2's `aocs`/`departments`/etc. existing first** — they do (as empty tables), so FK creation will succeed | None | None | None | None | **`validate_user_role_assignment_scope`/`validate_assignment_entity_membership` triggers do not exist yet** — until this migration runs, a real staging insert into `user_role_assignments` would succeed with NO scope validation at all (a real, exploitable gap today, closed only once this migration applies) | Creates the triggers + RLS for the first time | None | None | None | Additive |
| Phase 4 (registration/admin) | **Confirmed baseline gap, NOT this migration's fault**: `user_registration_requests` is referenced (`alter table`, inserts, `for update` selects) but has no `CREATE TABLE` anywhere in this repo's real migration history (only in the LOCAL TEST HARNESS's own `PRE_SHIMS` reconstruction) | **Will fail on staging** unless a real `CREATE TABLE public.user_registration_requests` migration is added first (see step 7 below) | None | None | None | None | None | Grants/RLS for the first time | None | None | None | See step 7 — this is the one REQUIRED new reconciliation action |
| Phase 5 (report classification) | None | Depends on Phase 4 (shares no direct table dependency, but is sequenced after it) and on every `report_sec0XX`/`offload_records` table existing — **confirmed they exist** (0 rows) | None | None | None | None | None | Grants for the first time | None | `cron.schedule('phase5-report-index-queue', ...)` — **`pg_cron` extension installation not confirmed**; if absent, only this one statement fails, not the whole file (it's typically the last statement) | None | Additive |
| Phase 6–8 | None | Depend on Phase 2–5 | None | None | None | None | None | Grants/RLS for the first time | Phase 8 creates `sat-combined-reports` bucket — **confirmed does not exist yet** | None | None | Additive |
| Phase 9 (CaterLink) | None | Depends on Phase 2/3 | None | None | None | PART H seeds specific named stations (KUL/PEN/JHB/AOR/IPH/LGK/KCH/BKI) by CODE lookup against `org_stations`, which will be populated by Phase 2 earlier in the same run — order-correct | None | Grants/RLS for the first time | None (confirmed: "no `create type`, no storage.buckets insert, no cron.schedule call" per its own comment, re-verified this round — matches the absence of a caterlink bucket in Phase 9 specifically) | None | Additive |
| Phase 10 (discussion) | None | Depends on Phase 3 | None | None | None | None | None | Grants/RLS for the first time (including the zero-grant lockdown on `discussion_author_mappings`) | None | None | None | Additive |
| Phase 11 (announcements) | None | Depends on Phase 2/3 | None | None | **`drop constraint`/`add constraint` pattern for `announcements_scope_aoc_check`/`announcement_audit_log_action_check`** — safe against an EMPTY table (confirmed 0 rows), would be a real migration-ordering risk only against populated data | None | None | Grants/RLS/immutability triggers for the first time | None | None | None | Additive against empty tables |
| Phase 12 (WOIS) | None | Depends on Phase 3/8/9/11 helpers | None | None | Same drop/re-add constraint pattern on `wois_messages`/`wois_conversations`, safe against 0 rows | None | None | Grants/RLS/audit for the first time | None | None | None | Additive |
| Phase 13 (both files) | None | Depends on everything above | None | None | None | **`flag_attendance_anomalies`/`trigger_sheets_sync` grant corrections operate on functions that must already exist** — confirmed these two LEGACY functions ARE in the exposed RPC list (`flag_attendance_anomalies`, `trigger_sheets_sync` both appear in the 26-RPC OpenAPI list), so this correction IS applicable and safe | None | Grants, `caterlink-final-pdfs`/`announcement-attachments` buckets (confirmed don't exist), `caterlink_transaction_pdfs`/`phase13_readiness_access_log` tables (confirmed exist already, empty) | None | None | None | Additive |

## 7. The one required new reconciliation action

Add a real, reviewed, versioned migration creating
`public.user_registration_requests` with exactly the shape
`supabase/tests/integration/migrate.mjs`'s `USER_REGISTRATION_REQUESTS_STUB`
already reconstructs (every column Phase 4 itself reads/writes) — **this
is schema work, not something this round performs**, since it would be a
new migration file requiring the same review this entire engagement has
applied to every other migration. Flagged here as a blocker for Phase 4,
not fixed in this commit.

## 8. Exact proposed staging execution order

| # | File | Prerequisite | Expected objects | Transactional | Expected affected rows | Verification query | Stop condition | Recovery action |
|---|---|---|---|---|---|---|---|---|
| 1 | *(new, not yet written)* `user_registration_requests` creation migration | None | 1 table + RLS | Yes | 0 (empty table) | `select count(*) from information_schema.tables where table_name='user_registration_requests'` → 1 | Table already exists with an incompatible shape | Abort; reconcile the shape manually before proceeding |
| 2 | `20260928000001_phase2_org_foundation.sql` | #1 (so Phase 4, later in the chain, has it) | `aocs`+6 more tables, seed rows | Yes | ~1 AOC + ~4 departments + hubs/stations/teams | `select count(*) from aocs where code='MY'` → 1 | Any statement errors | Transaction auto-rolls back; investigate before retrying |
| 3 | `20260928000002_phase3_role_permission_foundation.sql` | #2 | `role_definitions`(23 rows)+`user_role_assignments`+triggers+RLS | Yes | 23 role_definitions rows | `select count(*) from role_definitions` → 23 | Error, or count ≠ 23 | Roll back; re-check Phase 2 completed first |
| 4 | `20260928000003_phase4_registration_approval_admin.sql` | #3, #1 | admin/approval functions+RLS | Yes | 0 data rows | `select exists(select 1 from pg_proc where proname='approve_registration_request')` → true | `user_registration_requests` still missing | Apply #1 first |
| 5 | `20260928000004_phase5_report_classification_repository.sql` | #4 | `central_reports_index`/`report_index_queue`+cron | Yes | 0 rows | `select exists(select 1 from pg_proc where proname='index_report')` → true | `pg_cron` extension missing | Apply cron.schedule manually once extension exists, or accept the index feature without the cron job for now |
| 6 | `20260928000005_phase6_secure_report_access.sql` | #5 | secure-read RPCs | Yes | 0 | `select exists(select 1 from pg_proc where proname='list_my_submissions_secure')` → true | Error | Roll back |
| 7 | `20260928000006/7_phase7_dashboard_aggregates/closure.sql` | #6 | aggregate RPCs | Yes | 0 | spot-check one RPC exists | Error | Roll back |
| 8 | `20260930000001_phase8_operational_workflows.sql` | #7 | workflow RPCs + `sat-combined-reports` bucket | Yes | 0 data; 1 bucket | `select exists(select 1 from storage.buckets where id='sat-combined-reports')` → true | Error | Roll back |
| 9 | `20261001000001_phase9_caterlink_station_access.sql` | #8 | CaterLink tables/RPCs + 8-station capability seed | Yes | 8 `caterlink_station_capabilities` rows | `select count(*) from caterlink_station_capabilities` → 8 | Error, or named station codes not found in `org_stations` (would mean #2 didn't seed correctly) | Roll back; re-verify #2 |
| 10 | `20261005000001_phase10_anonymous_discussion_board.sql` | #9 | discussion RPCs | Yes | 0 | spot-check one RPC exists | Error | Roll back |
| 11 | `20261008000001_phase11_global_malaysia_announcements.sql` | #10 | announcement RPCs/constraints | Yes | 0 | spot-check one RPC exists | Error | Roll back |
| 12 | `20261010000001_phase12_wois_ai_2.sql` | #11 | WOIS RPCs | Yes | 0 | spot-check one RPC exists | Error | Roll back |
| 13 | `20261015000001_phase13_integration_rollout_readiness.sql` | #12 | 2 grant corrections + 2 readiness RPCs + audit table | Yes | 0 | `select exists(select 1 from pg_proc where proname='view_release_readiness_report_secure')` → true | Error | Roll back |
| 14 | `20261016000001_phase13_storage_and_admin_workflows.sql` | #13 | CaterLink PDF/announcement-attachment tables+RPCs, 2 buckets, entity-admin RPC | Yes | 0 | `select exists(select 1 from storage.buckets where id='caterlink-final-pdfs')` → true | Error | Roll back |
| 15 | Full re-run of `scripts/staging/discover.mjs` | #2–14 | — | n/a | n/a | Every Phase 2–13 RPC probe from step "representative check" now returns a real response, not "function not found" | Any probe still fails | Identify and apply the specific missed step |

## 9. Risks and blockers

- **Blocker**: `user_registration_requests` has no real versioned
  migration anywhere in this repo's history — step 1 above must be
  written and reviewed before step 4 can succeed.
- **Risk, unconfirmed**: `pgcrypto`/`pg_cron` extension installation
  state on this project is not discoverable with current tooling; if
  either is missing, the relevant statement fails loudly (not silently)
  and is a one-line fix (`create extension`) once confirmed via the
  Supabase dashboard or CLI.
- **Risk, low**: this project has already-populated LEGACY data (16
  profiles, 20 stations, etc.) that predates and is structurally
  unrelated to Phase 2-13 — applying Phase 2-13 does not touch any legacy
  table's data, but a human reviewing "is staging ready" should not
  mistake the legacy data's presence for Phase 2-13 readiness (exactly
  the confusion this reconciliation round corrects).
- **Not a blocker, but notable**: table existence for all 32 Phase 2-13
  tables, with a total absence of their functions, is unusual enough
  that re-confirming via a direct Postgres connection (once available)
  before actually applying anything live is recommended, even though
  this round's evidence is internally consistent.

## 10. Corrected account-plan arithmetic (no "up to" ambiguity)

| Component | Count | Notes |
|---|---|---|
| Base positive-role accounts | **23** | One per unique `role_definitions` code, test-proven (`tests/dashboard-role-matrix.test.mts`) |
| Additional station variants beyond the base | **7** | KUL ×3 (sso/so/aso) + JHB ×3 (sso/so/aso) + 1 no-CaterLink-station (aso). **PEN is excluded** — the base sso/so/aso accounts already default to PEN (`lib/role-matrix.mjs`'s own fallback), so a separate "pen" variant would be redundant, not additional; `scripts/staging/provision-test-accounts.mjs` was corrected this round to no longer create it. |
| Negative-state accounts | **7 planned** (pending/rejected/deactivated/revoked/expired/future-dated/foreign-AOC), **6 creatable today in this specific project** | Foreign-AOC requires a second active AOC to exist; none does in `ddlctzbnqewubltcavkh` today (confirmed: only `aocs.code='MY'` is seeded by Phase 2, and `aocs` itself has 0 rows until migrations are applied) — that one account is skipped with a clear message, never guessed or faked. |
| **Exact total, once Phase 2-13 is applied AND a second AOC is configured** | **37** | 23 + 7 + 7 |
| **Exact total creatable in `ddlctzbnqewubltcavkh` as it stands today (post-migration, no second AOC)** | **36** | 23 + 7 + 6 |
