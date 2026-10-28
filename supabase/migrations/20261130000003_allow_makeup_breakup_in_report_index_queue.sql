-- Forward migration to allow 'report_makeup' and 'report_breakup' in report_index_queue and resume_report_submission_secure.
-- Baseline: 105 -> 106.

-- 1. Align report_index_queue check constraint with central_reports_index
alter table public.report_index_queue drop constraint if exists report_index_queue_source_table_check;
alter table public.report_index_queue add constraint report_index_queue_source_table_check
  check (source_table in (
    'report_sec013', 'report_sec014', 'report_sec016', 'report_sec018',
    'report_sec029', 'report_sec033', 'offload_records', 'report_makeup', 'report_breakup'
  ));

-- 2. Update resume_report_submission_secure to support report_makeup and report_breakup
create or replace function public.resume_report_submission_secure(p_source_table text, p_source_id uuid, p_child_rows jsonb default '[]'::jsonb)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_owner uuid;
  v_actual_children integer;
begin
  if auth.uid() is null then
    raise exception 'Must be signed in.';
  end if;
  if p_source_table not in (
    'report_sec013', 'report_sec014', 'report_sec016', 'report_sec018',
    'report_sec029', 'report_sec033', 'offload_records', 'report_makeup', 'report_breakup'
  ) then
    raise exception 'Unsupported source_table: %', p_source_table;
  end if;

  if p_source_table = 'report_sec013' then
    select profile_id into v_owner from public.report_sec013 where id = p_source_id for update;
  elsif p_source_table = 'report_sec014' then
    select profile_id into v_owner from public.report_sec014 where id = p_source_id for update;
  elsif p_source_table = 'report_sec016' then
    select profile_id into v_owner from public.report_sec016 where id = p_source_id for update;
  elsif p_source_table = 'report_sec018' then
    select profile_id into v_owner from public.report_sec018 where id = p_source_id for update;
  elsif p_source_table = 'report_sec029' then
    select profile_id into v_owner from public.report_sec029 where id = p_source_id for update;
  elsif p_source_table = 'report_sec033' then
    select profile_id into v_owner from public.report_sec033 where id = p_source_id for update;
  elsif p_source_table = 'offload_records' then
    select profile_id into v_owner from public.offload_records where id = p_source_id for update;
  elsif p_source_table = 'report_makeup' then
    select profile_id into v_owner from public.report_makeup where id = p_source_id for update;
  elsif p_source_table = 'report_breakup' then
    select profile_id into v_owner from public.report_breakup where id = p_source_id for update;
  end if;

  if v_owner is null then
    raise exception 'Report not found.';
  end if;
  if v_owner <> auth.uid() and auth.role() <> 'service_role' then
    raise exception 'Only the submitting profile may resume its own report.';
  end if;

  if exists (
    select 1 from public.report_index_queue where source_table = p_source_table and source_id = p_source_id
  ) then
    return;
  end if;

  if p_source_table = 'report_sec013' then
    select count(*) into v_actual_children from public.report_sec013_profiling_duties where report_id = p_source_id;
  elsif p_source_table = 'report_sec014' then
    select count(*) into v_actual_children from public.report_sec014_patrols where report_id = p_source_id;
  elsif p_source_table = 'report_sec016' then
    v_actual_children := 0;
  elsif p_source_table = 'report_sec018' then
    select count(*) into v_actual_children from public.report_sec018_patrols where report_id = p_source_id;
  elsif p_source_table = 'report_sec029' then
    select count(*) into v_actual_children from public.report_sec029_items where report_id = p_source_id;
  elsif p_source_table = 'report_sec033' then
    select count(*) into v_actual_children from public.report_sec033_hold_checks where report_id = p_source_id;
  elsif p_source_table = 'offload_records' then
    select count(*) into v_actual_children from public.offload_items where report_id = p_source_id;
  elsif p_source_table = 'report_makeup' then
    select count(*) into v_actual_children from public.report_makeup_baggage_entries where report_id = p_source_id;
  elsif p_source_table = 'report_breakup' then
    select count(*) into v_actual_children from public.report_breakup_baggage_entries where report_id = p_source_id;
  end if;

  if v_actual_children = 0 and jsonb_array_length(p_child_rows) > 0 then
    if p_source_table = 'report_sec013' then
      insert into public.report_sec013_profiling_duties (report_id, entry_no, duty_area, time_from, time_to, location, sector_flight, description, incident_remark)
      select p_source_id, x.ord, x.duty_area, x.time_from, x.time_to, x.location, x.sector_flight, x.description, x.incident_remark
      from rows from (jsonb_to_recordset(p_child_rows) as (duty_area text, time_from text, time_to text, location text, sector_flight text, description text, incident_remark text))
        with ordinality as x(duty_area, time_from, time_to, location, sector_flight, description, incident_remark, ord);
    elsif p_source_table = 'report_sec014' then
      insert into public.report_sec014_patrols (report_id, entry_no, location, time_from, time_to, description)
      select p_source_id, x.ord, x.location, x.time_from, x.time_to, x.description
      from rows from (jsonb_to_recordset(p_child_rows) as (location text, time_from text, time_to text, description text))
        with ordinality as x(location, time_from, time_to, description, ord);
    elsif p_source_table = 'report_sec018' then
      insert into public.report_sec018_patrols (report_id, entry_no, time_from, time_to, parking_bay, aircraft_type, reg_no, description)
      select p_source_id, x.ord, x.time_from, x.time_to, x.parking_bay, x.aircraft_type, x.reg_no, x.description
      from rows from (jsonb_to_recordset(p_child_rows) as (time_from text, time_to text, parking_bay text, aircraft_type text, reg_no text, description text))
        with ordinality as x(time_from, time_to, parking_bay, aircraft_type, reg_no, description, ord);
    elsif p_source_table = 'report_sec029' then
      insert into public.report_sec029_items (report_id, item_code, checked, remark_type, remark_text)
      select p_source_id, x.item_code, x.checked, x.remark_type, x.remark_text
      from jsonb_to_recordset(p_child_rows)
        as x(item_code text, checked text, remark_type text, remark_text text);
    elsif p_source_table = 'report_sec033' then
      insert into public.report_sec033_hold_checks (report_id, entry_no, parking_bay_no, aircraft_registration_no, remarks)
      select p_source_id, x.ord, x.parking_bay_no, x.aircraft_registration_no, x.remarks
      from rows from (jsonb_to_recordset(p_child_rows) as (parking_bay_no text, aircraft_registration_no text, remarks text))
        with ordinality as x(parking_bay_no, aircraft_registration_no, remarks, ord);
    elsif p_source_table = 'offload_records' then
      insert into public.offload_items (report_id, entry_no, baggage_tag_no, reason, weight_kg)
      select p_source_id, x.ord, x.baggage_tag_no, x.reason, x.weight_kg
      from rows from (jsonb_to_recordset(p_child_rows) as (baggage_tag_no text, reason text, weight_kg numeric))
        with ordinality as x(baggage_tag_no, reason, weight_kg, ord);
    elsif p_source_table = 'report_makeup' then
      insert into public.report_makeup_baggage_entries (report_id, entry_no, container_pallet_trolley_no, seal_no, bay, destination)
      select p_source_id, x.ord, x.container_pallet_trolley_no, x.seal_no, x.bay, x.destination
      from rows from (jsonb_to_recordset(p_child_rows) as (container_pallet_trolley_no text, seal_no text, bay text, destination text))
        with ordinality as x(container_pallet_trolley_no, seal_no, bay, destination, ord);
    elsif p_source_table = 'report_breakup' then
      insert into public.report_breakup_baggage_entries (report_id, entry_no, container_pallet_trolley_no, seal_no, bay, breakdown_completed_time)
      select p_source_id, x.ord, x.container_pallet_trolley_no, x.seal_no, x.bay, x.breakdown_completed_time
      from rows from (jsonb_to_recordset(p_child_rows) as (container_pallet_trolley_no text, seal_no text, bay text, breakdown_completed_time text))
        with ordinality as x(container_pallet_trolley_no, seal_no, bay, breakdown_completed_time, ord);
    end if;

    if p_source_table = 'report_sec013' then
      select count(*) into v_actual_children from public.report_sec013_profiling_duties where report_id = p_source_id;
    elsif p_source_table = 'report_sec014' then
      select count(*) into v_actual_children from public.report_sec014_patrols where report_id = p_source_id;
    elsif p_source_table = 'report_sec016' then
      v_actual_children := 0;
    elsif p_source_table = 'report_sec018' then
      select count(*) into v_actual_children from public.report_sec018_patrols where report_id = p_source_id;
    elsif p_source_table = 'report_sec029' then
      select count(*) into v_actual_children from public.report_sec029_items where report_id = p_source_id;
    elsif p_source_table = 'report_sec033' then
      select count(*) into v_actual_children from public.report_sec033_hold_checks where report_id = p_source_id;
    elsif p_source_table = 'offload_records' then
      select count(*) into v_actual_children from public.offload_items where report_id = p_source_id;
    elsif p_source_table = 'report_makeup' then
      select count(*) into v_actual_children from public.report_makeup_baggage_entries where report_id = p_source_id;
    elsif p_source_table = 'report_breakup' then
      select count(*) into v_actual_children from public.report_breakup_baggage_entries where report_id = p_source_id;
    end if;
  end if;

  perform public.mark_report_ready_for_indexing(p_source_table, p_source_id, v_actual_children);
end;
$function$;
revoke execute on function public.resume_report_submission_secure(text, uuid, jsonb) from public, anon;
grant execute on function public.resume_report_submission_secure(text, uuid, jsonb) to authenticated, service_role;
