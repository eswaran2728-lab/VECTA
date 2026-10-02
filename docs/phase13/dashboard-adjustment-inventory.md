# Dashboard Adjustment Inventory (for the NEXT step — not built in Phase 13)

Phase 13 explicitly does not perform the consolidated visual dashboard
redesign. This is the inventory that step needs, per role, based on this
phase's integration findings. "Required modules/cards" and "missing
states" below are the inputs that step needs to scope real design work —
they are not a design spec themselves.

| Role | Current route(s) | Intended data scope | Required modules/cards | Missing/loading/error/empty states (confirmed gaps this round) | Desktop/mobile issues (sampled) | Accessibility issues (sampled) | UAT account needed |
|---|---|---|---|---|---|---|---|
| GHOD | announcements management, dashboards | Global, all AOCs | Global announcement composer, cross-AOC executive aggregate | Not independently re-verified this round | Not re-verified | Not re-verified | One approved GHOD account with no other role |
| MAA Boss / Admin, AAX Boss / Admin | announcements management, entity/admin aggregates (Phase 7), CaterLink (if applicable) | Malaysia AOC, own entity for directory exports | Malaysia AOC announcement composer, entity directory export, CaterLink whitelist admin (for CaterLink Management specifically — note the role name overlaps but is distinct) | Phase 11's management UI (`ManagementAnnouncementsView.tsx`) already has empty/loading/error/retry states built in Phase 11/12's own work — confirmed, not a gap | Not re-verified | Not re-verified | One of each of the 4 roles |
| Operation Manager | Phase 8 operational workflows, exports | Malaysia Operation | Duty-draw status, leave/OT review queue, export button | Not re-verified | Not re-verified | Not re-verified | One account |
| Main Enforcement | enforcement/workforce, SAT/profiling/investigation pages | SAT/Profiling/Enforcement Malaysia-wide | Workforce list, attendance exceptions, pending actions (all already built per `enforcement/workforce/page.tsx`) | Not re-verified | Not re-verified | Not re-verified | One account |
| CaterLink Management | CaterLink whitelist/transaction pages | Own AOC | Whitelist lifecycle queue, transaction/incident list, export button | **The final-transaction-PDF delivery this role depends on does not exist yet** (see `storage-matrix.md`) — this is a functional gap, not a dashboard-polish item, and should be fixed before dashboard work, not alongside it | Not re-verified | Not re-verified | One account |
| AirAsia Management | dashboards, read-only announcement view | Executive, read-only | Executive aggregate cards only — confirmed this round that no write affordance should ever appear for this role (ownership matrix) | Not re-verified | Not re-verified | Not re-verified | One account |
| Super Admin | `/super-admin`, `/super-admin/readiness` (new this phase) | Platform/technical only | Org manager (existing), release-readiness view (new this phase) | The readiness page built this phase has a bare loading/error state (inline text) — not styled to the rest of the app's design system; this is a known, deliberate minimum, not a finished UI | Not re-verified | Not re-verified | One account (already assumed to exist for testing) |
| Ordinary ASO/SO/DSE | home/duty/reports | Own scope (station/team) | Unchanged by Phases 9-13 | Not re-verified | Not re-verified | Not re-verified | Existing test accounts suffice |

## Why this is deliberately incomplete

A genuine per-role visual/UX audit means opening every route in a browser
at desktop and mobile widths, with a real account of that role, and
checking states — that is explicitly the NEXT step after Phase 13, not
this one. This table exists so that step has a starting checklist instead
of starting from nothing.
