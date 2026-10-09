# MAA/AAX Backend Report Separation Plan

Status: owner planning requirement. Do not implement until all role/dashboard requirements are collected and approved together.

Source notes: `C:\Users\eswaranp\Desktop\change vecta.txt` and the AAX Admin/Boss review.

## Authoritative business rule

- MAA and AAX personnel may appear together in an authorized Malaysia AOC staff directory and workforce overview.
- Operational reports are separated by operating entity.
- An AAX-classified report is visible to the AAX Boss and AAX Admin, subject to their finalized permissions. It is not visible to MAA Boss/Admin merely because they are in the same AOC.
- An MAA-classified report is visible to the MAA Boss and MAA Admin, subject to their finalized permissions. It is not visible to AAX Boss/Admin merely because they are in the same AOC.
- Access is derived from the caller's active role assignment and the report's trusted stored operating-entity classification.
- Client navigation, email address, profile label, station, or flight prefix must never be the sole authorization decision.

## Classification inputs

- `AK` flight prefix indicates MAA.
- `D7` flight prefix indicates AAX.
- Relevant aircraft-attendance, aircraft-search, and other flight-based report forms should automatically preselect the matching entity.
- The UI must show the detected entity and require correction/confirmation when detection is uncertain.
- The server must normalize the flight number and validate the selected entity before submission.
- The saved report must carry a trusted operating-entity identifier/code used by every secure list, search, detail, export, PDF, attachment, notification, and dashboard query.

## Exceptions that must fail safely

- Missing flight number.
- Malformed flight number.
- Flight number not beginning with AK or D7.
- Codeshare flight.
- A flight prefix that conflicts with trusted assignment/report context.
- Legacy report with no entity classification.

No exception may silently default to MAA or AAX. The form must request a valid choice or the report must enter a controlled unclassified-review queue. Unclassified reports must not appear in either entity leadership list until resolved by an authorized workflow.

## Backend access matrix

| Function | MAA Boss | MAA Admin | AAX Boss | AAX Admin |
|---|---:|---:|---:|---:|
| List/search MAA reports | Yes | Yes | No | No |
| Open completed MAA report | Yes | Yes | No | No |
| List/search AAX reports | No | No | Yes | Yes |
| Open completed AAX report | No | No | Yes | Yes |
| Malaysia-wide staff directory | Yes, if approved | Yes, if approved | Yes, if approved | Yes, if approved |
| Malaysia-wide workforce summary | Yes, oversight | Administrative summary only | Yes, oversight | Administrative summary only |
| Modify submitted report content | No | No | No | No |
| Reclassify a report | Separate audited authority required | Separate audited authority required | Separate audited authority required | Separate audited authority required |

## Secure report functions required

All report surfaces must use the same backend authorization decision:

1. Dashboard report counts by supported report type.
2. Paginated report list.
3. Search by normalized flight number.
4. Search by aircraft registration number.
5. Search by submitted/report date range.
6. Secure completed-report detail.
7. Attachment listing and signed-download authorization.
8. PDF authorization.
9. Export authorization, if later approved.
10. Notifications routed to the correct entity leadership.

No dashboard or application page may perform an authorized-ID lookup followed by a separate direct table read. Authorization and content retrieval must remain atomic in the secure RPC layer.

## Notification routing

- AAX report event recipients: AAX Boss and AAX Admin only, plus any separately defined operational recipient.
- MAA report event recipients: MAA Boss and MAA Admin only, plus any separately defined operational recipient.
- Do not notify the opposite entity's Boss/Admin.
- Deduplicate recipients when a person holds multiple qualifying assignments.
- Do not expose report content in notification payloads; include only safe identifiers and route through the authorized detail page.
- Revoked, expired, future, pending, rejected, or deactivated assignments receive nothing.

## Dashboard/report-search design

Both MAA and AAX leadership workspaces should include:

- Separate counts for each report type.
- One clear Reports button, separate from the Staff Directory button.
- Aircraft-registration search.
- Flight-number search.
- From/to date filtering.
- Completed-report status filter.
- Paginated results.
- Secure report-detail opening.
- Empty, loading, unauthorized, and error states.

The Staff Directory remains a staff function. It should not silently open the report page. Use separate Staff Directory and Reports cards/buttons.

## MAA/AAX dashboard symmetry

- MAA Boss mirrors AAX Boss, but report access is MAA-only.
- MAA Admin mirrors AAX Admin, but registration administration and report access are MAA-only.
- Combined MAA+AAX staff/workforce visibility does not imply combined report visibility.
- Neither Admin/Boss workspace shows Duty Terminal, check-in, or check-out.
- Remove duplicated Operation Dashboard navigation where My Dashboard provides the same leadership workspace.
- Bay Board should support hub and station selection, subject to a safe query design that does not infer report entity from station.

## Privacy-sensitive discussion requirement

MAA/AAX Boss access to an anonymous sender's identity is not ordinary report access. If approved, it requires a separate audited RPC with:

- explicit eligible role;
- required reason;
- event timestamp and actor audit;
- exact discussion/message identifier;
- no bulk identity export;
- no identity shown by default;
- policy decision on whether the affected sender is notified.

## Migration and rollout plan

1. Inventory all report creation, indexing, search, detail, attachment, PDF, export, and notification paths.
2. Define one canonical entity-classification function, including AK/D7 normalization and exception handling.
3. Add a forward-only migration for any missing entity constraints/indexes and secure role branches.
4. Backfill only after a reviewed dry-run identifies every legacy/unclassified report; never guess from station.
5. Add MAA/AAX Admin access to their own entity reports without granting boss or cross-entity authority.
6. Update secure list/search/detail functions and database types.
7. Update report forms to show and validate automatic AK/D7 selection.
8. Update notification routing.
9. Update role dashboards/navigation and remove irrelevant duty features.
10. Test the complete positive and negative access matrix on a disposable database, staging, desktop, and mobile.

## Required tests

- AK report is visible to MAA Boss/Admin and denied to AAX Boss/Admin.
- D7 report is visible to AAX Boss/Admin and denied to MAA Boss/Admin.
- Direct URL and RPC calls cannot bypass the UI restriction.
- Registration number, flight number, and date filters cannot leak cross-entity rows.
- Report details, attachments, PDFs, exports, and notifications follow the same entity rule.
- Role revocation, expiry, future start, pending/rejected/deactivated profile all fail closed.
- Codeshare/unknown prefix never silently routes to the wrong entity.
- Combined staff directory does not broaden report access.
- No Duty Terminal/check-in/out appears for MAA/AAX Boss/Admin.

## Deferred decisions

- Exact non-AK/D7 and codeshare workflow.
- Who may resolve or change an unclassified/misclassified report.
- Whether MAA/AAX Admin may export report data or only view/search it.
- Whether combined personnel directory includes contact details or only operational identity/scope fields.
- Whether Boss workforce drill-down includes individual attendance details or totals only.


---

# IMPLEMENTED — report-routing matrix, classification and test evidence

## Report-routing matrix (as built; verified by `supabase/tests/integration/verify_entity_report_separation.mjs`)
| Viewer | MAA report (AK) | AAX report (D7) | Unclassified / conflicting | Other AOC |
|---|---|---|---|---|
| MAA Boss / MAA Admin | open, search, count | denied (indistinguishable from missing) | denied | denied |
| AAX Boss / AAX Admin | denied | open, search, count | denied | denied |
| GHOD | only while flagged (existing rule) | only while flagged | only while flagged | n/a |
| Foreign-AOC Boss | denied | denied | denied | own AOC only |
| Pending / rejected / deactivated / revoked / expired / future leader | denied | denied | denied | denied |
Admin differences: MAA/AAX Admin read their own entity's reports but cannot export reports (`export_reports_secure` refuses an admin-only caller) and have no boss authority.

## AK/D7 classification matrix (database and `lib/avsec/flight-classification.ts` agree)
| Input | Result |
|---|---|
| `AK703`, `ak 703`, `AK-703` | classified MAA |
| `D7 123`, `d7123`, `D7123A` | classified AAX |
| `AK703/D7123`, `AK703 D7123`, `AK703 or D7123` | conflict -> unclassified, review queue |
| `XX123` | unknown prefix -> unclassified, review queue |
| empty / null | missing -> unclassified |
| `FLIGHT` | malformed -> unclassified |
The trusted classification is derived on the server from the stored flight value; the form badge is display only. A flight-prefix override is accepted only when the submitter holds exactly one active assignment and the entity is in the submitter's own AOC.

## Secure functions built
`get_report_by_source_secure`, `authorize_report_pdf_by_source_secure`, `search_reports_filtered_secure`, `get_entity_report_counts_secure`, `can_read_report_attachment`, `entity_report_recipients`. Lists and search return summary fields only; detail, PDF and attachment re-authorize; pages never read `central_reports_index` or a source table.

## Notifications
A report indexed for MAA notifies only eligible MAA Boss/Admin (AAX likewise): approved profile, active in-window assignment, one row per person per report (`dedup_key`), no self-notification, payload = identifiers only. Opening goes through the secure report route. The bell now also reads `user_notifications`.

## Test evidence (local only)
Native PostgreSQL: `verify_entity_report_separation.mjs` (classification, access matrix incl. six negative states and a synthetic foreign-AOC leader, direct-table closure, source RPCs, search leak checks, attachment predicate, export, notifications, counts, registrations, directory/workforce/Bay Board, identity reveal, GHOD flagged link, directory export). App tests: `tests/nav-capabilities.test.mts`, `tests/entity-leadership.test.mts`, `tests/entity-leadership-ui.test.mts`, and the updated closure tests.
