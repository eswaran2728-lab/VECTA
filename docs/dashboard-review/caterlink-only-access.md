# CaterLink-only access (Management, Driver, Third-Party Vendor)

## Display role -> existing role code (no roles were created)

| Display role | Existing identity |
|---|---|
| CaterLink Management | canonical Phase 3 role `caterlink_management` (active assignment) |
| CaterLink Driver | ICMS external account role `warehouse_pic` (legacy aliases `driver_ifc`, `driver_vendor`) |
| Third-Party Vendor | ICMS external account role `vendor` |

External identities are rows of the trusted `public.users` account table (status `active`) with no canonical
assignment. Migration `20261023000001` creates that table only where it is missing (staging); where the ICMS schema
already provides it, nothing changes.

## One server-side decision

`lib/auth/caterlink-access.ts` (`classifyPortalAccess`, `decidePortalRequest`) is used by the login redirect, the
OAuth callback, the root page, the middleware (pages and APIs), AVSEC `requireProfile` / `getCurrentProfile`, ICMS
`requireProfile` and the ICMS sign-in action. CaterLink-only identities reach `/caterlink/*`, `/icms/*`, auth pages
and `/api/icms|auth|health`; every VECTA, AVSEC, Super Admin and other API route redirects (pages) or answers 403
(APIs). Mixed VECTA + CaterLink identities, an external account with any canonical assignment, and non-active external
accounts fail closed. No decision uses an email address or user-editable metadata (the login-form heuristic was
removed and a closure test bans it).

## Database

`canon_is_active()` (migration `20261024000001`) no longer counts `caterlink_management`, so a CaterLink-only
identity reads no VECTA reference rows and has no VECTA own-record insert access. External accounts hold no
assignment, so every canonical policy returns nothing for them; they can read only their own `users` and `profiles` rows.

## Remaining gaps

- Legacy ICMS data tables (`incidents`, `vendor_transactions`, `part_*`) are absent on staging, so Driver/Vendor
  workflows render "not activated" there; Driver/Vendor transaction creation cannot be exercised on staging.
- Self-registration of external accounts (`registerUser`) is not enabled by the staging `public.users` table (no client
  write grant); provisioning is service-side.
