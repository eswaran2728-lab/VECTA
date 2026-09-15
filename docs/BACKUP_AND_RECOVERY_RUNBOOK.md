# VECTA BACKUP & RECOVERY RUNBOOK

## 1. System Overview & Scope
VECTA relies on PostgreSQL hosted on Supabase and object storage (Supabase Storage) for signatures, completed transaction PDFs, and incident photos.
AVSEC PDF/Excel exports are on-demand streams and NOT persisted in file storage.

## 2. Plan Limit & Infrastructure Baseline
- **Supabase Plan Limit:** PLAN LIMIT NOT VERIFIED (Tier-specific PITR/daily backup settings depend on dashboard configuration).
- **Postgres Engine:** 17.6 (ap-northeast-1).
- **Persistent Storage Drivers:**
  - File Storage: ~17.5 GB/year (incident photos, signed PDFs, signatures)
  - PostgreSQL Database: ~2.85 GB/year (audit logs, attendance, OT, SEC reports)

## 3. Disaster Recovery Scenarios & Step-by-Step Runbooks

### Scenario A: Bad Database Migration / DDL Failure
1. **Assessment:** Identify failed migration from `supabase_migrations` or deployment logs.
2. **Containment:** If application errors spike, revert deployment in Vercel to previous commit immediately.
3. **Rollback Execution:**
   - Check if an explicit down-migration or compensating migration is available in `supabase/migrations/`.
   - Never run `DROP TABLE` or `TRUNCATE` against production tables.
   - For failed constraint additions, execute `ALTER TABLE ... DROP CONSTRAINT IF EXISTS <constraint_name>;`.
4. **Verification:**
   - Execute `/api/health` endpoint to verify DB responsiveness.
   - Verify application queries in affected module (AVSEC, ICMS, OT).

### Scenario B: Accidental Record Corruption or Deletion
1. **Assessment:** Identify affected table and timestamps. Note: Submitted SEC reports (`report_sec013-033`) are immutable by DB triggers and cannot be deleted via normal app actions.
2. **Point-in-Time Recovery (PITR) / Backup Restore:**
   - **CRITICAL:** Do NOT restore a backup directly over the live production database instance if partial recovery is needed.
   - Restore backup to a staging/cloned database instance.
   - Extract missing or corrupted rows via `pg_dump` with `--data-only --table=<table_name>`.
   - Carefully insert extracted rows into production database with explicit transaction blocks (`BEGIN; ... COMMIT;`).

### Scenario C: Object Storage Loss or Corruption
1. **Assessment:** Inspect buckets `signatures`, `incident-photos`, `completed-forms`.
2. **Verification of Hashes:**
   - Signatures and incident photos carry SHA-256 hashes in database columns (`part_a.signature_hash`, etc.).
   - Query DB to verify whether metadata exists.
3. **Recovery:**
   - For missing completed-form PDFs: PDFs can be re-rendered on demand using transaction checkpoint data and stored signatures.

### Scenario D: Security Incident / Compromised Access
1. See [SECURITY_INCIDENT_RUNBOOK.md](file:///docs/SECURITY_INCIDENT_RUNBOOK.md) for full protocol.

## 4. Recovery Time & Point Objectives (RTO / RPO)
- **Target RPO (Recovery Point Objective):** <= 1 hour (managed automated daily backups + continuous WAL archiving if PITR active).
- **Target RTO (Recovery Time Objective):**
  - Application rollbacks (Vercel): < 5 minutes
  - Migration compensations: < 15 minutes
  - Database restoration from snapshot: < 30 minutes (current < 15GB DB scale)

## 5. Post-Restore Validation Checklist
- [ ] `/api/health` returns status `ok` and `database: true`.
- [ ] Login flow succeeds for test accounts.
- [ ] RLS policies verified: Ops AVSEC cannot view IFC AVSEC records.
- [ ] Immutability triggers verified active on `report_sec013-033` (`pg_trigger.tgenabled = 'O'`).
