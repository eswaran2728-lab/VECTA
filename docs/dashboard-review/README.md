# Dashboard Review Checklist — Per Role

This is the review checklist for the next phase's consolidated dashboard
adjustment, driven by staging test accounts created by
`scripts/staging/provision-test-accounts.mjs`. No review against this
checklist has been performed yet — this document is the checklist itself,
not a report of results.

## Before you start

- Open each role in a **separate browser profile or private/incognito
  window** — never two roles in the same browser profile at once. Session
  cookies are per-browser-profile, not per-tab; mixing roles in one
  profile risks reviewing the wrong role's actual access.
- **Sign out explicitly** (use the app's sign-out action, not just closing
  the tab) before switching to the next role's window, even in a private
  window — some session state can otherwise persist until the private
  window itself is fully closed.
- Credentials come from the operator-approved credentials file written by
  the provisioning script (path printed at the end of that script's run;
  never this document, never chat). Look up the row for the role you're
  reviewing by its `label` field.
- Screenshot naming convention: `<role-label>_<route-slug>_<viewport>_<state>.png`,
  e.g. `maa_boss_dashboard_desktop_loaded.png`,
  `aso-kul_duty-checkin_mobile_empty.png`.

## Per-role checklist (fill in during review — not pre-filled here)

For **every** role below, record:

| Field | What to capture |
|---|---|
| Login email reference | the `label` from the credentials file (never the email itself in any committed document) |
| Expected landing route | per `lib/avsec/auth.ts:landingPathForRole` / the role's own dashboard route |
| Profile fields | name, status, station/team/ops_group as shown in-app |
| Dashboard cards | which cards/modules actually render |
| Navigation modules | which nav entries are visible |
| Permitted actions | which write actions the UI offers |
| Prohibited actions | which actions must NOT be offered (cross-check against docs/phase13/ownership-matrix.md) |
| Direct URLs that must be denied | try navigating directly to a route this role shouldn't reach; must redirect/403, not render |
| Desktop checks | layout at desktop width |
| Mobile checks | layout at mobile width (see `resize_window` / the app's own responsive breakpoints) |
| Empty/loading/error states | trigger each deliberately where possible |
| Accessibility checks | keyboard navigation, focus visibility, contrast, screen-reader labels |
| Result | Pass / Change Required / **Security Defect** (escalate immediately, do not just note it) |

## Roles to review

### Global/technical
- `airasia_management` — executive read-only; verify NO write action anywhere, including no acknowledgement-report access (per Phase 11's confirmed privacy matrix).
- `ghod` — Global announcement authority; verify Malaysia AOC announcement creation is correctly ABSENT.
- `global_reporting_controller` — report/audit export ownership; verify no operational-workflow write access.
- `super_admin` — platform/technical only; verify NO automatic operational-data access (per the confirmed ownership matrix) and that `/super-admin/readiness` renders correctly.

### Operating-entity leadership
- `maa_boss`, `maa_admin` — MAA-scoped; verify AAX-scoped data is absent everywhere, and `maa_admin` can reach `/avsec/admin/entity-registrations` with only MAA requests listed.
- `aax_boss`, `aax_admin` — AAX-scoped; mirror of the above with AAX/MAA swapped.

### Department leadership
- `operation_manager`, `main_enforcement`, `compliance`, `caterlink_management` — each department-scoped; verify cross-department data is absent and export ownership matches `ownership-matrix.md` exactly.

### Investigation
- `investigation_sso`, `investigation_so`, `investigation_aso` — Malaysia-wide within Investigation unit; verify no station/hub-specific scoping leaks in.

### Special Action Team
- `sat_aso` (KUL-only by construction) — verify a non-KUL station is never selectable/visible.

### Profiling
- `profiling_so`, `profiling_aso` — verify scoping matches the assigned station/hub only.

### Operation hierarchy
- `hub_se` — hub-wide, never station-specific; verify no single-station drill-down implies exclusive station ownership.
- `dse` (KUL-only) — verify non-KUL is denied.
- `sso`, `so`, `aso` — station/team-scoped; review the KUL, PEN, JHB, and no-CaterLink-station variants (`-kul`/`-pen`/`-jhb`/`-no-caterlink` labels) separately, and confirm CaterLink-related UI is correctly absent for the no-CaterLink-station variant.

### Negative-state accounts (expected to FAIL, not succeed)
- `neg-pending`, `neg-rejected`, `neg-deactivated`, `neg-revoked`, `neg-expired`, `neg-future`, `neg-foreign-aoc` — for every one of these, the expected "Result" is that sign-in is denied or the account lands on a pending/denied page, NEVER a working dashboard. Record a **Security Defect** immediately if any of these can reach normal operational content.

## Fixture status

Synthetic UAT data (`scripts/staging/seed-uat-fixtures.mjs`) is **not yet
seeded** — see that script's own output for exactly which domains are
implemented vs. explicitly deferred this round. Reviewing an empty
dashboard is a valid first pass (confirms the role/scope gate itself
works) but is not sufficient for a full visual review; re-run the
checklist after fixtures are completed and seeded.
