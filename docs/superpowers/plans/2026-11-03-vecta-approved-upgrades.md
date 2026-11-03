# VECTA Approved Upgrades Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the approved optional handover, leave authority, report notifications and drafts, and station weather without changing production.

**Architecture:** Four independently reviewable phases. Enforce identity, scope and atomic state transitions in the database or server actions; use the existing VECTA UI and notification patterns. Each phase receives local tests and hosted staging verification before the next.

**Tech Stack:** Next.js, TypeScript, Supabase/PostgreSQL, Node test runner, Playwright, Vercel Preview.

**Spec:** `docs/superpowers/specs/2026-11-03-vecta-handover-leave-reports-weather-design.md`

## Global Constraints

- Work in the isolated Codex copy; preserve the separate Desktop checkout and unrelated edits.
- Production Supabase `zsxneokqulktgnccxgkz` and production Vercel remain untouched.
- Staging Supabase is `ddlctzbnqewubltcavkh`; deploy only to `eswaran1/vecta-staging-preview` Preview.
- Use forward migrations, guarded backups and transactional dry runs; never edit applied migration files.
- Do not use real staff data or credentials in test fixtures or logs.
- The weather feed is a daily general forecast, not observed live aviation weather; attribute MET Malaysia/data.gov.my.

## Review Focus

- An officer with multiple active assignments must have a deterministic station and team for each scoped action; test ambiguity rejection.
- A handover QR read simultaneously by two clients must complete once; test concurrency and replay.
- A leave span across Malaysia midnight must count inclusive calendar days and preserve already taken dates; test boundary dates.
- A submitted report whose DSE notification fails must remain submitted and surface the delivery failure; test it.
- A weather request that receives 429 or malformed data must leave the workspace usable; test unavailable state.

---

### Task 1: Optional recipient-bound handover

**Files:** `lib/avsec/duty/handover-actions.ts`, `handover-queries.ts`, `lib/avsec/schemas/handover.ts`, `app/(avsec)/avsec/duty/handover/**`, `components/avsec/duty/**`, new forward migration and focused tests.

- [ ] Write failing tests for exact staff-ID lookup, self/ambiguous/cross-station rejection, and another-team same-station acceptance.
- [ ] Add a new recipient-profile link and one-time challenge/audit fields with RLS and security-function checks; preserve historical rows.
- [ ] Make outgoing identity session-derived; show resolved recipient name and send a scoped in-app alert.
- [ ] Write failing tests for recipient-only acknowledgment, both-on-duty, challenge expiry/replay, fresh GPS, <=50 m accuracy, active-zone containment, <=50 m separation and simultaneous scans.
- [ ] Implement server-issued 60-second QR challenge and atomic verification. Failed verification leaves pending; checkout/day rollover shows Uncompleted without a transfer.
- [ ] Verify SEC016 handover remarks and optional checkout remain unchanged.
- [ ] Run focused tests, full local gates, guarded staging dry run/apply, two-account hosted checks, then a real two-phone station trial. Report that browser GPS is not proof of physical presence.

### Task 2: Unpaid leave routing and annual-leave cancellation

**Files:** `lib/avsec/duty/absence-actions.ts`, `absence-logic.ts`, `leave-submit.ts`, `app/(avsec)/avsec/admin/absences/page.tsx`, existing leave SQL functions via new forward migration, and focused tests.

- [ ] Write failing tests for 1–2 inclusive calendar-day unpaid leave requiring Operation Manager and 3+ requiring the entity Boss; reject client-supplied role/entity authority.
- [ ] Implement final-approver routing, audit and applicant notification in guarded DB functions plus thin actions.
- [ ] Write failing tests for fourth distinct same-day overlapping approved officer, including ranges touching on different days, later overlap changes and team isolation.
- [ ] Align the approval cap with peak same-day overlap and persist fourth-or-later exception status at approval.
- [ ] Write failing tests for DSE own-team direct cancellation, Operation Manager exception cancellation, mandatory reason, repeated cancellation, future/in-progress/past distinctions and MY midnight.
- [ ] Implement atomic cancellation preserving today and earlier days for in-progress leave while releasing tomorrow onward; update roster/leave views and notify officer.
- [ ] Run local gates and guarded staging verification with exact-ID cleanup before proceeding.

### Task 3: DSE copies and SEC014 cross-device draft

**Files:** `lib/avsec/reports/actions.ts`, `drafts.ts`, `components/avsec/forms/Sec014Form.tsx`, `app/(avsec)/avsec/reports/sec014/page.tsx`, notification helper/schema if needed, and focused tests.

- [ ] Write failing tests that each of SEC013/014/016/018/029/033 and Makeup/Breakup submits one idempotent in-app alert per active same-entity/station/team DSE, with a report link.
- [ ] Implement notification delivery after confirmed submission, preserve submission when delivery fails, and expose failure to technical monitoring; verify report read permissions on the link.
- [ ] Write failing tests for explicit whole-form SEC014 Save Draft, cross-device resume, local/server timestamp conflict choice, failed-save preservation and clear-on-confirmed-submit only.
- [ ] Implement the draft action and clear feedback with existing `report_drafts` and local autosave patterns.
- [ ] Run local gates and mobile/desktop staging checks; use exact-ID fixtures and cleanup.

### Task 4: Station forecast

**Files:** new focused server weather adapter and station mapping, shared workspace card, station workspace integration, and focused tests.

- [ ] Verify current official forecast API contract and exact location IDs for each supported VECTA station.
- [ ] Write failing tests for station mapping, today's morning/afternoon/night, next three days, group role without station, malformed response, stale feed and HTTP 429.
- [ ] Implement server-only GET of `https://api.data.gov.my/weather/forecast`, caching well below four requests/minute, bounded timeout and safe unavailable state.
- [ ] Show station, last update and MET Malaysia/data.gov.my CC BY 4.0 attribution. Avoid live/aviation-clearance claims.
- [ ] Run local gates and hosted Preview checks for multiple stations and mobile/desktop layouts.

## Final integration gate

- [ ] Confirm all phase commits, local/remote SHAs and clean worktree; show migration history and staging-only deployment commit.
- [ ] Run full `npm test`, TypeScript, lint and build, then hosted role scenarios and exact fixture cleanup.
- [ ] Provide a pass/fail matrix and distinguish verified behavior from pending real two-phone handover trial.
- [ ] Leave production and `main` unchanged; provide the final Preview URL only after verifying its commit and staging target.
