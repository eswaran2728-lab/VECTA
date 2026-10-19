-- Completed-forms bucket: remove the unrestricted authenticated upload and read policies (additive).
--
-- Defect: supabase/migrations/icms/20260718000007_completed_form_pdf.sql created, for role public,
--   "completed forms: authenticated upload"  (insert, bucket_id = 'completed-forms' and auth.role() = 'authenticated')
--   "completed forms: authenticated read"    (select, same condition)
-- so ANY signed-in account could upload any object into the private bucket and read and list every object in it.
--
-- Inventory (application code and staging): no active producer and no active consumer.
--   * The only writers, generateCompletedFormPdf() and generateVendorCompletedFormPdf() (lib/icms/completed-form-pdf*.ts), are exported but are
--     called by NO route, action, job or script; the live CaterLink PDF flow (runCaterlinkPdfJobs) writes with the service role to the separate
--     caterlink-final-pdfs bucket.
--   * Nothing reads transactions.completed_form_url or signs a completed-forms object.
--   * Staging holds 0 objects in the bucket.
--
-- Correction (fail closed): both policies are removed and NOTHING replaces them. With no policy for the bucket, an authenticated or anonymous
-- client can neither upload, read, list, move nor delete a completed-forms object. The trusted service role is unaffected (it bypasses RLS), which is
-- what any future server-side generator must use. No helper function is added, so there is nothing to grant. The bucket stays private. Nothing is
-- deleted: any object already stored is untouched.
-- If an active client-side workflow is ever introduced it needs its own reviewed, parent-bound policy; the signature and incident-photo rules do not
-- carry over automatically.

drop policy if exists "completed forms: authenticated upload" on storage.objects;
drop policy if exists "completed forms: authenticated read" on storage.objects;
