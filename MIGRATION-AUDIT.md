# Phase 0 — Migration Audit: Supabase Auth → Firebase Auth (Google Workspace SSO)

Scope: `VECTA` (AVSEC + ICMS) and `CATERLINK` (IFC/vendor drivers), which share **one Supabase
project** and therefore one `auth.users` table, one Postgres schema, and one set of RLS
policies. This document is Phase 0 of the migration plan — no feature code was changed.

---

## 1. Files calling Supabase auth methods

### VECTA

| File | Methods | Purpose |
|---|---|---|
| `lib/supabase/middleware.ts` | `auth.getUser()` | Central session check, runs in Next middleware on every non-excluded route |
| `lib/supabase/admin.ts` | service-role client factory (backs `auth.admin.*` calls) | Bypasses RLS |
| `lib/icms/auth.ts` | `auth.getUser()`, `auth.signOut()` | `requireProfile()`/`requireRole()` — ICMS's central guard |
| `lib/avsec/auth.ts` | `auth.getUser()` ×2 | `getCurrentUser()`/`getCurrentProfile()` — AVSEC's central guard |
| `lib/icms/actions/auth.ts` | `auth.signInWithPassword()`, `auth.signOut()` ×2 | ICMS login/logout actions |
| `lib/avsec/profile-actions.ts` | `auth.signOut()` | AVSEC logout |
| `lib/icms/actions/users.ts` | `auth.admin.createUser()`, `auth.admin.deleteUser()` | Admin creates/rolls back ICMS staff accounts |
| `lib/avsec/admin/actions.ts` | `auth.admin.createUser()`, `auth.admin.deleteUser()` | Admin creates/deletes AVSEC staff accounts |
| `lib/icms/actions/scan.ts` | `auth.getUser()` | Resolve caller before checkpoint scan |
| `lib/icms/actions/incidents.ts` | `auth.getUser()` | `markNotificationsRead()` |
| `lib/icms/actions/language.ts` | `auth.getUser()` ×2 | Per-user language preference |
| `app/api/icms/sync/route.ts` | `auth.getUser()` | Offline-queue replay endpoint |
| `app/api/icms/qr/mint/route.ts` | `auth.getUser(bearer)` | **Cross-app** (CaterLink→VECTA) QR mint — Bearer-token auth, not cookies |
| `app/api/icms/qr/validate/route.ts` | `auth.getUser()` | QR-token validation |
| `app/(avsec)/avsec/scan/page.tsx` | `auth.getUser()` | Inline session check, bypasses shared guard |
| `app/(avsec)/avsec/auth/callback/route.ts` | `auth.exchangeCodeForSession()` | Password-reset email callback; comment marks it for deprecation once SSO ships |
| `app/page.tsx` | `auth.getUser()` | Unified landing page, inline session check |
| `scripts/icms/seed.mjs` | admin client | Demo account seeding (script, not app code) |

No `signInWithOAuth`, `signUp`, `onAuthStateChange`, or `refreshSession` anywhere — login is
email/password only, no self-service signup (accounts are admin-created).

### CATERLINK

| File | Methods | Purpose |
|---|---|---|
| `src/lib/supabase/client.ts` | `createBrowserClient` | Browser client factory |
| `src/lib/supabase/server.ts` | `createServerClient` | Server client factory (cookies) |
| `src/lib/supabase/admin.ts` | service-role client | Backs `auth.admin.*` |
| `src/middleware.ts` | `auth.getUser()` | Session-refresh middleware (does not gate routes itself) |
| `src/lib/auth.ts` | `auth.getUser()`, `auth.signOut()` | `requireProfile()`/`requireRole()` — central guard |
| `src/lib/actions/auth-session.ts` | `auth.signInWithPassword()`, `auth.signOut()` | Login/logout action |
| `src/lib/actions/registration.ts` | `admin.auth.admin.createUser()`, `deleteUser()` | Public vendor-driver self-registration |
| `src/app/api/dev-seed/route.ts` | `admin.auth.admin.createUser()`, `deleteUser()` | Token-gated dev seeding — flagged "DELETE THIS FILE," not production |
| `src/lib/actions/transactions.ts`, `vendor-transactions.ts` | `auth.getSession()` | Pulls `access_token` to call **VECTA's** QR-mint API as a bearer token |
| `src/app/(app)/[id]/qr/page.tsx` | `auth.getSession()` | Same pattern, QR re-mint on view |
| `src/app/(app)/sign-out-button.tsx` | `auth.signOut()` | Client logout button |
| `src/app/(app)/[id]/live-refresh.tsx` | Supabase Realtime channel (session-bound, RLS-gated) | Live transaction status updates |
| `src/lib/storage.ts` | none directly, but every call runs through the caller's session so Storage RLS applies | Signature/photo/PDF upload + signed URLs |

No `signInWithOAuth`, `signUp`, `onAuthStateChange`, `refreshSession`, or
`exchangeCodeForSession` in CATERLINK's live code. An old migration comment references a
planned `src/app/auth/callback/route.ts` for Google OAuth that was never implemented — the
PIN-driver design it belonged to was dropped (see §4).

**Cross-app dependency:** CaterLink forwards its own Supabase-issued JWT (`access_token`) as a
Bearer token to VECTA's `/api/icms/qr/mint`. VECTA authenticates that call with
`auth.getUser(bearer)`. **Both apps must migrate their auth provider together**, or VECTA needs
a compatibility shim that accepts both a Supabase JWT and a Firebase ID token during the
transition window.

---

## 2. Middleware / route guards / session validators

**VECTA — `lib/supabase/middleware.ts`** (`updateSession`), the single top-level gate:
1. Calls `supabase.auth.getUser()` immediately after client construction (comment warns not to
   add logic before this call — avoids refresh races).
2. No user + protected path → redirect `/login` (and strips `sb-*` cookies). User + `/login` →
   redirect `/`.
3. For `/icms` and `/avsec`: looks up **both** `public.profiles` (AVSEC) and `public.users`
   (ICMS) by `id = user.id`, uses whichever exists, checks `status` is `approved`/`active`.
4. Applies `unified_role`-based checks (`isCheckinGateExempt`, `isAdminPathForbidden`, factored
   into `lib/supabase/middleware-gate-logic.ts`, unit-tested separately).
5. Redirects non-exempt roles without an open duty check-in to the check-in page. DB errors
   fail **closed**.
6. `/api/*` is excluded from this gate — each API route does its own `auth.getUser()`.

**VECTA — `lib/icms/auth.ts` / `lib/avsec/auth.ts`**: both call `auth.getUser()` then load the
relevant profile table, redirect on missing/inactive profile, and expose `requireRole(roles)`.
There is **no shared per-request session cache** — every guard, page, and action re-derives the
user from cookies independently, then re-queries the profile table for role/status. Role data
always costs a DB round-trip; there is no single "claims" source of truth today.

**CATERLINK — `src/middleware.ts`**: runs `auth.getUser()` purely to refresh the session/cookies
per the standard `@supabase/ssr` pattern — it does **not** itself redirect or gate access.

**CATERLINK — `src/lib/auth.ts` → `requireProfile()`**: the actual gate, called at the top of
every protected page. `auth.getUser()` → no user → redirect `/login`. Loads
`public.users` by id → no row → redirect `/login?error=no-profile`. `status !== "active"` →
force `signOut()` + redirect (defense-in-depth against a status change mid-session).
`requireRole(roles)` wraps it, but most CaterLink pages instead do inline
`profile.role === "warehouse_pic"` / `"vendor"` checks rather than calling `requireRole`.

Driver vs. vendor-driver distinction is a plain string compare on `profile.role` — there is no
separate CaterLink-specific JWT claim; role is always fetched via a normal table `select`.

---

## 3. RLS policies and their claim dependencies

**No policy in either repo reads `auth.jwt()`, `app_metadata`, or `user_metadata`.** Every
policy in both apps is keyed on two Postgres-native primitives supplied by Supabase's own
Postgres integration:

- **`auth.uid()`** — row ownership (`created_by = auth.uid()`, `completed_by = auth.uid()`, etc.)
- **`public.current_user_role()` / `current_role_name()`** — `security definer` helper functions
  that look up the caller's role by querying `profiles`/`users` where `id = auth.uid()`

VECTA additionally defines `current_station()`, `current_team()`, `role_rank()`,
`is_supervisor_or_above()` — all built the same way, all ultimately keyed on `auth.uid()`.

Representative examples:

```sql
-- VECTA, supabase/migrations/avsec/0002_rls.sql
create or replace function current_role_name() returns user_role as $$
  select role from profiles where id = auth.uid();
$$ language sql stable security definer set search_path = public;

create policy "profiles self select" on profiles for select
  using (id = auth.uid() or is_supervisor_or_above());
```

```sql
-- VECTA, supabase/migrations/icms/20260101000002_rls.sql
create or replace function public.current_user_role() returns text
  security definer stable set search_path = public
  as $$ select role from users where id = auth.uid(); $$;
```

```sql
-- CATERLINK, supabase/migrations/20260819000004_caterlink_v2_schema.sql
create policy "cl_signoffs insert" on cl_signoffs for insert
  with check (
    signer_id = auth.uid()
    and signer_role = current_user_role()   -- re-verifies role at write time, not client input
  );
```

**Team/ops-group separation (Operation AVSEC vs IFC AVSEC vs Hub AVSEC)** is enforced at the DB
layer via an `ops_group` column (`'operation_avsec' | 'ifc_avsec' | 'hub_avsec'`) on
`profiles`/`users`, checked directly inside INSERT policies:

```sql
-- VECTA, supabase/migrations/fix_ops_staff_checkpoint_insert_rls.sql
where p.id = auth.uid() and p.unified_role in ('aso','so','dse') and p.ops_group = 'ifc_avsec'
...
where p.id = auth.uid() and p.unified_role in ('aso','so','dse') and p.ops_group = 'operation_avsec'
```

This migration's own comment records that an **app-layer-only check had a gap** that let this
slip through, which is why the DB-level policy exists — RLS is the authoritative backstop here,
not the UI/action-layer check in `lib/icms/actions/scan.ts`. Any Firebase migration must
preserve an equally authoritative, equally hard-to-bypass check for this boundary.

**Consequence for migration:** because `auth.uid()` and `current_user_role()` are resolved
*inside Postgres* from the Supabase-issued JWT, replacing Supabase Auth means one of two paths:
(a) keep Supabase's Postgres JWT-verification plumbing and register Firebase as a trusted token
issuer (this is exactly what Supabase's "Third-Party Auth" feature does — Phase 3 targets this),
or (b) rewrite every RLS policy in both repos (~30+ migration files across VECTA, ~9 in
CATERLINK) to a different trust mechanism. Path (a) is what Phase 2/3 of the plan already
assumes.

---

## 4. Where roles are stored today

**Not in `auth.users.raw_user_meta_data` / `raw_app_meta_data` anywhere.** Roles live in plain
Postgres tables, one per app, both FK'd 1:1 to `auth.users.id`:

- **VECTA — `public.profiles`** (AVSEC-origin), created in
  `supabase/migrations/avsec/0001_init_schema.sql`, `role user_role not null default 'OFFICER'`.
  Extended with `unified_role`, `duty_post` (`unified_role_model.sql`), `ops_group`
  (`team_based_ops_groups.sql`), `status` (`avsec/0009_approval_workflow_and_monitor_roles.sql`).
- **VECTA — `public.users`** (ICMS-origin), created in
  `supabase/migrations/icms/20260101000001_schema.sql`, same `unified_role`/`duty_post`/
  `ops_group` columns added by the same two cross-cutting migrations, plus
  `preferred_language`.
- A single account lives in **one table, never both**. `unified_role_model.sql` explicitly
  avoided renaming either app's original `role` column in place, adding an additive
  `unified_role` text column instead ("dozens of live RLS policies... hardcoded against those
  exact strings; renaming in place would risk breaking every report/duty/admin policy in the
  running production app instantly").
- **CATERLINK — `public.users.role`** (the *same* `public.users` table VECTA's ICMS side uses —
  one shared Supabase project, one shared table). CaterLink deliberately reuses VECTA's existing
  roles rather than defining its own (migration header: "No new roles needed — CaterLink now
  reuses VECTA's EXISTING roles directly, same Supabase Auth project, same accounts"). CHECK
  constraint currently allows: `warehouse_pic, post2_avsec, post6_avsec, receiver, supervisor,
  enforcement, vendor, hub_avsec, redq_avsec, management, ops_staff, driver_vendor`.
  - Note: `driver_vendor` remains in the DB constraint and in some CaterLink RLS policies, but
    the live application code (`registration.ts`, `dev-seed/route.ts`) hardcodes `role: "vendor"`
    for new self-registered vendor drivers — `driver_vendor` looks like dead/legacy state,
    worth a cleanup ticket outside this migration.
  - CATERLINK's earlier `pin_drivers.vendor_id` design was dropped entirely
    (`20260819000003_drop_pin_drivers.sql`). There is no live `vendor_id` column today; vendor
    association is purely `users.role = 'vendor'` plus `created_by`/`completed_by` FKs.

One direct dependency on a Supabase-Auth-specific mechanism (not just the layer): VECTA's
`team_based_ops_groups.sql` uses `auth.users.banned_until` to hard-disable 3 obsolete demo
accounts. Firebase has no identical column — this needs a Firebase-side "disable user"
equivalent (`admin.auth().updateUser({ disabled: true })`).

---

## 5. What breaks immediately if `supabase.auth` disappeared

This is not limited to files that call `supabase.auth.*` directly — **because every RLS policy
in both repos is keyed on `auth.uid()`/`current_user_role()`, resolved from the JWT that
`supabase.auth` issues and `@supabase/ssr` attaches to the Postgres/Storage session, losing
`supabase.auth` breaks essentially every authenticated `.from(...)` query and every Storage
operation in both apps, even ones with no visible `auth.*` call in the same file.**

Direct breakage:
- **Login** (both apps): `signInWithPassword()` calls have no fallback.
- **Every protected page/action** (both apps): central guards (`requireProfile()` in both repos)
  call `auth.getUser()` first; nothing downstream runs without it.
- **Middleware** (both apps): both call `auth.getUser()` unconditionally on nearly every request.
- **Admin account creation** (both apps): `auth.admin.createUser()`/`deleteUser()` have no
  drop-in Firebase Admin SDK equivalent — different signatures and error semantics.
- **Cross-app QR minting**: CaterLink's `access_token` bearer flow to VECTA's `/api/icms/qr/mint`
  breaks on both ends simultaneously (see §1).
- **Realtime** (CaterLink `live-refresh.tsx`): Postgres-changes subscriptions are RLS-gated over
  the same session; breaks along with everything else.
- **Storage** (both apps): every upload/signed-URL call runs through the caller's own session
  specifically so Storage RLS applies — breaks identically to table RLS.

Bypass-prone spots worth noting for Phase 1 (routes that inline `auth.getUser()` instead of
going through the shared guard, so they need explicit attention when swapping providers):
`app/page.tsx`, `app/(avsec)/avsec/scan/page.tsx`, `app/api/icms/sync/route.ts`,
`app/api/icms/qr/validate/route.ts`, `app/api/icms/qr/mint/route.ts` (VECTA, all bypass
`lib/icms/auth.ts`/`lib/avsec/auth.ts`).

---

## 6. Report/transaction attachments — Supabase Storage buckets

**Confirmed: Supabase Storage, not S3/GCS. All buckets are private (`public: false`); all reads
go through server-generated signed URLs.** ⇒ **Backups need full byte-for-byte object sync, not
metadata-only** — the current backup workflow (Phase 5 target) captures DB rows only.

| Bucket | Created in (VECTA repo) | Used by |
|---|---|---|
| `signatures` | `supabase/migrations/icms/20260101000002_rls.sql` | `lib/icms/storage.ts` (VECTA), `src/lib/storage.ts` (CaterLink) — shared bucket, one Supabase project |
| `incident-photos` | same file | `lib/icms/storage.ts` |
| `completed-forms` | `supabase/migrations/icms/20260718000007_completed_form_pdf.sql` | `lib/icms/storage.ts`, `lib/icms/completed-form-pdf*.ts`, and CaterLink's `src/lib/storage.ts` (`uploadPdfBuffer`/`signedUrl`) |
| `report-attachments` | `supabase/migrations/avsec/0020_report_attachments.sql` | `lib/avsec/attachments/actions.ts` |

Bucket policies gate only on `auth.role() = 'authenticated'` — no per-row storage restriction;
the app enforces which rows a signed URL is generated for by re-deriving the parent row through
a normal (RLS-scoped) DB query first. `lib/avsec/attachments/actions.ts` stores a `sha256` of
uploaded content, so any copy to a new storage backend must preserve exact bytes to keep that
hash meaningful.

---

## 7. Operation AVSEC / IFC AVSEC / Hub AVSEC separation

Enforced at **both layers**, keyed on `ops_group` (`'operation_avsec' | 'ifc_avsec' |
'hub_avsec'`):

- **DB/RLS** (authoritative): explicit `ops_group = '...'` conditions inside INSERT policies on
  `transactions`/`part_b`/`part_c` etc. (`fix_ops_staff_checkpoint_insert_rls.sql`) — added after
  an app-layer-only check left a real gap (see §3).
- **App layer** (UX/early-rejection): `lib/icms/ops-group.ts` maps checkpoint roles to
  `ops_group`; `lib/icms/actions/scan.ts` performs a server-side scope check against the
  caller's own `ops_group` before allowing a scan; `app/page.tsx` and
  `app/(avsec)/avsec/scan/page.tsx` use the same mapping for UI visibility only.

**Reports is confirmed as the one shared surface** — the report tables' RLS policies allow
cross-team reads at supervisor rank and above (`role_rank()` / `is_supervisor_or_above()`), while
checkpoint transaction tables enforce strict `ops_group` isolation. No evidence of any other
shared surface between Operation AVSEC and IFC AVSEC.

**CATERLINK never grants or forges an AVSEC role.** Its only two role-writing code paths
(`registration.ts` hardcodes `role: "vendor"`; `dev-seed/route.ts` hardcodes from a fixed,
in-code test-account list) never accept a client-supplied role, and no CaterLink API updates
`users.role`. Sensitive AVSEC-only tables additionally re-verify the live role at write time
(e.g. `cl_signoffs`'s `signer_role = current_user_role()` check), so even a compromised/forged
row can't bypass the live RLS check. The one architectural risk to carry into the migration:
CaterLink and VECTA/ICMS share **one** `public.users` table and **one** identity space (one
Supabase project today, one Firebase project after Phase 3) — the invariant that must survive
the migration is "no role is ever client-writable, and every sensitive table re-checks the live
role from a trusted source," not any code-level separation between the two apps' repos.

---

## Which app is riskier to migrate, and why

**CATERLINK is the riskier app to migrate, despite being smaller.**

VECTA is larger (84 files touching auth-adjacent code vs. 16) and has two independently-evolved
auth guards (`lib/icms/auth.ts` and `lib/avsec/auth.ts`) plus several call sites that bypass
both — that is real, quantifiable Phase 1 work. But its risk is *contained*: everything VECTA
does lives inside its own repo, its own RLS policies, its own Postgres functions.

CATERLINK's risk is architectural and *external* to its own codebase:

1. It has **zero role storage of its own** — it reads and is bound by `public.users.role`, the
   same table and the same identity space VECTA's ICMS side owns. A CaterLink account is not a
   CaterLink concept at the database level; it's a VECTA/ICMS account that happens to have
   `role = 'vendor'` or `'warehouse_pic'`. Any change to how identity or roles are minted
   (Phase 3's `sync-claims` route, the `user_claims` table in Phase 2) has to get this exactly
   right for CaterLink even though CaterLink's repo has no visibility into that code.
2. It has a **live cross-app runtime dependency**: CaterLink forwards its own Supabase JWT as a
   bearer token to VECTA's `/api/icms/qr/mint` endpoint, and VECTA verifies it with
   `auth.getUser(bearer)`. This is the one place in either app doing token-based (not
   cookie-based) auth, and it means **the two apps cannot be cut over independently** without a
   compatibility window — flipping `AUTH_PROVIDER` on one app and not the other breaks QR minting
   immediately. Phase 4 already sequences CaterLink first specifically because it has fewer
   users, but the *dependency direction* (CaterLink calling into VECTA) means VECTA's
   `/api/icms/qr/mint` route must accept both token types during that window, which is VECTA
   code that has to be ready before CaterLink cuts over — not after.
3. Its role/status separation between "used to create AVSEC checkpoint data" and "used to
   create CaterLink deliveries" is enforced entirely by **runtime string comparison against a
   role space it doesn't own** — correct today, but it means CaterLink has no independent
   guardrail if the shared claims contract (Phase 2) is ever built or normalized incorrectly on
   the VECTA side. A bug in VECTA's `sync-claims` route that mis-maps a role could silently open
   or close CaterLink access with no CaterLink-side test to catch it (Phase 2's RLS separation
   tests should explicitly include CaterLink's driver/vendor roles, not just VECTA's four AVSEC
   scenarios).

Net: VECTA needs more *engineering hours* (bigger surface, two guards, several inline bypasses
to consolidate in Phase 1). CATERLINK needs more *coordination* — its correctness depends on
decisions made in the other repo, and its one genuinely novel piece of auth-adjacent code (the
QR bearer-token bridge) is a two-sided contract, not something it can migrate in isolation.
Recommend treating the CaterLink↔VECTA QR bridge as its own explicit sub-step inside Phase 4,
validated before either app's `AUTH_PROVIDER` flips in production.

---

*Produced in Phase 0. No application code was changed. Waiting for approval before Phase 1.*
