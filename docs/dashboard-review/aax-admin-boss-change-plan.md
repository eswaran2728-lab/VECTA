# AAX Admin and AAX Boss Dashboard Change Plan

Status: owner-approved planning requirement; implementation deferred until the remaining role reviews are collected.

Backend report separation is defined in `entity-report-backend-separation-plan.md`.

## Shared principles

- AAX Admin and AAX Boss are non-rostered leadership roles. Their workspaces must not show Duty Terminal, check-in, or check-out controls.
- Their navigation must contain only functions they are authorized and expected to use.
- Staff/directory oversight is Malaysia AOC-wide and may show both MAA and AAX personnel.
- Operational reports remain entity-routed: AAX reports go to AAX Boss and AAX Admin; MAA reports go to MAA Boss and MAA Admin.
- A report's entity must come from trusted classification. Flight prefix may assist form selection, but it must not be the only database authorization source.
- AAX flight prefix: D7. MAA flight prefix: AK.
- Aircraft attendance and aircraft-search forms should later use the flight prefix to preselect the entity, while server-side validation and trusted role/report classification remain authoritative.

## AAX Admin workspace

### Remove

- Duty Terminal.
- Check-in and check-out.
- Any duplicated operational dashboard.
- Any module unrelated to AAX entity administration.

### Dashboard and navigation

- Keep the profile simple.
- Show active AAX staff count.
- Show Malaysia-wide pending registration count.
- Open AAX Registration Administration.
- List only AAX registration requests.
- Approve AAX registration requests and assign role/scope.
- Reject AAX registration requests with a reason.
- Show a combined Malaysia AOC staff directory containing both MAA and AAX staff details.
- Export the AAX directory as currently authorized; any combined MAA+AAX export requires a separate authorization decision.
- Publish and manage Malaysia AOC announcements.
- View Malaysia AOC announcement acknowledgement reports.
- Show only specifically implemented AAX technical administration/configuration functions.

### Reports

- Add an AAX Reports page linked from the dashboard/directory area.
- Show every supported report type classified as AAX.
- Permit search by aircraft registration number, flight number, and date/date range.
- Permit opening completed AAX reports.
- Do not show MAA reports to AAX Admin.

### Bay Board

- Provide Bay Board visibility with a hub selector and station selector.
- Do not infer operating entity only from station; the data model/query must support the requested scope safely.

### Restrictions

- No boss-level authority merely because the user is AAX Admin.
- No Global announcement management.
- No GHOD, AAX Boss, Operation Manager, Super Admin, or AirAsia Management authority.
- No access to another AOC or another entity's operational reports.

## AAX Boss workspace

### Remove

- Remove the separate/duplicated Operation Dashboard entry when it offers the same functions as My Dashboard.
- Remove Duty Terminal, check-in, and check-out.

### Entity overview

- Keep one AAX Boss entity-overview dashboard.
- Display counts for all supported AAX report types, not a single combined unlabeled figure only.
- Provide report search by aircraft registration number, flight number, and date/date range.
- Permit opening completed AAX reports.
- Keep operational report routing entity-specific: no MAA report access through the AAX Boss assignment.

### Staffing and directory

- Show a combined Malaysia AOC staff directory with both MAA and AAX staff details.
- Show combined MAA+AAX workforce oversight where explicitly requested: active workforce, checked in, pending, and absent.
- This is oversight only; it does not automatically grant roster, attendance, leave, or overtime mutation authority.

### Bay Board

- Show Bay Board information by selectable hub and station.
- The selector must not imply entity ownership from station alone.

### Announcements and discussions

- Retain Malaysia AOC announcement creation, draft, schedule, publish, edit, pin, priority, acknowledgement, attachment, archive, and acknowledgement-report functions.
- Malaysia AOC announcements reach eligible MAA and AAX users.
- Do not grant Global announcement management.
- Discussions may be visible to eligible Malaysia AOC staff.
- AAX Boss may request identity disclosure for an anonymous message, but implementation requires a tightly audited reveal-identity workflow, a stated legitimate reason, and an explicit privacy/ownership approval. It must not silently remove anonymity or expose identities by default.

## Report classification and routing

- D7 flight number: preselect AAX.
- AK flight number: preselect MAA.
- AAX-classified reports: AAX Boss and AAX Admin recipients/readers according to their finalized permissions.
- MAA-classified reports: MAA Boss and MAA Admin recipients/readers according to their finalized permissions.
- Client-entered prefix is a convenience signal only. The server must validate and store trusted `operating_entity_id`/classification; access control must use that stored classification.
- Define behavior for missing, malformed, codeshare, non-AK/D7, or conflicting flight numbers before implementation.

## Decisions to confirm before implementation

1. Whether the combined MAA+AAX directory includes sensitive fields such as personal contact details, or only staff number, name, role, entity, station, team, and account state.
2. Whether combined workforce figures for AAX Boss are summary-only or allow person-level drill-down.
3. Whether AAX Boss anonymous-identity disclosure is authorized by policy, and what audit/reason/notification requirements apply.
4. Whether Bay Board is Malaysia-wide for both AAX Admin and AAX Boss, and whether person/report drill-down is allowed.
5. Exact treatment of codeshare and flight numbers outside AK/D7.

## Implementation order after all role reviews

1. Finalize the complete role/function matrix.
2. Update database authorization and report classification/routing.
3. Add report-search filters and completed-report access.
4. Add safe Bay Board hub/station filtering.
5. Update dashboard cards and navigation.
6. Remove duty/check-in controls from non-rostered leadership roles.
7. Add privacy-safe and audited anonymous-identity disclosure only if approved.
8. Run database, authorization, application, mobile, desktop, and role-by-role preview tests.


---

# Implementation notes (AAX and MAA are symmetric)
Everything above is implemented identically for MAA (flight prefix `AK`) and AAX (`D7`). The two entities are separate operating entities inside the Malaysia AOC: staff and workforce oversight is Malaysia-wide, but operational reports are separated by the report's stored operating-entity classification, never by station or e-mail. See `entity-report-backend-separation-plan.md` for the routing matrix and `dashboard-adjustment-implementation-plan.md` for migrations and unresolved owner decisions.
