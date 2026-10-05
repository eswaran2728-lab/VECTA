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
