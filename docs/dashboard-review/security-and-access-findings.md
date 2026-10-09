# Security and Access Findings (static)

> **Method:** STATIC, read-only source review of branch `dashboard/role-workspaces-adjustment` (HEAD `139d71cc4a1e4de8554ee2b9f3a12cf439da716f`, confirmed from `.git/HEAD` and `.git/refs`). No login was performed; **no browser behaviour is verified**. Hosted staging DB state is **UNVERIFIED** (only repo migrations were read).
> **Git working-tree cleanliness is UNVERIFIED.** `git status --short` could not be run (no shell on the owner's machine). Do not treat the tree as clean.
> **Credentials:** the staging credential PDF was used only for account labels and scopes. No passwords appear in these documents.
> Labels: CODE-CONFIRMED | REQUIRES-BROWSER-VERIFICATION | OWNER-DECISION-REQUIRED | SECURITY-DEFECT.

| ID | Label | Title | Detail |
|---|---|---|---|
| F-01 | **SECURITY-DEFECT** | `central_reports_index` direct-select vs revoke | Phase5 revokes direct access to `central_reports_index`, but dashboard/search code (`lib/avsec/dashboard/queries.ts`, `lib/avsec/search/queries.ts`, `lib/avsec/reports/queries.ts`) reads it directly and later migrations may re-grant. If staging still grants select to authenticated users, cross-entity/cross-station index rows could leak. Staging grants UNVERIFIED. Test: as maa_boss/aax_boss and a plain aso, query the index via the app and check zero cross-scope rows. |
| F-02 | **CODE-CONFIRMED** | Sidebar/bottom-nav 'ASO' fallback | `displayRole = primaryCompatRole ?? "ASO"` gives MAA/AAX Boss/Admin, GHOD and similar roles the ASO nav (Duty, Leave, OT, Timesheet). Remove for non-rostered leadership. Need browser confirmation of exact items rendered. |
| F-03 | **REQUIRES-BROWSER-VERIFICATION** | Duty/check-in server denial for leadership | Whether `duty/page.tsx` and the check-in middleware rule deny MAA/AAX/GHOD must be proven by direct URL (`/avsec/duty`). A reachable page is a SECURITY-DEFECT (hidden-button rule). |
| F-04 | **CODE-CONFIRMED** | Dead dashboard links for Boss/Admin | Dashboard cards link to routes whose guards do not admit the role, or have no target. Needs per-card click test. |
| F-05 | **CODE-CONFIRMED** | Entity registration page orphaned | `admin/entity-registrations` has no nav entry, uses raw AOC-id input; `EntityRegistrationsView` plus `lib/avsec/admin/entity-registrations.ts` export are unused by the dashboard. Admin cannot discover approve/reject. |
| F-06 | **CODE-CONFIRMED** | Announcements page guard blocks real publishers | `management/announcements/page.tsx` guard excludes the roles that `can_user_publish_announcement` permits (entity Boss/Admin). Fix guard to follow the DB decision; keep Global management denied. |
| F-07 | **CODE-CONFIRMED** | Admin roles have no report access | `has_report_access` (phase6) has no MAA/AAX Admin branch. Planned entity-scoped branch required (no boss or cross-entity authority). |
| F-08 | **CODE-CONFIRMED** | Bay Board and directory read path for entity roles | Canonical entity roles map to null compat; bay_board RLS (`20261020` canonical compat) and `canon_can_view_profile`/`canon_station_visible` do not clearly give MAA/AAX Boss/Admin a read path. Combined MY directory not implemented. |
| F-09 | **CODE-CONFIRMED** | Boss report counts single figure | EntityDashboard shows one aggregate (phase7 entity aggregates) rather than per report type. |
| F-10 | **CODE-CONFIRMED** | No AK/D7 preselection; no reg/flight/date search | `reports/lookup` and the forms do not classify by flight prefix; unknown/malformed/codeshare handling is undefined (OWNER-DECISION-REQUIRED). `confirm_report_operating_entity` exists in phase5 as the server helper. |
| F-11 | **REQUIRES-BROWSER-VERIFICATION** | Entity separation of detail/PDF/export/attachment | `get_report_secure`, `search_reports_secure`, `list_reports_secure`, `export_reports_secure` exist, but `reports/view/[type]/[id]`, `api/avsec/export/pdf/[type]/[id]/route.tsx`, and `export/excel/route.ts` must be tested with a cross-entity direct URL. Any MAA-reads-AAX success = SECURITY-DEFECT and a stop condition. |
| F-12 | **CODE-CONFIRMED** | GHOD flagged-link id mismatch | `flagged_reports_secure` returns the repository index id; ExecutiveDashboard builds `/avsec/reports/view/<type>/<id>` which expects the source report id. Likely broken link; REQUIRES-BROWSER-VERIFICATION. |
| F-13 | **CODE-CONFIRMED** | Tablet navigation gap (768-1023px) | Sidebar is `hidden lg:flex`; bottom nav is `md:hidden`. Between 768 and 1023px neither shows. |
| F-14 | **OWNER-DECISION-REQUIRED** | operation_manager holds user-admin powers | operation_manager is in `ADMIN_ROLES` guarding `admin/users`. Confirm intent. |
| F-15 | **OWNER-DECISION-REQUIRED** | hub_se reaches Duty | hub_se can open Duty. Decide whether hub_se is rostered. |
| F-16 | **OWNER-DECISION-REQUIRED** | Anonymous discussion identity | Current: no UI exposes sender identity to MAA/AAX Boss (CODE-CONFIRMED). The only identity resolver (`resolve_discussion_author_identity_secure`, phase10) is super_admin-only and has no reachable UI. Privacy classification: acceptable default (no reveal). If Boss reveal is wanted: separate audited RPC with reason, actor, timestamp, exact message id, no bulk, hidden by default, notification policy. |
| F-17 | **CODE-CONFIRMED** | Orphaned Phase 8 pages | Phase 8 pages (guarded by `requirePhase8Role`) have no nav entry. Decide keep/remove. |
| F-18 | **REQUIRES-BROWSER-VERIFICATION** | Negative-state enforcement | pending, rejected, deactivated, revoked, expired, future accounts must be denied. Source: RPC requires approved profile + active, unrevoked, in-window assignment; null compat then hits the 'ASO' display fallback, so confirm page guards redirect rather than render. Any operational reach = SECURITY-DEFECT. No foreign-AOC account exists in the manifest. |
| F-19 | **REQUIRES-BROWSER-VERIFICATION** | CaterLink-only separation | Middleware/`next.config.ts` rewrites + `decidePortalRequest` appear correct; leadership see empty CaterLink data via RLS. Test vendor/driver/caterlink_management against `/avsec/*` and `/super-admin`. Any success = SECURITY-DEFECT and stop condition. |
| F-20 | **CODE-CONFIRMED** | Public registration restricted | `api/auth/register` accepts only DSE/SO/ASO. Correct. |
| F-21 | **CODE-CONFIRMED** | Planned AAX/MAA report separation not yet implemented in UI | Backend plan docs define the rules; UI/search/notification routing not built. Combined directory must not grant combined reports. |
| F-22 | **OWNER-DECISION-REQUIRED** | Open policy questions | Directory sensitive fields; Boss workforce drill-down depth; Bay Board scope; codeshare/non-AK/D7 treatment; admin export of reports; who may reclassify reports. |

## Direct routes requiring browser tests (expected outcome in brackets)
- `/avsec/duty` as maa_admin, maa_boss, aax_admin, aax_boss, ghod [deny]
- `/avsec/reports/lookup` and `/avsec/reports/view/<type>/<id>` as aax_boss on an AK report, maa_boss on a D7 report [deny/zero rows]
- `/api/avsec/export/pdf/<type>/<id>` and `/api/avsec/export/excel` cross-entity [deny]
- `/avsec/admin/entity-registrations` as maa_admin, aax_admin [allow own entity], aax_boss, aso [deny]
- `/avsec/admin/users` as operation_manager [OWNER-DECISION], aso [deny]
- `/avsec/management/announcements` as maa_boss/aax_boss [allow Malaysia], aso [deny]
- `/avsec/bay-board`, directory pages as entity roles [allow with selector]
- `/super-admin` as every non-super_admin [deny]
- `/avsec/*` and `/icms/*` as vendor, driver, caterlink_management [portal only]
- `/avsec/my-dashboard` as all six neg-* accounts [denied/pending]
- `/avsec/sat/reports`, `/profiling/workspace`, `/investigation/cases`, `/enforcement/workforce` as cross-unit users [deny]
- Discussions: confirm no identity visible to Boss.

---

# Disposition after implementation (local certification)

| Static finding | Disposition |
|---|---|
| ASO fallback (`primaryCompatRole ?? "ASO"`) | **Fixed.** Layout builds `buildNavModel()` from canonical role codes; no default role. |
| Admin report access | **Fixed (narrow).** `has_report_access` admits MAA/AAX Admin for their own entity only; admin report export stays denied. |
| Registration page orphaned / raw AOC id | **Fixed.** Nav link for Admins; selectors from `list_registration_assignment_options_secure`; AOC and entity come from the request. The edge middleware also blocked the route and is corrected. |
| Dead dashboard links | **Fixed.** Admin dashboard no longer links `/avsec/admin/users` or `/avsec/admin/roster`; every dashboard href is asserted to have a page. |
| Announcement guard | **Fixed.** Canonical role codes: GHOD = Global, entity Boss/Admin = Malaysia AOC, AirAsia Management = read-only, others redirected. |
| GHOD flagged link | **Fixed (two defects).** The link used the repository id; `flagged_reports_secure` also selected columns that do not exist on the index and failed at run time. It now returns `source_id` and reads flag details from the source row. |
| Tablet navigation gap | **Fixed in code**; needs the browser pass. Bottom bar is now `lg:hidden`; a keyboard-accessible drawer opens from the header below 1024px. |
| Direct `central_reports_index` read | **Fixed.** `getReportById` and the PDF route use source-keyed RPCs; a closure test fails on any `.from("central_reports_index")`. |
| Admin directory export without UI caller | **Fixed.** Wired to the directory page for Admins (own entity), audited, active staff only. |
| Raw AOC id / missing scope selectors | **Fixed** (see registration row). |

## Defects found while building (all fixed in migrations 2, 3 and 5)
1. `report_source_summary` returned `report_sec016.sta_std` (type `time`) into a `text` column, so summarising ANY SEC016 row raised an error.
2. `flagged_reports_secure` selected `flagged_reason` / `flagged_at` from `central_reports_index`, which has neither column.
3. The indexing queue indexes `flight_number` and `report_date` as NULL, so any index-level flight/date filter would match nothing; filters read the trusted source row instead.
4. `approve_registration_request` did not bind the approval to the request's own entity: an admin of one entity could approve the other entity's request.
5. The report-attachments SELECT policy used `can_view_report` (which does not follow `has_report_access`); it now uses `can_read_report_attachment`.
6. The Malaysia directory initially omitted every Boss/Admin (protected roles carry their entity on the assignment, not on a membership).
7. Duty pages other than `/avsec/duty` and the timesheet used `requireProfile()` and attendance server actions used `getCurrentProfile()` (which substitutes "ASO"); any approved leader could open them or act as an ASO.
8. `export_entity_user_directory` included pending / deactivated profiles and expired or not-yet-started assignments.

## Credential security
The previous static-review session exposed staging passwords in private tool output. This phase did not print, reuse, rotate or commit any credential. **Rotate the staging credentials before wider organizational testing.** No `.env`, PDF or screenshot is part of the change set.
