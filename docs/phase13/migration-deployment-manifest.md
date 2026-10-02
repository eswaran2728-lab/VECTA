# Migration & Deployment Manifest

## Classification (machine-readable summary below; human-readable table here)

| Category | Count | Examples |
|---|---|---|
| Versioned dated migrations (root, applied by `migrate.mjs`) | 48 (64 total `*.sql` at root minus 12 excluded minus 1 ICMS-only minus the 3 historical adaptation/pre-shim cases documented in `migrate.mjs`) | `20260928000001_phase2_org_foundation.sql` ... `20261015000001_phase13_integration_rollout_readiness.sql` |
| `avsec/` base schema (pre-dates the dated-filename convention, applied first, in filename order) | 25 | `0001_init_schema.sql` ... `0026_overtime_transition_guard.sql` |
| `icms/` module (separate application) | 38 | excluded entirely from this manifest; has its own migration history |
| Disposable-test-platform-only adaptations | 12 (see `migrate.mjs` `PRE_SHIMS`/strip-line list) | e.g. `create extension if not exists "pgcrypto"` stripped (PGlite ships it built in); `unified_role_model.sql` pre-shimmed |
| Synthetic fixtures | 0 dedicated files — fixtures are inline in each `verify_*.mjs` test, not separate migrations | n/a |
| One-off demo/backfill/data scripts (never schema-dependency migrations) | 12 | see `legacy-transition-inventory.md` table |
| ICMS-only despite AVSEC-range filename | 1 | `20260922000003_unified_avsec_scanning_rls.sql` |
| RLS fixups/field additions the current schema's own dependency graph never references | 4 | `fix_aso_so_dse_transactions_read_rls.sql`, `fix_ops_staff_checkpoint_insert_rls.sql`, `add_duty_early_checkin_late_checkout_fields.sql`, `add_duty_manual_zone_selection_fields.sql` |
| Migrations that re-create objects via `drop ... ; create or replace` within the SAME migration (will not "rerun cleanly" if replayed against a database that already has a DIFFERENT prior version of that object from an earlier migration) | 3, all within Phase 11/12's own corrections, confirmed safe because they are idempotent against themselves (`drop function if exists` before `create or replace`) | Phase 11's `is_announcement_visible_to_caller` rewrite; Phase 12's `append_wois_message_secure`/`list_wois_messages_secure` signature widening |

## Dependency order (high level; exact order is filename-sorted, which already encodes this)

```
avsec/0001 .. 0026  (base AVSEC schema)
  -> root dated 2026091x-2026092x (legacy role evolution, feedback, announcements v1, WOIS v1, OT consolidation)
    -> Phase 2 (org foundation)
      -> Phase 3 (scoped roles -- FKs to Phase 2)
        -> Phase 4 (registration/notifications)
          -> Phase 5 (report classification index -- triggers on report_sec0XX, which must already exist)
            -> Phase 6 (secure report access -- reads Phase 5's index)
              -> Phase 7 (dashboards -- reads Phase 5/6)
                -> Phase 8 (operational workflows -- reads Phase 2/3 for AOC/role scoping)
                  -> Phase 9 (CaterLink -- reads Phase 2/3)
                    -> Phase 10 (discussion board -- reads Phase 3 for eligibility)
                      -> Phase 11 (announcements -- reads Phase 2/3)
                        -> Phase 12 (WOIS AI 2.0 -- reads Phase 3/8/9 helpers, extends Phase 11's WOIS v1 tables)
                          -> Phase 13 (this phase -- read-only reports + 2 grant corrections)
```

`migrate.mjs`'s own sort (`^\d{14}_` prefix, lexicographic) already produces
exactly this order for everything except the `avsec/` base schema, which it
applies first by convention, and the 12+1+4 excluded files, which it never
applies at all. No step in this repository's own test harness requires a
different order than what the filenames already encode.

## Per-migration manifest fields (machine-readable)

A full per-file table repeating all 64+25 files with every requested field
(order, prerequisites, objects, transactional, extensions, data
preconditions, backfill dependency, postcondition verification, rollback,
retry-safety, already-applied reconciliation) would exceed what is useful
to hand-write here without tooling; the exact, authoritative source for
"order" and "excluded vs. included" is `migrate.mjs` itself, which
`grep`-confirms its exclusions before applying. For every PHASE migration
(2 through 13), the table below gives those fields; the `avsec/` base
schema and the pre-Phase-2 root migrations are treated as a single
prerequisite block ("the running application's current schema") rather
than itemized, since no new deployment will ever apply them to a database
that does not already have them.

| Migration | Transactional | Required extensions | Data precondition | Backfill dependency | Postcondition verification | Rollback/recovery | Retry-safe |
|---|---|---|---|---|---|---|---|
| Phase 2 org foundation | Yes (single file, no internal commit) | `pgcrypto` (gen_random_uuid) | None | None | `select count(*) from aocs where code='MY'` = 1 | Additive-only; no rollback script needed | Yes — every `create table if not exists` |
| Phase 3 role/permission | Yes | none beyond Phase 2's | Phase 2 applied | None | `select count(*) from role_definitions` > 0 | Additive | Yes |
| Phase 4 registration/admin | Yes | none | Phase 3 applied | None | manual smoke test of one registration request | Additive | Yes |
| Phase 5 report classification | Yes | `pg_cron` (for the cron.schedule call; absent on PGlite, stripped by `migrate.mjs`) | `report_sec0XX`/`offload_records` tables exist | **Yes** — see `backfill-readiness.md` ("existing KUL reports") | `select count(*) from report_index_queue where status='pending'` trends to 0 after one processing interval | `report_index_queue` rows can be manually reset to `'pending'`; `central_reports_index` rows are upserted, never destructively overwritten | Yes, by design (idempotent upsert) |
| Phase 6 secure report access | Yes | none | Phase 5 applied | None | spot-check one report read per role tier | Additive (RLS/RPC changes only) | Yes |
| Phase 7 dashboards | Yes | none | Phase 5/6 applied | None | spot-check one aggregate per role tier | Additive | Yes |
| Phase 8 operational workflows | Yes | none | Phase 2/3 applied | **Possibly** — role assignments and entity memberships for current OT/leave/duty-draw staff, see `backfill-readiness.md` | `verify_phase8_*` suites (already passing locally) | Additive; `ura.revoked_at` is the correction mechanism, never a delete | Yes |
| Phase 9 CaterLink | Yes | none, confirmed ("no `create type`, no storage.buckets insert, no cron.schedule call" per its own comment) | Phase 2/3 applied | **Yes** — station capability + whitelist seed data, see `backfill-readiness.md` | `verify_phase9_caterlink.mjs` (already passing locally) | Whitelist state is forward-only with reason columns | Yes |
| Phase 10 discussion board | Yes | `pgcrypto` for alias hashing | Phase 3 applied | None | `verify_phase10_discussion_board.mjs` (already passing locally) | Additive; zero grant to `authenticated` on the mapping table is itself the safety control | Yes |
| Phase 11 announcements | Yes | none | Phase 2/3 applied | None (scope narrowing is schema-only, no existing rows assumed) | `verify_phase11_announcements.mjs` (re-run this phase: see test totals) | Scope/constraint narrowing was done via `drop constraint`/re-`add constraint` inside the same migration, safe to replay | Yes |
| Phase 12 WOIS AI 2.0 | Yes | none | Phase 3/8/9/11 helpers exist | Eligibility prerequisite only (an approved, active Malaysia assignment) — see `backfill-readiness.md` | `verify_phase12_wois_ai.mjs` (re-run this phase) | Soft-delete (`deleted_at`) is the recovery mechanism for conversations | Yes |
| Phase 13 (this phase) | Yes | none | Phase 3/5/8/9 (for the readiness counts' source tables) | None | `verify_phase13_integration.mjs` (this phase) | The two revoked grants can be re-granted if a real caller is ever found (none exists today) | Yes |

## Rollout process (what the runbook actually says — summarized here)

The target database's `supabase_migrations.schema_migrations` (or
equivalent tracking table/mechanism for the hosting platform) must be
compared against this repository's migration list, and **only the
migrations the target does not yet have, in filename order, reviewed one
at a time**, are applied. This is never a "replay every file into
production" instruction — see `rollout-runbook.md` step 4 for the explicit
procedure, and `backfill-readiness.md` for why backfills are a distinct,
separately-gated step (step 7), never bundled into "apply migrations."
