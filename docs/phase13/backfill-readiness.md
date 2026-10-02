# Backfill Readiness

No backfill is executed in this phase. Every item below is a **design for
a future, staging-first, read-only-preflight-gated backfill**, not a
script run against any real data.

## Inventory

| Backfill | Why it's needed | Preflight (read-only) | Estimated affected rows | Ambiguity handling | Idempotency | Failure recovery |
|---|---|---|---|---|---|---|
| Organizational hierarchy IDs | Existing `profiles.station`/`team` free-text must resolve to Phase 2's `org_stations`/`org_teams` rows before any Phase 8-12 RPC that joins on those FKs can see a given user | Count distinct `(station, team)` pairs with no matching `org_stations`/`org_teams` row | Unknown until run against real data; local synthetic fixtures show 0 (seeded to match) | Any unresolved `(station, team)` pair is quarantined into a review list, never auto-created as a new station/team | Re-running the preflight is read-only and always safe; the actual backfill would upsert by the resolved id, never duplicate | A partially-applied backfill leaves unresolved profiles exactly as they were (no FK is set until resolution succeeds) |
| Role assignments & entity memberships | Phase 3's `user_role_assignments`/Phase 4's entity memberships must exist for every current MAA/AAX/Operation/Enforcement staff member before Phase 8-12 scoped-role RPCs will authorize them | `view_legacy_role_mapping_report_secure()` (built this phase) is exactly this preflight for the MANAGEMENT/ADMIN/ENFORCEMENT subset; a parallel report for ASO/SO/DSE would need to compare `profiles.ops_group`/`station` against the intended target role, not built this phase | Not measured against real data | Zero-guess rule: an account whose current station/team/ops_group doesn't map to exactly one Phase 3 role+scope combination is left unassigned, never guessed | The replacement-assignment INSERT is additive; running it twice for the same profile+role+scope should be `on conflict do nothing` in the eventual script, matching the pattern every other Phase 3-12 insert already uses | A bad assignment is corrected via `revoked_at`, never a delete |
| Report classification/indexing | Phase 5's `process_report_index_queue` only processes rows already enqueued by the `index_report()` trigger going forward — reports filed BEFORE Phase 5 existed were never enqueued | `select count(*) from report_sec0XX_each_table` minus `select count(*) from central_reports_index where source_table=...` per table | Not measured against real data | n/a (deterministic: every report row either has an index entry or doesn't) | The backfill INSERTs into `report_index_queue`, which the existing idempotent processor already handles safely (confirmed unique index on `(source_table, source_id)`) | Failed rows land in `report_index_queue.status='permanently_failed'` with `last_error`, same recovery path as any other queue failure |
| Report immutable version 1 | Reports filed before Phase 6's versioning existed have no `version 1` snapshot row | Count report rows with zero rows in the version-history table | Not measured against real data | A report whose current content can't be unambiguously snapshotted (e.g. mid-edit at backfill time) is quarantined, not forced | The snapshot INSERT would be `on conflict (report_id, version_number) do nothing` | n/a — missing version 1 for an old report is a data-completeness gap, not a safety risk; can be re-run anytime |
| Existing KUL reports | Confirmed in a Phase 6-era code comment: "station = 'KUL - MAA' — ZERO ambiguous rows exist today" (`20260928000004_phase5_report_classification_repository.sql:26`) — i.e. this specific backfill concern was already checked once, historically, and found clean | Re-run the same ambiguity check before relying on that historical finding again, since real data changes over time | Historically 0 ambiguous | Same zero-guess rule | n/a | n/a |
| Current profiles → MAA/AAX affiliation | `user_entity_memberships` must exist for every current profile that Phase 9/11 code expects to resolve an entity for | Count profiles with an active role assignment in Malaysia's AOC but no `user_entity_memberships` row | Not measured | Zero-guess; a profile with ambiguous or no clear entity affiliation is quarantined | `on conflict do nothing` upsert | Corrected via `status='inactive'` then a fresh correct row, never an update-in-place of history |
| Hub/station/team mapping | Same category as "organizational hierarchy IDs" above, specifically for the hub layer | Count stations with no resolved `hub_id` | Not measured | Zero-guess | Upsert | n/a |
| CaterLink station capability | `caterlink_station_capabilities` must be seeded per real station before Phase 9's movement-authorization checks can ever return true for that station | Count active stations with no `caterlink_station_capabilities` row | Not measured | A station with no clear capability profile is left with CaterLink disabled (fail-closed default — see `feature-activation-controls.md`), never auto-enabled | Upsert by station | n/a |
| Whitelist lifecycle | Any currently-used (outside VECTA) vendor/vehicle/driver list must be entered through the normal `create_caterlink_whitelist_entry_secure` → `approve_...` → `activate_...` RPC chain, never a direct table insert | Count of any external whitelist source's entries, cross-referenced for duplicates by `(aoc_id, identifier)` | Not measured | A duplicate or ambiguous external identifier is quarantined for manual review, never auto-merged | The RPC chain is already idempotent/stateful by design (status transitions) | Lifecycle is forward-only with reason columns; recovery is a new reviewed transition, not a rollback |
| Legacy feedback archive | Pre-Phase-10 anonymous feedback (if any exists under the old `anonymous_staff_feedback` migration, `20260911000006`) is a structurally different table from Phase 10's discussion board and is NOT migrated into it in this phase | Count rows in the legacy feedback table | Not measured | n/a — no migration is proposed; the legacy table remains readable on its own terms | n/a | n/a |
| Announcement scope | Phase 11's narrowing from 5 scopes to 2 (`global`/`aoc`) was already handled as a schema-only correction in Phase 11 itself (CHECK constraint narrowing) — no row-level backfill was needed because no pre-existing `entity`/`department`/`station`-scoped announcement rows existed in any environment this was built against | Count any pre-existing announcement row with `scope not in ('global','aoc')` | Historically 0 (new feature) | n/a | n/a | n/a |
| WOIS eligibility prerequisites | Covered by the same "role assignments & entity memberships" backfill above — WOIS eligibility is derived entirely from `has_any_active_assignment_in_aoc`, with no separate data of its own | See above | — | — | — | — |

## Standing rules for every backfill above (restated explicitly)

- **Read-only preflight first, always**, producing an affected-row count
  and an ambiguity list before anything is written.
- **Zero-guess**: an ambiguous record is quarantined for manual review,
  never silently assigned a default.
- **Batch/retry**: every proposed backfill is additive/upsert-shaped,
  matching the pattern already used throughout Phases 2-13's own
  migrations (`on conflict do nothing`, status-transition-not-delete).
- **Idempotency**: re-running a preflight or a backfill script must be
  safe and produce the same result, by construction (upsert semantics).
- **Reconciliation output**: every backfill script (when eventually
  written) must print what it would do / did do, rows quarantined, and
  rows skipped as already-correct — not just a row count.
- **No production backfill was executed, drafted as a runnable script, or
  pointed at any real data in this phase.**
