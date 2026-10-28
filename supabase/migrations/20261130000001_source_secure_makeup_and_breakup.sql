-- Forward migration: 20261130000001_source_secure_makeup_and_breakup.sql
-- Enables source-keyed retrieval, PDF generation authorization, flight-date extraction,
-- filtered search, flag info and access request stubs for report_makeup and report_breakup.

-- 1. Source-keyed retrieval
create or replace function public.get_report_by_source_secure(p_source_table text, p_source_id uuid, p_version_number integer default null)
returns table (
  id uuid, source_table text, source_id uuid, report_type text, operating_entity_code text, hub_code text, station_code text,
  team_name text, flight_number text, report_date date, status text, severity text, flag_state text, version_number integer,
  current_version integer, content jsonb
)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Must be signed in.';
  end if;
  if p_source_table is null or p_source_table not in (
    'report_sec013', 'report_sec014', 'report_sec016', 'report_sec018',
    'report_sec029', 'report_sec033', 'offload_records', 'report_makeup', 'report_breakup'
  ) then
    raise exception 'Report not found or not authorized.';
  end if;
  select cri.id into v_id from public.central_reports_index cri where cri.source_table = p_source_table and cri.source_id = p_source_id;
  if v_id is null then
    raise exception 'Report not found or not authorized.';
  end if;
  if not exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.status = 'approved')
     or not public.has_report_access(v_id) then
    insert into public.report_access_audit (actor_id, repository_report_id, action, reason)
    values (auth.uid(), v_id, 'unauthorized_attempt', 'get_report_by_source_secure');
    raise exception 'Report not found or not authorized.';
  end if;
  return query select * from public.get_report_secure(v_id, p_version_number);
end;
$function$;
revoke execute on function public.get_report_by_source_secure(text, uuid, integer) from public, anon;
grant execute on function public.get_report_by_source_secure(text, uuid, integer) to authenticated, service_role;

-- 2. PDF authorization
create or replace function public.authorize_report_pdf_by_source_secure(p_source_table text, p_source_id uuid)
returns table (source_table text, source_id uuid, report_type text)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Must be signed in.';
  end if;
  if p_source_table is null or p_source_table not in (
    'report_sec013', 'report_sec014', 'report_sec016', 'report_sec018',
    'report_sec029', 'report_sec033', 'offload_records', 'report_makeup', 'report_breakup'
  ) then
    raise exception 'Report not found or not authorized.';
  end if;
  select cri.id into v_id from public.central_reports_index cri where cri.source_table = p_source_table and cri.source_id = p_source_id;
  if v_id is null then
    raise exception 'Report not found or not authorized.';
  end if;
  if not exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.status = 'approved')
     or not public.has_report_access(v_id) then
    insert into public.report_access_audit (actor_id, repository_report_id, action, reason)
    values (auth.uid(), v_id, 'unauthorized_attempt', 'authorize_report_pdf_by_source_secure');
    raise exception 'Report not found or not authorized.';
  end if;
  return query select * from public.authorize_report_pdf_secure(v_id);
end;
$function$;
revoke execute on function public.authorize_report_pdf_by_source_secure(text, uuid) from public, anon;
grant execute on function public.authorize_report_pdf_by_source_secure(text, uuid) to authenticated, service_role;

-- 3. Flight and date extraction
create or replace function public.report_source_flight_date(p_source_table text, p_source_id uuid)
returns table (flight text, report_date date)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
begin
  if p_source_table = 'report_sec016' then
    return query select t.flight, t.duty_date from public.report_sec016 t where t.id = p_source_id;
  elsif p_source_table = 'report_sec029' then
    return query select t.flight_no, t.submitted_at::date from public.report_sec029 t where t.id = p_source_id;
  elsif p_source_table = 'offload_records' then
    return query select t.flight_no, t.flight_date from public.offload_records t where t.id = p_source_id;
  elsif p_source_table = 'report_sec033' then
    return query select null::text, t.report_date from public.report_sec033 t where t.id = p_source_id;
  elsif p_source_table = 'report_sec013' then
    return query select null::text, t.submitted_at::date from public.report_sec013 t where t.id = p_source_id;
  elsif p_source_table = 'report_sec014' then
    return query select null::text, t.submitted_at::date from public.report_sec014 t where t.id = p_source_id;
  elsif p_source_table = 'report_sec018' then
    return query select null::text, t.submitted_at::date from public.report_sec018 t where t.id = p_source_id;
  elsif p_source_table = 'report_makeup' then
    return query select t.flight_number, t.duty_date from public.report_makeup t where t.id = p_source_id;
  elsif p_source_table = 'report_breakup' then
    return query select t.flight_number, t.duty_date from public.report_breakup t where t.id = p_source_id;
  end if;
end;
$function$;
revoke execute on function public.report_source_flight_date(text, uuid) from public, anon, authenticated;
grant execute on function public.report_source_flight_date(text, uuid) to service_role;

-- 4. Filtered search
create or replace function public.search_reports_filtered_secure(
  p_page integer default 1,
  p_page_size integer default 25,
  p_registration text default null,
  p_flight_number text default null,
  p_from_date date default null,
  p_to_date date default null,
  p_source_table text default null,
  p_status text default null
)
returns table (
  id uuid, source_table text, source_id uuid, report_type text, operating_entity_code text, flight_number text, report_date date, status text,
  flag_state text, indexed_at timestamptz, staff_name text, station text, team text, reg_no text, total_count bigint
)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_page integer := greatest(coalesce(p_page, 1), 1);
  v_page_size integer := least(greatest(coalesce(p_page_size, 25), 1), 100);
  v_reg text := nullif(regexp_replace(upper(coalesce(p_registration, '')), '[[:space:]_./-]+', '', 'g'), '');
  v_flight text := public.normalize_flight_number(p_flight_number);
begin
  if auth.uid() is null then
    raise exception 'Must be signed in.';
  end if;
  if not exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.status = 'approved') then
    raise exception 'Only an approved account may search reports.';
  end if;
  if p_source_table is not null and p_source_table not in (
    'report_sec013', 'report_sec014', 'report_sec016', 'report_sec018',
    'report_sec029', 'report_sec033', 'offload_records', 'report_makeup', 'report_breakup'
  ) then
    raise exception 'Unsupported report type filter.';
  end if;
  if p_status is not null and p_status not in ('submitted', 'draft', 'amended') then
    raise exception 'Unsupported status filter.';
  end if;
  if p_from_date is not null and p_to_date is not null and p_from_date > p_to_date then
    raise exception 'The from date is after the to date.';
  end if;

  return query
  with authorized as (
    select cri.*
    from public.central_reports_index cri
    where public.has_report_access(cri.id)
      and (p_source_table is null or cri.source_table = p_source_table)
      and (p_status is null or cri.status = p_status)
  ),
  summarised as (
    select a.id, a.source_table, a.source_id, a.report_type, a.operating_entity_code, a.status, a.flag_state, a.indexed_at,
           coalesce(a.flight_number, f.flight) as flight_number, coalesce(a.report_date, f.report_date) as report_date,
           s.staff_name as s_staff_name, s.station as s_station, s.team as s_team, s.reg_no as s_reg_no
    from authorized a
    cross join lateral public.report_source_summary(a.source_table, a.source_id) s
    cross join lateral public.report_source_flight_date(a.source_table, a.source_id) f
    where (v_reg is null or regexp_replace(upper(coalesce(s.reg_no, '')), '[[:space:]_./-]+', '', 'g') = v_reg)
  ),
  filtered as (
    select m.* from summarised m
    where (p_from_date is null or m.report_date >= p_from_date)
      and (p_to_date is null or m.report_date <= p_to_date)
      and (v_flight is null or public.normalize_flight_number(m.flight_number) = v_flight)
  ),
  counted as (select count(*) as n from filtered)
  select
    m.id, m.source_table, m.source_id, m.report_type, m.operating_entity_code, m.flight_number, m.report_date, m.status, m.flag_state,
    m.indexed_at, m.s_staff_name, m.s_station, m.s_team, m.s_reg_no, c.n
  from filtered m, counted c
  order by m.report_date desc nulls last, m.indexed_at desc, m.id
  limit v_page_size;
end;
$function$;
revoke execute on function public.search_reports_filtered_secure(integer, integer, text, text, date, date, text, text) from public, anon;
grant execute on function public.search_reports_filtered_secure(integer, integer, text, text, date, date, text, text) to authenticated, service_role;

-- 5. Flag info
create or replace function public.report_source_flag_info(p_source_table text, p_source_id uuid)
returns table (flagged_reason text, flagged_at timestamptz)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
begin
  if p_source_table not in (
    'report_sec013', 'report_sec014', 'report_sec016', 'report_sec018',
    'report_sec029', 'report_sec033', 'offload_records', 'report_makeup', 'report_breakup'
  ) then
    return;
  end if;
  return query execute format('select t.flagged_reason, t.flagged_at from public.%I t where t.id = $1', p_source_table) using p_source_id;
end;
$function$;
revoke execute on function public.report_source_flag_info(text, uuid) from public, anon, authenticated;
grant execute on function public.report_source_flag_info(text, uuid) to service_role;

-- 6. Access request stubs search
create or replace function public.search_report_stubs_for_request_secure(
  p_flight text default null, p_from date default null, p_to date default null, p_source_table text default null, p_page integer default 1, p_page_size integer default 25
)
returns table (id uuid, source_table text, operating_entity_code text, flight_number text, report_date date, status text, already_accessible boolean, total_count bigint)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_page integer := greatest(coalesce(p_page, 1), 1);
  v_size integer := least(greatest(coalesce(p_page_size, 25), 1), 50);
  v_flight text := public.normalize_flight_number(p_flight);
begin
  if not (public.has_active_role('ghod') or public.has_active_role('airasia_management')) then
    raise exception 'Only GHOD or AirAsia Management may search reports to request access.';
  end if;
  if p_source_table is not null and p_source_table not in (
    'report_sec013', 'report_sec014', 'report_sec016', 'report_sec018',
    'report_sec029', 'report_sec033', 'offload_records', 'report_makeup', 'report_breakup'
  ) then
    raise exception 'Unsupported report type filter.';
  end if;
  if v_flight is null and p_from is null and p_to is null then
    raise exception 'Provide a flight number or a date range.';
  end if;
  return query
  with c as (
    select cri.id as rid, cri.source_table as st, cri.operating_entity_code as ent, cri.status as stt, cri.source_id as sid, f.flight as fl, f.report_date as rd
    from public.central_reports_index cri
    cross join lateral public.report_source_flight_date(cri.source_table, cri.source_id) f
    where (p_source_table is null or cri.source_table = p_source_table)
  ), m as (
    select * from c
    where (v_flight is null or public.normalize_flight_number(c.fl) = v_flight)
      and (p_from is null or c.rd >= p_from) and (p_to is null or c.rd <= p_to)
  ), n as (select count(*) as k from m)
  select m.rid, m.st, m.ent, m.fl, m.rd, m.stt, public.has_report_access(m.rid), n.k
  from m cross join n
  order by m.rd desc nulls last, m.rid
  limit v_size offset (v_page - 1) * v_size;
end;
$function$;
revoke execute on function public.search_report_stubs_for_request_secure(text, date, date, text, integer, integer) from public, anon;
grant execute on function public.search_report_stubs_for_request_secure(text, date, date, text, integer, integer) to authenticated, service_role;
