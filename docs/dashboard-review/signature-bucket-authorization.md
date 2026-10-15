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

* The `incident-photos` bucket still carries the same historical broad upload/read policies (`incident photos: authenticated upload/read`).
  They are outside this change and should get the same treatment.
* The nine unreferenced legacy `part-b/<ts>-<id>` objects on staging are not removed automatically.
* Staging verification scripts that fabricate signature names (`verify-storage-staging.mjs`, `e2e-external-workflows.mjs`,
  `verify-external-workflows-staging.mjs`, `targeted-part-b-probe.mjs`) must switch to the bound paths before any post-application run.
* Part C, Part D, HUB and REDQ signatures remain blocked until the process owner answers
  `docs/dashboard-review/part-c-owner-questions.md`.
