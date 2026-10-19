# Completed-forms bucket lockdown (migration 20261116000001)

## Defect
`supabase/migrations/icms/20260718000007_completed_form_pdf.sql` created two policies for role `public`:
`completed forms: authenticated upload` (insert) and `completed forms: authenticated read` (select), both `bucket_id = 'completed-forms' and auth.role() = 'authenticated'`.
Any signed-in account (Driver, Vendor, an officer at any station, any AOC) could upload any object into the private bucket and read and list every object in it.

## Producer / consumer inventory (re-confirmed before the change)
| Question | Finding |
|---|---|
| Writers in application code | `generateCompletedFormPdf()` (`lib/icms/completed-form-pdf.ts`) and `generateVendorCompletedFormPdf()` (`lib/icms/completed-form-pdf-vendor.ts`) call `uploadPdfBuffer("completed-forms", …)` with the caller's own session. **Both are exported but called by no route, server action, job or script.** The only importers of `completed-form-pdf.ts` take `runCaterlinkPdfJobs`, which writes with the service role to the separate `caterlink-final-pdfs` bucket. |
| Readers in application code | none. `signedUrl("completed-forms", …)` is never called and nothing reads `transactions.completed_form_url` (it appears only in generated types). |
| Database writers / functions | none reference the bucket. |
| Staging (read-only, `scripts/staging/inspect-incident-photos.mjs --bucket=completed-forms`) | bucket private, **0 objects**. Policies: the two broad ones above. |

`tests/completed-forms-lockdown.test.mts` fails if either generator is ever wired in or a reader appears, so a future caller must come with its own reviewed policy.

## Why the bucket is fail-closed
With no active producer or consumer there is no legitimate client workflow to preserve, and none is invented:
* both historical policies are dropped and **nothing replaces them**, so an authenticated or anonymous client can neither upload, read, list, move nor delete a completed-forms object (Storage RLS has no policy that allows it);
* no helper function is added, so there is nothing to grant, no `auth.role()` and no user-metadata authorization;
* the bucket stays private; nothing is deleted (any stored object is untouched);
* the trusted `service_role` bypasses RLS, which is what any future server-side generator must use.

If a client-side workflow is ever introduced it needs its own parent-bound policy; the signature and incident-photo rules do not carry over automatically.

## Matrix
| Actor | Upload | Read / list | Move / delete |
|---|---|---|---|
| Anonymous | denied | denied | denied |
| Any authenticated account (officer, Driver, Vendor, Management, Operation Manager, Main Enforcement, other AOC, pending / rejected / deactivated profile, revoked / expired / future assignment) | denied | denied (0 rows) | denied |
| `service_role` | allowed | allowed | allowed |

Verified by `supabase/tests/integration/verify_completed_forms_lockdown.mjs` (PGlite and native PostgreSQL) and by named probes in the guarded staging runner.
