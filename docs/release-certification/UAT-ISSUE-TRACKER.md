# VECTA staging UAT issue tracker

Each row is one issue found during UAT. Status: Open, Fixed on staging (needs staff retest), Verified, Deferred.

| ID | Date | Issue | Status | Evidence / where fixed |
|----|------|-------|--------|------------------------|
| UAT-001 | 2026-11-05 | The DSE and SO could not see their team's reports in a history list: only "My Submission History" (personal) existed. | Fixed on staging (needs staff retest) | Team Submission History at `/avsec/history/team` for DSE and SO; migration `20261205000001`. |
| UAT-002 | 2026-11-05 | Eight DSE alerts failed for Charlie reports: seven AK reports were entered with typed station `KUL - AAX` by KUL - MAA / CHARLIE officers, and `KUL - AAX` has no CHARLIE team. | Fixed on staging (needs staff retest) | Alerts now use the report's canonical station and team; all eight recovered once by `recover-dse-alerts.mjs`; new reports must match the officer's assigned station and team. |
| UAT-003 | 2026-11-05 | A DSE was never alerted to a MAA-entity officer's report (alerts required the DSE to share the submitter's entity). | Fixed on staging (needs staff retest) | Entity condition removed: a DSE is one role per station and team. 25 reports submitted since 4 Nov (before the fix) did not get an alert and were NOT back-filled; decision needed. |
| UAT-004 | 2026-11-05 | Acknowledgment of a report whose typed station differed from the officer's assignment would have been refused. | Fixed on staging (needs staff retest) | `get_report_submitter` and `can_acknowledge_report` use the canonical scope; one audit record per acknowledgment. |
| UAT-005 | 2026-11-05 | Real-staff trial still needed: a Charlie DSE and SO acknowledging AK and D7 reports; an Alpha DSE/SO confirming they cannot see Charlie reports. | Open | No DSE or SO login exists on staging for the automated hosted checks. |
| UAT-006 | 2026-11-06 | A staff password-reset link opened the form without a recovery session, so submitting showed “Auth session missing”. | Fixed on staging (needs staff retest) | Commit `2c416d0`, Preview `q9su7zbjk`: reset requests use a cross-browser recovery link; the form waits for a valid session and clears URL tokens. Fresh-browser staging probe passed without changing a password. The older staff Preview `cr50d4xtl` does not include this fix. |
