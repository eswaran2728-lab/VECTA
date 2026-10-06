-- PROPOSED (not applied): repair the storage upload policy that currently blocks EVERY authenticated upload.
--
-- Defect (confirmed on staging 2026-10-06): the policy "report attachments object insert" on storage.objects calls
-- get_report_submitter(...) directly. 20260924000001_pre_upgrade_remediation.sql revoked EXECUTE on that function from
-- authenticated, and PostgreSQL checks function privileges when it initialises the policy expression -- even for a row in
-- another bucket -- so every INSERT into storage.objects by an authenticated user fails with
-- "permission denied for function get_report_submitter". Signatures, incident photos, completed forms and report
-- attachments are all affected, which blocks every signature-based CaterLink workflow in the UI.
--
-- Minimum fix: evaluate the SAME predicate through a boolean SECURITY DEFINER wrapper that authenticated may execute,
-- and point the policy at it. The predicate, the bucket restriction and the path convention are unchanged; the function
-- returns only true/false, so get_report_submitter itself stays unexecutable by clients.

create or replace function public.can_upload_report_attachment(p_object_name text)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select exists (
    select 1
    from public.get_report_submitter(
      (storage.foldername(p_object_name))[1],
      nullif((storage.foldername(p_object_name))[2], '')::uuid
    ) sub
    where sub.profile_id = auth.uid()
  );
$function$;
revoke execute on function public.can_upload_report_attachment(text) from public, anon;
grant execute on function public.can_upload_report_attachment(text) to authenticated, service_role;

drop policy if exists "report attachments object insert" on storage.objects;
create policy "report attachments object insert" on storage.objects for insert
  with check (
    bucket_id = 'report-attachments'
    and public.can_upload_report_attachment(name)
  );
