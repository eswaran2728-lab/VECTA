# Route / Navigation Closure

## Method

`find app -name "page.tsx"` → 87 pages. `grep -rl "requireRole\|requireProfile"` →
67 of them. The other 20 were individually inspected (not assumed gapped)
to confirm each has SOME legitimate server-side gate:

| Pattern | Pages using it | Example |
|---|---|---|
| `requireRole`/`requireProfile` (`lib/avsec/auth.ts`) | 67 | most AVSEC pages |
| `requirePhase8Role` (`lib/phase8/auth.ts`) | `enforcement/workforce`, `investigation/cases[/[id]]`, `profiling/workspace`, `sat/reports` | scoped-role AVSEC pages built alongside Phase 8 |
| `isSuperAdmin()` + manual `redirect()` | `super-admin/page.tsx`, `super-admin/readiness/page.tsx` | Super Admin pages |
| Inline session + profile check, no shared helper | `scan/page.tsx` (checks `unified_role`/`ops_group` directly, delegates the real scope check to `scanTransaction()` server action) | — |
| Supabase Auth's own session requirement | `auth/update-password/page.tsx` (`supabase.auth.updateUser()` itself fails without an active session — the security boundary is Supabase Auth, not this repo's code) | — |
| Genuinely public, by design | `login`, `register`, `forgot-password`, `reset-password`, `app/page.tsx`, `pending-approval` (reachable only by a signed-in-but-unapproved user, which it itself checks and redirects on) | — |
| ICMS pages (separate module, `lib/icms/auth.ts`) | 6 ICMS `page.tsx` files | out of this audit's scope (confirmed separate app) |

**Finding: no page.tsx was found with zero server-side gate and non-public
content.** The gate mechanism is not unified (5 different patterns), which
is worth consolidating in a future phase, but no actual authorization hole
was found this round.

## What "no UI hiding is treated as security" means here, confirmed

Every one of the gate patterns above is a **server component** `redirect()`
or a **server action's** own RLS/RPC check — none of them is "the nav link
is just not rendered." A direct URL hit re-runs the same server-side gate
every time (confirmed by reading the pattern, not by manually hitting every
URL in a browser this round — see "Known limitations").

## Closure test added this phase

`tests/phase13-route-closure.test.mts` (static source scan, not a live
HTTP test): asserts every `page.tsx` under `app/` either matches one of
the five known gate patterns above, is in the explicit public allowlist,
or is under `app/(icms)` — and fails loudly, naming the offending file, if
a new page is ever added with none of those. This turns today's manual
finding into a standing guard against regression, per this phase's
"closure tests that fail if unsafe patterns reappear" requirement.

## Explicitly NOT verified this round

- Live direct-URL hits in a running browser against every route (87 pages
  × however many roles — not attempted; the static-gate-presence check
  above is a proxy, not a substitute).
- Mobile navigation reachability for every permitted function.
- Dead links / duplicate-obsolete-page-replacing-a-new-secure-page (would
  require diffing navigation menus against the route list, not performed
  this round).
- Compatibility-user (legacy MANAGEMENT/ADMIN) access scope beyond what
  `legacy-transition-inventory.md` already covers.
