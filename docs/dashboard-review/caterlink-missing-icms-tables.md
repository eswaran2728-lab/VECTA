# CaterLink / ICMS tables missing on staging (reconciliation plan, NOT applied)

Read-only catalog comparison against staging `ddlctzbnqewubltcavkh` on 2026-10-05.

Present: `transactions` (stub created by `20261001000001_phase9_caterlink_station_access.sql`, not the full ICMS schema), `users`, `drivers`, `vehicles`, `seals`, `seal_verifications`, `catering_companies`, `profiles`.

Missing (used by `lib/icms` and `app/(icms)`) and the versioned migration that defines each:

| Table | Defined in `supabase/migrations/...` |
|---|---|
| `incidents` | `icms/20260101000001_schema.sql` |
| `part_a`, `part_b`, `part_c`, `part_d` | `icms/20260101000001_schema.sql` |
| `audit_logs` | `icms/20260101000001_schema.sql` |
| `incident_photos` | `icms/20260301000004_phase5_incidents.sql` |
| `segment_timeouts` | `icms/20260810000003_segment_timeouts.sql` |
| `vendor_transactions`, `vendor_part_a/b/c` | `icms/20260813000002_vendor_movement.sql` |
| `part_hub`, `part_redq` | `icms/20260817000002_multiroute_redq_restructure.sql` |

Affected workflows (all remain BLOCKED): Management incidents/audit/reports/history/archive, Driver dispatch (Parts A-D, hub, RedQ), Vendor deliveries, segment timeouts.

Plan (needs separate authorization before any hosted change):
1. Do not replay the ICMS chain wholesale: it also creates its own `users`/`transactions` and seeds demo data, which conflict with the already-present stub and external-account table.
2. Write one additive reconciliation migration containing only the missing tables above, with RLS using the canonical `canon_*` helpers, no demo/seed rows, and `if not exists` guards.
3. Validate locally on a clean PGlite/native schema clone, including the CaterLink-only isolation tests.
4. Take a verified staging backup, apply via the staged runner, then run Driver/Vendor functional tests.

Until step 4 passes, Driver/Vendor workflows are BLOCKED; no schema change has been made.

---

## Correction after the full staging catalog comparison (2026-10-05, read-only)

The "14 missing tables" framing understated the gap and hid an architectural fork.

1. **Staging already carries the Phase 9 canonical CaterLink model**: `transactions`, `seals`, `seal_verifications`, `catering_companies`, `vehicles`, `drivers`, `caterlink_checkpoint_part_a/part_d/hub/redq`, `part_b_c`, `caterlink_incidents`, `caterlink_incident_notes`, `caterlink_archives`, `caterlink_transaction_pdfs`, `caterlink_station_capabilities`, plus ~40 `*_caterlink_*_secure` RPCs. All have 0 rows except `users` (2).
2. **The ICMS pages and actions still read the legacy workflow tables** (`incidents`, `part_a`..`part_d`, `part_hub`, `part_redq`, `audit_logs`, `incident_photos`, `segment_timeouts`, `vendor_transactions`, `vendor_part_a/b/c`) in ~25 files under `lib/icms`, `app/(icms)` and `app/api/icms`. Only whitelist management, PDF, archive and export already use canonical RPCs.
3. **`transactions` is the Phase 9 shape, not the legacy shape.** 15 legacy columns that the legacy workflow uses are absent: `current_stage`, `lifecycle_status`, `escalation_reason`, `status_entered_at`, `escort_officer_name`, `escort_officer_staff_id`, `escort_vehicle_number`, `part_d_skipped`, `part_d_skip_reason`, `supplies_boxes/carts/oven_racks/pallets/smu/total`. The legacy functions that reference them (`sync_transaction_stage`, `guard_transaction_update`, `escalate_timeouts`, `skip_part_d`) exist or are defined by migrations that were never applied, and the legacy triggers on `transactions`, `seals` etc. (audit, immutability, sequence, escalation) are absent.
4. **The Vendor workflow has no canonical equivalent** (`vendor_*` exist only in the legacy chain).
5. Phase 9 deliberately renamed its checkpoint tables so they never collide with the legacy `part_*` names (`verify_phase9_legacy_collision_non_regression_native.mjs`).

Therefore a "create the 14 missing tables" migration would stand up a second, parallel legacy data model beside the canonical one and still leave `transactions` incomplete. No migration has been written or applied.

Decision required before a migration can be drafted:
- **A. Complete the legacy workflow schema** on staging (additive: 15 `transactions` columns, 14 tables, their triggers/functions, canonical-role RLS, grants). Larger, creates two parallel models; Vendor works.
- **B. Re-point the ICMS pages/actions to the canonical Phase 9 tables/RPCs** (code change, no hosted DDL for Management/Driver); Vendor would still need new vendor tables.
