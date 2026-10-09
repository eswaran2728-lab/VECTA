# Current Role Dashboard Inventory (static)

> **Method:** STATIC, read-only source review of branch `dashboard/role-workspaces-adjustment` (HEAD `139d71cc4a1e4de8554ee2b9f3a12cf439da716f`, confirmed from `.git/HEAD` and `.git/refs`). No login was performed; **no browser behaviour is verified**. Hosted staging DB state is **UNVERIFIED** (only repo migrations were read).
> **Git working-tree cleanliness is UNVERIFIED.** `git status --short` could not be run (no shell on the owner's machine). Do not treat the tree as clean.
> **Credentials:** the staging credential PDF was used only for account labels and scopes. No passwords appear in these documents.
> Labels: CODE-CONFIRMED | REQUIRES-BROWSER-VERIFICATION | OWNER-DECISION-REQUIRED | SECURITY-DEFECT.

## 1. Account inventory (40 accounts from the staging manifest; labels/scopes only)

| # | Role | Account label | Scope |
|---|---|---|---|
| 1 | aax_admin | aax_admin | MY / AAX |
| 2 | aax_boss | aax_boss | MY / AAX |
| 3 | airasia_management | airasia_management | global |
| 4 | aso | aso | operation / northern / PEN / ALPHA / MAA |
| 5 | aso | aso-bki-receipt | operation / sabah / BKI / ALPHA / MAA |
| 6 | aso | aso-jhb | operation / southern_east_coast / JHB / ALPHA / MAA |
| 7 | aso | aso-kch-receipt | operation / sarawak / KCH / ALPHA / MAA |
| 8 | aso | aso-kul | operation / kul / KUL-MAA / ALPHA / MAA |
| 9 | aso | aso-no-caterlink | operation / sarawak / BTU / ALPHA / MAA |
| 10 | aso | neg-deactivated-profile | KUL-MAA / ALPHA |
| 11 | aso | neg-expired-assignment | KUL-MAA / ALPHA |
| 12 | aso | neg-future-assignment | KUL-MAA / ALPHA |
| 13 | aso | neg-pending-profile | KUL-MAA / ALPHA |
| 14 | aso | neg-rejected-profile | KUL-MAA / ALPHA |
| 15 | aso | neg-revoked-assignment | KUL-MAA / ALPHA |
| 16 | caterlink_management | caterlink_management | MY / caterlink |
| 17 | compliance | compliance | MY / compliance |
| 18 | dse | dse | operation / kul / KUL-MAA / ALPHA / MAA |
| 19 | ghod | ghod | global |
| 20 | global_reporting_controller | global_reporting_controller | global |
| 21 | hub_se | hub_se | operation / northern / MAA |
| 22 | investigation_aso | investigation_aso | enforcement / investigation / MAA |
| 23 | investigation_so | investigation_so | enforcement / investigation / MAA |
| 24 | investigation_sso | investigation_sso | enforcement / investigation / MAA |
| 25 | maa_admin | maa_admin | MY / MAA |
| 26 | maa_boss | maa_boss | MY / MAA |
| 27 | main_enforcement | main_enforcement | MY / enforcement |
| 28 | operation_manager | operation_manager | MY / operation |
| 29 | profiling_aso | profiling_aso | enforcement / profiling / northern / PEN / ALPHA / MAA |
| 30 | profiling_so | profiling_so | enforcement / profiling / northern / PEN / ALPHA / MAA |
| 31 | sat_aso | sat_aso | enforcement / sat / kul / KUL-MAA / ALPHA / MAA |
| 32 | so | so | operation / northern / PEN / ALPHA / MAA |
| 33 | so | so-jhb | operation / southern_east_coast / JHB / ALPHA / MAA |
| 34 | so | so-kul | operation / kul / KUL-MAA / ALPHA / MAA |
| 35 | sso | sso | operation / northern / PEN / ALPHA / MAA |
| 36 | sso | sso-jhb | operation / southern_east_coast / JHB / ALPHA / MAA |
| 37 | sso | sso-kul | operation / kul / KUL-MAA / ALPHA / MAA |
| 38 | super_admin | super_admin | technical |
| 39 | vendor | caterlink-vendor | CaterLink-only |
| 40 | warehouse_pic | caterlink-driver | CaterLink-only (driver) |

Observations on the manifest:
- No foreign-AOC negative account is present (OWNER-DECISION-REQUIRED: supply one to test cross-AOC denial).
- `caterlink-vendor` carries role `vendor`; `caterlink-driver` carries role `warehouse_pic` (REQUIRES-BROWSER-VERIFICATION that these classify as CaterLink driver/vendor).
- No MAA/AAX `ASO`-style station variants exist for entity roles; hub_se, compliance, main_enforcement, operation_manager have no station variants.
- Six negative accounts: pending, rejected, deactivated, revoked, expired, future-dated (all `aso`, KUL-MAA).

## 2. How a role reaches a dashboard (CODE-CONFIRMED)
1. Edge gate (`lib/supabase/middleware.ts`, `middleware-gate-logic.ts`) applies super-admin, CaterLink-only and check-in rules; portal classification (`classifyPortalAccess`/`decidePortalRequest`) yields caterlink_management / driver / vendor / vecta / super_admin / blocked / conflict / none.
2. Canonical roles come from RPC `get_my_active_role_assignments()` (approved profile, active role, not revoked, within start/end dates). A compat map converts to legacy roles; **MAA/AAX/GHOD and similar map to null**.
3. `app/(avsec)/avsec/layout.tsx` passes `displayRole = access?.primaryCompatRole ?? "ASO"` to `AppSidebar` and `TeamBottomNav` (the fallback is the root of several findings).
4. `my-dashboard/page.tsx` dispatches to EntityDashboard, EntityAdminDashboard, ExecutiveDashboard, OperationManagerDashboard, SuperAdminDashboard or GenericLinkHubDashboard. `LINK_HUB_CONFIG` is the single source for dashboard links and route-guard allowed codes (`requireRouteAccess`/`routeAllows`).
5. Page guards: `requireProfile`, `requireRole`, `requireRouteAccess`, `requirePhase8Role`.

## 3. Functions per role family (as built, from source)
- **Entity Boss (MAA/AAX):** EntityDashboard; boss report count is a single figure (not per type); has announcement publish rights in DB (`can_user_publish_announcement`) but the announcements page guard does not admit them (see findings); no UI path to read Bay Board/directory under canonical-only roles (RLS `canon_station_visible`/`canon_can_view_profile`); anonymous identity is not exposed to Boss anywhere in UI.
- **Entity Admin (MAA/AAX):** EntityAdminDashboard; registration RPC `list_entity_registration_requests_secure` exists and the page `admin/entity-registrations` exists but has **no nav link** and takes a raw AOC-id input; no report access path (`has_report_access` has no admin branch); directory export RPC `export_entity_user_directory` exists (phase4) but the helper is unused.
- **Global (airasia_management, ghod, global_reporting_controller):** ExecutiveDashboard / link hub; GHOD flagged-report links use the index id where the view route expects the source id.
- **super_admin:** SuperAdminDashboard at `/super-admin`; discussion identity resolution RPC `resolve_discussion_author_identity_secure` is restricted to super_admin but no UI reaches it.
- **operation_manager:** OperationManagerDashboard; also in `ADMIN_ROLES` so reaches `admin/users`.
- **Department leadership/enforcement/investigation/SAT/profiling:** link-hub driven by `LINK_HUB_CONFIG`; page guards on `sat/reports`, `profiling/workspace`, `investigation/cases`, `enforcement/workforce`.
- **Operations hierarchy (hub_se, dse, sso, so, aso):** link hub; Duty, leave, OT, timesheet; hub_se reaches Duty.
- **CaterLink-only:** diverted to the portal via `next.config.ts` rewrites and the middleware decision; leadership roles see empty CaterLink data (RLS).
- **Public registration:** `api/auth/register` restricted to DSE/SO/ASO (CODE-CONFIRMED, correct).

## 4. Role matrix (one row per account)

| Account | Role | Current dashboard | Keep | Add | Remove | Must deny | Desktop | Mobile | Result |
|---|---|---|---|---|---|---|---|---|---|
| aax_admin | aax_admin | EntityAdminDashboard (via my-dashboard dispatch) | Entity registration admin, staff directory, announcements (Malaysia AOC), role/scope assignment, directory export (AAX) | Nav link to entity-registrations; AAX Reports (reg/flight/date); Bay Board hub/station selector; combined MY directory; ack reports | Duty Terminal, check-in/out, Leave, OT, Timesheet (sidebar 'ASO' fallback links); dead dashboard links | MAA reports; Global announcements; boss authority; /super-admin; GHOD/Exec views; CaterLink data; other-AOC data | Not browser-tested | Not browser-tested | Change Required (static) |
| aax_boss | aax_boss | EntityDashboard (single entity overview) | Entity overview, Malaysia announcements, staff directory | Per-report-type counts; AAX Reports (reg/flight/date, completed); workforce oversight (active/checked-in/pending/absent); Bay Board hub/station selector | Duty Terminal, check-in/out, Leave, OT, Timesheet (sidebar 'ASO' fallback links); duplicate Operation Dashboard entry; dead links | MAA reports; Global announcements; anonymous identity (no default reveal); /super-admin; CaterLink data | Not browser-tested | Not browser-tested | Change Required (static) |
| airasia_management | airasia_management | ExecutiveDashboard | Global read-only oversight cards | Owner to define scope | Duty Terminal, check-in/out, Leave, OT, Timesheet (sidebar 'ASO' fallback links) | Admin/user-admin; /super-admin; announcement management unless approved; mutations | Not browser-tested | Not browser-tested | Change Required (static: ASO-fallback sidebar) |
| aso | aso | Link hub (ASO) | Duty, leave, OT, own reports | - | - | Other-station data; admin pages; entity reports | Not browser-tested | Not browser-tested | Correct (static); browser verification required |
| aso-bki-receipt | aso | Link hub (ASO) | Duty, leave, OT, own reports | - | - | Other-station data; admin pages; entity reports | Not browser-tested | Not browser-tested | Correct (static); browser verification required |
| aso-jhb | aso | Link hub (ASO) | Duty, leave, OT, own reports | - | - | Other-station data; admin pages; entity reports | Not browser-tested | Not browser-tested | Correct (static); browser verification required |
| aso-kch-receipt | aso | Link hub (ASO) | Duty, leave, OT, own reports | - | - | Other-station data; admin pages; entity reports | Not browser-tested | Not browser-tested | Correct (static); browser verification required |
| aso-kul | aso | Link hub (ASO) | Duty, leave, OT, own reports | - | - | Other-station data; admin pages; entity reports | Not browser-tested | Not browser-tested | Correct (static); browser verification required |
| aso-no-caterlink | aso | Link hub (ASO) | Duty, leave, OT, own reports | - | - | Other-station data; admin pages; entity reports | Not browser-tested | Not browser-tested | Correct (static); browser verification required |
| neg-deactivated-profile | aso (deactivated profile) | None expected (denied/pending page) | - | - | Any operational dashboard | Everything operational | Not browser-tested | Not browser-tested | Expected: denied/pending. Static: guards deny; **browser test mandatory** (any operational reach = SECURITY-DEFECT) |
| neg-expired-assignment | aso (expired assignment) | None expected (denied/pending page) | - | - | Any operational dashboard | Everything operational | Not browser-tested | Not browser-tested | Expected: denied/pending. Static: guards deny; **browser test mandatory** (any operational reach = SECURITY-DEFECT) |
| neg-future-assignment | aso (future-dated assignment) | None expected (denied/pending page) | - | - | Any operational dashboard | Everything operational | Not browser-tested | Not browser-tested | Expected: denied/pending. Static: guards deny; **browser test mandatory** (any operational reach = SECURITY-DEFECT) |
| neg-pending-profile | aso (pending profile) | None expected (denied/pending page) | - | - | Any operational dashboard | Everything operational | Not browser-tested | Not browser-tested | Expected: denied/pending. Static: guards deny; **browser test mandatory** (any operational reach = SECURITY-DEFECT) |
| neg-rejected-profile | aso (rejected profile) | None expected (denied/pending page) | - | - | Any operational dashboard | Everything operational | Not browser-tested | Not browser-tested | Expected: denied/pending. Static: guards deny; **browser test mandatory** (any operational reach = SECURITY-DEFECT) |
| neg-revoked-assignment | aso (revoked assignment) | None expected (denied/pending page) | - | - | Any operational dashboard | Everything operational | Not browser-tested | Not browser-tested | Expected: denied/pending. Static: guards deny; **browser test mandatory** (any operational reach = SECURITY-DEFECT) |
| caterlink_management | caterlink_management | CaterLink portal (/icms via rewrite) | CaterLink management portal only | - | Any VECTA operational link | All /avsec operational pages; reports; directory; /super-admin | Not browser-tested | Not browser-tested | Correct by design (static); browser verification required |
| compliance | compliance | Link hub (compliance) | Compliance views | - | Duty Terminal, check-in/out, Leave, OT, Timesheet (sidebar 'ASO' fallback links) | User admin; enforcement mutations; /super-admin | Not browser-tested | Not browser-tested | Change Required (static: ASO-fallback sidebar) |
| dse | dse | Link hub (DSE) | Station/team operations, duty | - | - | Other-station data; user admin | Not browser-tested | Not browser-tested | Correct (static); browser verification required |
| ghod | ghod | ExecutiveDashboard (flagged-reports list) | Executive oversight, flagged reports | Fix flagged-report link id (index id vs source id) | Duty Terminal, check-in/out, Leave, OT, Timesheet (sidebar 'ASO' fallback links) | /super-admin; entity admin; user admin | Not browser-tested | Not browser-tested | Change Required (static: ASO-fallback sidebar) |
| global_reporting_controller | global_reporting_controller | Link-hub / Executive (per LINK_HUB_CONFIG) | Global reporting views | Owner to define | Duty Terminal, check-in/out, Leave, OT, Timesheet (sidebar 'ASO' fallback links) | /super-admin; user admin; registration admin | Not browser-tested | Not browser-tested | Change Required (static: ASO-fallback sidebar) |
| hub_se | hub_se | Link hub (hub SE) | Hub oversight | Owner decision: is Duty/check-in applicable? | Duty (reachable today; OWNER-DECISION) | Other-hub data; user admin; /super-admin | Not browser-tested | Not browser-tested | Change Required (static: ASO-fallback sidebar) |
| investigation_aso | investigation_aso | Link hub (investigation) | Investigation cases | - | - | Other-unit workspaces; user admin | Not browser-tested | Not browser-tested | Correct (static); browser verification required |
| investigation_so | investigation_so | Link hub (investigation) | Investigation cases | - | Non-roster Duty links if shown | Other-unit workspaces; user admin | Not browser-tested | Not browser-tested | Correct (static); browser verification required |
| investigation_sso | investigation_sso | Link hub (investigation) | Investigation cases | - | Non-roster Duty links if shown | Other-unit workspaces; user admin | Not browser-tested | Not browser-tested | Correct (static); browser verification required |
| maa_admin | maa_admin | EntityAdminDashboard | Same as aax_admin, MAA scope | MAA Reports (reg/flight/date); nav link to entity-registrations; Bay Board selector; combined MY directory | Duty Terminal, check-in/out, Leave, OT, Timesheet (sidebar 'ASO' fallback links); dead dashboard links | AAX reports; Global announcements; boss authority; /super-admin; CaterLink data | Not browser-tested | Not browser-tested | Change Required (static) |
| maa_boss | maa_boss | EntityDashboard | Same as aax_boss, MAA scope | Per-report-type counts; MAA Reports; workforce oversight; Bay Board selector | Duty Terminal, check-in/out, Leave, OT, Timesheet (sidebar 'ASO' fallback links); duplicate Operation Dashboard entry; dead links | AAX reports; Global announcements; anonymous identity; /super-admin | Not browser-tested | Not browser-tested | Change Required (static) |
| main_enforcement | main_enforcement | Link hub (enforcement) | Enforcement search/workforce | - | Duty Terminal, check-in/out, Leave, OT, Timesheet (sidebar 'ASO' fallback links) | Operations roster mutation; user admin; /super-admin | Not browser-tested | Not browser-tested | Change Required (static: ASO-fallback sidebar) |
| operation_manager | operation_manager | OperationManagerDashboard | Operations oversight | - | User-admin powers unless owner approves (ADMIN_ROLES); Duty Terminal, check-in/out, Leave, OT, Timesheet (sidebar 'ASO' fallback links) | Entity registration admin; /super-admin; AAX/MAA entity reports unless assigned | Not browser-tested | Not browser-tested | Change Required (static: ASO-fallback sidebar) |
| profiling_aso | profiling_aso | Link hub (profiling) | Profiling workspace | - | - | Other-unit workspaces; user admin | Not browser-tested | Not browser-tested | Correct (static); browser verification required |
| profiling_so | profiling_so | Link hub (profiling) | Profiling workspace | - | - | Other-unit workspaces; user admin | Not browser-tested | Not browser-tested | Correct (static); browser verification required |
| sat_aso | sat_aso | Link hub (SAT) | SAT reports | - | - | Other-unit workspaces; user admin; cross-station data | Not browser-tested | Not browser-tested | Correct (static); browser verification required |
| so | so | Link hub (SO) | Duty, leave, OT, own reports | - | - | Other-station data; admin pages | Not browser-tested | Not browser-tested | Correct (static); browser verification required |
| so-jhb | so | Link hub (SO) | Duty, leave, OT, own reports | - | - | Other-station data; admin pages | Not browser-tested | Not browser-tested | Correct (static); browser verification required |
| so-kul | so | Link hub (SO) | Duty, leave, OT, own reports | - | - | Other-station data; admin pages | Not browser-tested | Not browser-tested | Correct (static); browser verification required |
| sso | sso | Link hub (SSO) | Team operations, duty | - | - | Other-station/team mutation; user admin | Not browser-tested | Not browser-tested | Correct (static); browser verification required |
| sso-jhb | sso | Link hub (SSO) | Team operations, duty | - | - | Other-station/team mutation; user admin | Not browser-tested | Not browser-tested | Correct (static); browser verification required |
| sso-kul | sso | Link hub (SSO) | Team operations, duty | - | - | Other-station/team mutation; user admin | Not browser-tested | Not browser-tested | Correct (static); browser verification required |
| super_admin | super_admin | SuperAdminDashboard (/super-admin) | Technical administration | Reachable discussion identity-reveal UI if owner approves (currently unreachable); audit log | Operational ASO links if shown | Must not be used for routine ops; reveal only via audited RPC | Not browser-tested | Not browser-tested | Change Required (static: reveal unreachable) |
| caterlink-vendor | vendor | CaterLink portal (vendor) | CaterLink vendor functions only | - | - | All /avsec operational pages; /super-admin | Not browser-tested | Not browser-tested | Correct by design (static); browser verification required |
| caterlink-driver | warehouse_pic | CaterLink portal (driver/warehouse) | CaterLink driver functions only | - | - | All /avsec operational pages; /super-admin | Not browser-tested | Not browser-tested | Correct by design (static); browser verification required |

---

# FINAL role / function matrix after implementation (supersedes the static "as built" rows for the roles below)

| Role | Entry | Navigation (one model) | Reports | Directory | Registrations | Announcements | Duty / Leave / OT / Timesheet |
|---|---|---|---|---|---|---|---|
| MAA Boss / AAX Boss | One entity overview (no duplicate Operation Dashboard) | Overview, Entity Reports, Staff Directory, Bay Board, Discussions, Malaysia Announcements, Profile | Own entity only: per-type counts + total, search, open, PDF/attachment | Malaysia combined (safe fields) | No | Malaysia AOC (manage + acknowledgement report) | **No** (UI and server) |
| MAA Admin / AAX Admin | Entity admin overview (own-entity active staff, Malaysia-wide pending total) | Overview, Registration Administration, Entity Reports, Staff Directory, Bay Board, Discussions, Announcements, Profile | Own entity only; no report export | Malaysia combined + own-entity export | Own entity: list / approve (role + scope) / reject with reason | Malaysia AOC | **No** |
| GHOD | Executive dashboard | Workspace links, Discussions, Announcements, Profile | Flagged reports only (working link) | n/a | n/a | Global only | **No** |
| AirAsia Management | Executive dashboard | Workspace links, Discussions, Announcements (read-only) | per existing rules | n/a | n/a | Read-only | **No** |
| Global Reporting Controller | Link hub | Report Search, Export/Filters, Discussions | repository-wide secure search | n/a | n/a | none | **No** |
| Operation Manager | Operation manager dashboard | Operations, attendance monitoring, reports, User Directory/Geofence (user-admin authority unchanged) | existing | existing | existing | none (cannot publish) | no personal roster |
| Hub SE / DSE / SSO / SO / ASO | Role dashboard | Legacy station navigation, now chosen from the role code | existing | n/a | n/a | read | **Yes** (Hub SE keeps Duty) |
| CaterLink Management | CaterLink portal | CaterLink group only | none | n/a | n/a | n/a | n/a |
| Unknown role | My Dashboard | My Dashboard + Profile only | none | none | none | none | none |

Navigation is a display convenience: every destination re-authorizes server-side, and the database remains the authority.
