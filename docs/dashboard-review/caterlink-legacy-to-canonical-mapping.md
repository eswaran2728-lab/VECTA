# CaterLink: legacy ICMS pages/actions mapped to the canonical Phase 9 model (option B)

Status: implemented and validated **locally only**. The proposed migration
`supabase/migrations/20261025000001_caterlink_external_workflows.sql` has **not** been applied to any
hosted database. Until it is applied, the pages that need it render "not activated" (they do not error).

Authority: the existing Phase 9 tables and secure RPCs are authoritative for Management and Driver. Only the
Third-Party Vendor workflow gets new tables. The 14 legacy tables are **not** recreated.

## Page mapping

| Page (under `app/(icms)/icms/`) | Legacy source | Canonical replacement | Status |
|---|---|---|---|
| `dashboard` (Driver/Vendor cards) | `transactions`, `vendor_transactions` | `transactions` (own rows via existing `created_by` policy); `caterlink_vendor_deliveries` | re-pointed |
| `dashboard` (Management) | `incidents`, `segment_timeouts`, `part_a..d` embeds, `status_entered_at` | `caterlink_incidents`; `caterlink_checkpoint_part_a`, `part_b_c`, `caterlink_checkpoint_part_d` embeds; SLA dropped | re-pointed; SLA warning removed (no canonical segment limits) |
| `transactions` (list) | `transactions`, `seals` | unchanged (already canonical) + new `seals` read policy so the creator can read its seals | works once the migration is applied |
| `transactions/new` | `catering_companies`, `vehicles`, `drivers` (RLS hides them from a Driver) | `list_caterlink_driver_options_secure()` | re-pointed |
| `transactions/[id]` | `part_a..d`, `part_hub`, `part_redq`, `incidents`, `segment_timeouts`, 15 absent `transactions` columns | rewritten read-only on `caterlink_checkpoint_*`, `part_b_c`, `caterlink_incidents`, `seals` | re-pointed (read-only) |
| `transactions/[id]/part-b, part-c, part-d, part-hub, part-redq, skip-part-d, incident` | legacy tables | none exists | **BLOCKED** (explicit stub; no checkpoint-write RPC in the canonical model) |
| `incidents` | `incidents`, `incident_photos` | `caterlink_incidents`; `resolve_caterlink_incident_secure`, `reopen_caterlink_incident_secure` | re-pointed; photo PDF export dropped |
| `reports` | `transactions` embeds, `incidents`, `segment_timeouts`, `catering_companies` embed | canonical sources; company names read separately; no SLA | re-pointed |
| `admin/archive` | `transactions` (archived), legacy `archive_all_pending` RPC | `transactions`; `archive_caterlink_transaction_secure` per transaction | re-pointed |
| `admin/audit` | `audit_logs` | `list_caterlink_audit_secure()` over `phase8_audit_log` | re-pointed (new RPC) |
| `admin/whitelists` | already canonical RPCs | unchanged | unchanged |
| `vendor-transactions` (list, new, `[id]`, `part-b`, `part-c`) | `vendor_transactions`, `vendor_part_a/b/c` | `caterlink_vendor_deliveries`, `caterlink_vendor_checkpoints` + 3 RPCs | re-pointed (new tables) |
| `scan` + `api/icms/qr/validate` | `vendor_transactions` for vendor passes | `caterlink_vendor_deliveries` (catering lookup unchanged) | re-pointed; scan permission unchanged |

## Action mapping

| Action | Legacy | Canonical |
|---|---|---|
| `createTransaction` (Driver) | inserts `transactions`+`part_a`+`seals` with 15 absent columns | `create_caterlink_driver_transaction_secure` (identity, whitelist, name match, numbering, seal, Part A, audit, all server-side) |
| `createVendorTransaction` | `vendor_transactions` + `vendor_part_a` | `create_caterlink_vendor_delivery_secure` |
| `submitVendorPartB` | `vendor_part_b`, role `post2_avsec` | `record_caterlink_vendor_security_check_secure` (authorised by the new `can_check_vendor_delivery` station capability + an active station-operator assignment; **not** derived from the scan decision) |
| `submitVendorPartC` | dual warehouse PIC + vendor signature | `complete_caterlink_vendor_delivery_secure` (owning Vendor only) |
| `resolveIncident` | direct update of `incidents` | `resolve_caterlink_incident_secure` |
| `reopenIncident`, `archiveSingleTransaction`, whitelist, export, PDF actions | already canonical RPCs | unchanged |
| `resetWeek` | `archive_all_pending` (absent) | loop of `archive_caterlink_transaction_secure` |
| `getExportResetBundle` | `part_a..d` | canonical checkpoint tables |
| `submitCheckpoint*`, `skipPartD`, `reportIncident`, `unescalate` in `actions/transactions.ts` | legacy tables | none; **unreachable** (their pages are BLOCKED stubs); left in place, flagged for removal |

Not changed (VECTA-side readers of legacy `incidents`/`transactions`; their errors are tolerated):
`app/page.tsx`, `lib/dashboard/flight-detail.ts`, `lib/dashboard/needs-your-action.ts`,
`lib/avsec/duty/handover-queries.ts`, `app/(avsec)/avsec/admin/alerts/page.tsx`,
`lib/icms/completed-form-pdf*.ts`.

## The proposed migration (additive, idempotent)

1. **Hardening**: revoke `TRUNCATE`, `REFERENCES`, `TRIGGER` from `anon`/`authenticated` on 17 CaterLink tables.
   Staging showed these granted through default privileges; RLS does not govern them, so any signed-in user could
   truncate e.g. `drivers` or the checkpoint tables. (Pre-existing exposure, now closed.)
2. **Read policies**: `SELECT` on `caterlink_checkpoint_part_a`, `part_b_c`, `caterlink_checkpoint_part_d`,
   `caterlink_checkpoint_hub`, `caterlink_checkpoint_redq`, `seals`, `seal_verifications` scoped by the caller's
   visibility of the parent transaction (the existing `transactions_read_policy` decides). Before this these tables
   had RLS on and no policy, i.e. unreadable by clients.
3. `caterlink_external_role()` — role from the trusted `public.users` row; a mixed identity (any active assignment)
   resolves to none.
4. `create_caterlink_driver_transaction_secure(...)` and `list_caterlink_driver_options_secure()` (Driver).
5. Vendor: tables `caterlink_vendor_deliveries`, `caterlink_vendor_checkpoints` (write-once, never deleted, RLS, no
   client write grant), the separate capability described below, `caterlink_can_check_vendor_station()`, and
   `create_/record_..._security_check_/complete_..._secure`.
6. `list_caterlink_audit_secure()` for CaterLink Management.

Data effects: no existing row, constraint, policy, account or assignment changes. Two tables and 9 functions are
added, plus **one new column** `caterlink_station_capabilities.can_check_vendor_delivery` (default false, set true for
PEN and JHB only; the update touches only that column). Existing scan (PEN/JHB), receipt (KCH/BKI) and create (KUL)
capability values and the scan/receipt functions are byte-identical (asserted by the verifier).

## Decisions that need approval before hosted application

- **Vendor Part C** is the owning Vendor's confirmation after the security check. The legacy dual signature with a
  warehouse PIC is not carried over: the warehouse PIC is the Driver identity, which must not see vendor workflow data.
- **Vendor Part B** (the security check) is its own station capability, `can_check_vendor_delivery`, seeded true for
  **PEN and JHB only** and held by an active sso/so/aso/dse assignment at that exact station (Staff Profiling,
  revoked/expired assignments and unapproved profiles are excluded). It is deliberately **not** derived from
  `can_user_scan_caterlink`: the scan verifier enforces that no other database function builds on the scan decision.
  The legacy `post2_avsec` role has no canonical equivalent. Deliveries at KUL/KCH/BKI are not possible; enabling another
  station is a data change to that one column.
- Driver creation is limited to stations with `can_create` (today: KUL - MAA, KUL - AAX). Only the truck seal is a
  seal row; extra seals, escort details and the supplies breakdown are kept in the Part A remarks (the canonical
  `transactions` row has no columns for them).
- The `signatures` storage bucket policy lets **any authenticated user read any signature object** (and list
  paths). That predates this work but now includes external accounts. Not changed here; tightening it is a separate
  reviewed change.

## Unresolved gaps

- AVSEC checkpoint progression (Parts B/C/D, Hub, REDQ, skip, incident raising from a checkpoint) has no canonical
  write path. Those pages are BLOCKED stubs. Only transaction creation, vendor deliveries, receipt (existing RPC),
  incident resolve/reopen, archive, export, whitelist and audit are functional.
- Final PDF RPCs exist but nothing in the UI calls them.
- No segment time limits / SLA reporting.
- End-to-end browser workflows cannot run on the preview until the migration is applied to staging.

## Backup and recovery procedure for the hosted application (not yet authorized)

Before: take a fresh encrypted staging backup with `scripts/staging/backup.mjs` (authenticates against the two original
backups). The gated runner `scripts/staging/apply-external-workflows-migration.mjs --preflight-only` then re-authenticates
all backups, checks exactly 64 recorded migrations ending at `20261024000001`, 56 Auth users / 56 profiles, the 40 review
accounts, empty CaterLink workflow tables, `public.users` = 2 rows and scan = `JHB,PEN`, and writes an encrypted snapshot of
the pre-change table privileges, policies and capability rows.

Apply: the same runner without `--preflight-only` runs the migration and the history insert in **one transaction** and
verifies inside it (2 vendor tables with RLS, 9 functions definer/search_path/anon-denied, no legacy tables, no
TRUNCATE/REFERENCES/TRIGGER for clients, capabilities unchanged except the new column = `JHB,PEN`, scan and receipt
function bodies identical, Auth/profiles/assignments/`public.users` fingerprints unchanged). Any failed check rolls the
whole transaction back, leaving staging exactly as before.

Recovery after a commit (data effects are limited to the new empty objects plus the capability column, so reversal is
exact; no existing row is modified):

```sql
begin;
drop table if exists public.caterlink_vendor_checkpoints, public.caterlink_vendor_deliveries cascade;
drop function if exists public.create_caterlink_driver_transaction_secure(text,text,text,text,text,text,text,text,text,boolean,text,text,text,text,integer,text[]);
drop function if exists public.list_caterlink_driver_options_secure();
drop function if exists public.create_caterlink_vendor_delivery_secure(text,text,text,text,text,text,text,text);
drop function if exists public.record_caterlink_vendor_security_check_secure(uuid,text,text,text,text,text,jsonb);
drop function if exists public.complete_caterlink_vendor_delivery_secure(uuid,text,text);
drop function if exists public.caterlink_can_check_vendor_station(uuid,uuid);
drop function if exists public.list_caterlink_audit_secure(integer);
drop function if exists public.caterlink_external_role();
drop function if exists public.caterlink_vendor_guard();
drop policy if exists caterlink_checkpoint_part_a_read on public.caterlink_checkpoint_part_a;
drop policy if exists part_b_c_read on public.part_b_c;
drop policy if exists caterlink_checkpoint_part_d_read on public.caterlink_checkpoint_part_d;
drop policy if exists caterlink_checkpoint_hub_read on public.caterlink_checkpoint_hub;
drop policy if exists caterlink_checkpoint_redq_read on public.caterlink_checkpoint_redq;
drop policy if exists seals_read on public.seals;
drop policy if exists seal_verifications_read on public.seal_verifications;
revoke select on public.caterlink_checkpoint_part_a, public.part_b_c, public.caterlink_checkpoint_part_d,
  public.caterlink_checkpoint_hub, public.caterlink_checkpoint_redq from authenticated;
alter table public.caterlink_station_capabilities drop column if exists can_check_vendor_delivery;
-- restore the privileges the hardening revoked, exactly as recorded in the encrypted pre-change snapshot (acl list)
-- e.g. grant truncate, references, trigger on public.<table> to authenticated;   -- only for tables whose snapshot ACL had them
delete from supabase_migrations.schema_migrations where version = '20261025000001';
commit;
```

Sequences `cl_vendor_seq_<year>` are created lazily on the first vendor delivery and must be dropped too if any exist.
Restoring the revoked TRUNCATE/REFERENCES/TRIGGER grants is optional and not recommended (it re-opens a pre-existing
exposure); the snapshot makes it possible if it is ever required. A full restore from the encrypted backup
(`scripts/staging/restore-backup.mjs`) remains the last resort.
