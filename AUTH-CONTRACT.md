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

## Phase 3 status

Firebase project `airasia-avsec-auth` (Spark plan, RM0), Google sign-in
only, both Vercel domains authorized. Confirmed with ICT: Google Workspace
is the native IdP (not federated behind Okta/Entra), so `SSO-SWAP.md`
doesn't apply.

Built and verified (type-check, lint, full test suite, production build,
boundary script all pass):

- `lib/auth/providers/firebase-admin.ts` / `firebase-client.ts` — Admin
  and client SDK singletons, the only files that import `firebase`/
  `firebase-admin` directly (enforced by `check-auth-boundary.sh`, now
  also checking Firebase SDK imports, not just Supabase's).
- `lib/auth/providers/firebase.ts` — the real `AuthProvider` implementation:
  `getUser()`/`getSession()` verify a Firebase session cookie
  (`fb-session`); `getAccessToken()` reads a separate short-lived ID-token
  cookie (`fb-id-token`); `signOut()` revokes refresh tokens and clears
  both cookies; `signIn()` throws — Google sign-in is a browser operation
  (`signInWithPopup`), not something a password-shaped server method can
  do.
- `app/api/auth/session` — establishes both cookies from a client-obtained
  ID token. `app/api/auth/sync-claims` — verifies the caller's ID token,
  **re-checks the Workspace domain server-side** (the client-side `hd`
  hint is UX only), reads `public.user_claims`, calls
  `setCustomUserClaims()`. `components/auth/GoogleSignInButton.tsx` drives
  the flow end to end, including the forced `getIdToken(true)` refresh
  after syncing — **skipping that step is the single most common failure
  mode in this kind of migration**: the browser keeps using the
  pre-claims token and every RLS query silently returns nothing.
- `lib/supabase/server.ts` / `client.ts` — now branch on
  `AUTH_PROVIDER`/`NEXT_PUBLIC_AUTH_PROVIDER`: Firebase mode builds the
  Supabase client with the `accessToken` option instead of
  `supabase.auth`, per Supabase's Third-Party Auth integration.
- Claims re-sync wired into every role-changing admin action
  (`lib/icms/actions/users.ts`, `lib/avsec/admin/actions.ts`) via
  `bestEffortSyncClaims()` — a no-op today (no environment has
  `FIREBASE_SERVICE_ACCOUNT_BASE64` set until Phase 4), real once it does.
- `app/login/page.tsx` branches on `AUTH_PROVIDER`: unset/`supabase`
  renders the existing email/password form completely unchanged;
  `firebase` renders `GoogleSignInButton` instead. Zero behaviour change
  to the default path.
- `supabase/migrations/claims_contract.sql` — **applied directly to the
  live `vecta-prod` project** (via Supabase MCP, with the user's explicit
  confirmation of the target project first), not just committed as a file.
- `supabase/config.toml` — new file (none existed before), declares
  `[auth.third_party.firebase]` for local CLI use.

**Known limitations, flagged rather than silently accepted:**

1. **Edge middleware can't verify Firebase sessions.** Firebase Admin
   SDK's `verifySessionCookie()` needs Node.js; `middleware.ts` runs on
   the Edge runtime. `AUTH_PROVIDER=firebase` makes middleware pass every
   request through untouched — **not a security regression**, since every
   page/action's own `requireProfile()`/`requireRole()` and RLS remain the
   authoritative checks regardless of middleware (this file's own gate was
   already documented as additive defense-in-depth, not the boundary).
   Lost: the check-in-gate redirect and the coarse admin-path block
   happening at the edge. Fix before relying on either under Firebase:
   stateless ID-token verification with `jose` against Google's JWKS
   (Edge-compatible), not the Admin SDK.
2. **The CaterLink→VECTA QR-mint bearer-token flow will go stale under
   Firebase.** `getAccessToken()` returns the ID-token cookie set at last
   session establishment (~1 hour lifetime) with no server-side refresh —
   Firebase has no equivalent of Supabase's cookie-refresh-on-every-request
   middleware pattern. Needs a fix before Phase 4's cutover touches this
   flow: either a client-side `onIdTokenChanged` listener that periodically
   re-POSTs to `/api/auth/session`, or redesigning the cross-app call to
   not depend on bearer freshness matching browser session freshness.
3. **CATERLINK's `lib/auth/providers/firebase.ts` is still the Phase 1
   stub — deliberately not built out in this phase.** CaterLink's drivers,
   especially third-party vendor drivers, likely don't have AirAsia
   Workspace accounts at all — the entire premise of Phase 3 ("Google
   Workspace sign-in IS the AirAsia SSO") may not extend to them. Building
   a parallel Google-sign-in flow for CaterLink without confirming this
   would be guessing at a design decision, not implementing a specified
   one. **Open question for the user before CaterLink's Firebase work
   starts:** do CaterLink drivers/vendors get Workspace accounts too, a
   different Firebase sign-in method (e.g. email/password via Firebase),
   or do they stay on Supabase Auth indefinitely (in which case Phase 4's
   "flip CATERLINK first" sequencing needs to change to reflect that only
   VECTA is actually cutting over)?

**Still needed before this is live (manual/console steps, not code):**

- Register Firebase in the Supabase Dashboard: **Authentication → Sign In
  / Providers → Third Party Auth → Add provider → Firebase**, paste
  project ID `airasia-avsec-auth`. (`supabase/config.toml`'s
  `[auth.third_party.firebase]` block only affects local CLI use — this
  dashboard step is what makes it take effect on `vecta-prod`, and no
  MCP tool in this session exposes it programmatically.)
- Set every `NEXT_PUBLIC_FIREBASE_*` / `AVSEC_WORKSPACE_DOMAIN` /
  `FIREBASE_SERVICE_ACCOUNT_BASE64` var from `.env.example` in Vercel —
  still `AUTH_PROVIDER=supabase` in production until Phase 4.
- Test end-to-end on a Vercel preview with `AUTH_PROVIDER=firebase` before
  trusting any of this — per Phase 3's own verify criteria, nothing here
  has been exercised against a live signed-in session yet.
