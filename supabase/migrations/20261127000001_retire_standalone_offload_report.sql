-- Retire STANDALONE Offload Information creation (owner decision, 2026-10).
--
-- Offload Information is part of the SEC016 Departure Attending Report: report_sec016 carries its own offload section, fields and
-- validation, and that path is untouched. The separate offload_records report was a second way to file the same information and is no
-- longer a creatable form. This migration closes it at the database boundary, not just in the UI:
--
--   * can_create_report_form('offload') is false for every caller, so the BEFORE INSERT trigger on offload_records
--     (trg_enforce_form_assignment) refuses a standalone insert from any authenticated session.
--   * list_my_report_forms_secure() no longer offers 'offload'.
--   * Existing 'offload' rows in report_form_assignments are REVOKED (revoked_at set), not deleted, so the history of who could file
--     it is kept.
--
-- Nothing is dropped or rewritten: offload_records, offload_items, their report-repository index rows, attachments, exports and audit
-- entries stay exactly as they were and remain readable through the existing secure report access (view / PDF / Excel). The service
-- role still bypasses the trigger (auth.role() <> 'authenticated'), which is how any future owner-approved data correction would run.
-- The form_type CHECK keeps accepting 'offload' so the revoked rows remain valid.

create or replace function public.can_create_report_form(p_form text)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select p_form <> 'offload'
    and exists (
      select 1
      from public.report_form_assignments a
      join public.get_my_active_role_assignments() r on r.role_code = a.role_code
      where a.revoked_at is null
        and a.form_type = p_form
        and (a.profile_id is null or a.profile_id = auth.uid())
        and (a.station_code is null or a.station_code = r.station_code)
    );
$function$;
revoke execute on function public.can_create_report_form(text) from public, anon;
grant execute on function public.can_create_report_form(text) to authenticated, service_role;

create or replace function public.list_my_report_forms_secure()
returns table (form_type text)
language sql
stable
security definer
set search_path to 'public'
as $function$
  select f from unnest(array['sec016', 'sec014', 'sec029', 'sec018', 'sec033', 'sec013']) as f
  where public.can_create_report_form(f);
$function$;
revoke execute on function public.list_my_report_forms_secure() from public, anon;
grant execute on function public.list_my_report_forms_secure() to authenticated, service_role;

update public.report_form_assignments
   set revoked_at = now()
 where form_type = 'offload'
   and revoked_at is null;
