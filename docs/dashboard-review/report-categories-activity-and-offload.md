# Report categories, personal/station activity, Offload retirement, and the open CaterLink / roster decisions

Branch `ui/stitch-mobile-redesign`. Staging `ddlctzbnqewubltcavkh` only; production is never contacted, `main` is untouched. This document records
what changed in this pass, what deliberately did **not** change, and what is still waiting on a process-owner or owner decision.

## 1. Existing security reports are grouped

| Category | Forms (unchanged routes, codes and submission behaviour) |
|---|---|
| Daily Reports | `AA/SEC/F/014 Rev.03` ASO Daily Report (`/avsec/reports/sec014`) · `AA/SEC/F/013 Rev.03` Daily Report Profiling (`/avsec/reports/sec013`) |
| Aircraft Reports | `AA/SEC/F/016 Rev.03` ASO Attending Flight Report · `AA/SEC/F/029 Rev.03` Aircraft Search Checklist · `AA/SEC/F/018 Rev.01` Aircraft Security Patrol and Guarding Duty Log · `AA/SEC/F/033 Rev.02` Aircraft Hold Checklist |

* One definition: `lib/avsec/reports/report-categories.ts` (pure, tested). One renderer: `components/avsec/reports/ReportCategoryGroups.tsx`, used by the
  landing page (grid) and the ASO home "New report" list (list). Layout is one column on phones and two from 420 px; touch targets are 56 px; colours are theme tokens only,
  so light, dark and device appearance follow the app.
* **Which forms a person sees is the database's decision**, not the grouping's: the caller's `report_form_assignments` through `list_my_report_forms_secure()`
  (`getAllowedReportForms()`), the same source the submit actions and the `trg_enforce_form_assignment` table triggers use. The landing page previously used a
  role constant (`requiresDailyReport`); it now uses the database list. Consequences: an ordinary ASO sees Daily Reports → SEC014 only (SEC013 is **not** shown just
  because it is a "Daily Report") and all four Aircraft forms; a Profiling ASO sees Daily Reports → SEC013 only and no Aircraft category; SO, SSO, DSE, Hub SE and
  leadership see no filing cards (they acknowledge or oversee; the empty note points to History). A category with no permitted form is not rendered.
* **History stays accessible** (`/avsec/history`) from both screens.
* **Makeup Report and Breakup Report are deferred.** No form, field, report code, table, route or clickable card exists for them; a test scans the source tree and
  migrations to keep it that way. See §7 for what the owner must provide.

## 2. Offload Information stays inside SEC016 Departure; the standalone report is retired

Owner decision: Offload Information is a section of the SEC016 Departure Attending Report.

Kept, unchanged: the SEC016 departure Offload Information section (`offload_baggage_tag_no`, `offload_remark` and the departure validation) in `Sec016Form`,
`lib/avsec/schemas/sec016.ts` and `submitSec016`.

Retired, at every boundary that was reachable:

| Boundary | Before | Now |
|---|---|---|
| Report tile / selector | no tile (it was never in the selectors) | none |
| Role table | `aso` held `offload` in `ROLE_CAPABILITIES` | removed; no role may create it |
| Server action `submitOffload` | inserted `offload_records` + `offload_items` | returns the message "Offload Information is now part of the SEC016 Departure Attending Report…" before reading input or touching the database |
| Database | `can_create_report_form('offload')` true for every ASO station; trigger `trg_enforce_form_assignment` on `offload_records` accepted it | migration `20261127000001_retire_standalone_offload_report`: `can_create_report_form('offload')` is false for everyone, `list_my_report_forms_secure()` no longer lists it, the `offload` rows of `report_form_assignments` are **revoked** (kept, `revoked_at` set). The trigger therefore refuses any standalone insert from an authenticated session |
| Old links | `/avsec/reports/offload` redirected to SEC016 | unchanged: the link lands on the SEC016 form (itself gated: unauthenticated → login, no SEC016 assignment → the person's own dashboard) |
| Old queued offline items | would have been submitted | the queued `offload` kind gets the retirement message instead of a crash |

Preserved: `offload_records`, `offload_items`, their repository index rows, attachments, PDF/Excel export code (`OffloadPdf`, `excel.ts`), enforcement search and the entity filter that
lists "Offload Records", and audit data. The migration never references those tables (the runner rejects it if it does), and the staging dry run inserts a synthetic historical record and
item, proves them byte-identical and owner-readable after the migration, and removes exactly them. Staging currently holds 0 historical offload records, so the preservation proof on
staging is the synthetic fixture plus the unchanged-fingerprint checks. The service role still bypasses the trigger (`auth.role() <> 'authenticated'`), which is how an owner-approved data correction would run.

## 3. The landing-page activity display

The old "Live activity stream" merged duty records, movements, report submissions and incidents that the officer could *see*, so it read as if the officer had done them. It is replaced by two sections.

**My Recent Activity** — only actions the signed-in officer performed, last 7 days, newest first, each with the action's own timestamp:

| Action | Source | Actor scope in the query itself |
|---|---|---|
| Checked in / checked out for duty | `duty_records` | `.eq("profile_id", userId)` |
| Submitted report | `list_my_submissions_secure` (derives the caller from `auth.uid()`; no parameter) | the RPC (own rows only; the 7-day window is applied to them in the page query) |
| Origin / checkpoint (Part B, C), delivery (D), REDQ | `part_b_c`, `caterlink_checkpoint_part_d`, `caterlink_checkpoint_redq` | `.eq("completed_by", userId)` |
| Confirmed destination receipt | `caterlink_checkpoint_hub` (the only current writer is the receipt RPC) | `.eq("completed_by", userId)` |

The user id is the authenticated user from the session, never request input. The pure builder re-checks the actor (defence in depth). Row-level security remains the authority and **no audit table is read**, so audit access is not widened. A
movement that is merely visible, station-assigned or created by somebody else never appears here. If there is no evidence the section shows "You have no recorded actions in the last 7 days." — nothing is invented.

**Station Activity** — operational records the role may read, for the officer's own station (leadership with no single station keep their existing role-scoped reads and see "all authorised stations"):
duty check-ins at the station, movements touching the station (created there, destined there, origin or destination station id), reports filed at the station, and open incidents on those movements. Another station's
records are filtered out in the query and again in the builder. Columns: Time, Activity, **Route** (the movement route: HUB / AIRCRAFT / REDQ / MAINTENANCE, never presented as a station), **Station/Location**
(shown only when the record carries a real station, otherwise "—"), Status. The heading states "Loaded at HH:MM MYT when this page opened. It does not update by itself; use Refresh." — the list is a page-render snapshot, not a stream.
Mobile shows cards, desktop a horizontally scrollable table, both on theme tokens.

## 4. Report segregation and acknowledgement: unchanged

No change to ASO submit → entity classification / access restrictions → SO/SSO acknowledgement. AK derives MAA and D7 derives AAX only when explicit classification is absent; an explicit stored entity stays authoritative; MAA/AAX
separation by stored entity and AOC is not touched; same-station/team acknowledgement and the SEC014 exception are not touched; there is no return/edit/resubmit workflow; submitted records stay immutable. The existing suites
for these rules run unchanged (see the verification section of the report).

## 5. DSE, responsibilities, and the roster / zone findings

DSE is kept as is: the application, account, role definition and permissions are unchanged. Responsibilities as understood today: DSE — assigned KUL team roster and applicable supervisory duties; Hub SE — assigned-hub roster oversight;
Operation Manager — Operation roster oversight and the Duty Geofence Zones screen; ASO/SO — follow the assigned roster and use duty check-in/out. Nothing was changed to broaden access.

**Finding A — Duty Geofence Zones: database policy is wider than the page and action gate.**
* Database (`20261020000001_canonical_operations_compatibility.sql`): `duty_zones` insert/update/delete policies use `canon_can_admin_station(station)`, which allows `operation_manager` for any station, `dse` for their own station, and `hub_se` for stations of their assigned hub. Read uses `canon_station_visible`.
* Application: `/avsec/admin/zones` and the `upsertZone` / `toggleZoneActive` actions use `requireRole(ADMIN_ROLES)` = the legacy MANAGEMENT/ADMIN ranks, i.e. Operation Manager only; the navigation entry "Duty Geofence Zones" is shown to Operation Manager only.
* Practical effect: a DSE or Hub SE cannot reach the zone screen or action, but their database policy would allow a direct data-API write to zones of their own station/hub. Not changed: broadening DSE/Hub SE zone administration is not owner-approved. Owner decision needed: either confirm DSE/Hub SE should administer zones (then add them to the page/action gate) or narrow the database policy to Operation Manager (then a forward migration).

**Finding B — leave notices are station-scoped where team scope is expected.**
* `absence_notices` policies (`absence_notices_select_elevated`, `absence_notices_dse_management_update`) admit any `dse` assignment at the notice's **station** (`canon_has_role_at_station`), with no team condition. A DSE of one team at a station can therefore read, approve or reject another team's leave notices at the same station. `getApprovedLeavesForRoster` filters by station only and relies on that policy.
* The roster cell write path is correct: `upsert_roster_cell_secure` / `clear_roster_cell_secure` call `can_manage_roster_secure(station, team)`, which requires the DSE's own team (`has_role_in_scope(... v_team_id)`), `list_roster_officers_secure` filters per team, and `team_rosters` reads are team-scoped (`can_manage_roster_secure` / `canon_team_visible`). Only the leave-notice policies are station-only.
* Not changed (owner decision: should leave approval be team-scoped for DSE?).

**Finding C — Hub SE has roster authority in the database but not in the roster actions.** `can_manage_roster_secure` allows `hub_se` for stations of the assigned hub, while `upsertRosterCell`, `clearRosterCell` and `setTeamScheduleRange` call `requireRole([...ADMIN_ROLES, "DSE"])`, which does not list Hub SE. Not changed; same owner decision as A.

## 6. CaterLink: what works, what is not complete

Working and preserved (not changed here): OUTBOUND **HUB** movement — creation by the Driver, Part B at the origin (PEN/JHB) with seals and automatic escalation, destination receipt (KCH/BKI and every capable destination), the final-receipt PDF job for every completed receipt, listing and signed download; the separate **Vendor** Parts A/B/C delivery workflow; escalation; station/party isolation (least-privilege read, `20261119000001`). Routes whose next step has no recording workflow are shown **disabled with an explanation** on the creation form (`lib/icms/route-readiness.ts`: "Part X has no recording workflow yet — this movement cannot be completed. Awaiting the CaterLink process owner's design.").

**Not complete — do not describe full CaterLink route coverage as delivered:**

| Item | Current state | Missing process-owner decisions |
|---|---|---|
| Movement **Part C** (Airport Security Post / Post 6) | page is an honest "not available" stub; no write RPC | responsible role and station (origin, destination or a separate airport post), fields and checks, signatures, sequence relative to B/D, escalation, completion rule |
| Movement **Part D** (delivery to SRA warehouse or aircraft) | stub; table `caterlink_checkpoint_part_d` exists, no write RPC | receiver role and station, fields (seal intact, aircraft identifier), signatures, whether it can be skipped and by whom, completion rule |
| **REDQ** re-seal | stub; table `caterlink_checkpoint_redq` exists, no write RPC | who reseals, where, old/new seal rules, signatures, sequence (A→B→REDQ→C→D), escalation |
| **Inbound** (A→C→B) | route disabled on the creation form | entry station and role at each step, direction-specific fields, completion rule |
| **Aircraft** route (A→B→C→D) | disabled (needs C and D) | as Part C and Part D |
| **Maintenance** (A→B→C) | disabled (needs C) | as Part C; who closes a maintenance movement |
| Incident raise / skip Part D | fail-closed since `20261108000001`; no actor matrix | who may raise an incident from which step, severity, photos, notification, who may skip Part D and why |

Until these are answered nothing is activated or invented. Passing HUB and Vendor tests does not mean the other routes work. The earlier `caterlink-workflow-gap-audit.md` and `part-c-owner-questions.md` hold the detailed question list; the table above is the current summary.

## 7. Deferred: Makeup Report and Breakup Report

To be added from owner-provided templates. Needed before any work: the template documents, report codes and revisions, who files and who acknowledges (roles, stations, teams), fields and validation, attachments, entity classification (MAA/AAX) and access rules, numbering format, PDF/Excel layout, retention, and whether either belongs in a category (Daily or Aircraft) or needs its own. Nothing is created now: no form, field, code, table, route or placeholder card.

## 8. UAT scenarios added (S254–S265)

| ID | Scenario | Expected |
|---|---|---|
| S254 | ASO opens the landing page | Daily Reports (SEC014) and Aircraft Reports (SEC016, 029, 018, 033) are shown; SEC013 is absent; History link present |
| S255 | Profiling ASO opens the landing page | Only Daily Reports → SEC013; no Aircraft category |
| S256 | SO / SSO / DSE / Hub SE open the landing or role page | No report filing cards; History reachable |
| S257 | ASO home "New report" list | Same grouping as the landing page |
| S258 | Phone width, light, dark and device appearance | Cards readable, 44 px+ targets, no horizontal scroll, theme colours |
| S259 | Open `/avsec/reports/offload` | Lands on SEC016 (or login / own dashboard if not permitted); no standalone Offload form exists |
| S260 | ASO files SEC016 Departure with Offload Information | Section, fields and validation work; the report submits |
| S261 | ASO checks in, files SEC014 and records a CaterLink action | My Recent Activity lists exactly those, with their own times |
| S262 | Another officer at the same station acts | The other officer's actions are in Station Activity only, never in my list |
| S263 | PEN officer's Station Activity | Only PEN records; route shows HUB/AIRCRAFT as "Route"; station shown only when the record has one; "Loaded at … Refresh" wording |
| S264 | Leadership landing / dashboards | Existing scope rules unchanged; no personal list invented |
| S265 | MAA/AAX segregation and SO acknowledgement | Unchanged: classification at submission, acknowledgement separate |
