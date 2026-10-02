# Legacy Role Transition Inventory & Retirement Gate

## Why `profiles.role` and `unified_role` are both still load-bearing

`profiles.role` is a Postgres enum (`OFFICER`/`ASO`/`SO`/`DSE`/`ENFORCEMENT`/`MANAGEMENT`/`ADMIN` — confirmed via `avsec/0001_init_schema.sql`, `0008_rename_roles_add_enforcement.sql`, `0011_add_management_role.sql`). It was **never** extended with a `SUPER_ADMIN` value. Real Super Admin identification instead uses a second, independent text column, `unified_role`, whose CHECK constraint explicitly allows `'super_admin'` (`20260911000002_merge_admin_into_management.sql`). `lib/super-admin/actions.ts:isSuperAdmin()` checks `role === "SUPER_ADMIN" || unified_role === "super_admin"` — the first branch can never actually be true today (confirmed while building this phase's own Super-Admin gate, which initially made the same mistaken assumption and was corrected before being tested — see the Phase 13 migration's comments). **This is not a new bug introduced by Phase 13** — it is a pre-existing quirk of how Super Admin has always been identified, now documented for the first time.

## Inventory and classification

| Reference | Location | Classification | Why |
|---|---|---|---|
| `profiles.role` enum (`MANAGEMENT`/`ADMIN`/`ENFORCEMENT`/`ASO`/`SO`/`DSE`) | `lib/avsec/auth.ts:requireRole/requireProfile`, 22 files found by `grep -rl "profile.role ==="` across `app/`, `lib/`, `components/` | **Still required for current users** | This is the live server-side gate (`redirect()` on failure, not UI hiding) for every AVSEC page that isn't one of the new Phase 8-12 Malaysia subsystems. No Phase 3 scoped-role equivalent exists for general AVSEC navigation. |
| `profiles.unified_role` text | `lib/super-admin/actions.ts`, `20260911000002_merge_admin_into_management.sql` and successors | **Still required for current users** | Sole path by which Super Admin is identified at all; no enum value exists to replace it with. |
| `ORG_WIDE_ROLES`/`MONITOR_ROLES`/`DAILY_REPORT_ROLES`/`DUTY_ROLES` rank arrays | `lib/avsec/auth.ts` | **Still required for current users** | Drive report-filing/monitoring/duty-check-in gating across the pre-Phase-8 AVSEC app; Phase 3 scoped roles do not yet cover this surface. |
| `lib/icms/auth.ts` role checks | ICMS module | **Out of scope for this Malaysia-upgrade retirement** | ICMS is confirmed (by `migrate.mjs`'s own documented exclusion) a separate application with its own role model; this phase does not touch it. |
| `20260921000001_management_can_approve_pending_staff.sql` / `20260922000001_management_manage_non_admin_staff.sql` | Phase 4 registration approval | **Still required for current users** | Approval workflow gates on `profiles.role in ('MANAGEMENT','ADMIN')` directly; no Phase 3 equivalent RPC was found for "who can approve registrations" (sampled, not exhaustively re-derived). |
| `has_role_in_scope`/`has_active_role_for_aoc`/`has_any_active_assignment_in_aoc` (Phase 3/8/9) | `20260928000002`, `20260930000001`, `20261001000001` | **Safely replaced (for the subsystems that use them)** | Every Phase 8-12 Malaysia-specific RPC built since Phase 8 uses this family exclusively — confirmed by this engagement's own build history (Phases 8-12 explicitly required "do not authorize using legacy profile-role text alone" and were verified against that rule each time). |
| `flag_attendance_anomalies(int)` grant to `authenticated` | `avsec/0024_attendance_report.sql` | **Unsafe bypass — corrected this phase** | No role check inside the function body at all; grant let any authenticated user trigger an org-wide attendance sweep. Zero application callers found. Corrected via a new forward migration (revoke), not an edit to the historical file. |
| `trigger_sheets_sync()` default PUBLIC grant | `avsec/0023_sheet_sync_queue.sql` | **Unsafe bypass — corrected this phase** | No grant/revoke statement at all meant default PUBLIC execute, reachable by `anon`. Corrected the same way. |
| `20260922003_unified_avsec_scanning_rls.sql` | ICMS-only despite AVSEC-range filename | **Dead/out-of-scope** | Already classified this way by `migrate.mjs`'s own documented exclusion list; re-confirmed, not re-derived. |
| One-off demo/backfill scripts (`provision_hub_avsec_team.sql`, `seed_all_rosters_and_checkin_today.sql`, `backfill_icms_shadow_users.sql`, `migrate_icms_real_users.sql`, `full_account_wipe_and_fresh_roster.sql`, `consolidate_checkpoint_demos_and_give_ifc_hub_checkin.sql`, `grant_icms_access_to_admin_enforcement.sql`, `management_icms_parity.sql`, `reset_roster_hierarchy.sql`, `fix_demo_ifc_missing_ops_group.sql`, `apply_all_pending_migrations.sql`, `create_icms_duty_post_demo_accounts.sql`) | repository root | **Dead code / requires staging evidence before ever running again** | Already classified by `migrate.mjs` as "unsafe/meaningless against synthetic fixtures" — these touch specific real accounts or ICMS legacy data, not a repeatable schema change. None should ever be replayed against any real environment without a fresh, reviewed, environment-specific script. |
| `fix_aso_so_dse_transactions_read_rls.sql`, `fix_ops_staff_checkpoint_insert_rls.sql`, `add_duty_early_checkin_late_checkout_fields.sql`, `add_duty_manual_zone_selection_fields.sql` | repository root | **Requires staging evidence** | `migrate.mjs` confirms (by grep) that nothing in this repo's own schema/fixtures references what these touch — meaning they target objects that exist in a real deployed database but not in this repo's traced dependency graph. They must be verified against the TARGET database's actual schema before inclusion in any rollout, never assumed safe from repo inspection alone. |

## The retirement gate

Legacy `profiles.role in ('MANAGEMENT','ADMIN','ENFORCEMENT')` and
`unified_role = 'super_admin'` access **may not be removed** until ALL of
the following are true — this is enforced as a documented gate here, and
partially as read-only evidence via
`view_legacy_role_mapping_report_secure()` (Phase 13 migration), not as
code that blocks anything automatically (there is nothing to block yet,
since nothing retires in this phase):

1. Every legacy privileged account has an approved Phase 3 scoped-role
   replacement assignment — **measured by**
   `view_legacy_role_mapping_report_secure()`'s `has_replacement_assignment`
   column, Super-Admin-only, audited.
2. Replacement workflows pass staging.
3. Replacement dashboards pass role-by-role UAT.
4. No application route/action depends solely on the legacy role —
   **not yet true**: Phase 4 registration approval and general AVSEC
   navigation still depend solely on it (see table above).
5. No RLS policy depends solely on the legacy role — **not yet
   verified exhaustively**; `20260923000003_super_admin_privilege_containment.sql`
   alone has ~8 policies keyed to `profiles.role::text = any(array['ADMIN','SUPER_ADMIN'])`
   with no scoped-role alternative branch (sampled, not individually
   re-verified this round).
6. No cron, trigger, or notification depends solely on the legacy role —
   **the two corrected cron grants did not depend on it either way** (they
   had no role check at all); this condition is otherwise unverified
   beyond those two.
7. Export/audit/archival ownership is confirmed — see `ownership-matrix.md`
   (confirmed not to have been broadened).
8. Malaysia live trial completes successfully — **not started**.
9. ICT approves the cleanup — **not requested**.

**Current status: BLOCKED.** Condition 1 alone is measurably unmet for at
least one fixture class (any legacy-role profile with no active
`user_role_assignments` row), confirmed by `verify_phase13_integration.mjs`.
No account mapping was performed against any real data — the report is a
dry-run read query, and this phase ran it only against synthetic test
fixtures, never a real profile.

## Future cleanup sequence (not executed in this phase)

1. Run `view_legacy_role_mapping_report_secure()` against the real staging
   (then production) database as Super Admin; export the result.
2. For every unreplaced legacy account, create and approve the
   corresponding Phase 3 scoped-role assignment — a manual, reviewed
   action per account, never a bulk/automatic mapping.
3. Re-run the report until `legacy_profiles_without_replacement_assignment`
   (also surfaced in `view_release_readiness_report_secure()`) is zero.
4. Re-point every route/RLS/cron/notification identified in condition 4-6
   above at the Phase 3 scoped-role check, verified individually.
5. Only after conditions 2-9 above are independently satisfied, drop the
   legacy grant/role branches in a reviewed forward migration — never by
   editing the historical files that introduced them.

This sequence is reversible at every step up to step 5; nothing here
deletes a legacy role value or a user's existing access.
