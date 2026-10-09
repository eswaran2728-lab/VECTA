-- Entity dashboards: per-report-type counts (same authorization as search) and the entity-admin overview. Additive, forward-only.
--
-- * get_entity_report_counts_secure(): one row per report type (zero rows included) counting ONLY reports the caller is authorized
--   to read (has_report_access) -- so an MAA leader's counts can never include an AAX report. Optional date window read from the
--   trusted source row (the indexing queue leaves the index date NULL). Counts are aggregates only; no content leaves the function.
-- * get_entity_admin_overview_secure(): MAA/AAX Admin only. Own-entity active staff count and the Malaysia-wide pending-registration
--   TOTAL (a count only -- the other entity's requests stay invisible to the admin).

create or replace function public.get_entity_report_counts_secure(p_from_date date default null, p_to_date date default null)
returns table (source_table text, report_label text, total bigint)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
begin
  if auth.uid() is null then
    raise exception 'Must be signed in.';
  end if;
  if not exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.status = 'approved') then
    raise exception 'Only an approved account may count reports.';
  end if;
  if p_from_date is not null and p_to_date is not null and p_from_date > p_to_date then
    raise exception 'The from date is after the to date.';
  end if;
  return query
  with types(st, lbl, ord) as (
    values ('report_sec016', 'SEC016 Aircraft Attendance / Search', 1),
           ('report_sec029', 'SEC029 Aircraft Search Checklist', 2),
           ('offload_records', 'Offload Records', 3),
           ('report_sec014', 'SEC014 Daily Report', 4),
           ('report_sec018', 'SEC018 Patrol Report', 5),
           ('report_sec033', 'SEC033 Report', 6),
           ('report_sec013', 'SEC013 Profiling', 7)
  ), authorized as (
    select cri.id, cri.source_table as st, cri.source_id
    from public.central_reports_index cri
    where public.has_report_access(cri.id)
  ), dated as (
    select a.st, coalesce(f.report_date, null) as rdate
    from authorized a
    cross join lateral public.report_source_flight_date(a.st, a.source_id) f
  ), counted as (
    select d.st, count(*) as n
    from dated d
    where (p_from_date is null or d.rdate >= p_from_date) and (p_to_date is null or d.rdate <= p_to_date)
    group by d.st
  )
  select t.st, t.lbl, coalesce(c.n, 0)::bigint
  from types t left join counted c on c.st = t.st
  order by t.ord;
end;
$function$;
revoke execute on function public.get_entity_report_counts_secure(date, date) from public, anon;
grant execute on function public.get_entity_report_counts_secure(date, date) to authenticated, service_role;

create or replace function public.get_entity_admin_overview_secure()
returns table (entity_code text, entity_active_staff bigint, malaysia_pending_registrations bigint)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_aoc uuid;
  v_entity uuid;
  v_code text;
begin
  if auth.uid() is null then
    raise exception 'Must be signed in.';
  end if;
  select ura.aoc_id, ura.operating_entity_id, oe.code into v_aoc, v_entity, v_code
  from public.user_role_assignments ura
  join public.role_definitions rd on rd.id = ura.role_definition_id and rd.is_active
  join public.profiles p on p.id = ura.profile_id and p.status = 'approved'
  join public.operating_entities oe on oe.id = ura.operating_entity_id
  where ura.profile_id = auth.uid() and rd.code in ('maa_admin', 'aax_admin')
    and ura.revoked_at is null and ura.starts_at <= now() and (ura.ends_at is null or ura.ends_at > now())
  order by ura.starts_at limit 1;
  if v_entity is null then
    raise exception 'Only an approved MAA or AAX Admin may view this overview.';
  end if;
  return query
  select v_code,
    (select count(distinct x.profile_id) from (
        select uem.profile_id from public.user_entity_memberships uem
        join public.profiles pp on pp.id = uem.profile_id and pp.status = 'approved'
        where uem.operating_entity_id = v_entity and uem.status = 'active' and uem.starts_at <= now() and (uem.ends_at is null or uem.ends_at > now())
        union
        select ura.profile_id from public.user_role_assignments ura
        join public.profiles pp on pp.id = ura.profile_id and pp.status = 'approved'
        where ura.operating_entity_id = v_entity and ura.revoked_at is null and ura.starts_at <= now() and (ura.ends_at is null or ura.ends_at > now())
      ) x)::bigint,
    (select count(*) from public.user_registration_requests r where r.status = 'pending' and r.requested_aoc_id = v_aoc)::bigint;
end;
$function$;
revoke execute on function public.get_entity_admin_overview_secure() from public, anon;
grant execute on function public.get_entity_admin_overview_secure() to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Entity directory export: active, approved staff only (same columns, same signature)
-- ---------------------------------------------------------------------------------------------
-- The original export returned any non-revoked assignment, including pending/rejected/deactivated profiles and assignments that
-- had expired or not yet started. The export now lists only effective assignments of approved profiles. Protected leadership roles
-- remain omitted, and name / staff number / scope codes are the only fields (no e-mail, phone or credential).
create or replace function public.export_entity_user_directory(p_entity_code text)
returns table (
  profile_id uuid, name text, staff_no text, role_code text, department_code text, unit_code text, hub_code text,
  station_code text, team_name text, assignment_starts_at timestamptz
)
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if not public.is_entity_admin(p_entity_code) then
    raise exception 'Not an authorized, approved entity Admin for %.', p_entity_code;
  end if;

  insert into public.user_admin_audit_log (actor_id, action, new_state)
  values (auth.uid(), 'export', jsonb_build_object('entity', p_entity_code));

  return query
  select
    p.id, public.sanitize_csv_value(p.name), public.sanitize_csv_value(p.staff_no), rd.code, d.code, u.code, h.code, s.code,
    public.sanitize_csv_value(t.name), ura.starts_at
  from public.user_role_assignments ura
  join public.role_definitions rd on rd.id = ura.role_definition_id and rd.is_active
  join public.profiles p on p.id = ura.profile_id and p.status = 'approved'
  join public.user_entity_memberships uem on uem.id = ura.entity_membership_id and uem.status = 'active'
       and uem.starts_at <= now() and (uem.ends_at is null or uem.ends_at > now())
  join public.operating_entities oe on oe.id = uem.operating_entity_id
  left join public.departments d on d.id = ura.department_id
  left join public.units u on u.id = ura.unit_id
  left join public.hubs h on h.id = ura.hub_id
  left join public.org_stations s on s.id = ura.station_id
  left join public.org_teams t on t.id = ura.team_id
  where oe.code = p_entity_code
    and ura.revoked_at is null and ura.starts_at <= now() and (ura.ends_at is null or ura.ends_at > now())
    and rd.code not in (
      'airasia_management', 'ghod', 'global_reporting_controller', 'super_admin',
      'maa_boss', 'aax_boss', 'maa_admin', 'aax_admin',
      'operation_manager', 'main_enforcement', 'compliance', 'caterlink_management'
    );
end;
$function$;
revoke execute on function public.export_entity_user_directory(text) from public, anon;
grant execute on function public.export_entity_user_directory(text) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- GHOD flagged-report listing: working columns + the SOURCE id for the link
-- ---------------------------------------------------------------------------------------------
-- Two defects in flagged_reports_secure(): (1) it returned only the repository id, while the report view route is keyed by the
-- report's own source id, so the GHOD link could never resolve; (2) it selected flagged_reason / flagged_at from
-- central_reports_index, which has no such columns (they live on the source rows), so the call failed at run time. The function now
-- returns source_id and reads the flag details from the trusted source row. Authorization (has_report_access over flagged rows) is
-- unchanged. The return type changes, so the old signature is dropped first.
create or replace function public.report_source_flag_info(p_source_table text, p_source_id uuid)
returns table (flagged_reason text, flagged_at timestamptz)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
begin
  if p_source_table not in ('report_sec013', 'report_sec014', 'report_sec016', 'report_sec018', 'report_sec029', 'report_sec033', 'offload_records') then
    return;
  end if;
  return query execute format('select t.flagged_reason, t.flagged_at from public.%I t where t.id = $1', p_source_table) using p_source_id;
end;
$function$;
revoke execute on function public.report_source_flag_info(text, uuid) from public, anon, authenticated;
grant execute on function public.report_source_flag_info(text, uuid) to service_role;

drop function if exists public.flagged_reports_secure(integer, integer);
create function public.flagged_reports_secure(p_page integer default 1, p_page_size integer default 25)
returns table (
  id uuid, source_id uuid, source_table text, report_type text, operating_entity_code text, flight_number text, report_date date,
  status text, severity text, flagged_reason text, flagged_at timestamptz, total_count bigint
)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_page integer := greatest(coalesce(p_page, 1), 1);
  v_page_size integer := least(greatest(coalesce(p_page_size, 25), 1), 100);
begin
  if auth.uid() is null then
    raise exception 'Must be signed in.';
  end if;
  if not exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.status = 'approved') then
    raise exception 'Only an approved account may list flagged reports.';
  end if;

  return query
  with authorized as (
    select cri.*
    from public.central_reports_index cri
    where cri.flag_state = 'flagged'
      and public.has_report_access(cri.id)
  ),
  detailed as (
    select a.id, a.source_id, a.source_table, a.report_type, a.operating_entity_code, a.flight_number, a.report_date,
           a.status, a.severity, f.flagged_reason, f.flagged_at
    from authorized a
    cross join lateral public.report_source_flag_info(a.source_table, a.source_id) f
  ),
  counted as (
    select count(*) as n from detailed
  )
  select d.id, d.source_id, d.source_table, d.report_type, d.operating_entity_code, d.flight_number, d.report_date,
         d.status, d.severity, d.flagged_reason, d.flagged_at, c.n
  from detailed d, counted c
  order by d.flagged_at desc nulls last, d.id
  limit v_page_size
  offset (v_page - 1) * v_page_size;
end;
$function$;
revoke execute on function public.flagged_reports_secure(integer, integer) from public, anon;
grant execute on function public.flagged_reports_secure(integer, integer) to authenticated, service_role;
