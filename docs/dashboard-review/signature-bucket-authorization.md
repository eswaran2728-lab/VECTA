# Signature bucket: upload authorization (migration 20261113000001)

## Defect

`supabase/migrations/icms/20260101000002_rls.sql` created the policy **"signatures: authenticated upload"**
(`bucket_id = 'signatures' and auth.role() = 'authenticated'`, applied to role `public`). Any signed-in account could therefore create any
object name anywhere in the private `signatures` bucket. Migration `20261111000001` bound only the `vendor-part-b/` prefix; every other
name passed through its restrictive policy unchanged, so arbitrary uploads (unknown prefixes, other parties' prefixes, path tricks) stayed possible.

Reads were already scoped (`20261026000002`: own upload, or a visible checkpoint references the object) and are unchanged.

## Inventory (producers and consumers)

All producers upload from a **server action with the caller's own session**, so Storage RLS applies. The browser sends only the image
(a base64 data URL); it never supplies a bucket, path or name. There is no mobile/offline upload path (`/api/icms/sync` handles no signatures).

| # | Workflow (file) | Actor / role | Parent at upload time | Required scope / state | Referencing row | Format (new) |
|---|---|---|---|---|---|---|
| 1 | Driver creates a movement, Part A (`lib/icms/actions/transactions.ts` `createTransaction`) | active external Driver (`warehouse_pic`) | none yet | own account id | `caterlink_checkpoint_part_a` | `part-a/<uid>/<uuid>.<ext>` |
| 2 | Officer records Part B (`completePartB`) | station operator with scan capability, on duty | `transactions` row | active assignment at origin/destination station, AOC, not Staff Profiling; status `CREATED` (outbound) / `AIRPORT_POST_APPROVED` (inbound); no Part B yet | `part_b_c` (stage B) | `part-b/<transaction>-<uuid>.<ext>` |
| 3 | Destination receipt (`lib/avsec/caterlink/receipt.ts`) | officer who may confirm receipt at the movement's trusted destination | `transactions` row | `can_user_confirm_caterlink_receipt`, receipt-ready status, sender separation | `caterlink_checkpoint_hub` | `receipt/<transaction>/<uuid>.<ext>` |
| 4 | Vendor creates a delivery, Part A (`createVendorTransaction`) | active external Vendor | none yet | own account id | `caterlink_vendor_checkpoints` stage A | `vendor-signatures/<uid>/<uuid>.<ext>` |
| 5 | Officer security-checks a delivery, vendor Part B (`submitVendorPartB`) | station operator, vendor-check capability | `caterlink_vendor_deliveries` | delivery's station + AOC, status `CREATED` | stage B | `vendor-part-b/<delivery>/<uuid>.<ext>` |
| 6 | Vendor completes a delivery, vendor Part C (`submitVendorPartC`) | owning Vendor | `caterlink_vendor_deliveries` | `vendor_user_id` = caller, status `SECURITY_VERIFIED`, no stage C yet | stage C | `vendor-part-c/<delivery>/<uuid>.<ext>` |
| – | Part C / Part D / HUB / REDQ legacy forms | no writer exists (workflows await the process owner) | – | – | `part_b_c` stage C, `caterlink_checkpoint_part_d`, `caterlink_checkpoint_redq` | **blocked**: no signature reference is accepted |

`<ext>` is `png`, `jpg` or `webp` (lower case only); `<uuid>` is a lower-case hex UUID.

Consumers (all read-only, unchanged): transaction and vendor detail pages and the archive export (`signedUrl("signatures", …)` through the
caller's session, authorised by `caterlink_signature_visible`), `lib/icms/completed-form-pdf*.ts` (signed URLs / service role), the final-PDF
jobs. The service role is used only to remove an unreferenced object and to list orphans.

## Staging inventory (read-only; normalised prefixes and counts only)

`node --env-file=.env.local scripts/staging/inspect-signature-bucket.mjs` (a `READ ONLY` transaction, rolled back):

| Normalised prefix | Objects | Referenced by a checkpoint |
|---|---:|---:|
| `part-b/<ts>-<id>.<ext>` (legacy flat name) | 9 | 0 |
| `vendor-signatures/<ts>-<id>.<ext>` | 6 | 6 |
| `vendor-part-b/<ts>-<id>.<ext>` (legacy flat name) | 5 | 5 |
| `vendor-part-c/<ts>-<id>.<ext>` | 3 | 3 |
| `part-a/<ts>-<id>.<ext>` | 2 | 2 |
| `e2e-probe/<label>-<n>.<ext>` (earlier staging verification) | 4 | 4 |
| **Total** | **29** | |

Every object has a non-null `owner`. Policies on staging before this migration: `[INSERT] signatures: authenticated upload` (role `public`) and
`[SELECT] signatures: scoped read`. Historical names keep working for **reads**; nothing is renamed or deleted. The nine unreferenced legacy
`part-b/<ts>-<id>` objects are leftovers of refused saves; they are not touched here (a data decision for the owner).

## Effective policy matrix

| | Before | After |
|---|---|---|
| INSERT | `signatures: authenticated upload` (any signed-in user, any name) + restrictive `vendor-part-b/` binding | `signatures: workflow upload` (role `authenticated`; `owner = auth.uid()` **and** `caterlink_signature_upload_allowed(name)`) + the unchanged restrictive `vendor-part-b/` policy |
| UPDATE / DELETE | none for clients | none for clients (no overwrite, move, upsert or removal) |
| SELECT | `signatures: scoped read` | unchanged |
| Unknown prefix / flat legacy name / traversal / double separator / upper-case or other extension / arbitrary file name | allowed | **denied** |
| Anonymous | denied (`auth.role()`) | denied (no policy for `anon`) |
| `service_role` | bypasses RLS | unchanged (trusted removal and reconciliation only) |

No authorization uses `user_metadata` or `auth.role()`. Every `SECURITY DEFINER` helper checks `auth.uid()`, sets `search_path`, revokes
`PUBLIC`/`anon` and grants only `authenticated` (upload helpers) or `service_role` (reference check, orphan listing).

## Finalisation binding

`caterlink_signature_owner_guard()` (the trigger already on the six checkpoint tables) now requires the stored reference to be the bound path for
**that table, row parent and actor**, and to point at an object that exists, is owned by the actor and is less than 20 minutes old (the
orphan reconciliation floor is 30 minutes, so a reference can never adopt an object that is being removed). A checkpoint that cannot carry a
signature workflow (Part C, Part D, REDQ) rejects any signature reference.

## Failure cleanup

* The path is server-derived; a refused upload leaves nothing (Storage RLS rejects the insert).
* A **returned** database refusal (or a Part B result that did not create a new record) removes exactly that object (`settleSignature`,
  service role, only if no checkpoint references it).
* A **thrown** failure, or a transport failure returned as an error object (status 0 / no SQLSTATE, e.g. a timeout), is ambiguous (the
  transaction may still commit), so the object is kept; the scheduled reconciliation decides.
* An officer who already recorded Part B may submit again: the upload is accepted, the RPC answers `ALREADY_RECORDED`, and the new object is
  discarded because that result did not create a new record. Any other officer is refused once Part B exists.
* `GET /api/icms/vendor-signature-reconcile` (daily Vercel Cron, `CRON_SECRET`, fails closed) lists objects older than 30 minutes under any
  approved prefix that no checkpoint references (`list_orphan_signatures_secure`, service role only), re-checks every path
  (`caterlink_signature_referenced`) and removes them.

## Limitations

* The `incident-photos` and `completed-forms` buckets that carried the same historical policies are locked down by migrations 20261114000001 and 20261116000001.
* The nine unreferenced legacy `part-b/<ts>-<id>` objects on staging are not removed automatically.
* Staging verification scripts that fabricate signature names (`verify-storage-staging.mjs`, `e2e-external-workflows.mjs`,
  `verify-external-workflows-staging.mjs`, `targeted-part-b-probe.mjs`) must switch to the bound paths before any post-application run.
* Part C, Part D, HUB and REDQ signatures remain blocked until the process owner answers
  `docs/dashboard-review/part-c-owner-questions.md`.

## Hardening (migration 20261115000001) and the second independent review

A second, fresh review of the implementation found no bypass of the upload policy or the finalisation guard and no cross-station / cross-AOC /
cross-entity gap between the helpers and the RPCs they mirror. It recorded residual risks, handled as follows:

| Finding | Disposition |
|---|---|
| A 5xx gateway failure (no SQLSTATE) was treated as a definite refusal, so a committed signature could be deleted | **Fixed.** Status 0, any 5xx, or a transport-fault message without a SQLSTATE is ambiguous: the object is kept for reconciliation (`isAmbiguousTransportError`). |
| One object could back more than one row of the same actor (Part A / vendor creation are actor-bound) | **Fixed.** `caterlink_signature_refs` (primary key, RLS on, no client grant) makes every object single-use, atomically, including under concurrent inserts. |
| Reconciliation capacity: 200 per run, a stuck head starved the rest, an account could create unlimited leftovers | **Fixed.** `list_orphan_signatures_secure(minutes, offset)` orders by (created_at, name) and pages; the cron route pages up to 20 times per run, advancing past rows that could not be removed; the upload policy refuses an account that already has 30 UNREFERENCED objects created in the last hour (leftovers only; objects backing a real checkpoint never count, so a busy officer is not blocked; the check bounds abuse rather than being an atomic gate, so concurrent uploads at the limit can overshoot by the concurrency level). |
| Object content was bounded only by its file name | **Fixed where the platform allows.** The bucket is limited to 5 MB and image/png, image/jpeg, image/webp. |
| `ON CONFLICT DO UPDATE` on the receipt can leave an unreferenced object | **Fixed.** After every successful call the application verifies the reference and removes an unreferenced object (an unknown reference state is never deleted). |
| Structural policy check only saw policies containing the word "signatures" | **Fixed.** The runner now enumerates every permissive write policy on `storage.objects`, requires each to name a bucket, and requires that the only one reaching the signatures or incident-photos bucket is `signatures: workflow upload`. |

### Intentional limitations
* A signed upload URL minted before authority is lost can create an object afterwards (platform behaviour). Finalisation re-authorises, so the effect is an
  orphan removed by reconciliation.
* The stored `signature_hash` is supplied by the application and is not compared with the object's bytes.
* The policy and guard compare `storage.objects.owner` (uuid). If a hosted Storage version stopped populating it, uploads and finalisation would fail closed
  (availability, not security). Staging has no object with a null owner.
* Reconciliation runs daily (Vercel Hobby allows only daily crons). Capacity is up to 20 pages of 200 per run, and an account cannot hold more than ~30
  unreferenced objects created within an hour, so the backlog is bounded. **Business decision for the process owner:** whether 30 per hour is the right
  limit for the busiest receipt/Part B officers (it only counts unreferenced leftovers, so normal work never reaches it) and whether more than daily
  reconciliation is wanted once the project leaves the Hobby plan.
* The nine unreferenced legacy `part-b/<ts>-<id>` objects on staging are not removed (no authorisation was given).
* Part C, Part D, HUB and REDQ signatures stay blocked pending the owner decisions in `part-c-owner-questions.md`.

### Test note: the native `verify_phase8_concurrency_round2_native` count (21 vs 22)
The suite races a case resolve against a reopen. The assertion block is branch-dependent by design: if the reopen wins the race it asserts one fact,
if it loses it asserts two (denial message and final state). Both outcomes are valid, so 21 or 22 passing assertions are both correct and neither
is a flake. It is not a defect.

### Staging verification scripts
The four staging scripts (`verify-storage-staging.mjs`, `e2e-external-workflows.mjs`, `verify-external-workflows-staging.mjs`, `targeted-part-b-probe.mjs`) now upload
every fixture signature through the actor's own session to a parent-bound path (`scripts/staging/lib/signature-fixtures.mjs`), use a fresh object per record, and
test BOTH gates for an unauthorised actor (the Storage upload, then the RPC with a well-formed bound path that carries no object, so the RPC's own check answers).
A refusal is credited only when it is a genuine authorization refusal, and a named expected rule is required when given. Fixture/setup faults are counted
separately and end the run with exit code 2 (never a pass); a failed control ends it with exit code 1 even if a later setup fault occurs. Each run removes only the
unreferenced objects it created itself (decided by the database's own reference check), so repeated runs do not consume the hourly quota. These scripts
require the migrations to be applied and have NOT been executed in this phase (no live application is authorised).
