-- Repair actual ASO UI/database compatibility without rewriting historical reports.
-- Historical SEC029 wording remains valid; only the two exact current Rev.03 declarations are added.
alter table public.report_sec029 drop constraint report_sec029_declaration_check;
alter table public.report_sec029 add constraint report_sec029_declaration_check check (declaration in (
  'I CERTIFY THAT THE ABOVE CHECKS HAVE BEEN CARRIED OUT AND NO DISCREPANCY WAS FOUND.',
  'DISCREPANCIES FOUND AND DUTY OFFICER IS NOTIFIED (PROVIDE DETAILS BELOW)',
  'I CERTIFY THAT THE ABOVE SEARCH HAS BEEN CARRIED OUT AND NO DISCREPANCY WAS FOUND.',
  'DISCREPANCIES FOUND AND DUTY SECURITY EXECUTIVE / DUTY OFFICER IS NOTIFIED (PROVIDE DETAILS BELOW).'
));

-- The contract promises text, while the canonical source column is TIME.
CREATE OR REPLACE FUNCTION public.report_source_summary(p_source_table text, p_source_id uuid)
 RETURNS TABLE(staff_name text, station text, team text, secondary_identifier text, reg_no text, bay_no text, sta_std text, submitter_profile_id uuid)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if p_source_table = 'report_sec013' then
    return query select t.staff_name, t.station, t.team, null::text, null::text, null::text, null::text, t.profile_id from public.report_sec013 t where t.id = p_source_id;
  elsif p_source_table = 'report_sec014' then
    return query select t.staff_name, t.station, t.team, null::text, null::text, null::text, null::text, t.profile_id from public.report_sec014 t where t.id = p_source_id;
  elsif p_source_table = 'report_sec016' then
    return query select t.staff_name, t.station, t.team, ('Flight ' || coalesce(t.flight, '?') || ' · Reg ' || coalesce(t.reg_no, '?')), t.reg_no, t.bay_no, t.sta_std::text, t.profile_id from public.report_sec016 t where t.id = p_source_id;
  elsif p_source_table = 'report_sec018' then
    return query select t.staff_name, t.station, t.team, null::text, null::text, null::text, null::text, t.profile_id from public.report_sec018 t where t.id = p_source_id;
  elsif p_source_table = 'report_sec029' then
    return query select t.staff_name, t.station, t.team, ('Flight ' || coalesce(t.flight_no, '?') || ' · Reg ' || coalesce(t.aircraft_registration, '?')), t.aircraft_registration, null::text, null::text, t.profile_id from public.report_sec029 t where t.id = p_source_id;
  elsif p_source_table = 'report_sec033' then
    return query select t.staff_name, t.station, t.team, null::text, null::text, null::text, null::text, t.profile_id from public.report_sec033 t where t.id = p_source_id;
  elsif p_source_table = 'offload_records' then
    return query select t.staff_name, t.station, t.team, ('Flight ' || coalesce(t.flight_no, '?') || ' · ' || coalesce(t.destination, '?')), null::text, null::text, null::text, t.profile_id from public.offload_records t where t.id = p_source_id;
  elsif p_source_table = 'report_makeup' then
    return query select t.staff_name, t.station, t.team, ('Flight ' || coalesce(t.flight_number, '?') || ' · ' || coalesce(t.destination, '?')), null::text, null::text, null::text, t.profile_id from public.report_makeup t where t.id = p_source_id;
  elsif p_source_table = 'report_breakup' then
    return query select t.staff_name, t.station, t.team, ('Flight ' || coalesce(t.flight_number, '?') || ' · ' || coalesce(t.origin, '?')), null::text, null::text, null::text, t.profile_id from public.report_breakup t where t.id = p_source_id;
  else
    raise exception 'Unsupported source_table: %', p_source_table;
  end if;
end;
$function$
;

-- Add one explicit movement field to the same caller-owned list. No caller-supplied profile id.
-- Drop is RESTRICT (no CASCADE), because PostgreSQL cannot add an OUT column with CREATE OR REPLACE.
drop function public.list_my_submissions_secure(integer);
create function public.list_my_submissions_secure(p_limit integer default 20)
returns table(id uuid, source_table text, report_no text, status text, submitted_at timestamptz, created_at timestamptz, staff_name text, station text, team text, secondary_identifier text, flight_type text)
language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 200);
begin
  if auth.uid() is null then raise exception 'Must be signed in.'; end if;
  return query
  with mine as (
    select 'report_sec013'::text as source_table, t.id, t.report_no, lower(t.status::text) as status, t.submitted_at, t.created_at, null::text as flight_type from public.report_sec013 t where t.profile_id = auth.uid()
    union all
    select 'report_sec014', t.id, t.report_no, lower(t.status::text), t.submitted_at, t.created_at, null::text from public.report_sec014 t where t.profile_id = auth.uid()
    union all
    select 'report_sec016', t.id, t.report_no, lower(t.status::text), t.submitted_at, t.created_at, t.flight_type::text from public.report_sec016 t where t.profile_id = auth.uid()
    union all
    select 'report_sec018', t.id, t.report_no, lower(t.status::text), t.submitted_at, t.created_at, null::text from public.report_sec018 t where t.profile_id = auth.uid()
    union all
    select 'report_sec029', t.id, t.report_no, lower(t.status::text), t.submitted_at, t.created_at, null::text from public.report_sec029 t where t.profile_id = auth.uid()
    union all
    select 'report_sec033', t.id, t.report_no, lower(t.status::text), t.submitted_at, t.created_at, null::text from public.report_sec033 t where t.profile_id = auth.uid()
    union all
    select 'offload_records', t.id, t.report_no, lower(t.status::text), t.submitted_at, t.created_at, null::text from public.offload_records t where t.profile_id = auth.uid()
    union all
    select 'report_makeup', t.id, t.report_no, lower(t.status::text), t.submitted_at, t.created_at, null::text from public.report_makeup t where t.profile_id = auth.uid()
    union all
    select 'report_breakup', t.id, t.report_no, lower(t.status::text), t.submitted_at, t.created_at, null::text from public.report_breakup t where t.profile_id = auth.uid()
  )
  select m.id, m.source_table, m.report_no, m.status, m.submitted_at, m.created_at, s.staff_name, s.station, s.team, s.secondary_identifier, m.flight_type
  from mine m
  cross join lateral public.report_source_summary(m.source_table, m.id) s
  order by m.created_at desc, m.id
  limit v_limit;
end;
$function$;
revoke execute on function public.list_my_submissions_secure(integer) from public, anon;
grant execute on function public.list_my_submissions_secure(integer) to authenticated, service_role;
