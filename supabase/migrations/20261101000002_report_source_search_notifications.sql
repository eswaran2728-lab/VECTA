-- MAA / AAX report separation, part 2: atomic source-keyed report access, filtered search, attachment authorization,
-- admin-export closure and entity-routed notifications. Additive and forward-only; no data is rewritten.
--
-- * get_report_by_source_secure() / authorize_report_pdf_by_source_secure(): the application used to read central_reports_index
--   DIRECTLY to turn (source table, source id) into a repository id and then call get_report_secure(). Direct SELECT on the index is
--   revoked for clients, so that lookup failed and no leadership user could open a report. The lookup, the authorization and the
--   content retrieval now happen inside one secure call; "missing" and "not authorized" are indistinguishable.
-- * search_reports_filtered_secure(): registration / flight (normalised) / date range / type / status filters with pagination.
--   Every filter is applied AFTER has_report_access(), so rows and counts never leak across entities. Summary fields only.
-- * can_read_report_attachment(): the attachment-bucket SELECT policy follows the same report-access decision.
-- * export_reports_secure(): entity Admin accounts are denied export (owner decision pending); all other behaviour is unchanged.
-- * entity report notifications: a report indexed for MAA notifies only eligible MAA Boss/Admin; AAX likewise; deduplicated; the
--   payload carries identifiers only.

-- ---------------------------------------------------------------------------------------------
-- Source-keyed secure access
-- ---------------------------------------------------------------------------------------------
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
  if p_source_table is null or p_source_table not in ('report_sec013', 'report_sec014', 'report_sec016', 'report_sec018', 'report_sec029', 'report_sec033', 'offload_records') then
    raise exception 'Report not found or not authorized.';
  end if;
  select cri.id into v_id from public.central_reports_index cri where cri.source_table = p_source_table and cri.source_id = p_source_id;
  if v_id is null then
    raise exception 'Report not found or not authorized.';
  end if;
  -- An unauthorized caller gets exactly the same generic error as for a missing report; the attempt is audited here (outside any
  -- subtransaction, so the audit row survives the error).
  if not exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.status = 'approved')
     or not public.has_report_access(v_id) then
    insert into public.report_access_audit (actor_id, repository_report_id, action, reason)
    values (auth.uid(), v_id, 'unauthorized_attempt', 'get_report_by_source_secure');
    raise exception 'Report not found or not authorized.';
  end if;
  -- get_report_secure() re-checks the same decision, audits the access, and returns the content.
  return query select * from public.get_report_secure(v_id, p_version_number);
end;
$function$;
revoke execute on function public.get_report_by_source_secure(text, uuid, integer) from public, anon;
grant execute on function public.get_report_by_source_secure(text, uuid, integer) to authenticated, service_role;

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
  if p_source_table is null or p_source_table not in ('report_sec013', 'report_sec014', 'report_sec016', 'report_sec018', 'report_sec029', 'report_sec033', 'offload_records') then
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

-- ---------------------------------------------------------------------------------------------
-- Filtered search (registration, flight, date range, type, status) with pagination
-- ---------------------------------------------------------------------------------------------
-- Latent defect fix: report_source_summary returned report_sec016.sta_std (type time) into a text column, so summarising ANY
-- report_sec016 row raised "structure of query does not match function result type". Same signature, same behaviour otherwise.
create or replace function public.report_source_summary(p_source_table text, p_source_id uuid)
returns table (staff_name text, station text, team text, secondary_identifier text, reg_no text, bay_no text, sta_std text, submitter_profile_id uuid)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
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
  else
    raise exception 'Unsupported source_table: %', p_source_table;
  end if;
end;
$function$;

-- The indexing queue indexes flight_number / report_date as NULL, so filters read them from the trusted source row instead
-- (no backfill needed; historical rows are searchable immediately). Internal helper: not callable by clients.
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
  end if;
end;
$function$;
revoke execute on function public.report_source_flight_date(text, uuid) from public, anon, authenticated;
grant execute on function public.report_source_flight_date(text, uuid) to service_role;

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
  if p_source_table is not null and p_source_table not in ('report_sec013', 'report_sec014', 'report_sec016', 'report_sec018', 'report_sec029', 'report_sec033', 'offload_records') then
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
  limit v_page_size
  offset (v_page - 1) * v_page_size;
end;
$function$;
revoke execute on function public.search_reports_filtered_secure(integer, integer, text, text, date, date, text, text) from public, anon;
grant execute on function public.search_reports_filtered_secure(integer, integer, text, text, date, date, text, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Attachments: the bucket SELECT policy follows the same report-access decision
-- ---------------------------------------------------------------------------------------------
create or replace function public.can_read_report_attachment(p_object_name text)
returns boolean
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_type text := (storage.foldername(p_object_name))[1];
  v_id uuid;
begin
  if auth.uid() is null then
    return false;
  end if;
  begin
    v_id := nullif((storage.foldername(p_object_name))[2], '')::uuid;
  exception when others then
    return false;
  end;
  if v_type is null or v_id is null then
    return false;
  end if;
  return public.can_view_report(v_type, v_id)
    or exists (
      select 1 from public.central_reports_index cri
      where cri.source_table = v_type and cri.source_id = v_id and public.has_report_access(cri.id)
    );
end;
$function$;
revoke execute on function public.can_read_report_attachment(text) from public, anon;
grant execute on function public.can_read_report_attachment(text) to authenticated, service_role;

drop policy if exists "report attachments object select" on storage.objects;
create policy "report attachments object select" on storage.objects for select
  using (bucket_id = 'report-attachments' and public.can_read_report_attachment(name));

-- ---------------------------------------------------------------------------------------------
-- Export: entity Admin accounts are not export-authorised (owner decision pending); behaviour otherwise unchanged
-- ---------------------------------------------------------------------------------------------
create or replace function public.report_export_denied_for_entity_admin()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  with active_codes as (
    select distinct rd.code
    from public.user_role_assignments ura
    join public.role_definitions rd on rd.id = ura.role_definition_id and rd.is_active
    where ura.profile_id = auth.uid()
      and ura.revoked_at is null
      and ura.starts_at <= now()
      and (ura.ends_at is null or ura.ends_at > now())
  )
  select exists (select 1 from active_codes where code in ('maa_admin', 'aax_admin'))
     and not exists (select 1 from active_codes where code not in ('maa_admin', 'aax_admin'));
$function$;
revoke execute on function public.report_export_denied_for_entity_admin() from public, anon;
grant execute on function public.report_export_denied_for_entity_admin() to authenticated, service_role;

create or replace function public.export_reports_secure(
  p_max_rows integer default 1000,
  p_flight_number text default null,
  p_aoc_id uuid default null,
  p_operating_entity_code text default null,
  p_department_id uuid default null,
  p_hub_id uuid default null,
  p_station_id uuid default null,
  p_team_id uuid default null,
  p_severity text default null,
  p_flag_state text default null,
  p_status text default null,
  p_from_date date default null,
  p_to_date date default null
)
returns table (
  id uuid, source_table text, report_type text, operating_entity_code text, flight_number text, report_date date, status text,
  severity text, flag_state text, content jsonb
)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_max_rows integer := least(greatest(coalesce(p_max_rows, 1000), 1), 5000);
  v_row_count integer;
begin
  if auth.uid() is null then
    raise exception 'Must be signed in.';
  end if;
  if not exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.status = 'approved') then
    raise exception 'Only an approved account may export reports.';
  end if;
  if public.report_export_denied_for_entity_admin() then
    raise exception 'Report export is not enabled for entity Admin accounts.';
  end if;

  return query
  select
    cri.id, cri.source_table, public.sanitize_csv_value(cri.report_type) as report_type,
    public.sanitize_csv_value(cri.operating_entity_code) as operating_entity_code,
    public.sanitize_csv_value(cri.flight_number) as flight_number,
    cri.report_date, cri.status, cri.severity, cri.flag_state,
    public.report_source_content(cri.source_table, cri.source_id) as content
  from public.central_reports_index cri
  where public.has_report_access(cri.id)
    and (p_flight_number is null or cri.flight_number = p_flight_number)
    and (p_aoc_id is null or cri.aoc_id = p_aoc_id)
    and (p_operating_entity_code is null or cri.operating_entity_code = p_operating_entity_code)
    and (p_department_id is null or cri.department_id = p_department_id)
    and (p_hub_id is null or cri.hub_id = p_hub_id)
    and (p_station_id is null or cri.station_id = p_station_id)
    and (p_team_id is null or cri.team_id = p_team_id)
    and (p_severity is null or cri.severity = p_severity)
    and (p_flag_state is null or cri.flag_state = p_flag_state)
    and (p_status is null or cri.status = p_status)
    and (p_from_date is null or cri.report_date >= p_from_date)
    and (p_to_date is null or cri.report_date <= p_to_date)
  order by cri.indexed_at desc, cri.id
  limit v_max_rows;

  get diagnostics v_row_count = row_count;

  insert into public.report_access_audit (actor_id, action, reason)
  values (auth.uid(), 'export_generated', format('rows=%s max_rows=%s', v_row_count, v_max_rows));
end;
$function$;

-- ---------------------------------------------------------------------------------------------
-- Entity-routed notifications
-- ---------------------------------------------------------------------------------------------
alter table public.user_notifications drop constraint if exists user_notifications_event_type_check;
alter table public.user_notifications add constraint user_notifications_event_type_check
  check (event_type in (
    'request_submitted', 'request_approved', 'request_rejected',
    'transfer_initiated', 'transfer_accepted', 'transfer_rejected',
    'membership_ended', 'assignment_ended', 'deactivation',
    'leave_status_changed', 'ot_status_changed', 'investigation_case_assigned',
    'caterlink_movement_received', 'caterlink_whitelist_approved', 'caterlink_whitelist_rejected',
    'entity_report_submitted'
  ));

-- The recipient set for an entity report: ACTIVE, approved Boss/Admin of exactly that entity in the report's AOC.
-- Pending / rejected / deactivated profiles and revoked / expired / future assignments never qualify; one row per person.
create or replace function public.entity_report_recipients(p_entity_code text, p_aoc_id uuid)
returns table (profile_id uuid)
language sql
stable
security definer
set search_path to 'public'
as $function$
  select distinct ura.profile_id
  from public.user_role_assignments ura
  join public.role_definitions rd on rd.id = ura.role_definition_id and rd.is_active
  join public.profiles p on p.id = ura.profile_id and p.status = 'approved'
  where p_entity_code in ('MAA', 'AAX')
    and ura.aoc_id = p_aoc_id
    and rd.code = any (case p_entity_code when 'MAA' then array['maa_boss', 'maa_admin'] else array['aax_boss', 'aax_admin'] end)
    and ura.revoked_at is null
    and ura.starts_at <= now()
    and (ura.ends_at is null or ura.ends_at > now());
$function$;
revoke execute on function public.entity_report_recipients(text, uuid) from public, anon, authenticated;
grant execute on function public.entity_report_recipients(text, uuid) to service_role;

create or replace function public.notify_entity_leadership_of_report()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  r record;
begin
  if new.operating_entity_code not in ('MAA', 'AAX') or new.aoc_id is null then
    return new;
  end if;
  for r in select er.profile_id from public.entity_report_recipients(new.operating_entity_code, new.aoc_id) er
  loop
    if r.profile_id is distinct from new.submitter_profile_id then
      perform public.notify(
        r.profile_id, 'entity_report_submitted', 'entity_report:' || new.id::text || ':' || r.profile_id::text,
        null, null, null,
        jsonb_build_object('repository_report_id', new.id, 'source_table', new.source_table, 'source_id', new.source_id)
      );
    end if;
  end loop;
  return new;
end;
$function$;
revoke execute on function public.notify_entity_leadership_of_report() from public, anon, authenticated;

drop trigger if exists trg_notify_entity_leadership_of_report on public.central_reports_index;
create trigger trg_notify_entity_leadership_of_report
  after insert on public.central_reports_index
  for each row execute function public.notify_entity_leadership_of_report();
