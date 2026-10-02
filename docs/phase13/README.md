# Phase 13 — Integration, Legacy Transition Readiness & Rollout Controls

This directory is the evidence-backed integration/readiness package Phase 13
produces. It is **not** a claim that VECTA's Malaysia upgrade is ready for
production — see `rollout-runbook.md` for everything that still has to
happen in staging, UAT, trial, and ICT handover before that is true.

Method: every finding below traces to a real file, migration, function, or
`grep` result cited inline — nothing here is inferred from a migration's
existence alone. Where a subsystem was sampled rather than traced
line-by-line (because full exhaustive tracing of ~100 migration files and
every route in one phase is not realistic), that is stated explicitly next
to the finding, not implied to be complete.

| Document | Covers |
|---|---|
| [`integration-matrix.md`](./integration-matrix.md) | Per-subsystem authoritative tables/RPCs/roles/routes/legacy paths/audit/notifications/storage/jobs/rollback/staging-only tests |
| [`legacy-transition-inventory.md`](./legacy-transition-inventory.md) | Legacy `MANAGEMENT`/`ADMIN`/`ENFORCEMENT` inventory, classification, and the retirement gate |
| [`migration-deployment-manifest.md`](./migration-deployment-manifest.md) | Migration inventory, dependency order, and the reconciliation-based rollout approach |
| [`backfill-readiness.md`](./backfill-readiness.md) | Every backfill Phases 2-12 introduced or require, and its preflight/quarantine design |
| [`feature-activation-controls.md`](./feature-activation-controls.md) | Activation/rollback controls for every major Phase 8-12 system, including Gemini |
| [`cron-queue-matrix.md`](./cron-queue-matrix.md) | Every scheduled/background job: owner, schedule, permissions, monitoring, recovery |
| [`storage-matrix.md`](./storage-matrix.md) | Every storage bucket: authority, expiry, isolation, and the two gaps found |
| [`ownership-matrix.md`](./ownership-matrix.md) | Notification/audit/export/archive ownership, confirmed against the approved role list |
| [`route-navigation-closure.md`](./route-navigation-closure.md) | Protected-route/navigation inventory and the closure test that enforces it |
| [`dashboard-adjustment-inventory.md`](./dashboard-adjustment-inventory.md) | What the *next* step (consolidated dashboard adjustment) needs per role — not built in Phase 13 |
| [`rollout-runbook.md`](./rollout-runbook.md) | The staging → UAT → trial → ICT handover sequence, step by step |

## What Phase 13 changed in the database

One new, additive, forward-only migration:
`supabase/migrations/20261015000001_phase13_integration_rollout_readiness.sql`.

- Revokes an over-broad `authenticated` grant on `flag_attendance_anomalies(int)`
  and the default PUBLIC grant on `trigger_sheets_sync()` (see
  `cron-queue-matrix.md` §"Findings corrected"). Both are confirmed, by
  `grep`, to have zero application callers — the correction changes nothing
  for any current user or feature.
- Adds two read-only, Super-Admin-gated, audited reports:
  `view_legacy_role_mapping_report_secure()` and
  `view_release_readiness_report_secure()`, backing the retirement gate and
  the `/super-admin/readiness` page.

No historical migration file was edited. No production/remote database was
touched. No backfill was executed.
