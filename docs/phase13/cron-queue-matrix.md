# Cron / Queue / Background-Job Matrix

Three real `cron.schedule()` calls exist in the repository (confirmed by
`grep -rln "cron.schedule" supabase/migrations`); two others referenced in
the ICMS module and one in a dropped-legacy-OT migration are out of scope
(ICMS is a separate app; the dropped migration's cron job no longer
exists — confirmed by its filename, `20260914000006_drop_legacy_ot_requests.sql`).

| Job | Owner | Schedule | Function | Permissions (before this phase) | Permissions (after this phase) | Idempotent | Retry behavior | Monitoring query | Stale threshold | Failure alert | Manual recovery | Disable/rollback |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `phase5-report-index-queue` | Phase 5 | `* * * * *` (every minute) | `process_report_index_queue(50)` | `service_role` only (correct already) | unchanged | Yes — unique index on `(source_table, source_id)` prevents double-indexing | `attempts`/`status` columns; `permanently_failed` after repeated failure (exact threshold sampled, not re-derived this round) | `select count(*) from report_index_queue where status in ('pending','failed')` | Not formally defined; a `pending` row older than ~5 minutes under a 1-minute schedule is a strong signal something is stuck | None implemented (no alerting table/webhook found) | Reset a `permanently_failed` row's `status` to `'pending'` manually | `select cron.unschedule('phase5-report-index-queue');` |
| `sheets-sync-every-2-min` | AVSEC (legacy, pre-Phase-2) | `*/2 * * * *` | `trigger_sheets_sync()` | **No grant/revoke statement at all → default PUBLIC execute (callable by `anon`)** | **Corrected this phase**: revoked from `public, anon, authenticated`; granted to `service_role` only | Yes — it's a no-op when sync is disabled/unconfigured | None beyond the Edge Function's own retry (out of this repo) | n/a locally (depends on `sheet_sync_config` and a live Edge Function) | n/a locally | n/a locally | `select cron.unschedule('sheets-sync-every-2-min');` or set `sheet_sync_config.enabled = false` |
| `flag-attendance-anomalies` | AVSEC (legacy, pre-Phase-2) | `0 20 * * *` (daily 20:00) | `flag_attendance_anomalies(4)` | **Granted to `authenticated` with no internal role check** | **Corrected this phase**: revoked from `public, anon, authenticated`; granted to `service_role` only | Yes — `on conflict (profile_id, duty_date, shift_code) do nothing` for the absence-sweep insert; the two `update` statements are naturally idempotent (they only flip a boolean from false to true) | None beyond Postgres's own statement atomicity | `select count(*) from duty_records where is_missing_checkout and duty_date = current_date - 1` as a rough proxy | Not formally defined | None implemented | `select cron.unschedule('flag-attendance-anomalies');` |

## Cron-only functions confirmed NOT executable by `anon`/`authenticated` (after this phase)

- `process_report_index_queue` — already correct.
- `trigger_sheets_sync` — corrected this phase.
- `flag_attendance_anomalies` — corrected this phase.

A broader sweep for every other `SECURITY DEFINER` function with a
missing or over-broad grant was **not** performed exhaustively this round
(that would mean individually reviewing every `grant`/`revoke` statement
across ~100 migration files); the three functions above were found
specifically because they are the only `cron.schedule()` targets, which
this phase's instructions called out by name as the thing to check.

## Local platform substitution vs. managed Supabase pg_cron

PGlite has no `pg_cron` extension; `migrate.mjs` strips `create extension
if not exists pg_cron;` lines and the harness calls `process_report_index_queue`
and the attendance sweep **manually**, never on a real schedule. The
native PostgreSQL 17 test instance used for `verify_*:native` is a plain
Postgres install, also without `pg_cron` configured. **Neither local
platform proves a real cron schedule actually fires, fires on time, or
survives a database restart** — that is exclusively a managed-Supabase,
staging-environment concern (see `rollout-runbook.md` step 9).
