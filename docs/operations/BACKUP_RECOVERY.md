# VECTA Database Backup & Recovery

Production Supabase project `zsxneokqulktgnccxgkz` ("vecta-prod") is on the **Supabase Free plan**, which provides **no automatic backups and no Point-in-Time Recovery (PITR)**. Per an explicit operator decision (2026-09-21), VECTA is **not** upgrading to a paid Supabase plan to obtain this. This document describes the independent, free, verified backup/recovery mechanism implemented instead.

**Status as of this writing: VERIFIED. Run #2 (2026-09-21) completed the full pg_dump → validate → isolated restore → data/integrity verification → artifact upload sequence successfully — see "Restore Test Result" below for the actual evidence.**

---

## Backup Method

**`pg_dump` in custom (`-Fc`) format**, scoped to the `public` schema only, run inside GitHub Actions on an official `postgres:17` container image — guaranteeing the client tooling exactly matches the production server version (Postgres 17.6).

Workflow file: [`.github/workflows/db-backup.yml`](../../.github/workflows/db-backup.yml)

Why `pg_dump` custom format over a raw SQL dump: it's compressed, supports parallel restore (`--jobs`), and — critically for the validation step — its table-of-contents can be inspected with `pg_restore --list` **without connecting to any database**, so a corrupted/incomplete dump is caught immediately, in the same run that produced it, before it's ever trusted.

## Schedule

**Daily, at 18:17 UTC (02:17 Asia/Kuala_Lumpur)** — a low-traffic hour for this app — via the workflow's `cron` trigger. Also runnable on-demand any time via **GitHub → Actions → "VECTA Database Backup & Restore Verification" → Run workflow** (the `workflow_dispatch` trigger).

## Storage Location

**GitHub Actions build artifacts**, uploaded at the end of each successful run (`actions/upload-artifact@v4`). This deliberately avoids adding any new third-party storage service, credential, or cost — the artifact store is already part of the same GitHub account/repository this codebase lives in, access-controlled by the same repository permissions.

## Retention

**30 days, rolling.** Each day's artifact is named `vecta-db-backup-<UTC timestamp>` with `retention-days: 30` — GitHub automatically expires artifacts older than that, so the repository always holds roughly the last 30 daily generations without any manual cleanup.

## Credential Requirements

**One GitHub Actions repository secret, `SUPABASE_DB_URL`**, containing the database connection string with password — added by a human directly in the GitHub web UI, never passed through code, chat, or committed to the repository. See "Activation" below for the exact value to use.

The workflow's first step (`Guard — required secret present`) fails immediately with a clear message if this secret is missing, rather than silently skipping the backup.

## Activation (one-time operator action required)

1. Go to **Supabase Dashboard → `vecta-prod` project → Project Settings → Database → Connection string**.
2. Select the **"Session pooler"** tab (not "Direct connection") — GitHub Actions runners are IPv4-only, and Supabase's direct database host on newer projects is IPv6-only; the Session Pooler connection is IPv4-compatible and fully supports `pg_dump`/`pg_restore`.
3. Copy the URI, and replace `[YOUR-PASSWORD]` in it with your actual database password (Dashboard → Project Settings → Database → Database Password — reset it there if you don't have it saved).
4. In GitHub: **this repository → Settings → Secrets and variables → Actions → New repository secret**.
   - Name: `SUPABASE_DB_URL`
   - Value: the connection string from step 3.
5. Optionally trigger the workflow immediately: **Actions tab → "VECTA Database Backup & Restore Verification" → Run workflow** — otherwise it runs automatically at the next scheduled time.

## How to Verify a Backup Ran

**GitHub → Actions → "VECTA Database Backup & Restore Verification"** — each run shows PASS/FAIL for every step (dump, validation, restore-test, verification queries, artifact upload). A green run is real, executed evidence: the dump was non-empty, contained the expected VECTA tables, was successfully restored into a real (if temporary) Postgres 17 instance, and representative tables/relationships were queried successfully in that restored copy. **A failed run sends GitHub's standard workflow-failure notification** to the repository's configured recipients — this is the failure-detection mechanism, and it's on by default with no extra setup.

To download and inspect a specific backup: open a successful run → **Artifacts** section at the bottom → download `vecta-db-backup-<timestamp>` → this is the actual `.dump` file usable for a real recovery (see below).

## How to Restore

**Never restore over production directly without a deliberate, reviewed decision to do so.** For inspection/drills, always restore into a separate database first (a new Supabase project, or a local/throwaway Postgres instance — exactly what the workflow itself does automatically on every run, into a container that's destroyed immediately after).

```bash
# 1. Create or point at a target database (NEVER production for a drill):
#    e.g. a fresh local Postgres, or a new empty Supabase project.

# 2. Restore the downloaded .dump file:
pg_restore --no-owner --no-privileges \
  --host=<target-host> --port=5432 --username=postgres --dbname=<target-db> \
  --jobs=4 \
  vecta_backup_<timestamp>.dump

# 3. Verify representative tables/counts match expectations (the workflow's
#    own "Verify restored data" step shows the exact queries used).
```

**For an actual production recovery** (production genuinely lost/corrupted): restore the most recent known-good artifact into a **new** Supabase project first, verify it thoroughly using the same representative-table checks the workflow runs, then repoint the application's `NEXT_PUBLIC_SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` environment variables at the recovered project once confidence is established — do not attempt an in-place restore over a project that might still hold partially-intact, recoverable data without first taking a fresh dump of its current state for comparison.

## Restore Test Result

**Verified via real execution.**

- **Run**: [`VECTA Database Backup & Restore Verification #2`](https://github.com/eswaran2728-lab/VECTA/actions/runs/35565575933) — 2026-09-21, manually triggered, branch `claude/merge-icms-avsec-aa-ops-67cnk0`, commit `15af816`. Status: **Success**, 58s.
- **Dump**: `pg_dump` of the production `public` schema completed; artifact `vecta-db-backup-20260921_054305Z` uploaded, 112 KB / 114,546 bytes, SHA256 `905542a83a9a9c692acebdf0b4cf990a9383cde4da1ce0e9f2bc02963154bbe5`.
- **Validation**: dump size check and `pg_restore --list` table-of-contents check both passed — all 10 representative tables (`profiles, users, report_sec014, report_sec016, report_sec029, report_acknowledgements, transactions, overtime_requests, shift_handovers, duty_records`) confirmed present in the dump's structure before any restore was attempted.
- **Restore**: `pg_restore` into the throwaway `restore-target` Postgres 17 service container completed. 225 statements were rejected (`pg_restore: error: could not execute query: ERROR: schema "auth" does not exist`) — every one of these was a `CREATE POLICY ...` statement referencing `auth.uid()`/`auth.*`, because the isolated restore container is a bare `postgres:17` image with no Supabase `auth` schema. This is the exact, expected consequence of the Known Limitations documented below (this mechanism does not back up or restore Supabase Auth) — RLS **policy objects** could not be recreated in this throwaway container, but this did not affect the underlying **tables or data**, which restored completely (see next point). Restoring into a real recovery target — a new Supabase project, which already has the `auth` schema — would not hit this error.
- **Data verification** (live query output against the restored copy):

  | table | row count |
  |---|---|
  | duty_records | 456 |
  | profiles | 31 |
  | report_acknowledgements | 1 |
  | report_sec014 | 3 |
  | transactions | 6 |
  | users | 30 |

  Referential integrity check (`report_acknowledgements.acknowledged_by` → `profiles.id`): **0 orphaned rows** — every acknowledgement in the backup correctly links to a real profile.

**Conclusion**: the backup mechanism is confirmed working end-to-end for its documented scope (schema + data in `public`). The 225 ignored errors are a documented, expected limitation (Auth schema not covered by this mechanism, per "Known Limitations" below), not a defect in the backup/restore of application data.

## Known Limitations

This mechanism backs up **PostgreSQL data and schema in the `public` schema only**. It explicitly does **not** cover:

- **Supabase Auth** (`auth.*` schema — user accounts, password hashes, sessions, identities). A restored `public` schema alone will contain `profiles`/`users` rows whose `id` no longer corresponds to any real `auth.users` row in a fresh project — **logins would not work** until Auth users are separately recreated/migrated. This is the single most important limitation: **this is an application-data backup, not a full account-recovery mechanism.**
- **Supabase Storage** (signature images, incident photos, completed-transaction PDFs, uploaded attachments) — these live in Storage buckets, not the `public` Postgres schema, and are not included in a `pg_dump`. A restore recovers the *reference* (the file path stored in a table column) but not the file itself.
- **Edge Functions and their configuration/secrets** — not covered; these are deployed/configured separately in Supabase and would need to be redeployed independently.
- **Database roles, extensions, and cluster-level configuration** — `--no-owner --no-privileges` deliberately strips role/ownership information (which wouldn't exist identically in a recovery target anyway); this is a data/schema recovery mechanism, not a full cluster clone.

**Do not describe this as "full Supabase disaster recovery."** It is a verified, automated safety net for the application's relational data — the thing most at risk of silent corruption from a bad migration or application bug — not a substitute for Supabase's own paid backup/PITR product if full-fidelity recovery (including Auth and Storage) is later required.

## Recovery Procedure (summary)

1. Identify the most recent **green** (passing) workflow run in GitHub Actions.
2. Download its backup artifact.
3. Restore it into a **new**, empty Supabase project (or local Postgres for inspection) — never directly over a still-partially-functioning production project.
4. Run the same representative-table/row-count/referential-integrity checks the workflow itself runs, to confirm the restored data is sound.
5. Separately address Auth (recreate/migrate `auth.users`) and Storage (re-upload or recover signature/photo/PDF files from their original source if still available) before considering the recovery complete — per the Known Limitations above.
6. Only once (3)–(5) are verified, repoint the application's environment variables at the recovered project.
