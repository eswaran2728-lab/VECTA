# Dashboard Adjustment Implementation Plan (proposal only; nothing implemented)

> **Method:** STATIC, read-only source review of branch `dashboard/role-workspaces-adjustment` (HEAD `139d71cc4a1e4de8554ee2b9f3a12cf439da716f`, confirmed from `.git/HEAD` and `.git/refs`). No login was performed; **no browser behaviour is verified**. Hosted staging DB state is **UNVERIFIED** (only repo migrations were read).
> **Git working-tree cleanliness is UNVERIFIED.** `git status --short` could not be run (no shell on the owner's machine). Do not treat the tree as clean.
> **Credentials:** the staging credential PDF was used only for account labels and scopes. No passwords appear in these documents.
> Labels: CODE-CONFIRMED | REQUIRES-BROWSER-VERIFICATION | OWNER-DECISION-REQUIRED | SECURITY-DEFECT.

Authorisation to implement has NOT been given. Order follows the owner plans.

1. **Browser certification first** (owner runs the sequence in the final report); confirm F-01, F-03, F-11, F-18, F-19.
2. **Owner decisions** (F-14, F-15, F-16, F-22).
3. **DB (forward-only migrations, disposable DB first):** confirm/repair grants on `central_reports_index`; add MAA/AAX Admin branch to `has_report_access` scoped to own entity; AK/D7 canonical classifier using `confirm_report_operating_entity`, never guessing for missing/malformed/codeshare (unclassified review queue); Bay Board hub/station read path not inferring entity from station; combined MY directory function (field set per decision); optional audited identity-reveal RPC.
4. **Secure RPC layer:** list/search (registration, flight, date range), detail, attachments, PDF, export all through RPCs; no authorise-then-direct-read; notification routing per entity with dedupe.
5. **App:** remove ASO fallback for leadership; remove Duty/check-in for Boss/Admin; one Boss overview; per-type counts; separate Directory and Reports buttons; link entity-registrations (with entity picker not raw id); fix announcements guard; fix GHOD link id; fix tablet nav gap; remove dead links; decide Phase 8 pages.
6. **Tests:** full positive/negative matrix (AK/D7, direct URL/RPC, revoked/expired/future/pending/rejected/deactivated, combined directory not widening reports), desktop 1440x900 and mobile 390x844, then staging per-role.
7. **Rollback:** each migration forward-only with documented compensating migration; app changes behind small PRs.

---

# IMPLEMENTATION RECORD — MAA/AAX leadership dashboards, entity report separation (local, uncommitted until verified)

> Status: **implemented and locally certified only.** Nothing has been pushed, merged, deployed, migrated on hosted staging, backfilled or activated. Staging application needs a separate authorization. The "proposal only" header above describes the earlier static review; this section records what was then built.

## Migrations added (additive, forward-only; none edits an applied migration)
| File | Purpose |
|---|---|
| `20261101000001_flight_classification_and_report_access.sql` | `normalize_flight_number`, `classify_flight_operating_entity` (classified / missing / malformed / unknown_prefix / conflict), `report_classification_review_queue` (service-role only), new `derive_report_classification()` (flight override only for a submitter with exactly one active assignment in the entity's own AOC; otherwise the entity stays NULL and the report is queued for review; non-flight reports take the entity from the submitter's active membership), `enqueue_unclassified_flight_report()` triggers, and a redefined `has_report_access()` that adds MAA/AAX Boss and Admin for their OWN entity only (every other branch copied unchanged). |
| `20261101000002_report_source_search_notifications.sql` | `get_report_by_source_secure` and `authorize_report_pdf_by_source_secure` (source-keyed; unauthorized and missing are indistinguishable and the attempt is audited), `search_reports_filtered_secure` (registration / normalised flight / date range / type / status; filters applied AFTER `has_report_access`), `report_source_flight_date` (flight/date read from the trusted source row because the indexing queue indexes them as NULL), `report_source_summary` fix, `can_read_report_attachment` + attachment SELECT policy, `export_reports_secure` denied to admin-only callers, `entity_report_submitted` notifications with `entity_report_recipients()` and a dedupe key. |
| `20261101000003_leadership_registration_directory_bayboard.sql` | `caller_entity_leadership_aoc`, `approve_registration_request` bound to the request's own entity and AOC (cross-entity approval refused in the database), `list_entity_registration_requests_detailed_secure`, `list_registration_assignment_options_secure` (selectors, protected roles excluded), `list_malaysia_staff_directory_secure`, `get_malaysia_workforce_summary_secure`, `list_bay_board_scopes_secure`, `get_bay_board_secure`. |
| `20261101000004_discussion_identity_reveal.sql` | `platform_feature_flags` (kill switch `discussion_identity_reveal`), `reveal_discussion_author_identity_secure` (Boss only, same AOC, reason >= 10 chars, audit written BEFORE disclosure, 10 reveals/hour, staff number and name only). |
| `20261101000005_entity_report_counts_and_admin_overview.sql` | `get_entity_report_counts_secure` (per-type counts under the same authorization as search), `get_entity_admin_overview_secure`, tightened `export_entity_user_directory` (approved profiles, effective assignments only), and a repaired `flagged_reports_secure` (now returns `source_id` and reads flag details from the source row). |

## Implementation decisions
1. **Authorization lives in the database.** Pages and navigation are a convenience layer; every RPC re-checks the caller (active approved profile, active in-window assignment, exact AOC and entity).
2. **Prefix assists, never decides alone.** AK -> MAA and D7 -> AAX is used only when the value is a single clean flight number AND the submitter's own AOC matches the entity's AOC. Missing, malformed, unknown-prefix and conflicting (codeshare, several numbers, "or/and") values stay unclassified and are queued for review. There is no retroactive guessing from station or e-mail and no hosted backfill.
3. **No ASO fallback anywhere in the navigation.** `lib/dashboard/nav-capabilities.ts` is the single role -> navigation model for the sidebar, drawer and bottom tabs. Unknown roles get My Dashboard + Profile only; several distinct roles are never merged silently.
4. **Non-rostered leadership is denied server-side**, not only hidden: duty pages and attendance actions use `requireAttendanceProfile()` / `getAttendanceProfile()`; `/avsec/duty` and `/avsec/duty/timesheet` were already gated by the canonical route policy. `hub_se` keeps Duty; `operation_manager` keeps its user-administration authority.
5. **Reports and the staff directory are separate functions** (`/avsec/entity-reports`, `/avsec/directory`). Seeing a person never grants a report.
6. **The edge middleware previously blocked `/avsec/admin/entity-registrations` for MAA/AAX Admin** (the whole `/avsec/admin` prefix was management-only). `isAdminPathForbiddenFor` now allows exactly that route for the two admin roles.
7. **Admin export is closed.** MAA/AAX Admin may export their OWN entity's staff directory, but `export_reports_secure` denies them.
8. **Identity reveal is built and enabled by migration seed**, with a kill switch. See Owner decisions.

## Execution order for staging (NOT authorized yet)
1. Owner authorizes staging application. 2. Encrypted backup. 3. Dry-run of migrations 1-5 in a rolled-back transaction against the staging catalog. 4. Apply. 5. Real-role probes (the six negative-state accounts, one MAA and one AAX leader, an ASO per entity). 6. Browser certification (checklist in `mobile-desktop-review.md`). Rollback is a compensating forward migration (restore the previous `has_report_access` body from `20260928000005`, drop the new objects); no data is rewritten by these migrations.

## Unresolved owner decisions (documented, not invented)
- **Sender notification on identity reveal**: none is sent. Whether the revealed author should be told is unresolved.
- **Existing `super_admin` identity resolution** (`resolve_discussion_author_identity_secure`, returns e-mail) is unchanged; confirm it should remain beside the Boss reveal.
- **Who may reclassify an unclassified/conflicting report** and the review-queue UI: the queue is populated and service-role readable only; no reviewer screen exists.
- **Offload records** have no detail viewer, so the entity report list shows them as "Summary only".
- **Directory fields**: staff number, name, entity, role, department/unit, hub/station/team and account state only (no e-mail or contact data).
- **Announcement management list** still reads through the legacy table queries (RLS-scoped); the write paths, publish authority and the audited acknowledgement report are secure RPCs.
- **Credential rotation**: staging passwords were exposed in private tool output during the previous static-review session. They must be rotated before wider organizational testing. This phase did not rotate or reuse them.
