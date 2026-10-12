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

### Final canonical capability / navigation matrix (generated from the code; baseline = no scanner and no receipt capability)

| Role | Dashboard | Rostered (Duty / Leave / OT / Timesheet) | Bay Board | Report forms it may create | Navigation destinations |
|---|---|---|---|---|---|
| AirAsia Management | executive | no | none | none | /avsec/my-dashboard, /avsec/reports/request-access, /avsec/discussions, /avsec/management/announcements |
| GHOD | executive | no | none | none | /avsec/my-dashboard, /avsec/reports/request-access, /avsec/discussions, /avsec/management/announcements |
| Global Reporting Controller | grc | no | none | none | /avsec/my-dashboard, /avsec/reports/lookup, /avsec/reports/requests, /avsec/discussions |
| Super Admin | technical portal only (/super-admin) | no | none | none | Release Readiness, technical/security administration only |
| MAA Boss | entity_boss | no | read_only_selector | none | /avsec/my-dashboard, /avsec/entity-reports, /avsec/directory, /avsec/bay-board, /avsec/discussions, /avsec/management/announcements |
| AAX Boss | entity_boss | no | read_only_selector | none | /avsec/my-dashboard, /avsec/entity-reports, /avsec/directory, /avsec/bay-board, /avsec/discussions, /avsec/management/announcements |
| MAA Admin | entity_admin | no | read_only_selector | none | /avsec/my-dashboard, /avsec/entity-reports, /avsec/directory, /avsec/admin/entity-registrations, /avsec/admin/entity-staff, /avsec/bay-board, /avsec/discussions, /avsec/management/announcements |
| AAX Admin | entity_admin | no | read_only_selector | none | /avsec/my-dashboard, /avsec/entity-reports, /avsec/directory, /avsec/admin/entity-registrations, /avsec/admin/entity-staff, /avsec/bay-board, /avsec/discussions, /avsec/management/announcements |
| Operation Manager | operation_manager | no | read_only_selector | none | /avsec/my-dashboard, /avsec/bay-board, /avsec/operation/duty-draw, /avsec/admin/attendance-monitor, /avsec/admin/absences, /avsec/duty/overtime, /avsec/admin/roster, /avsec/admin/zones, /avsec/admin/attendance-report, /avsec/reports/lookup, /avsec/operation/staff, /avsec/caterlink/movements, /avsec/discussions, /avsec/discussions/moderation |
| Main Enforcement | enforcement | no | read_only_selector | none | /avsec/my-dashboard, /avsec/enforcement/search, /avsec/reports/lookup, /avsec/enforcement/workforce, /avsec/investigation/cases, /avsec/sat/reports, /avsec/discussions |
| Compliance | compliance | no | none | none | /avsec/my-dashboard, /avsec/reports/lookup, /avsec/flights, /avsec/caterlink/movements, /avsec/discussions |
| Investigation SSO | investigation | no | none | none | /avsec/my-dashboard, /avsec/investigation/cases, /avsec/reports/lookup, /avsec/enforcement/search, /avsec/sat/reports, /avsec/discussions |
| Investigation SO | investigation | no | none | none | /avsec/my-dashboard, /avsec/investigation/cases, /avsec/reports/lookup, /avsec/enforcement/search, /avsec/sat/reports, /avsec/discussions |
| Investigation ASO | investigation | no | none | none | /avsec/my-dashboard, /avsec/investigation/cases, /avsec/reports/lookup, /avsec/enforcement/search, /avsec/sat/reports, /avsec/discussions |
| SAT ASO | link_hub | yes | actions | none | /avsec/my-dashboard, /avsec/duty, /avsec/bay-board, /avsec/sat/reports, /avsec/duty/absences, /avsec/duty/overtime, /avsec/duty/timesheet, /avsec/discussions, /avsec/feedback |
| Profiling SO | link_hub | yes | actions | none | /avsec/my-dashboard, /avsec/duty, /avsec/bay-board, /avsec/profiling/workspace, /avsec/duty/absences, /avsec/duty/overtime, /avsec/duty/timesheet, /avsec/discussions, /avsec/feedback |
| Profiling ASO | link_hub | yes | actions | sec013 | /avsec/my-dashboard, /avsec/duty, /avsec/bay-board, /avsec/reports/sec013, /avsec/profiling/workspace, /avsec/duty/absences, /avsec/duty/overtime, /avsec/duty/timesheet, /avsec/discussions, /avsec/feedback |
| Hub SE | hub | yes | actions | none | /avsec/my-dashboard, /avsec/hub, /avsec/duty, /avsec/bay-board, /avsec/admin/roster, /avsec/reports/lookup, /avsec/duty/absences, /avsec/duty/overtime, /avsec/duty/timesheet, /avsec/discussions, /avsec/feedback |
| DSE | link_hub | yes | actions | none | /, /avsec/duty, /avsec/bay-board, /avsec/admin/roster, /avsec/duty/absences, /avsec/duty/overtime, /avsec/duty/timesheet, /avsec/reports/lookup, /avsec/discussions, /avsec/feedback |
| SSO | link_hub | yes | actions | none | /, /avsec/duty, /avsec/bay-board, /avsec/duty/absences, /avsec/duty/overtime, /avsec/duty/timesheet, /avsec/reports/lookup, /avsec/discussions, /avsec/feedback |
| SO | link_hub | yes | actions | none | /, /avsec/duty, /avsec/bay-board, /avsec/duty/absences, /avsec/duty/overtime, /avsec/duty/timesheet, /avsec/reports/lookup, /avsec/discussions, /avsec/feedback |
| ASO | link_hub | yes | actions | sec016, sec014, sec029, sec018, sec033, offload | /, /avsec/duty, /avsec/bay-board, /avsec/duty/absences, /avsec/duty/overtime, /avsec/duty/timesheet, /avsec/discussions, /avsec/feedback |
| CaterLink Management | caterlink | no | none | none | /icms/dashboard, /icms/transactions, /icms/incidents, /icms/admin/whitelists, /icms/admin/archive, /icms/admin/audit, /icms/reports |

Notes: `/avsec/profile` is in every menu and omitted above. Capability-dependent extras: an ASO/SO/SSO at a scanner station (PEN, JHB) also gets `/avsec/scan` and `/icms/transactions`; at a final-receipt station (BKI, KCH) the link `/avsec/caterlink/receipt` instead (never both); a station with neither (BTU) gets no CaterLink link. The report forms a role may create are DATA (`report_form_assignments`), shown in the column as the seeded default. 'Dashboard' = which dashboard component `/avsec/my-dashboard` renders. Destinations are *display*; each one re-authorizes server-side (`requireRouteAccess`, `requirePhase8Role`, `requireEntityLeadership`, `requireAttendanceProfile`, secure RPCs).

### Attendance and oversight
Non-rostered roles (AirAsia Management, GHOD, Global Reporting Controller, MAA/AAX Boss and Admin, Compliance, Investigation SSO/SO/ASO) are refused on every duty page and attendance server action by `requireAttendanceProfile()` / `getAttendanceProfile()`. Operation Manager and Main Enforcement are *oversight* roles: they use the shared approval queues (leave escalation, final OT approval, attendance monitor) but have no personal duty or timesheet.

**Investigation roster evidence:** `supabase/migrations/20260930000001_phase8_operational_workflows.sql` states "Investigation is Malaysia-wide and has no station/team roster". On that evidence Duty, Leave, OT, Timesheet and Bay Board are removed for Investigation. **Owner decision (applied): Investigation staff are NON-ROSTERED.** It is enforced in the capability table, the dashboard resolver, navigation, the route guards (`requireAttendanceProfile`), the server actions and the database (a trigger refuses duty, leave, overtime and handover writes from a caller whose every role is non-rostered).

## 3. MAA / AAX report separation (unchanged design, extended)
Implemented in migrations `20261101000001-5` (see `entity-report-backend-separation-plan.md`). In this task: the **stored explicit entity is authoritative** — a trusted (service_role) insert that carries `operating_entity_id` keeps it; the AK/D7 prefix only *proposes* an entity for reports that carry none, and never overrides a stored value (`derive_report_classification`, migration `20261102000001`, verified: AK703 with a stored AAX stays AAX, D7 123 with a stored MAA stays MAA, a conflicting flight with a stored entity keeps it, a conflicting flight with none stays unclassified).

## 4. Station CaterLink capability result
The database is the source of truth (`can_user_scan_caterlink`, `can_user_confirm_caterlink_receipt`, migrations `20261021000001` and `20261022000001`). Verified locally: **Scanner PEN and JHB; final receipt BKI and KCH; vendor check PEN and JHB; BTU none; KUL per its on-duty workflow** (`verify_caterlink_scan_authorization` and `verify_caterlink_receipt_authorization`, run in the final battery). BKI/KCH operators get **no** scanner and **no** CaterLink stream merely because they hold final-receipt authority: the stream and scanner links depend on `can_user_scan_caterlink` only. Stale text in `canonical-compat-migration-plan.md` ("KCH/BKI currently have none configured") is superseded by migration `20261022000001`. The "Page 4" diagram on diagrams.net is external to the repository and still needs the owner's update so both pages agree.
**Gap:** `confirm_caterlink_destination_receipt_secure` has no caller in the application UI, so the BKI/KCH receipt capability exists in the database but there is no screen to use it yet.

## 5. Migrations added in this task
| File | Purpose |
|---|---|
| `20261102000001_role_workspace_support.sql` | Explicit stored entity authority; Bay Board read path for Operation Manager and Main Enforcement; Global Reporting Controller request queue, grant/expiry history, access-and-export audit and request rejection; `request_report_access` requires an approved profile with an active assignment. |
| `20261103000001_role_workspace_completion.sql` | Investigation non-rostered (database layer); report-form assignments + trigger; Operation Manager staff search; Investigation links / evidence / timeline / closure / audit and the private evidence bucket; BKI/KCH receipt list; read-only CaterLink movements; Hub SE selector and overview; GHOD / AirAsia report-request search and my-requests; stricter `request_report_access`. |
| `20261102000002_entity_staff_maintenance.sql` | Admin staff-maintenance read path (`list_entity_staff_for_admin_secure`, `list_entity_assignment_options_secure`) and a narrow profile-guard branch. Fixes a latent defect: an entity Admin's `deactivate_assignment` / `transfer_assignment_same_entity` failed with "Not authorized to modify this profile." because the profile guard only admitted an Admin holding a pending registration for that profile. |

## 6. Owner decisions applied in the completion pass
| # | Decision | Where it is enforced |
|---|---|---|
| 1 | Investigation SSO/SO/ASO are non-rostered: no Duty, Check-In/Out, leave, OT, timesheet, Bay Board, roster | capability table; nav; dashboard config; `requireAttendanceProfile`; `enforce_rostered_actor` triggers on `duty_records`, `absence_notices`, `overtime_requests`, `shift_handovers` |
| 2 | Report forms follow the assigned function | `report_form_assignments` + `can_create_report_form()` + `list_my_report_forms_secure()` + a `BEFORE INSERT` trigger on all seven report tables; pages use `requireReportFormAccess`; submit actions use `mayCreateReportForm` |
| 3 | Operation Manager does not administer users | `USER_ADMIN_ROLES = []` on `/avsec/admin/users` and all seven account actions; read-only `/avsec/operation/staff` (`search_operation_staff_secure`); no user-admin RPC admits the role |
| 4 | Main Enforcement: dedicated workspace only | edge allowlist `MAIN_ENFORCEMENT_ALLOWED_AVSEC_PREFIXES` (deny by default) for a caller whose only role is `main_enforcement`; four attendance/exports APIs return 403; landing is `/avsec/my-dashboard` |
| 5 | Investigation case links | flight, staff and evidence links; timeline; closure; audit history (migration `20261103000001`) |
| 6 | Four workflows | Compliance read-only CaterLink view; Hub SE selector; GHOD / AirAsia request interface; BKI / KCH final receipt |
| 7 | Future-assignment fixture | `scripts/staging/refresh-future-assignment-fixture.mjs` (dry-run by default, staging-only, one account, one column) — **not executed** |

### Report-form mapping (the seeded defaults; narrow by revoking an individual station/form row)
| Role | Forms |
|---|---|
| Standard ASO | SEC016, SEC014, SEC029, SEC018, SEC033, Offload — **one explicit row per active station and form** (no all-station row); each pair can be revoked individually, and a station added later gets no form until one is assigned |
| Profiling ASO | SEC013 only |
| Profiling SO | none (acknowledgement queue only) |
| SAT ASO | none (final combined-PDF workflow, not the ordinary forms) |
| SO, SSO, DSE, Hub SE, Operation Manager, Main Enforcement, Compliance, Investigation, executives, GRC, Boss, Admin | none |

### Investigation cases (migration `20261103000001`)
- Links: reports (existing, `has_report_access` re-checked), flights (normalised; a codeshare/conflict is refused) and staff (by staff number, approved profiles). Idempotent per case.
- Evidence: authorize (`prepare_case_evidence_secure`) → server uploads with the service role into the **private** `investigation-evidence` bucket (no client INSERT policy) → register (`register_case_evidence_secure`, path must start with the case id). Rows are append-only. Download = `authorize_case_evidence_download_secure` (audited) then a 60-second signed URL. The bucket SELECT policy (`can_read_case_evidence`) allows only investigators and only registered paths.
- Status: open → resolved → **closed** (`close_investigation_case_secure`, Investigation SSO or Main Enforcement, reason required) → reopened. A closed case rejects new notes, report links, flight/staff links and evidence until reopened. Source reports are never modified by linking (they stay immutable under the existing triggers).
- Timeline (`get_investigation_case_timeline_secure`): opened, notes, report/flight/staff links, evidence, resolved, closed, reopened, assigned. Audit history (`list_investigation_case_audit_secure`) lists every audited action including evidence access.

### The four workflows
- **Compliance CaterLink view** — `/avsec/caterlink/movements`: list only. The RPC omits driver identity, QR token and seal; the page has no button or form.
- **Hub SE** — `/avsec/hub`: stations of the assigned hub only (`caller_hub_se_hub`); a station outside the hub is refused; scanner / receipt flags come from the station capability functions and are off for a Hub SE (no station assignment).
- **GHOD / AirAsia Management** — `/avsec/reports/request-access`: search returns metadata stubs only (type, entity, flight, date, status); `request_report_access` now needs GHOD or AirAsia Management, a reason of at least 10 characters, a duration of 1–90 days and at most 20 pending requests. The GRC approves (read-only, time-limited grant) or rejects (recorded reason). AirAsia Management remains aggregate-only unless its own request is approved.
- **BKI / KCH final receipt** — `/avsec/caterlink/receipt`: lists movements whose destination is the operator's station; the receiver verifies route, seal and delivery details (any unchecked item requires a discrepancy note), signs, and `confirm_caterlink_destination_receipt_secure` records receiver, station and time, audits it and notifies the sender. No scanner, no stream, no Post 2 / Post 6 repetition. PEN and JHB keep their scanner and vendor-check capabilities; BTU has no CaterLink link.
  **Final PDF:** after the receipt commits, `regenerateFinalPdfAfterReceipt` renders the completed form (now including the receipt part, read from `caterlink_checkpoint_hub`) with the service role, hashes it and records it through `record_caterlink_receipt_pdf_version` (migration `20261104000001`, service-role only, requires a COMPLETED transaction and a receipt by that receiver, idempotent by content hash). The previous version is superseded, never overwritten; if regeneration fails the receipt stays committed and the screen says the PDF is pending.
  **Destinations:** the single list is `HUB_DESTINATIONS` in `lib/icms/constants.ts` (PEN, JHB, NILAI, KCH, BKI); forms, actions and tests use it. Migration `20261027000002` widens the two database CHECK constraints. KCH and BKI are final-receipt stations only (no scanner, no stream).

### Defects fixed in the completion pass
1. Entity Admin deactivation/transfer failed on the profile guard (fixed in the previous pass; re-verified).
2. `list_caterlink_movements_readonly_secure` initially failed on an ambiguous column (found by the verifier, fixed).
3. `request_report_access` accepted any active role; it is now limited to GHOD and AirAsia Management with a specific reason.
4. The legacy `/avsec/dashboard`, duty, flights, admin pages and three operations exports were reachable by Main Enforcement; closed at the edge. The legacy dashboard family (`/avsec/dashboard`, heatmap, duty monitor) is now closed to every role except Operation Manager (`requireLegacyManagementDashboard`); all others are sent to `/avsec/my-dashboard`, which shows a notice rather than redirecting when a role has no workspace.
5. Direct server-action calls to account administration were reachable by the Operation Manager; closed.
6. Buttons and links had no global visible focus style; `:focus-visible` outline added.

## 7. Component-level responsive / accessibility preparation (local, not hosted-browser)
Static component checks (`tests/role-workspaces-completion.test.mts`) assert, for every new page and form: announced empty / error states (`role="status"` / `role="alert"`), a denied state (guard or redirect), tables inside `overflow-x-auto` with a header row, no oversized fixed width, a `<main>` landmark, 44px touch targets, labelled fields, and the global visible-focus rule; the drawer keeps `aria-modal`, Escape handling and the tablet bottom bar. **Hosted-browser certification at 390×844, 768, 834, 1024 and 1440×900 is NOT executed** and remains pending, together with role-by-role UAT.

## 8. Still pending (staging / owner)
- Hosted role-by-role UAT and browser certification (checklist in `mobile-desktop-review.md`).
- Live execution of the fixture refresh (separate explicit authorization).
- Staging application of the migrations in `staging-migration-plan.md` (separate authorization), with a dry-run and real-role probes first.
- Rotation of the staging credentials exposed in an earlier session, before wider organizational testing.
- The external "Page 4" diagram needs the owner's update so both diagram pages agree on BKI/KCH final receipt.
- A Compliance-style station filter on the movements list is not built.
