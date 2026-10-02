# VECTA Staging Test-Account & UAT Fixture Tooling

Scripts in this directory provision/tear down staging test accounts and
(partially) synthetic UAT fixture data for dashboard review. **Every
script defaults to a read-only/dry-run mode and refuses to touch any
hosted project at all unless every one of the following is true:**

- `VECTA_ALLOW_STAGING_PROVISIONING=true` is set exactly (not "1", not
  "yes" — exactly the string `true`).
- `VECTA_APPROVED_STAGING_PROJECT_REF` is set to the exact Supabase
  project reference the operator has confirmed is the disposable staging
  project — never guessed, never defaulted.
- `SUPABASE_SERVICE_ROLE_KEY` is set. There is no fallback; no script in
  this directory will ever use the anon key or invent a credential.
- The resolved project reference does not match
  `VECTA_PRODUCTION_PROJECT_REF` (if set) or any other hardcoded
  known-production reference in `lib/env-guard.mjs`.

All four checks live in exactly one place — `lib/env-guard.mjs`'s
`resolveStagingAdminContext()` — so every script in this directory shares
the same gate rather than re-implementing it.

## Scripts

| Script | Purpose | Default | Live flag |
|---|---|---|---|
| `provision-test-accounts.mjs` | Creates one account for each of the 23 unique approved Phase 3 role codes, labeled station-role variants (KUL/PEN/JHB/no-CaterLink-station), and seven dedicated negative-state accounts | `--dry-run` (prints the plan, makes no network call) | `--live --email-domain=<operator-approved-domain>` |
| `teardown-test-accounts.mjs` | Deletes accounts matching the `vecta.uat.` prefix AND an exact `--run-id` | `--dry-run` (lists what would be deleted) | `--live` |
| `seed-uat-fixtures.mjs` | Synthetic UAT data for dashboard review, tagged `[UAT:<run-id>]` | `--dry-run` | `--live --as-profile-id=<id>` (announcements only this round — see the script's own output for what else is NOT implemented) |

## Credentials and manifests

`provision-test-accounts.mjs --live` writes a credentials file (role,
email, one-time password, full scope, expected landing page) and a
recovery manifest to `os.tmpdir()/vecta-staging-credentials/` by default
— **outside this repository** — or to `--credentials-dir=<path>` if the
operator specifies a different operator-approved location (still never
inside the repository). Both are `0600`-mode files. `.gitignore` also
defensively excludes `*staging-credentials*.json` / `*staging-manifest*.json`
in case either is ever written inside the repo by mistake.

**Passwords are never printed to stdout, never logged, never written to
any committed file, and never stored as account/profile metadata in the
database.** Each account gets its own independently random 32-character
password (`crypto.randomBytes(24).toString("base64url")` — well above
the required 20-character minimum).

## Idempotency

Every create step checks for an existing row first (by email for the
auth user, by profile id for the profile, by `(profile_id, aoc_id,
operating_entity_id, status)` for entity memberships, by `(profile_id,
role_definition_id, revoked_at)` for role assignments) and skips with
`EXISTS` rather than creating a duplicate. Re-running
`provision-test-accounts.mjs --live` with the same `--run-id` is safe.

## What this tooling does NOT do

- It does not weaken RLS, disable the `validate_user_role_assignment_scope`
  or `validate_assignment_entity_membership` triggers, or insert a role
  assignment shape those triggers would reject for a real user — every
  scope resolved in `lib/role-matrix.mjs` is transcribed directly from
  those trigger functions.
- It does not invent a mailbox domain — `--email-domain` must be passed
  explicitly every time.
- It does not create a second AOC for the foreign-AOC negative-state
  account if one doesn't already exist in the target project; it skips
  that one account with a clear message instead.
- It does not delete the bootstrap Super Admin account under any
  circumstance — it isn't in the `vecta.uat.` prefix, so `teardown-test-accounts.mjs`
  structurally cannot touch it.
