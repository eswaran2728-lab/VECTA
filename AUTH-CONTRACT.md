# Phase 2 — Claims Contract

VECTA and CATERLINK share one Supabase project/database (see
`MIGRATION-AUDIT.md`). This document is the single normative description of
the claim shape both apps' auth layers (`lib/auth/` / `src/lib/auth/`) will
read once Phase 3 mints a Firebase JWT carrying these claims — and, until
then, of `public.user_claims`, the read-only view that derives the same
shape from today's Supabase tables.

## Claim table

| Claim | Type | Meaning | Required |
|---|---|---|---|
| `role` | `"authenticated"` | Postgres role — mandatory or Supabase RLS rejects the token | yes |
| `app_role` | `admin\|management\|enforcement\|so\|aso\|dse\|vendor` | app role (the `unified_role` vocabulary — see caveat below) | yes |
| `team` | `operation\|ifc\|hub\|null` | AVSEC team | VECTA |
| `station` | text (e.g. `KUL`, `JHB`, `PEN` — see `stations` table for the live list) \| null | hub/AVSEC station | hub users |
| `staff_id` | string | AirAsia staff ID | AVSEC users |
| `vendor_id` | string \| null | vendor company | CATERLINK vendors — **not modeled yet**, see caveat |
| `email` | string | identity | yes |

## Caveat: `app_role` is NOT the same vocabulary as `current_user_role()`/`current_role_name()`

Both apps' RLS already had role-reading functions before this phase —
`current_user_role()` (ICMS, reads `public.users.role`),
`current_role_name()` (AVSEC, reads `public.profiles.role`). Those return
each app's **original, per-app role vocabulary**: things like
`post2_avsec`, `warehouse_pic`, `receiver`, or `ASO`/`SO`/`DSE`/`ADMIN`.
Dozens of live RLS policies are hardcoded against those exact strings.

`app_role` above is a **different, coarser** vocabulary —
`unified_role` (see `supabase/migrations/unified_role_model.sql`):
`admin | management | enforcement | so | aso | dse | vendor`. It exists so
a claims-reading UI/guard can ask "is this an ASO-tier account?" without
knowing which of the two origin tables (or which checkpoint-specific role
name) the account actually has.

**These must never be conflated.** `claims_contract.sql`'s new
`current_app_role()` function reads/derives `app_role` (unified_role);
existing RLS keeps using `current_user_role()`/`current_role_name()`
(original per-app vocabulary) completely unchanged. See that migration's
header comment for the full reasoning.

## `vendor_id`: not modeled yet

No `vendor_id` column exists anywhere in the schema (confirmed in
`MIGRATION-AUDIT.md` §7 — CaterLink's earlier `pin_drivers.vendor_id`
design was dropped). Vendor association today is purely
`app_role = 'vendor'` plus `created_by`/`completed_by` foreign keys on
transaction rows. `public.user_claims` and `current_*_claim()` therefore
always emit `vendor_id: null`. If a real multi-vendor-company concept is
ever needed, that's a separate, additive schema change — not assumed here.

## Where each claim is read today (Phase 2) vs. after Phase 3

| | Today (Phase 2) | After Phase 3 |
|---|---|---|
| `role` | Supabase's own JWT `role` claim | mirrored the same way by `/api/auth/sync-claims` |
| `app_role`/`team`/`station`/`staff_id` | `current_app_role()`/`current_team_claim()`/`current_station_claim()`/`current_staff_id_claim()` — `auth.jwt() ->> '<claim>'` first, falling back to a `profiles`/`users` lookup by `auth.uid()`. Today the JWT side is always null (no custom claims exist on a Supabase-native token), so behaviour is identical to before this phase. | same functions, now short-circuiting on the JWT claim `/api/auth/sync-claims` set — no DB round trip |
| `vendor_id` | always `null` (not modeled) | same, unless a real vendor_id concept is added later |
| `email` | `auth.jwt() ->> 'email'` (unchanged, Supabase already provides this) | mirrored the same way |

`public.user_claims` (the view) and `current_app_role()` /
`current_team_claim()` / `current_station_claim()` /
`current_staff_id_claim()` (the functions) are defined in
`supabase/migrations/claims_contract.sql`. All are additive — no existing
table, function, or RLS policy was altered.

## `user_claims` is authoritative for READING, not the new source of truth for WRITING

`public.user_claims` is a `security_invoker` **view** over
`public.profiles` and `public.users` — not a new writable table. Role
changes still happen through each app's existing admin actions
(`lib/icms/actions/users.ts`, `lib/avsec/admin/actions.ts`). "The app
never invents roles" (Phase 2's requirement) is satisfied because the view
can only ever reflect what those two tables already say — there's no
second, independently-writable copy of role data to drift out of sync.

## Team separation is enforced in RLS, not the UI

Confirmed and tested (`supabase/tests/database/rls_team_separation.test.sql`
in this repo, `supabase/tests/database/rls_driver_vendor_access.test.sql`
in CATERLINK — run via `supabase test db`, not executed in the environment
that wrote them; see each file's header):

1. Operation AVSEC cannot read/write IFC AVSEC checkpoint data — proven
   against `part_b`'s (ifc_avsec-only) insert policy.
2. IFC AVSEC cannot read/write Operation AVSEC checkpoint data — proven
   against `part_c`'s (operation_avsec-only) insert policy, and the
   mirror-image acceptance case for both directions.
3. Reports is the shared surface — proven by asserting no `report_*` RLS
   policy filters on `ops_group` at all (the mechanism every other
   separation check in this file relies on).
4. A vendor-only account (no `public.profiles` row) is rejected by every
   AVSEC checkpoint policy tested here, by construction — and accepted by
   CaterLink's own `cl_transactions` insert policy (tested in CATERLINK's
   own test file, using `driver_vendor`/`warehouse_pic` — see that file's
   header for a role-naming mismatch found and flagged separately, not
   fixed in this phase).

## Next: Phase 3

Phase 3 wires Firebase Auth (Google Workspace sign-in) and
`/api/auth/sync-claims`, which will actually set these claims as Firebase
custom claims per this contract, and register Firebase with Supabase's
Third-Party Auth so `auth.jwt()` on a Firebase-issued token resolves the
same way it does today for a Supabase-issued one.
