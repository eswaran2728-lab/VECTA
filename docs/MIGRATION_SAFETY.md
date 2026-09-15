# VECTA DATABASE MIGRATION SAFETY STANDARD

## 1. Production Migration Principle
VECTA operates 24/7 aviation security and continuity workflows. Zero unplanned downtime and zero audit log / report loss are strict requirements.

## 2. 7-Step Migration Lifecycle Standard
Every production database change MUST adhere to the following sequence:

```text
PRE-CHECK → MIGRATION DRAFT → CODE REVIEW → RECOVERY PLAN → APPLY → VERIFY → ROLLBACK (IF REQUIRED)
```

1. **PRE-CHECK:**
   - Verify active connections and lock status on target tables.
   - Verify compatibility with existing table rows.
   - Ensure RLS policies and immutability triggers will remain intact.

2. **MIGRATION DRAFT:**
   - Always use idempotent DDL (`ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `DROP CONSTRAINT IF EXISTS`).
   - Use `CONCURRENTLY` for index creation on large tables (`CREATE INDEX CONCURRENTLY`).
   - For column additions with default values, avoid lock contention in Postgres 11+ by using standard constant defaults.

3. **CODE REVIEW:**
   - Check for prohibited patterns:
     - ❌ `DROP TABLE` or `TRUNCATE`
     - ❌ `ALTER TABLE ... DISABLE TRIGGER ALL` on production security tables without explicit approval
     - ❌ Unbounded `UPDATE` or `DELETE` without indexed `WHERE` clause
     - ❌ Removing `ops_group` from RLS policies
     - ❌ Simplifying `(station + team + ops_group)` to `(station + team)`

4. **RECOVERY PLAN:**
   - Prepare a corresponding forward rollback script before executing any migration.

5. **APPLY:**
   - Execute in a transaction block (`BEGIN; ... COMMIT;`) when DDL supports transactional execution.
   - For long-running index creations, execute outside transaction blocks using `CONCURRENTLY`.

6. **VERIFY:**
   - Query `supabase_migrations` to confirm applied status.
   - Run automated RLS regression tests (`npm test`).
   - Verify `/api/health` returns status `ok`.

7. **ROLLBACK:**
   - If error rates increase or RLS regressions occur, immediately execute recovery plan.

## 3. Immutability Trigger Protection Policy
Submitted SEC reports (`report_sec013`, `report_sec014`, `report_sec016`, `report_sec018`, `report_sec029`, `report_sec033`, `offload_records`) are protected by PostgreSQL triggers blocking UPDATE/DELETE.
- Any DBA remediation that requires updating historical records must be documented as an explicit, controlled DBA procedure and require owner review.
