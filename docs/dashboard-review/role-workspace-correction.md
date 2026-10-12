# Role-workspace correction (local certification record)

Source of the work: the staging role-dashboard audit of 12 October 2026 (`vecta-role-dashboard-audit.md`, outside the repo) compared with the repository. Everything below is **local and uncommitted to any remote**; nothing was applied to hosted staging.

## 1. Future-dated assignment — root cause and fix

**Finding in the audit:** `future.assignment` signed in and received the full KUL ASO workspace.

**What the code and database actually do (proved locally, not assumed):**
- `get_my_active_role_assignments()` — the only source of the application's role decision — requires an approved profile, an active role definition, `revoked_at is null`, `starts_at <= now()` and (`ends_at is null` or `ends_at > now()`). A future-dated assignment returns no rows, so the app sees "no assignment" and redirects to the pending page. `has_active_role`, `has_role_in_scope`, `has_report_access`, announcements, CaterLink scan, WOIS and every other helper apply the same window.
- `supabase/tests/integration/verify_assignment_time_validity.mjs` (native PG17, 58 checks) compares **every zero-argument client-callable function** (54 of them, 216 comparisons) between an approved profile with *no* assignment and profiles whose only assignment is future (+1 day and +10 years), expired or revoked. Any difference would be a leak; there is none. It also proves, for each of those states and a pending profile: `get_my_active_role_assignments` empty, `has_active_role` identical for all 23 role codes, exact-scope `has_role_in_scope` false, `has_report_access` false on a report in the user's own station, filtered report search empty, opening the report by id refused, announcements identical to "no assignment", CaterLink scan false, WOIS false, the Malaysia directory and Bay Board RPCs refused, and direct reads of `bay_board`, `duty_records`, `roster_entries` identical to "no assignment". An ACTIVE ASO is the control (it differs on many functions), so the harness can see a leak.
- `tests/assignment-time-validity.test.mts` statically scans the **latest definition of every database function** and fails if any authorization function reads `user_role_assignments` without `starts_at`, `revoked_at` and `ends_at` (only the six assignment-management functions that act on one named row are exempt, and are listed).

**Root cause (strongly supported, not confirmed against hosted data):** the staging fixture was provisioned on **2026-10-05** with `starts_at = provisioning time + 1 day` (`scripts/staging/provision-test-accounts.mjs`). By the audit date (2026-10-12) that assignment had **already started**, so the account was legitimately active. This is fixture drift, not an authorization defect: the application correctly granted an effective assignment. To confirm, run this read-only query on staging (not run here — hosted access was out of scope):
`select p.email, ura.starts_at, now() from user_role_assignments ura join profiles p on p.id = ura.profile_id where p.email like 'future.assignment%';` — `starts_at` will be in the past.

**Fix applied:** the provisioning tool now uses `+3650 days` for the future-dated state, and a test fails if it is ever changed back to a short offset. The existing staging account needs a **fixture refresh under a separate authorization** (update `starts_at` to a far-future date); this task did not change staging accounts.

## 2. One capability table

`lib/auth/role-capabilities.ts` is the single definition for: exact role label, dashboard kind, rostered (personal Duty / Leave / OT / Timesheet), Bay Board mode and the report forms a role may create. Navigation (`lib/dashboard/nav-capabilities.ts`), the dashboard resolver (`/avsec/my-dashboard`), the landing path, the attendance guards, the Bay Board page and actions and the report-submit actions all read it. A role with no entry has no capability (fail closed). There is no default role anywhere.

### Final capability / navigation matrix (generated from the code)

| Role | Dashboard | Rostered (Duty / Leave / OT / Timesheet) | Bay Board | Report forms it may create | Navigation destinations |
|---|---|---|---|---|---|
| AirAsia Management | executive | no | none | none | /avsec/my-dashboard, /avsec/discussions, /avsec/management/announcements |
| GHOD | executive | no | none | none | /avsec/my-dashboard, /avsec/discussions, /avsec/management/announcements |
| Global Reporting Controller | grc | no | none | none | /avsec/my-dashboard, /avsec/reports/lookup, /avsec/reports/requests, /avsec/discussions |
| Super Admin | technical portal only (/super-admin) | no | none | none | Release Readiness, technical/security administration only |
| MAA Boss | entity_boss | no | read_only_selector | none | /avsec/my-dashboard, /avsec/entity-reports, /avsec/directory, /avsec/bay-board, /avsec/discussions, /avsec/management/announcements |
| AAX Boss | entity_boss | no | read_only_selector | none | /avsec/my-dashboard, /avsec/entity-reports, /avsec/directory, /avsec/bay-board, /avsec/discussions, /avsec/management/announcements |
| MAA Admin | entity_admin | no | read_only_selector | none | /avsec/my-dashboard, /avsec/entity-reports, /avsec/directory, /avsec/admin/entity-registrations, /avsec/admin/entity-staff, /avsec/bay-board, /avsec/discussions, /avsec/management/announcements |
| AAX Admin | entity_admin | no | read_only_selector | none | /avsec/my-dashboard, /avsec/entity-reports, /avsec/directory, /avsec/admin/entity-registrations, /avsec/admin/entity-staff, /avsec/bay-board, /avsec/discussions, /avsec/management/announcements |
| Operation Manager | operation_manager | no | read_only_selector | none | /avsec/my-dashboard, /avsec/bay-board, /avsec/operation/duty-draw, /avsec/admin/attendance-monitor, /avsec/admin/absences, /avsec/duty/overtime, /avsec/admin/roster, /avsec/admin/zones, /avsec/admin/attendance-report, /avsec/reports/lookup, /icms/transactions, /avsec/discussions, /avsec/discussions/moderation |
| Main Enforcement | enforcement | no | read_only_selector | none | /avsec/my-dashboard, /avsec/enforcement/search, /avsec/reports/lookup, /avsec/enforcement/workforce, /avsec/investigation/cases, /avsec/sat/reports, /avsec/discussions |
| Compliance | compliance | no | none | none | /avsec/my-dashboard, /avsec/reports/lookup, /avsec/flights, /avsec/discussions |
| Investigation SSO | investigation | no | none | none | /avsec/my-dashboard, /avsec/investigation/cases, /avsec/reports/lookup, /avsec/enforcement/search, /avsec/sat/reports, /avsec/discussions |
| Investigation SO | investigation | no | none | none | /avsec/my-dashboard, /avsec/investigation/cases, /avsec/reports/lookup, /avsec/enforcement/search, /avsec/sat/reports, /avsec/discussions |
| Investigation ASO | investigation | no | none | none | /avsec/my-dashboard, /avsec/investigation/cases, /avsec/reports/lookup, /avsec/enforcement/search, /avsec/sat/reports, /avsec/discussions |
| SAT ASO | link_hub | yes | actions | none | /avsec/my-dashboard, /avsec/duty, /avsec/bay-board, /avsec/sat/reports, /avsec/duty/absences, /avsec/duty/overtime, /avsec/duty/timesheet, /avsec/discussions, /avsec/feedback |
| Profiling SO | link_hub | yes | actions | none | /avsec/my-dashboard, /avsec/duty, /avsec/bay-board, /avsec/profiling/workspace, /avsec/duty/absences, /avsec/duty/overtime, /avsec/duty/timesheet, /avsec/discussions, /avsec/feedback |
| Profiling ASO | link_hub | yes | actions | sec013 | /avsec/my-dashboard, /avsec/duty, /avsec/bay-board, /avsec/reports/sec013, /avsec/profiling/workspace, /avsec/duty/absences, /avsec/duty/overtime, /avsec/duty/timesheet, /avsec/discussions, /avsec/feedback |
| Hub SE | hub | yes | actions | none | /avsec/my-dashboard, /avsec/duty, /avsec/bay-board, /avsec/admin/roster, /avsec/reports/lookup, /avsec/duty/absences, /avsec/duty/overtime, /avsec/duty/timesheet, /avsec/discussions, /avsec/feedback |
| DSE | link_hub | yes | actions | none | /, /avsec/duty, /avsec/bay-board, /avsec/admin/roster, /avsec/duty/absences, /avsec/duty/overtime, /avsec/duty/timesheet, /avsec/reports/lookup, /avsec/discussions, /avsec/feedback |
| SSO | link_hub | yes | actions | none | /, /avsec/duty, /avsec/bay-board, /avsec/duty/absences, /avsec/duty/overtime, /avsec/duty/timesheet, /avsec/reports/lookup, /avsec/discussions, /avsec/feedback |
| SO | link_hub | yes | actions | none | /, /avsec/duty, /avsec/bay-board, /avsec/duty/absences, /avsec/duty/overtime, /avsec/duty/timesheet, /avsec/reports/lookup, /avsec/discussions, /avsec/feedback |
| ASO | link_hub | yes | actions | sec016, sec014, sec029, sec018, sec033, offload | /, /avsec/duty, /avsec/bay-board, /avsec/duty/absences, /avsec/duty/overtime, /avsec/duty/timesheet, /avsec/discussions, /avsec/feedback |
| CaterLink Management | caterlink | no | none | none | /icms/dashboard, /icms/transactions, /icms/incidents, /icms/admin/whitelists, /icms/admin/archive, /icms/admin/audit, /icms/reports |

Notes: `/avsec/profile` is in every menu and omitted above. Destinations are *display*; each one re-authorizes server-side (`requireRouteAccess`, `requirePhase8Role`, `requireEntityLeadership`, `requireAttendanceProfile`, secure RPCs).

### Attendance and oversight
Non-rostered roles (AirAsia Management, GHOD, Global Reporting Controller, MAA/AAX Boss and Admin, Compliance, Investigation SSO/SO/ASO) are refused on every duty page and attendance server action by `requireAttendanceProfile()` / `getAttendanceProfile()`. Operation Manager and Main Enforcement are *oversight* roles: they use the shared approval queues (leave escalation, final OT approval, attendance monitor) but have no personal duty or timesheet.

**Investigation roster evidence:** `supabase/migrations/20260930000001_phase8_operational_workflows.sql` states "Investigation is Malaysia-wide and has no station/team roster". On that evidence Duty, Leave, OT, Timesheet and Bay Board are removed for Investigation. This is recorded as a **product decision to confirm**; restoring them is a one-line change in the capability table.

## 3. MAA / AAX report separation (unchanged design, extended)
Implemented in migrations `20261101000001-5` (see `entity-report-backend-separation-plan.md`). In this task: the **stored explicit entity is authoritative** — a trusted (service_role) insert that carries `operating_entity_id` keeps it; the AK/D7 prefix only *proposes* an entity for reports that carry none, and never overrides a stored value (`derive_report_classification`, migration `20261102000001`, verified: AK703 with a stored AAX stays AAX, D7 123 with a stored MAA stays MAA, a conflicting flight with a stored entity keeps it, a conflicting flight with none stays unclassified).

## 4. Station CaterLink capability result
The database is the source of truth (`can_user_scan_caterlink`, `can_user_confirm_caterlink_receipt`, migrations `20261021000001` and `20261022000001`). Verified locally: **Scanner PEN and JHB; final receipt BKI and KCH; vendor check PEN and JHB; BTU none; KUL per its on-duty workflow** (`verify_caterlink_scan_authorization` and `verify_caterlink_receipt_authorization`, run in the final battery). BKI/KCH operators get **no** scanner and **no** CaterLink stream merely because they hold final-receipt authority: the stream and scanner links depend on `can_user_scan_caterlink` only. Stale text in `canonical-compat-migration-plan.md` ("KCH/BKI currently have none configured") is superseded by migration `20261022000001`. The "Page 4" diagram on diagrams.net is external to the repository and still needs the owner's update so both pages agree.
**Gap:** `confirm_caterlink_destination_receipt_secure` has no caller in the application UI, so the BKI/KCH receipt capability exists in the database but there is no screen to use it yet.

## 5. Migrations added in this task
| File | Purpose |
|---|---|
| `20261102000001_role_workspace_support.sql` | Explicit stored entity authority; Bay Board read path for Operation Manager and Main Enforcement; Global Reporting Controller request queue, grant/expiry history, access-and-export audit and request rejection; `request_report_access` requires an approved profile with an active assignment. |
| `20261102000002_entity_staff_maintenance.sql` | Admin staff-maintenance read path (`list_entity_staff_for_admin_secure`, `list_entity_assignment_options_secure`) and a narrow profile-guard branch. Fixes a latent defect: an entity Admin's `deactivate_assignment` / `transfer_assignment_same_entity` failed with "Not authorized to modify this profile." because the profile guard only admitted an Admin holding a pending registration for that profile. |

## 6. Decisions still needed from the owner
1. Confirm Investigation SSO/SO/ASO are not rostered (evidence above).
2. Report forms per role: a standard ASO may create SEC016, SEC014, SEC029, SEC018, SEC033 and Offload (SEC013 belongs to the Profiling unit). Narrowing by station or function needs an explicit rule.
3. Operation Manager "generic user administration": the navigation entry is removed, but `/avsec/admin/users` and its account-mutating actions remain reachable by URL because no other role currently creates accounts. Decide who replaces that function before the route is closed.
4. Main Enforcement: the legacy `/avsec/dashboard` page is no longer linked or landed on, but remains reachable by URL.
5. Investigation case linking covers reports only (flights, staff and evidence links are not implemented).
6. Compliance read-only CaterLink live movement view and Hub SE station selector are not implemented (no safe backing page exists).
7. A UI for GHOD / AirAsia Management to *request* report access (the RPC exists and now requires an active assignment).
8. Final-receipt screen for BKI/KCH (see section 4).
