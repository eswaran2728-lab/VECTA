# Proposed hosted-staging migration order (NOT executed)

Nothing in this document has been applied to hosted staging. Execution needs a separate, explicit authorization and the frozen-hash gated runner described below, which dry-runs first.

## Reconciliation
- Hosted staging history is recorded through `20261027000001_station_visibility_requires_approved_profile` (applied earlier by the reviewed profile-status repair).
- The repository holds every later file listed below. None is hosted.
- `20261027000002_hub_destinations_kch_bki.sql` sorts **before** the pending `202611*` files and must be applied first: later migrations and tests assume KCH/BKI are valid HUB destinations.
- No two migration files share a 14-digit timestamp (`tests/migration-order.test.mts`).

## Order, frozen hashes (SHA-256 of the LF-normalised file)
| # | Migration | SHA-256 |
|---|---|---|
| 1 | `20261027000002_hub_destinations_kch_bki` | `ffee7558b79356f8cfe1d66af3cbf99dd549ff43db6ab5c08f4b7a6c8674d1d5` |
| 2 | `20261101000001_flight_classification_and_report_access` | `905906984e4d80de10739d5275ee0797150dce908782c77e3709ead5c1c6166b` |
| 3 | `20261101000002_report_source_search_notifications` | `3e403f81b1285e942c9cfae56c11e2f35a5e27b2d10e1c7a689fef07838b0984` |
| 4 | `20261101000003_leadership_registration_directory_bayboard` | `1807464e384e8c65ba83866be4d15d719fb6faf565c97bda03e6d226b30d6d44` |
| 5 | `20261101000004_discussion_identity_reveal` | `891cb8c6e37e005b360b65fe019e504972520c8c5c62db82224d126706524e14` |
| 6 | `20261101000005_entity_report_counts_and_admin_overview` | `8f4863685d1947463724810331b31e33cdf5ab9bd4535b5da6ef1ff75556da1b` |
| 7 | `20261102000001_role_workspace_support` | `b477f818c8e85fb88a0500ee8c5416fd897e42e5638bd74e91c0cb29ba3fc3ed` |
| 8 | `20261102000002_entity_staff_maintenance` | `d7a0a81c3866932c88a3aebd25aa645ccc429a59e625186f6ef3ac0a2f3b47ed` |
| 9 | `20261103000001_role_workspace_completion` | `8c6420b6eb4e80b401963cb8771325e095a138ec3e35d5f232350c150036f4d8` |
| 10 | `20261104000001_caterlink_receipt_pdf_version` | `65943c95e3172b7af1caaebb9484c6dac93eaf763d5d641fb4a561e02cbe679f` |
| 11 | `20261105000001_caterlink_pdf_generation_jobs` | `292f070befd2e0fe1eb79b115403c7c20075f3a6fd74abd76accb4b357f6049b` |

Each migration depends on every earlier one (full from-scratch rebuild verified on PGlite and native PostgreSQL 17: 96 migrations applied, 0 failed). `20261105000001` depends on `20261104000001`, which depends on `20261027000002`.

## Runner (prepared, NOT executed): `scripts/staging/apply-role-workspace-migrations.mjs`
- `--print-plan` / `--print-recovery` work offline. `--phase=dry-run` applies all eleven inside ONE transaction, runs the verification queries and real-role probes, ROLLS BACK, and confirms staging is unchanged; it writes a receipt. `--phase=apply` additionally needs the exact phrase `APPLY 11 MIGRATIONS TO STAGING ddlctzbnqewubltcavkh` and a matching, fresh dry-run receipt, then applies and records each migration exactly once in its own transaction, stopping at the first mismatch.
- Gates: exact repo / branch / origin, clean tree, HEAD == `--expected-head`; approved staging ref only and the production ref absent; verified TLS; existing backups authenticate and a fresh backup (< 6 h, same Auth-user count, outside the repo) authenticates; hosted history is exactly 68 migrations ending `20261027000001` with none of the new versions; the repository holds exactly the frozen files (no missing, extra, reordered or modified file). It prints no credential, connection string or secret.
- Recovery per migration: `--print-recovery`.

## Unchanged by this plan
PEN / JHB / NILAI keep their scanner and vendor-check capabilities; KCH and BKI have final receipt only (no scanner, no stream); BTU has no CaterLink access.
