# Notification / Audit / Export / Archive Ownership Matrix

## Confirmed ownership (restated exactly as specified, not broadened)

| Role | Owns |
|---|---|
| Global Reporting Controller | Report and audit exports |
| Operation Manager | Malaysia Operation attendance, roster, leave and OT exports |
| Main Enforcement | SAT and Profiling attendance, roster, leave and OT exports |
| CaterLink Management | CaterLink transactions, incidents and archive exports |
| MAA/AAX Admin | Assigned-entity directory exports, technical synchronization and system configuration |
| MAA/AAX Boss | Oversight dashboards/reports — **not** automatic technical administration |
| AirAsia Management | Executive read-only access |
| Super Admin | Platform/technical administration only, **not** automatic operational-data access |

This phase did not find, and did not introduce, any code path that
broadens any of these. The one place this was explicitly checked and
corrected is `flag_attendance_anomalies`/`trigger_sheets_sync` (see
`cron-queue-matrix.md`) — neither function returns operational data to its
caller (they only mutate `duty_records` or fire a sync webhook), so the
over-broad grant was a mutation/trigger risk, not a data-ownership
violation, but it was still real unauthorized capability and is corrected.

## Notification recipients, deduplication, read-state

- `user_notifications` (Phase 4) carries `event_type`/`payload`/`read_at` —
  per-recipient read state is a column on the row itself, not a separate
  join table, so deduplication is structural (one row per event per
  recipient).
- `wois_audit_log`/`phase13_readiness_access_log` are audit tables, not
  notification tables — they have no recipient/read-state concept by
  design; they exist so an ACTOR can see their own history, not so anyone
  gets notified of anything.
- Protected-role omission: AirAsia Management and Super Admin are
  confirmed, by the ownership table above, to never be automatic
  recipients of operational notifications (no code path in this audit
  grants them one); this was not individually re-traced through every
  `user_notifications` insert site (sampled).

## Audit actor, scope, immutability

- Every audit table found in this engagement (`announcement_audit_log`,
  `discussion_identity_resolutions`, `wois_audit_log`,
  `phase13_readiness_access_log`) follows the same shape: `actor_profile_id`
  (or equivalent) + `event_type`/`action` + `created_at`, written only by
  `SECURITY DEFINER` functions, never by a direct client insert (confirmed
  via `revoke insert ... from authenticated` on each one this engagement
  built).
- Immutability: none of these tables have an `UPDATE` policy or RPC for
  `authenticated` either — once written, a row cannot be changed by
  anyone but `service_role`.
- No confidential payload leakage: `wois_audit_log.details`/
  `phase13_readiness_access_log` carry only small structured metadata
  (tool names, report types) — never a raw report body, an attachment, or
  a credential. Re-confirmed this round for the two new Phase 13 functions
  specifically (`view_release_readiness_report_secure`'s own output was
  tested to contain no `sk-...`-shaped or `password` substring).

## Export role ownership, limits, audit

- Export RPCs (`export_caterlink_data_secure`, report export paths) were
  **sampled, not individually re-verified this round** for row limits or
  dedicated export-audit logging; their role gates match the ownership
  table above based on naming and the Phase 9 migration's own role checks,
  not a fresh line-by-line re-read.

## Archived-record access, final PDF delivery, user-directory export scope

- Archived CaterLink transactions: forward-only status transition,
  `CaterLink Management`-owned per the ownership table; not independently
  re-verified this round beyond the Phase 9 RPC names.
- Final PDF delivery: see the CaterLink PDF gap in `storage-matrix.md` —
  there is currently no delivery path to verify, because there is no
  Storage wiring yet.
- User-directory export scope: "MAA/AAX Admin: assigned-entity directory
  exports" is the specified ownership; no code path was found in this
  audit that lets an Admin export a directory outside their assigned
  entity (consistent with the Phase 9/11 pattern of resolving AOC/entity
  from the caller's own assignment, never a caller-supplied parameter) —
  sampled, not exhaustively re-traced.

## Technical synchronization / configuration ownership

"MAA/AAX Admin: ... technical synchronization and system configuration"
— the only "technical synchronization" found in this codebase is the
legacy Google-Sheets sync (`trigger_sheets_sync`/`sheet_sync_config`),
which predates the Phase 2-13 role model entirely and has no role check
of its own (its only gate, after this phase's correction, is
`service_role`-only execution — i.e., it runs as infrastructure, not as
any particular human role). There is no evidence in this codebase that an
MAA/AAX Admin currently operates this sync through any UI; it is
configured via the `sheet_sync_config` table directly. This is noted as a
limitation, not resolved in this phase (resolving it would mean building
a new UI, which is new feature work, not integration/readiness work).
