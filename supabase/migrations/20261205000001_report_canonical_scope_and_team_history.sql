-- Report visibility, acknowledgment and alert scope: one canonical operational station and team per report (product owner direction, 2026-11-05).
--
-- Finding: every report already stores the submitter's CANONICAL scope (org_station_id / org_team_id, set from the submitter's active assignment by the
-- classification trigger), and the report entity (from the flight prefix). But three paths still read the station and team the officer TYPED on the form:
--   * get_report_submitter (used by can_view_report, can_acknowledge_report and the acknowledgment policies),
--   * the DSE alert lookup, which also demanded the DSE share the submitter's operating entity,
--   * and nothing listed a team's reports, so a DSE or SO had only the personal history.
-- Seven SEC016 and one SEC014 were saved with typed station 'KUL - AAX' by officers assigned to KUL - MAA / CHARLIE. 'KUL - AAX' has no CHARLIE team, so the alert
-- lookup failed (8 delivery failures), and typed-text checks would refuse acknowledgment.
--
-- Rule now: a DSE or SO sees, and acknowledges within their authority, every submitted report of their OWN station and team whatever its entity (AK/MAA and
-- D7/AAX alike) and nothing of any other station or team. The report entity is kept for the boss rules (the MAA Boss sees MAA only, the AAX Boss AAX only),
-- which are unchanged. No historical report row is rewritten.

-- 1. The canonical scope of a stored report -------------------------------------------------------------------------------------------------------------------
create or replace function public.report_canonical_scope(p_source_table text, p_source_id uuid)
returns table (profile_id uuid, station_code text, team_name text, typed_station text, typed_team text, entity_code text, station_id uuid, team_id uuid)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
begin
  if p_source_table not in ('report_sec013', 'report_sec014', 'report_sec016', 'report_sec018', 'report_sec029', 'report_sec033', 'report_makeup', 'report_breakup', 'offload_records') then
    raise exception 'Unsupported source_table: %', p_source_table;
  end if;
  return query execute format(
    'select t.profile_id, coalesce(st.code, t.station)::text, coalesce(tm.name, t.team)::text, t.station::text, t.team::text, t.operating_entity_code::text, t.org_station_id, t.org_team_id
       from public.%I t left join public.org_stations st on st.id = t.org_station_id left join public.org_teams tm on tm.id = t.org_team_id where t.id = $1', p_source_table)
    using p_source_id;
end;
$function$;
revoke execute on function public.report_canonical_scope(text, uuid) from public, anon, authenticated;
grant execute on function public.report_canonical_scope(text, uuid) to service_role;

-- 2. Visibility and acknowledgment read the canonical scope ----------------------------------------------------------------------------------------------------
create or replace function public.get_report_submitter(p_report_type text, p_report_id uuid)
returns table (profile_id uuid, station text, team text)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_table text := case p_report_type
    when 'sec013' then 'report_sec013' when 'sec014' then 'report_sec014' when 'sec016' then 'report_sec016' when 'sec018' then 'report_sec018'
    when 'sec029' then 'report_sec029' when 'sec033' then 'report_sec033' when 'makeup' then 'report_makeup' when 'breakup' then 'report_breakup'
    when 'offload' then 'offload_records' else null end;
begin
  if v_table is null then
    return;
  end if;
  return query select s.profile_id, s.station_code, s.team_name from public.report_canonical_scope(v_table, p_report_id) s;
end;
$function$;

create or replace function public.can_acknowledge_report(p_report_type text, p_report_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  sub record;
  v_caller integer;
  v_sub integer;
begin
  if auth.uid() is null then
    return false;
  end if;
  select * into sub from public.get_report_submitter(p_report_type, p_report_id);
  if sub is null then
    return false;
  end if;
  v_caller := public.canon_my_level();
  v_sub := public.canon_profile_level(sub.profile_id);

  return coalesce(
    (
      v_caller = v_sub + 1
      or (p_report_type in ('makeup', 'breakup') and v_sub = 1 and public.canon_has_role(array['so', 'sso']))
      or (p_report_type = 'sec014' and v_sub = 1 and public.canon_has_role(array['so', 'sso', 'dse']))
    )
    and public.canon_same_team(sub.station, sub.team),
    false
  )
  -- A DSE is the operational lead of ONE station and team: every staff report of that exact station and team is within their authority, either entity.
  or coalesce(public.canon_dse_of_team(sub.station, sub.team) and v_sub in (1, 2), false);
end;
$function$;

-- one audit record per acknowledgment action (the unique constraint already allows only one acknowledgment per report)
create or replace function public.audit_report_acknowledgement()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  perform public.phase8_write_audit('report_acknowledged', 'report_acknowledgement', new.id, jsonb_build_object('report_type', new.report_type, 'report_id', new.report_id));
  return new;
end;
$function$;
revoke execute on function public.audit_report_acknowledgement() from public, anon, authenticated;
drop trigger if exists trg_audit_report_acknowledgement on public.report_acknowledgements;
create trigger trg_audit_report_acknowledgement after insert on public.report_acknowledgements for each row execute function public.audit_report_acknowledgement();

-- 3. DSE alerts resolve recipients from the report's canonical scope, for both entities ----------------------------------------------------------------------------
create or replace function public.dse_scope_recipients(p_station_id uuid, p_team_id uuid, p_submitter uuid)
returns table (profile_id uuid)
language sql
stable
security definer
set search_path to 'public'
as $function$
  select distinct ura.profile_id
  from public.user_role_assignments ura
  join public.role_definitions rd on rd.id = ura.role_definition_id and rd.is_active and rd.code = 'dse'
  join public.profiles p on p.id = ura.profile_id and p.status = 'approved'
  where p_station_id is not null and p_team_id is not null
    and ura.station_id = p_station_id
    and ura.team_id = p_team_id
    and ura.profile_id <> p_submitter
    and ura.revoked_at is null
    and ura.starts_at <= now()
    and (ura.ends_at is null or ura.ends_at > now());
$function$;

-- Idempotent (one alert per report per DSE) and never raises: every failure is recorded for monitoring. Returns the number of alerts offered.
create or replace function public.deliver_dse_report_notifications_v2(p_source_table text, p_source_id uuid, p_report_no text, p_flight text)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  s record;
  r record;
  v_count integer := 0;
begin
  begin
    select * into s from public.report_canonical_scope(p_source_table, p_source_id);
    if s.profile_id is null then
      raise exception 'Report % not found.', p_source_id;
    end if;
    if s.station_id is null or s.team_id is null then
      raise exception 'The report has no canonical station and team, so its DSE cannot be resolved safely.';
    end if;
    for r in select d.profile_id from public.dse_scope_recipients(s.station_id, s.team_id, s.profile_id) d loop
      begin
        perform public.notify(r.profile_id, 'dse_report_submitted', 'dse_report:' || p_source_table || ':' || p_source_id::text || ':' || r.profile_id::text,
          null, null, null,
          jsonb_build_object('source_table', p_source_table, 'source_id', p_source_id, 'report_no', p_report_no, 'flight', p_flight, 'station', s.station_code, 'team', s.team_name, 'entity', s.entity_code));
        v_count := v_count + 1;
      exception when others then
        insert into public.report_notification_failures (source_table, source_id, recipient_profile_id, error) values (p_source_table, p_source_id, r.profile_id, left(sqlerrm, 500));
      end;
    end loop;
  exception when others then
    begin
      insert into public.report_notification_failures (source_table, source_id, error) values (p_source_table, p_source_id, left(sqlerrm, 500));
    exception when others then
      null;
    end;
  end;
  return v_count;
end;
$function$;

create or replace function public.notify_dse_of_report()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  j jsonb := to_jsonb(new);
begin
  if (j ->> 'status') is distinct from 'submitted' then
    return new;
  end if;
  perform public.deliver_dse_report_notifications_v2(tg_table_name, new.id, j ->> 'report_no', coalesce(j ->> 'flight', j ->> 'flight_no', j ->> 'flight_number'));
  return new;
exception when others then
  begin
    insert into public.report_notification_failures (source_table, source_id, error) values (tg_table_name, new.id, left(sqlerrm, 500));
  exception when others then
    null;
  end;
  return new;
end;
$function$;

revoke execute on function public.dse_scope_recipients(uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function public.deliver_dse_report_notifications_v2(text, uuid, text, text) from public, anon, authenticated;
grant execute on function public.dse_scope_recipients(uuid, uuid, uuid) to service_role;
grant execute on function public.deliver_dse_report_notifications_v2(text, uuid, text, text) to service_role;

-- 4. New reports cannot carry a station or team different from the submitter's assignment ---------------------------------------------------------------------
create or replace function public.enforce_report_operational_scope()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_station text;
  v_team text;
  j jsonb := to_jsonb(new);
begin
  if auth.uid() is null or auth.role() = 'service_role' then
    return new;
  end if;
  if new.org_station_id is null or new.org_team_id is null then
    return new;
  end if;
  select st.code, tm.name into v_station, v_team from public.org_stations st join public.org_teams tm on tm.id = new.org_team_id where st.id = new.org_station_id;
  if v_station is null then
    return new;
  end if;
  -- the SEC029 station list collapses both KUL stations into 'KUL'
  if (j ->> 'station') is distinct from v_station and not (tg_table_name = 'report_sec029' and (j ->> 'station') = 'KUL' and v_station like 'KUL%') then
    raise exception 'The report station must be your assigned station (%). Select % and try again.', v_station, v_station using errcode = 'P0001';
  end if;
  if upper(coalesce(j ->> 'team', '')) is distinct from upper(v_team) then
    raise exception 'The report team must be your assigned team (%). Select % and try again.', v_team, v_team using errcode = 'P0001';
  end if;
  return new;
end;
$function$;
revoke execute on function public.enforce_report_operational_scope() from public, anon, authenticated;

drop trigger if exists trg_zz_enforce_report_operational_scope on public.report_sec013;
create trigger trg_zz_enforce_report_operational_scope before insert on public.report_sec013 for each row execute function public.enforce_report_operational_scope();
drop trigger if exists trg_zz_enforce_report_operational_scope on public.report_sec014;
create trigger trg_zz_enforce_report_operational_scope before insert on public.report_sec014 for each row execute function public.enforce_report_operational_scope();
drop trigger if exists trg_zz_enforce_report_operational_scope on public.report_sec016;
create trigger trg_zz_enforce_report_operational_scope before insert on public.report_sec016 for each row execute function public.enforce_report_operational_scope();
drop trigger if exists trg_zz_enforce_report_operational_scope on public.report_sec018;
create trigger trg_zz_enforce_report_operational_scope before insert on public.report_sec018 for each row execute function public.enforce_report_operational_scope();
drop trigger if exists trg_zz_enforce_report_operational_scope on public.report_sec029;
create trigger trg_zz_enforce_report_operational_scope before insert on public.report_sec029 for each row execute function public.enforce_report_operational_scope();
drop trigger if exists trg_zz_enforce_report_operational_scope on public.report_sec033;
create trigger trg_zz_enforce_report_operational_scope before insert on public.report_sec033 for each row execute function public.enforce_report_operational_scope();
drop trigger if exists trg_zz_enforce_report_operational_scope on public.report_makeup;
create trigger trg_zz_enforce_report_operational_scope before insert on public.report_makeup for each row execute function public.enforce_report_operational_scope();
drop trigger if exists trg_zz_enforce_report_operational_scope on public.report_breakup;
create trigger trg_zz_enforce_report_operational_scope before insert on public.report_breakup for each row execute function public.enforce_report_operational_scope();

-- 5. Team Submission History for DSE and SO ------------------------------------------------------------------------------------------------------------------
-- Scope is the caller's OWN station and team (every DSE or SO assignment they hold), matched on the report's canonical station and team. Both entities appear.
create or replace function public.list_team_submissions_secure(
  p_limit integer default 25,
  p_offset integer default 0,
  p_type text default null,
  p_from date default null,
  p_to date default null,
  p_entity text default null,
  p_search text default null,
  p_flight text default null,
  p_ack text default null
)
returns table (
  total_count bigint, source_table text, report_type text, id uuid, report_no text, staff_name text, staff_id text, flight text, entity text,
  station text, team text, typed_station text, submitted_at timestamptz, status text, acknowledged_at timestamptz, acknowledged_by_name text, can_acknowledge boolean
)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
  v_flight text := nullif(upper(btrim(coalesce(p_flight, ''))), '');
begin
  if auth.uid() is null then raise exception 'Must be signed in.'; end if;
  if not exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.status = 'approved') then raise exception 'Only an approved account may view team submissions.'; end if;
  if not exists (select 1 from public.canon_assignments() a where a.role_code in ('dse', 'so') and a.station_code is not null and a.team_name is not null) then
    raise exception 'Team Submission History is available to a DSE or SO of a station and team.';
  end if;
  if p_ack is not null and p_ack not in ('acknowledged', 'pending') then raise exception 'Invalid acknowledgment filter.'; end if;

  return query
  with scope as (
    select distinct a.station_code, upper(a.team_name) as team_upper from public.canon_assignments() a where a.role_code in ('dse', 'so') and a.station_code is not null and a.team_name is not null
  ),
  allr as (
    select 'report_sec013'::text st, 'sec013'::text rt, t.id, t.report_no, t.profile_id, t.staff_name, null::text flight, t.operating_entity_code ec, t.station typed, t.org_station_id osid, t.org_team_id otid, t.team tteam, t.submitted_at, t.status::text status from public.report_sec013 t
    union all select 'report_sec014', 'sec014', t.id, t.report_no, t.profile_id, t.staff_name, null, t.operating_entity_code, t.station, t.org_station_id, t.org_team_id, t.team, t.submitted_at, t.status::text from public.report_sec014 t
    union all select 'report_sec016', 'sec016', t.id, t.report_no, t.profile_id, t.staff_name, t.flight, t.operating_entity_code, t.station, t.org_station_id, t.org_team_id, t.team, t.submitted_at, t.status::text from public.report_sec016 t
    union all select 'report_sec018', 'sec018', t.id, t.report_no, t.profile_id, t.staff_name, null, t.operating_entity_code, t.station, t.org_station_id, t.org_team_id, t.team, t.submitted_at, t.status::text from public.report_sec018 t
    union all select 'report_sec029', 'sec029', t.id, t.report_no, t.profile_id, t.staff_name, t.flight_no, t.operating_entity_code, t.station, t.org_station_id, t.org_team_id, t.team, t.submitted_at, t.status::text from public.report_sec029 t
    union all select 'report_sec033', 'sec033', t.id, t.report_no, t.profile_id, t.staff_name, null, t.operating_entity_code, t.station, t.org_station_id, t.org_team_id, t.team, t.submitted_at, t.status::text from public.report_sec033 t
    union all select 'report_makeup', 'makeup', t.id, t.report_no, t.profile_id, t.staff_name, t.flight_number, t.operating_entity_code, t.station, t.org_station_id, t.org_team_id, t.team, t.submitted_at, t.status::text from public.report_makeup t
    union all select 'report_breakup', 'breakup', t.id, t.report_no, t.profile_id, t.staff_name, t.flight_number, t.operating_entity_code, t.station, t.org_station_id, t.org_team_id, t.team, t.submitted_at, t.status::text from public.report_breakup t
  ),
  scoped as (
    select x.*, coalesce(os.code, x.typed) as canon_station, coalesce(ot.name, x.tteam) as canon_team
    from allr x
    left join public.org_stations os on os.id = x.osid
    left join public.org_teams ot on ot.id = x.otid
    where lower(x.status) = 'submitted'
  ),
  visible as (
    select s.* from scoped s where exists (select 1 from scope c where c.station_code = s.canon_station and c.team_upper = upper(coalesce(s.canon_team, '')))
  ),
  shaped as (
    select v.st, v.rt, v.id, v.report_no, v.staff_name, p.staff_no as staff_id, v.flight, v.ec, v.canon_station, v.canon_team, v.typed, v.submitted_at, lower(v.status) as status,
           ak.acknowledged_at, coalesce(ap.name, ap.email) as ack_name
    from visible v
    left join public.profiles p on p.id = v.profile_id
    left join public.report_acknowledgements ak on ak.report_type = v.rt and ak.report_id = v.id
    left join public.profiles ap on ap.id = ak.acknowledged_by
    where (p_type is null or v.rt = lower(p_type))
      and (p_from is null or (v.submitted_at at time zone 'Asia/Kuala_Lumpur')::date >= p_from)
      and (p_to is null or (v.submitted_at at time zone 'Asia/Kuala_Lumpur')::date <= p_to)
      and (p_entity is null or v.ec = upper(p_entity))
      and (v_search is null or v.staff_name ilike '%' || v_search || '%' or p.staff_no ilike '%' || v_search || '%' or v.report_no ilike '%' || v_search || '%')
      and (v_flight is null or upper(coalesce(v.flight, '')) like '%' || v_flight || '%')
      and (p_ack is null or (p_ack = 'acknowledged' and ak.id is not null) or (p_ack = 'pending' and ak.id is null))
  )
  select count(*) over () as total_count, s.st, s.rt, s.id, s.report_no, s.staff_name, s.staff_id, s.flight, s.ec, s.canon_station, s.canon_team, s.typed, s.submitted_at, s.status,
         s.acknowledged_at, s.ack_name, public.can_acknowledge_report(s.rt, s.id)
  from shaped s
  order by s.submitted_at desc nulls last, s.id
  limit v_limit offset v_offset;
end;
$function$;
revoke execute on function public.list_team_submissions_secure(integer, integer, text, date, date, text, text, text, text) from public, anon;
grant execute on function public.list_team_submissions_secure(integer, integer, text, date, date, text, text, text, text) to authenticated, service_role;
