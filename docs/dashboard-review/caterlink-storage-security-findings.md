# Storage policy findings (staging, 2026-10-06)

Two storage-policy problems were found while verifying the CaterLink external workflows. Neither is fixed on staging;
both repairs are prepared in `supabase/proposed-migrations/` (deliberately outside `supabase/migrations/` so nothing applies
them by accident) and need separate approval.

## 1. BLOCKER: every authenticated upload fails (pre-existing)

- Symptom: any signed-in user uploading to `signatures` (or `incident-photos`, `completed-forms`, `report-attachments`) gets
  `permission denied for function get_report_submitter`. Confirmed on staging for AVSEC officers, Operation Manager,
  CaterLink Management, Driver and Vendor.
- Cause: the policy `report attachments object insert` on `storage.objects` calls `get_report_submitter(...)` directly.
  `20260924000001_pre_upgrade_remediation.sql` revoked EXECUTE on that function from `authenticated`. PostgreSQL checks
  function privileges when it initialises the policy expression, even for a row in another bucket, so the whole INSERT fails.
- Effect: every UI step that stores a signature is BLOCKED: Driver transaction creation, Vendor delivery creation, the
  Part B security check and Vendor completion. The database functions themselves work (proven with signature path strings).
- Proposed fix: `20261026000001_storage_upload_policy_repair.sql`: a boolean SECURITY DEFINER wrapper
  `can_upload_report_attachment(name)` evaluating the same predicate; the policy now calls the wrapper. `get_report_submitter`
  stays unexecutable by clients; uploads to other buckets are unchanged; a report-attachment upload for a report the caller did
  not file is still refused. Reproduced and verified locally (`verify_storage_policies.mjs`).

## 2. OPEN SECURITY ISSUE: any authenticated user can read and list every signature

- Policy: `signatures: authenticated read` (`bucket_id = 'signatures' and auth.role() = 'authenticated'`), from
  `icms/20260101000002_rls.sql`. The same pattern exists for `incident-photos` and `completed-forms` (not changed in the proposal).
- Confirmed on staging with the real external accounts (`probe-signature-exposure.mjs`, temporary probe objects, removed afterwards):
  the Driver and the Vendor can **list** the bucket, **download** another party's object by path and **mint a signed URL** for it.
- Affected: all signature objects (movement Parts A-D/Hub/REDQ, vendor Parts A-C). Today the bucket is empty on staging because
  uploads fail (item 1), so no real signature is exposed yet; fixing item 1 without item 2 would start exposing them.
- Proposed minimum correction: `20261026000002_signature_read_scoping.sql`: read only if the object is the caller's own upload or a
  checkpoint row referencing it is visible to the caller (SECURITY INVOKER check, so the parent-transaction / delivery row-level
  security from `20261025000001` decides). Upload is unchanged.
- Compatibility: every current consumer (movement and vendor detail pages, archive export, final PDFs, receipt confirmation) reads a
  signature through a checkpoint row the same caller can already see, so those workflows are unaffected. A user listing the bucket
  sees only their own uploads and signatures of records they may see. Verified locally: Driver A/B and Vendor A/B each see only their
  own; Management sees all referenced; Operation Manager sees movement signatures; a PEN officer sees the vendor signatures it can
  check; unrelated officers and anon see none; orphan objects are invisible to clients.
- Recommended order: apply both together (repair 1 first), so that enabling uploads never exposes signatures.

## Other findings

- `has_station_assignment_for_transaction` (existing `transactions_read_policy`) ignores the profile status: a **pending, rejected or
  deactivated profile that still holds an active assignment at the movement's origin station can read that movement**, and through the
  new parent-visibility policies its seals and checkpoints. Revoked, expired and future-dated assignments are correctly denied.
  This predates the migration (the new policies inherit, and do not widen, the visibility). A fix (require an approved profile in that
  helper) is a separate hosted change and is not included.
