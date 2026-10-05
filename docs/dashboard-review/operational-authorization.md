# Canonical operational authorization

Decision (2026-10-05): operational route gates must not depend on the missing `profiles.unified_role`
or any legacy column. Access is decided by the caller's active Phase 3 `user_role_assignments`,
read through `get_my_active_role_assignments()` (identity from `auth.uid()`; approved profile, active
role definition, non-revoked, effective start/end dates all enforced inside the function).

## How it works
* `lib/auth/canonical-access.ts` (pure): `deriveCanonicalAccess`, `accessSatisfiesRoles`, `deriveOperatorScope`,
  `isOrgWideOperator`. The canonical -> legacy-page rank mapping lives in `lib/auth/compat-role-map.mjs`
  (one source, also used by the staging tooling).
* `lib/auth/route-access.ts` (pure): which canonical roles may open a route, **derived from
  `lib/dashboard/linkHubConfig.ts`** so a dashboard link and the route it targets cannot disagree.
* `lib/avsec/auth.ts`: `requireProfile` / `requireRole` / `requireRouteAccess` / `getCurrentProfile` decide from
  canonical access. `getRawProfile` is for setup / awaiting-approval / chrome only and decides nothing.
* `lib/supabase/middleware.ts`: one `get_my_active_role_assignments` call per gated request; status from
  `profiles.status`; external CaterLink identity from `users.role` only.

## Canonical -> legacy-page rank (least privilege)
`aso`->ASO, `so`/`sso`->SO, `dse`/`hub_se`->DSE, `operation_manager`->MANAGEMENT, `main_enforcement`->ENFORCEMENT
(the reverse of `supabase/PHASE8_ACTIVATION_PLAN.md`). **Every other role has no legacy-page rank** and works
through the Phase 7 dashboards and the canonical RPC workspaces. **This mapping is an authorization policy
decision and needs your review.**

## Behaviour
* Approved profile, no active assignment -> `/avsec/pending-approval` ("No workspace assigned yet"). A legacy
  `ADMIN`/`MANAGEMENT` value grants nothing.
* Pending/rejected/deactivated profile -> pending page. Revoked, expired, future-dated, inactive-role -> the
  RPC returns no row, so the same "No workspace assigned yet" state.
* Canonical `super_admin` -> `/super-admin` only; kept off operational routes.
* Canonical roles with no legacy rank land on `/avsec/my-dashboard`.
* Duty check-in gate applies only to roles whose dashboard includes the duty terminal
  (`aso, so, sso, dse, sat_aso, profiling_so, profiling_aso`).
* Email text and `user_metadata` no longer route or authorise anyone (the old `includes("driver")` etc. heuristics are gone).

## Migrated gates
Middleware (login redirect, gated routes, check-in exemption); `requireProfile`/`requireRole`; `getCurrentProfile`
(now null unless approved + assigned); AVSEC layout, pending page, profile-setup; landing page; scan page and
`scanTransaction` (Profiling denial now from the assignment list); ICMS layout and transactions org-wide flag;
auth callback; ICMS login action; needs-your-action; Super Admin gates (earlier round); link-target pages
`/avsec/reports/lookup`, `/avsec/enforcement/search`, `/avsec/duty`(+timesheet), `/avsec/reports/sec013`,
`/avsec/dashboard` via `requireRouteAccess`. All reads and writes of `unified_role` were removed
(registration, admin account creation, ICMS users, shadow users). A closure test fails if any handwritten code names it.

## Retained compatibility reads and unresolved items
1. **`ops_group`** (about 50 files): kept as a workflow attribute for CaterLink checkpoint ownership
   (`lib/icms/ops-group.ts`), report/roster scoping, `sec013` and `bay-board` branch redirects. Phase 2 has no
   canonical equivalent for the Operation / IFC / Hub split, so it cannot be replaced without a mapping decision.
   It still limits *which* checkpoint a canonically-authorised user may complete.
2. **ICMS identity model** (`public.users`, ICMS roles, ICMS RLS): a separate application model.
   Canonical accounts have no `users` row, so `/icms/*` pages and checkpoint-completion actions
   (`requireProfile`/`requireCheckpointRole` in `lib/icms/auth.ts`) redirect them. `/avsec/scan` and
   `scanTransaction` work canonically. `caterlink_management` therefore cannot yet open its dashboard links
   (`/icms/dashboard`, `/icms/transactions`, `/icms/incidents`, whitelist, archive). A bridge decision is needed.
3. **Legacy-table RLS** still keys on the raw `profiles.role` (Phase 13 retirement-gate condition 5). App
   gates do not change database policies. Provisioning therefore also writes compatibility `role`, `station`
   and `team` text so legacy RLS sees a consistent profile.
4. **Supervising-officer eligibility** (`lib/avsec/reports/actions.ts`, `getEligibleSupervisingOfficers`) reads
   *another* user's legacy `role`/`station`/`team`.
5. **`/avsec/admin/roster`** is linked from the `dse` and `hub_se` dashboards but is gated to ADMIN ranks and the
   edge admin gate (a pre-existing inconsistency, now listed as a known gap in the tests).
6. **Production risk:** with this change a real user with no active assignment has no operational access.
   Do not deploy until `view_legacy_role_mapping_report_secure()` shows every legacy user has a replacement
   assignment. Also, accounts created after this change have `profiles.unified_role` NULL on a database that still
   has the column; any production RLS keyed on it would not match.
