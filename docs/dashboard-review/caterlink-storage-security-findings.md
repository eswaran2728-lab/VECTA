# Storage policy findings and repairs (staging, 2026-10-06)

## Status

| Item | Status |
|---|---|
| Authenticated uploads failed (`get_report_submitter`) | **FIXED on staging** by `20261026000001_storage_upload_policy_repair.sql` |
| Any authenticated user could read/list every signature | **FIXED on staging** by `20261026000002_signature_read_scoping.sql` |
| Pending/rejected/deactivated profiles read movements | **OPEN** — proposed repair prepared, NOT applied (see below) |

Both storage repairs were applied together, in order, in ONE transaction by `scripts/staging/apply-storage-repairs.mjs`
(hash-pinned migration files, exact pre-state, in-transaction real-role probes, fail closed). SHA-256:
`20261026000001` = `8d241df18648625478f60b38156c5bf651fcbbff9135a96b87cbe8770dc5d093`,
`20261026000002` = `68d0b69a1cd80b7d7bb9e689475d525a8ce8564914f75b3c5fe2810a652d31a6`.
Staging history: 65 migrations (last `20261025000001`) -> 67 (last `20261026000002`).

## 1. Upload defect (fixed)

The policy `report attachments object insert` on `storage.objects` called `get_report_submitter(...)` directly, but
`20260924000001_pre_upgrade_remediation.sql` had revoked EXECUTE on it from `authenticated`. PostgreSQL checks function privileges
when it initialises the policy expression, even for rows in other buckets, so every authenticated INSERT failed. Repair 1 adds
`public.can_upload_report_attachment(name)`: boolean, SECURITY DEFINER, `search_path` pinned to `public`, EXECUTE for
`authenticated`/`service_role` only (not anon/PUBLIC); the policy now calls it. It returns only true/false about the caller's own
filing right. `get_report_submitter` stays unexecutable by authenticated, anon and PUBLIC (asserted locally and in the staging runner).

## 2. Signature read exposure (fixed)

`signatures: authenticated read` allowed any authenticated user to list, download and sign any signature object (demonstrated on
staging with the real Driver and Vendor accounts before the fix). Repair 2 replaces it with
`signatures: scoped read` (`to authenticated`): readable only if `owner = auth.uid()` (the uploader) OR a checkpoint row that
references the object is visible to the caller (`caterlink_signature_visible(name)`, SECURITY INVOKER, so the parent-transaction /
delivery row-level security decides). Upload is unchanged; there is no UPDATE or DELETE policy, so overwrite and delete are denied.
A write-side guard (`caterlink_signature_owner_guard`, BEFORE INSERT on the six checkpoint tables) refuses a record that references a
signature object uploaded by a different account, so a reference cannot be used to unlock someone else's object. No authorization
uses email, filenames, client-supplied roles or UI state.

Compatibility: every consumer of the bucket (movement and vendor detail pages, archive export, final PDFs, receipt confirmation) reads
a signature through a checkpoint row the same caller can already see. The `incident-photos` and `completed-forms` buckets carry the
same broad-read pattern and were **not** changed (no current CaterLink workflow stores signatures there); they remain a follow-up.

## Verification

- Local: `verify_storage_policies.mjs` 57 assertions, 0 failures (the original 23 retained): defect reproduced; repairs applied; same-user
  and cross-user INSERT / SELECT (list) / download / signed-URL authorisation / UPDATE / DELETE for Driver A/B, Vendor A/B, Management,
  Operation Manager, AVSEC officer, unrelated officer, no-role account, Staff Profiling and anon; write-side guard.
- Staging, in the runner transaction (rolled back): real Driver, Vendor, officer, Management and anon roles.
- Staging, real accounts through the Storage API (`verify-storage-staging.mjs`): see the final report matrix.

## 3. OPEN: pending / rejected / deactivated profiles can read movements

- Helper: `public.has_station_assignment_for_transaction(aoc, destination_station, origin_station)` — checks station, AOC, revocation and
  dates, **not `profiles.status`**. (`has_role_in_scope` / `has_active_role_for_aoc`, the other branches of the same policy, do require
  `p.status = 'approved'`.)
- Policy: `transactions_read_policy` (its station-staff branch) is the only user of the helper. Through the parent-visibility policies of
  `20261025000001` the same people also read that movement's `seals`, `seal_verifications` and `caterlink_checkpoint_*` / `part_b_c` rows.
- Who: any holder of an active station-scoped assignment (sso/so/aso/dse, and any other role carrying a `station_id`, e.g. Staff Profiling)
  whose profile is pending, rejected or deactivated, for movements originating at or destined for their station.
- Why it passes: the helper never joins `profiles`. Revoked, expired and future-dated assignments are denied because the helper tests them.
- Browser note: the app's own guard redirects such profiles to `/avsec/pending-approval`, so the flaw is reachable through the REST API
  (their own JWT), not through the UI. Reproduction: `scripts/staging/reproduce-profile-state-flaw.mjs` (read-only) —
  pending, rejected and deactivated accounts read the movement, Part A and seals; revoked, expired and future accounts do not.
- Proposed minimum repair (NOT applied): `supabase/proposed-migrations/20261027000001_station_visibility_requires_approved_profile.sql`
  adds `join profiles p ... and p.status = 'approved'` to the helper; signature, SECURITY DEFINER, volatility, `search_path` and grants
  unchanged; no policy edited. Validated locally by `verify_profile_state_visibility.mjs` (16 assertions): flaw reproduced; after the
  repair pending/rejected/deactivated are denied, approved officers, Management, Operation Manager and the creating Driver unaffected;
  access follows profile state immediately; idempotent; scan decision untouched.
- Compatibility: only the profile-state check is added. No current workflow depends on a non-approved profile reading movements.
  Approved, active station staff are unaffected. Separate approval is required before it is applied.
