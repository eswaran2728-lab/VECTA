# Role Dashboard Add / Remove Matrix (static)

> **Method:** STATIC, read-only source review of branch `dashboard/role-workspaces-adjustment` (HEAD `139d71cc4a1e4de8554ee2b9f3a12cf439da716f`, confirmed from `.git/HEAD` and `.git/refs`). No login was performed; **no browser behaviour is verified**. Hosted staging DB state is **UNVERIFIED** (only repo migrations were read).
> **Git working-tree cleanliness is UNVERIFIED.** `git status --short` could not be run (no shell on the owner's machine). Do not treat the tree as clean.
> **Credentials:** the staging credential PDF was used only for account labels and scopes. No passwords appear in these documents.
> Labels: CODE-CONFIRMED | REQUIRES-BROWSER-VERIFICATION | OWNER-DECISION-REQUIRED | SECURITY-DEFECT.

## Cross-role rules to apply (owner plan)
- Remove Duty Terminal, check-in and check-out from MAA/AAX Admin and Boss (non-rostered). Status: CODE-CONFIRMED that the sidebar/bottom-nav fall back to ASO links for roles whose compat role is null; REQUIRES-BROWSER-VERIFICATION of what each account actually sees.
- Boss: one entity-overview dashboard, no duplicate Operation Dashboard; per-type report counts; reg/flight/date search; completed-report access; workforce oversight; Bay Board hub/station selection; Malaysia (not Global) announcement management.
- Admin: simple dashboard; entity registration approve/reject; role/scope assignment; directory; entity export; entity-specific reports; no boss authority.
- Staff Directory and Reports stay separate buttons.
- Combined Malaysia directory visibility must not broaden report access.

## Must remain denied (all roles unless listed)
- AK reports for AAX roles; D7 reports for MAA roles (also details, attachments, PDF, export, notifications).
- Global announcement management for MAA/AAX roles.
- `/super-admin` for everyone except super_admin.
- Operational `/avsec` pages for CaterLink-only accounts.
- Any operational data for the six negative-state accounts.
- Anonymous-discussion identity for everyone except an audited, per-message workflow (if approved).

## Matrix

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

# Applied changes (local)

| Item | Applied |
|---|---|
| Remove Duty / Check In/Out / Leave / Overtime / Timesheet from non-rostered leadership | Done in navigation AND enforced server-side (attendance guards on pages and actions). |
| Remove duplicate Operation Dashboard entry for Boss/Admin | Done (single overview). |
| Boss: per-type report counts, entity total, search, open, secure PDF/attachment | Done. |
| Boss: Malaysia-wide workforce overview, combined directory, Bay Board selector, Malaysia announcements | Done. |
| Boss: anonymous-author reveal | Built behind a kill switch (`platform_feature_flags.discussion_identity_reveal`), Boss only, audited. |
| Admin: own-entity staff count, Malaysia-wide pending total, registration administration, own-entity directory export | Done. |
| Admin: remove Boss authority, cross-entity reports, Global announcements, report export | Done / denied in the database. |
| Do NOT change: Operation Manager user-admin authority, Hub SE Duty, foreign-AOC account creation, credential rotation, production | Unchanged. |
