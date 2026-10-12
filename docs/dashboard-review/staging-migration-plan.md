# Proposed hosted-staging migration order (NOT executed)

Nothing in this document has been applied to hosted staging. Execution needs a separate, explicit authorization, a dry run and real-role probes first, through a new frozen-hash gated runner (not yet written).

## Reconciliation
- Hosted staging history is recorded through `20261027000001_station_visibility_requires_approved_profile` (applied earlier by the reviewed profile-status repair).
- The repository holds every later file listed below. None is hosted.
- `20261027000002_hub_destinations_kch_bki.sql` sorts **before** the pending `202611*` files and must be applied first: later migrations and tests assume KCH/BKI are valid HUB destinations.
- No two migration files share a 14-digit timestamp (`tests/migration-order.test.mts`).

## Order
| # | Migration | Depends on |
|---|---|---|
| 1 | `20261027000002_hub_destinations_kch_bki` | `transactions`, `caterlink_checkpoint_hub` (Phase 9) |
| 2–6 | `20261101000001` … `20261101000005` | canonical role model; item 1 |
| 7–8 | `20261102000001`, `20261102000002` | items 2–6 |
| 9 | `20261103000001_role_workspace_completion` (per-station ASO form seeds) | items 1–8, `org_stations` |
| 10 | `20261104000001_caterlink_receipt_pdf_version` | `caterlink_transaction_pdfs`, `caterlink_checkpoint_hub`, item 1 |

The chain was verified by a full from-scratch rebuild on PGlite and native PostgreSQL 17 (95 migrations applied, 0 failed).

## Unchanged by this plan
PEN / JHB / NILAI keep their scanner and vendor-check capabilities; KCH and BKI have final receipt only (no scanner, no stream); BTU has no CaterLink access.
