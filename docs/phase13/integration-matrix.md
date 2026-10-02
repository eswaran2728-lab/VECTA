# Phase 13 Integration Matrix

Per subsystem: authoritative tables, RPCs, roles/scopes, routes, legacy
compatibility path, audit/notification events, storage, background jobs,
deployment dependencies, rollback/recovery, and known staging-only tests.
Confirmed by direct inspection of the cited files; a "sampled" note means
the subsystem was spot-checked rather than traced exhaustively.

## Organizational hierarchy (Phase 2)

- **Tables**: `aocs`, `operating_entities`, `departments`, `units`, `hubs`, `org_stations`, `org_teams` — `supabase/migrations/20260928000001_phase2_org_foundation.sql`.
- **RPCs**: none write-facing exposed to clients; hierarchy is read via direct `select` under RLS.
- **Roles**: none write it at runtime; it is seeded structure.
- **Routes**: consumed everywhere (station/department pickers).
- **Legacy path**: pre-Phase-2 code used free-text `station`/`team` strings on `profiles` directly; both still exist side by side (`profiles.station`, `profiles.team`) — see `legacy-transition-inventory.md`.
- **Audit/Notification**: none dedicated.
- **Storage**: n/a.
- **Background job**: none.
- **Deployment dependency**: must exist before any Phase 3+ scoped-role insert (FK dependency).
- **Rollback**: additive tables only; no destructive rollback needed.
- **Staging-only test**: none beyond RLS, already covered locally.

## Scoped roles & permissions (Phase 3)

- **Tables**: `role_definitions`, `user_role_assignments` — `20260928000002_phase3_role_permission_foundation.sql`.
- **RPCs**: `has_role_in_scope`, `has_active_role_for_aoc`/`has_active_role_in_aoc`, `my_aoc_id`, `get_my_active_role_assignments`, `has_any_active_assignment_in_aoc` (Phase 8/9), `has_active_entity_membership_in_aoc` (Phase 9).
- **Roles**: this IS the role system for Phase 8-12; `role_definitions.code` is the vocabulary (`ghod`, `maa_boss`, `maa_admin`, `aax_boss`, `aax_admin`, `operation_manager`, `hub_se`, `caterlink_management`, `airasia_management`, `super_admin`, `aso`/`so`/`dse`, etc.).
- **Routes**: consumed by every Phase 8-12 secure RPC's authorization check; no dedicated management UI for assignments was found in this audit (sampled) beyond `/super-admin` org manager.
- **Legacy path**: `profiles.role` (enum: `OFFICER`→renamed historically to `ASO`/`SO`/`DSE`/`ENFORCEMENT`/`MANAGEMENT`/`ADMIN`) and `profiles.unified_role` (text, checked against `'super_admin'|'management'|'enforcement'|'dse'|'so'|'aso'|'vendor'`) are BOTH still live and both still gate real server-side access (`lib/avsec/auth.ts:requireRole`, `lib/super-admin/actions.ts:isSuperAdmin`). See `legacy-transition-inventory.md` for the full classification.
- **Audit**: none dedicated at the assignment level (no `role_assignment_audit` table found).
- **Storage**: n/a.
- **Background job**: none.
- **Deployment dependency**: depends on Phase 2 org tables (FKs to `aocs`/`departments`/etc.).
- **Rollback**: additive; a bad assignment is corrected by `revoked_at`, never a delete.
- **Staging-only test**: real Supabase Auth JWT claims propagation into `auth.uid()` for RLS (PGlite/native simulate this via `pg_temp.simulate_user`, which is a close but not identical substitute — see `migrate.mjs` comments).

## Registration, approval, assignment, transfer, deactivation (Phase 4)

- **Tables**: `user_registration_requests`, `user_notifications` — `20260928000003_phase4_registration_approval_admin.sql`.
- **RPCs**: `get_my_registration_request()`, `get_my_notifications(p_limit)`, approval/rejection RPCs (sampled, not individually re-verified this round).
- **Roles**: Management/Admin approve; legacy `profiles.role in ('MANAGEMENT','ADMIN')` gates this per `20260921000001_management_can_approve_pending_staff.sql` and `20260922000001_management_manage_non_admin_staff.sql` — **this is a legacy-role-dependent path, not yet ported to Phase 3 scoped roles** (see `legacy-transition-inventory.md`, classified "still required for current users").
- **Routes**: `/avsec/admin/users` (sampled from route name only, not re-opened this round).
- **Legacy path**: see above — this entire subsystem is itself a legacy-compatibility surface still in active use.
- **Audit**: `user_notifications` doubles as a lightweight event log (`event_type`/`payload`).
- **Storage**: n/a.
- **Background job**: none found.
- **Deployment dependency**: none beyond `profiles`.
- **Rollback**: additive.
- **Staging-only test**: real email delivery for approval notices (if wired — not confirmed this round).

## Central report classification/repository (Phase 5)

- **Tables**: `central_reports_index`, `report_index_queue` — `20260928000004_phase5_report_classification_repository.sql`.
- **RPCs**: `index_report()` (trigger-invoked), `process_report_index_queue(int)` (cron-invoked, `service_role`-only — confirmed via grant/revoke, see `cron-queue-matrix.md`).
- **Roles**: n/a for writes (trigger-driven); reads go through Phase 6's secure layer, not this table directly.
- **Routes**: indirect only, via Phase 6 report readers.
- **Legacy path**: none — this is wholly new infrastructure layered on top of the pre-existing `report_sec0XX`/`offload_records` tables, which remain the source of truth for report content itself.
- **Audit**: `report_index_queue.last_error`/`attempts`/`status` is the retry/failure trail.
- **Storage**: n/a.
- **Background job**: `phase5-report-index-queue`, every minute — see `cron-queue-matrix.md`.
- **Deployment dependency**: depends on every `report_sec0XX`/`offload_records` table existing first (the trigger source).
- **Rollback**: a stuck/`permanently_failed` queue row can be manually reset to `'pending'`; the index table itself is additive-only (upsert by `(source_table, source_id)`).
- **Staging-only test**: real pg_cron execution cadence and failure alerting (local test harness runs the queue processor manually, never via a real cron scheduler).

## Secure report access, attachments, PDF, exports (Phase 6)

- **Tables**: `report_sec0XX` family, `offload_records`, attachment tables, `sat_combined_reports`.
- **RPCs**: `list_my_submissions_secure`, `flagged_reports_secure`, `get_attachment_authorization_secure`, `get_report_version_content_secure`, `resolve_report_access_reason`, export RPCs (sampled).
- **Roles**: Global Reporting Controller (reports+audit exports — see `ownership-matrix.md`), submitter (own), rank-based monitors (`MONITOR_ROLES`).
- **Routes**: `/avsec/reports/...` (sampled from naming, not re-opened).
- **Legacy path**: `MONITOR_ROLES`/`DAILY_REPORT_ROLES` in `lib/avsec/auth.ts` are the legacy rank-hierarchy helper still gating report-filing/monitoring UI; the underlying RLS additionally enforces scoped-role checks per Phase 6's own migration (not re-verified line-by-line this round).
- **Audit**: `report_index_queue`/attachment-authorization calls are the closest audit trail; no dedicated `report_access_audit` table found in this pass (sampled).
- **Storage**: `report-attachments` (private) — see `storage-matrix.md`.
- **Background job**: shares Phase 5's queue.
- **Deployment dependency**: Phase 5.
- **Rollback**: version history is immutable by design (`get_report_version_content_secure` reads a version, never overwrites one) — no rollback needed, only forward amendment.
- **Staging-only test**: real signed-URL expiry behavior for attachments.

## Dashboards (Phase 7)

- **Tables/RPCs**: dashboard aggregate RPCs in `20260928000006_phase7_dashboard_aggregates.sql` / `...007_phase7_closure_dashboards.sql` — confirmed exercised correctly for station-scoped vs. org-wide vs. entity-scoped callers in the already-passing `verify_phase7_*` test suites (**already tested, not re-derived this round**).
- **Roles**: station-scoped (ASO), org-wide (Operation Manager/AirAsia Management), entity-scoped (MAA/AAX Boss/Admin).
- **k-anonymity**: the existing test suite already proves the "1-record hub folded into `combined_below_threshold`" behavior — a real, working privacy control, not a gap.
- **Legacy path**: none additional beyond Phase 3's role checks.
- **Audit/Storage/Jobs**: n/a.
- **Rollback**: read-only aggregates; nothing to roll back.
- **Staging-only test**: dashboard visual correctness (explicitly out of scope for Phase 13 — see `dashboard-adjustment-inventory.md`).

## Operation workforce workflows (Phase 8)

- **Tables**: `overtime_requests`, duty-draw tables, roster tables.
- **RPCs**: `list_pending_leave_for_reviewer_secure`, `review_leave_request_secure`, `initiate_duty_draw_secure`, `finalize_duty_draw_secure`, `get_duty_draw_secure`, `record_duty_draw_assignment_secure`, `list_duty_draw_history_secure`, `upsert_roster_cell_secure`.
- **Roles**: Operation Manager (export owner — see `ownership-matrix.md`), Hub SE (reviewer), submitter (own).
- **Gap confirmed this round**: **no "own leave status" read RPC exists** — `list_pending_leave_for_reviewer_secure` is a reviewer queue, not a submitter's own-status view. Already documented and deliberately left unimplemented in Phase 12's WOIS tool set for exactly this reason; the gap is in the underlying app, not specific to WOIS.
- **Legacy path**: none additional.
- **Audit**: `overtime_requests_audit_trail` (per `20260914000005_overtime_requests_audit_trail_and_dedup.sql`).
- **Storage**: n/a.
- **Background job**: none dedicated found (sampled).
- **Rollback**: `review_leave_request_secure`/duty-draw finalize are designed idempotent per the already-passing Phase 8 concurrency tests.
- **Staging-only test**: real-time duty-draw concurrency under production load (local native concurrency tests are a strong proxy, not identical).

## Enforcement, Investigation, SAT, Profiling

- **Tables**: `sat_combined_reports` + SEC-report family filed by these roles.
- **Roles**: Main Enforcement (export owner for SAT/Profiling attendance/roster/leave/OT — see `ownership-matrix.md`).
- **Legacy path**: `ENFORCEMENT` legacy role (enum value, added `avsec/0008_rename_roles_add_enforcement.sql`) still gates enforcement-specific UI per `lib/avsec/auth.ts:MONITOR_ROLES`.
- **Storage**: `sat-combined-reports` (private) — see `storage-matrix.md`.
- **Audit/Jobs**: sampled, none dedicated found beyond the report-index queue.
- **Staging-only test**: real SAT PDF generation/delivery.

## CaterLink station access, whitelist lifecycle, final transaction PDFs (Phase 9)

- **Tables**: `caterlink_station_capabilities`, `catering_companies`, `vehicles`, `drivers`, transaction/incident tables.
- **RPCs**: full whitelist lifecycle (`create_caterlink_whitelist_entry_secure` → `approve_...` → `activate_...`/`deactivate_...`/`revoke_...`/`update_..._pass_expiry_secure`), `create_caterlink_transaction_secure`, `confirm_caterlink_destination_receipt_secure`, `archive_caterlink_transaction_secure`, `authorize_caterlink_pdf_secure`, `raise_caterlink_incident_secure`/`resolve_...`/`reopen_...`, `export_caterlink_data_secure`.
- **Usability gate**: `caterlink_identity_is_usable()` (and `resolve_usable_caterlink_vehicle/driver()`) — confirmed to treat an expired `pass_expiry_date` as categorically unusable regardless of `status` (comment at line ~687-688 of the Phase 9 migration), closing exactly the "expired/revoked entry authorizes movement" risk this phase's instructions call out.
- **Roles**: CaterLink Management (whitelist admin + exports — see `ownership-matrix.md`).
- **Gap confirmed this round**: `authorize_caterlink_pdf_secure` returns a `pdf_storage_path`, but **no storage bucket was created for it and no application code calls `supabase.storage` for a CaterLink PDF anywhere** (`grep` across `app/`, `lib/`, `components/` found zero matches) — the authorization RPC exists; the actual PDF generation/upload/signed-download wiring does not. See `storage-matrix.md`.
- **Audit**: incident lifecycle (`raise`/`resolve`/`reopen`) and whitelist lifecycle (`approved_by`/`deactivated_by`/`revoked_by` + timestamps) are self-auditing columns, not a separate audit table.
- **Background job**: none.
- **Rollback**: whitelist state transitions are forward-only with reason columns; no destructive rollback path, by design.
- **Staging-only test**: real station-gate hardware/process integration (out of this phase's scope entirely).

## Anonymous Malaysia discussion board (Phase 10)

- **Tables**: `discussion_author_mappings` (zero grant to `authenticated`), `discussion_identity_resolutions` (audit), discussion threads/messages (sampled names, not re-opened this round since already fully tested in Phase 10).
- **RPCs**: `get_my_discussion_authored_ids_secure`, `remove_own_discussion_content_secure`, `resolve_discussion_author_identity_secure` (single-id only, no bulk variant — a structural proof against mass-deanonymization, confirmed in Phase 10's own design).
- **Roles**: anyone eligible (Malaysia AOC, per the established Phase 10 eligibility check — not re-verified line-by-line this round, already covered by `verify_phase10_discussion_board.mjs`).
- **Legacy path**: none.
- **Audit**: `discussion_identity_resolutions`.
- **Storage**: "anonymous-discussion attachments if supported" — **not supported**: no table/column for discussion attachments was found in this pass (sampled); this is believed accurate rather than exhaustively confirmed.
- **Staging-only test**: alias-derivation salt rotation behavior under a real KMS/secret-manager (local tests use a fixed server salt).

## Global & Malaysia announcements (Phase 11)

- **Tables**: `announcements`, `announcement_audit_log`, `announcement_attachments`.
- **RPCs**: `get_visible_announcements_secure`, `get_announcement_detail_secure`, `create_announcement_secure`, `update_announcement_secure`, `publish_announcement_secure`, `archive_announcement_secure`, `acknowledge_announcement_secure`, `get_announcement_acknowledgement_report_secure`, `add_announcement_attachment_secure`, `get_announcement_attachments_secure`.
- **Roles**: `ghod` (Global only), `maa_boss`/`maa_admin`/`aax_boss`/`aax_admin` (Malaysia AOC only) — fully certified in Phase 11/its correction, re-confirmed this round by re-running `verify_phase11_announcements.mjs` unchanged (see test totals).
- **Gap confirmed this round**: `add_announcement_attachment_secure`/`get_announcement_attachments_secure` ARE called from `lib/avsec/announcements/actions.ts`/`queries.ts`, but **no Storage bucket backs `announcement_attachments.storage_path`** — the UI (`ManagementAnnouncementsView.tsx`) instead sends announcement photos as inline base64 `photoDataUrl`, never through Supabase Storage. The attachment RPC/authorization path exists and is tested; the Storage-backed upload it implies was never built.
- **Audit**: `announcement_audit_log` (includes `view_acknowledgement_report`, added in the Phase 11 correction).
- **Background job**: none.
- **Staging-only test**: real notification delivery on publish (if any is wired — not confirmed this round).

## WOIS AI 2.0 and the Gemini activation boundary (Phase 12)

- **Tables**: `wois_conversations`, `wois_messages`, `wois_audit_log`.
- **RPCs**: `is_wois_eligible_secure`, `create_wois_conversation_secure`, `rename_...`, `delete_...`, `list_wois_conversations_secure`, `list_wois_messages_secure`, `append_wois_message_secure`, `record_wois_audit_event_secure`.
- **Roles**: approved, actively-assigned Malaysia AOC staff only (`has_any_active_assignment_in_aoc`), not legacy `profiles.role`.
- **Activation boundary**: `WOIS_AI_PROVIDER=gemini` + `GEMINI_API_KEY` both required (`lib/wois/config.ts`); confirmed still unconfigured in this environment (§24 of the Phase 13 report).
- **Legacy path**: none — this subsystem was built entirely on Phase 3 scoped roles from the start.
- **Audit**: `wois_audit_log` + `phase13_readiness_access_log` (new, unrelated subsystem, see below).
- **Storage**: n/a (no file attachments).
- **Background job**: none.
- **Staging-only test**: real Gemini request/response/quota/fallback behavior (explicitly deferred, per Phase 12's own completion status).

## Super Admin containment, Global Reporting Controller, AirAsia Management/GHOD, MAA/AAX Boss/Admin, multi-AOC isolation

See `ownership-matrix.md` for the confirmed, non-broadened ownership list and `legacy-transition-inventory.md` for how Super Admin is actually identified today (`profiles.role = 'ADMIN'` + `unified_role = 'super_admin'` — not a dedicated enum value, confirmed this round while building the Phase 13 readiness gate; see that document for why this matters). Multi-AOC isolation is already proven for Malaysia-vs-foreign-AOC in every Phase 8-12 test suite (`zz`/foreign-AOC fixtures denied throughout); future-AOC readiness is structural (every Phase 8-12 RPC resolves its AOC id by code, never hardcodes Malaysia's UUID) but no second AOC has been configured or trialed — that is explicitly deferred to the rollout runbook.
