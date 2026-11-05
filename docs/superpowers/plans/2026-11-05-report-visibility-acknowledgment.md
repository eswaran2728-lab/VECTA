# Report visibility, acknowledgment and alert scope (design and plan)

**Rule (product owner, 2026-11-05).** A DSE is one operational role for one station and team. A DSE and an SO see, and acknowledge within their authority, every submitted
security report of their OWN station and team, whatever the report's entity (AK/MAA and D7/AAX alike), and nothing of any other station or team. The MAA Boss sees MAA
reports only and the AAX Boss AAX only. Other role boundaries are unchanged. No report is duplicated or rewritten to create visibility.

## What the investigation found
- Every report already stores the submitter's CANONICAL scope (`org_station_id`, `org_team_id`, set from the active assignment by the classification trigger) and its entity
  (from the flight prefix). The secured detail path (`get_report_by_source_secure` -> `has_report_access`, via the report index) uses those, so DSE/SO detail access was already
  canonical and entity-independent; the bosses are entity-based.
- Three paths still used the station and team TYPED on the form: `get_report_submitter` (behind `can_view_report`, `can_acknowledge_report` and the acknowledgment policies),
  the DSE alert lookup (which also required the DSE to share the submitter's entity), and there was no team list at all.
- Seven SEC016 and one SEC014 from KUL - MAA / CHARLIE officers were saved with typed station `KUL - AAX`; `KUL - AAX` has no CHARLIE team, so the alert lookup raised
  (8 recorded delivery failures). Separately, the entity rule meant no Charlie DSE (AAX-entity membership) was ever alerted to a MAA submitter's report.

## Design (migration `20261205000001`)
1. `report_canonical_scope(table, id)` returns the canonical station/team (falling back to typed text only when no canonical value exists), the entity and the ids.
2. `get_report_submitter` reads it, so `can_view_report`, the acknowledgment policies and `can_acknowledge_report` use the canonical scope.
3. `can_acknowledge_report`: existing rules kept; a DSE of the exact station and team may also acknowledge reports of ASO, SO and SSO submitters in that team.
4. A trigger writes exactly one `report_acknowledged` audit record per acknowledgment (one acknowledgment per report is already a unique constraint).
5. DSE alerts: `dse_scope_recipients(station_id, team_id, submitter)` (no entity condition) and `deliver_dse_report_notifications_v2`, idempotent per report and DSE, failures
   recorded, never raised. `notify_dse_of_report` uses them.
6. `enforce_report_operational_scope` (before insert, all eight tables): a signed-in submitter's typed station and team must equal their assignment (SEC029's collapsed `KUL`
   accepted; imports and service writes untouched). History is never rewritten.
7. `list_team_submissions_secure`: reports of the caller's own DSE/SO station and team, both entities, with filters and paging; refuses anyone who is not a DSE or SO.
8. App: `/avsec/history/team` (DSE/SO only; cards on phones, table on larger screens; filters validated in `team-history-filters.ts`); `/avsec/history` stays personal.
   SSO is deliberately NOT given the team history (its existing report access is unchanged).

## Recovery of the eight failed alerts
`scripts/staging/recover-dse-alerts.mjs` (dry run by default, `--expect=8`, `--apply`): each failure is resolved only if the report is submitted, has a canonical station and team and
that team has an active DSE; delivery is idempotent. All eight were recoverable to the CHARLIE DSE and were delivered once.

## Verification
- Guarded runner `apply-report-scope-migration.mjs`: 34 probes with real identities in rolled-back transactions (Charlie and Alpha DSE and SO, both bosses, an outsider).
- Hosted: `verify-report-scope-hosted.mjs` (real sessions and pages, exact-ID cleanup). Checks needing a DSE or SO login print NOT VERIFIED when no such login exists.
