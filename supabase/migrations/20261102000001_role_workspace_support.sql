-- Role-workspace correction support (additive, forward-only; nothing here edits an applied migration).
--
--  A. derive_report_classification(): a STORED explicit entity written by a trusted (service_role) insert is authoritative -- the flight
--     prefix (AK -> MAA, D7 -> AAX) only PROPOSES a value for reports that carry none, and never overrides one.
--  B. Bay Board read path (selectors + rows) also for Operation Manager and Main Enforcement (read-only oversight), in addition to the
--     MAA/AAX Boss and Admin it already served. Still AOC-scoped; still no entity inference from a station.
--  C. Global Reporting Controller workspace: report-request queue, grant / expiry history, access-and-export audit, request rejection
--     (audited). GRC only; summaries and identifiers, never report content.
--  D. request_report_access(): only an approved profile with an ACTIVE, in-window assignment may open a request (pending / rejected /
--     deactivated / revoked / expired / future-dated callers fail closed, exactly like the rest of the report layer).

-- ---------------------------------------------------------------------------------------------
-- A. explicit stored entity is authoritative
-- ---------------------------------------------------------------------------------------------
create or replace function public.derive_report_classification()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_match_count integer;
  v_flight text;
  v_flight_class record;
  v_entity record;
  v_assignment_aoc uuid;
  v_explicit_entity_id uuid;
  v_explicit_entity_code text;
begin
  -- A trusted caller (service_role: import / reconciliation / the entity-confirmation workflow) may store an explicit entity.
  if auth.role() = 'service_role' and new.operating_entity_id is not null then
    v_explicit_entity_id := new.operating_entity_id;
    v_explicit_entity_code := new.operating_entity_code;
  end if;

  if auth.role() <> 'service_role' then
    new.aoc_id := null;
    new.operating_entity_id := null;
    new.operating_entity_code := null;
    new.department_id := null;
    new.unit_id := null;
    new.hub_id := null;
    new.org_station_id := null;
    new.org_team_id := null;
    new.severity := null;
    new.flag_state := 'unflagged';
    new.flagged_by := null;
    new.flagged_reason := null;
    new.flagged_at := null;
    new.unflagged_by := null;
    new.unflagged_at := null;
  end if;

  select count(*) into v_match_count
  from public.user_role_assignments ura
  join public.role_definitions rd on rd.id = ura.role_definition_id
  where ura.profile_id = new.profile_id
    and rd.is_active
    and ura.revoked_at is null
    and ura.starts_at <= now()
    and (ura.ends_at is null or ura.ends_at > now())
    and ura.aoc_id is not null;

  if v_match_count = 1 then
    select ura.aoc_id, coalesce(ura.operating_entity_id, uem.operating_entity_id), coalesce(oe.code, oem.code),
           ura.department_id, ura.unit_id, ura.hub_id, ura.station_id, ura.team_id
    into new.aoc_id, new.operating_entity_id, new.operating_entity_code, new.department_id, new.unit_id, new.hub_id, new.org_station_id, new.org_team_id
    from public.user_role_assignments ura
    left join public.operating_entities oe on oe.id = ura.operating_entity_id
    left join public.user_entity_memberships uem on uem.id = ura.entity_membership_id and uem.status = 'active'
      and uem.starts_at <= now() and (uem.ends_at is null or uem.ends_at > now())
    left join public.operating_entities oem on oem.id = uem.operating_entity_id
    where ura.profile_id = new.profile_id
      and ura.role_definition_id in (select id from public.role_definitions where is_active)
      and ura.revoked_at is null
      and ura.starts_at <= now()
      and (ura.ends_at is null or ura.ends_at > now())
      and ura.aoc_id is not null
    limit 1;

    v_flight := case tg_table_name
      when 'report_sec016' then to_jsonb(new) ->> 'flight'
      when 'report_sec029' then to_jsonb(new) ->> 'flight_no'
      when 'offload_records' then to_jsonb(new) ->> 'flight_no'
      else null
    end;
    if tg_table_name in ('report_sec016', 'report_sec029', 'offload_records') and v_explicit_entity_id is null then
      v_assignment_aoc := new.aoc_id;
      select * into v_flight_class from public.classify_flight_operating_entity(v_flight);
      new.operating_entity_id := null;
      new.operating_entity_code := null;
      if v_flight_class.status = 'classified' then
        select oe.id, oe.code, oe.aoc_id into v_entity from public.operating_entities oe where oe.code = v_flight_class.entity_code limit 1;
        if v_entity.id is not null and v_entity.aoc_id is not distinct from v_assignment_aoc then
          new.operating_entity_id := v_entity.id;
          new.operating_entity_code := v_entity.code;
        end if;
      end if;
    end if;
  end if;

  -- The stored explicit value wins over anything a prefix or the submitter's membership would propose.
  if v_explicit_entity_id is not null then
    new.operating_entity_id := v_explicit_entity_id;
    new.operating_entity_code := v_explicit_entity_code;
  end if;

  return new;
end;
$function$;

-- ---------------------------------------------------------------------------------------------
-- B. Bay Board read path for oversight roles
-- ---------------------------------------------------------------------------------------------
create or replace function public.caller_bay_board_aoc()
returns uuid
language sql
stable
security definer
set search_path to 'public'
as $function$
  select ura.aoc_id
  from public.user_role_assignments ura
  join public.role_definitions rd on rd.id = ura.role_definition_id and rd.is_active
  join public.profiles p on p.id = ura.profile_id and p.status = 'approved'
  where ura.profile_id = auth.uid()
    and rd.code in ('maa_boss', 'maa_admin', 'aax_boss', 'aax_admin', 'operation_manager', 'main_enforcement')
    and ura.aoc_id is not null
    and ura.revoked_at is null
    and ura.starts_at <= now()
    and (ura.ends_at is null or ura.ends_at > now())
  order by ura.starts_at
  limit 1;
$function$;
revoke execute on function public.caller_bay_board_aoc() from public, anon;
grant execute on function public.caller_bay_board_aoc() to authenticated, service_role;

create or replace function public.list_bay_board_scopes_secure()
returns table (hub_code text, hub_name text, station_code text, station_name text)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_aoc uuid := public.caller_bay_board_aoc();
begin
  if v_aoc is null then
    raise exception 'Only an approved entity leader or operations / enforcement oversight role may use the Bay Board selectors.';
  end if;
  return query
  select h.code, h.name, s.code, s.name
  from public.hubs h join public.org_stations s on s.hub_id = h.id and s.is_active
  where h.aoc_id = v_aoc
  order by h.name, s.code;
end;
$function$;
revoke execute on function public.list_bay_board_scopes_secure() from public, anon;
grant execute on function public.list_bay_board_scopes_secure() to authenticated, service_role;

create or replace function public.get_bay_board_secure(p_hub_code text default null, p_station_code text default null)
returns table (id uuid, station text, reg_no text, aircraft_type text, bay text, flight text, on_ground_since timestamptz)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_aoc uuid := public.caller_bay_board_aoc();
begin
  if v_aoc is null then
    raise exception 'Only an approved entity leader or operations / enforcement oversight role may view the Bay Board through this path.';
  end if;
  return query
  select b.id, b.station, b.reg_no, b.aircraft_type, b.bay, b.flight, b.on_ground_since
  from public.bay_board b
  join public.org_stations s on s.code = b.station and s.is_active
  join public.hubs h on h.id = s.hub_id and h.aoc_id = v_aoc
  where b.cleared_at is null
    and (p_station_code is null or s.code = p_station_code)
    and (p_hub_code is null or h.code = p_hub_code)
  order by b.station, b.bay nulls last, b.on_ground_since;
end;
$function$;
revoke execute on function public.get_bay_board_secure(text, text) from public, anon;
grant execute on function public.get_bay_board_secure(text, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- C. Global Reporting Controller workspace
-- ---------------------------------------------------------------------------------------------
alter table public.report_access_audit drop constraint if exists report_access_audit_action_check;
alter table public.report_access_audit add constraint report_access_audit_action_check check (action in (
  'view', 'version_view', 'download', 'export',
  'access_request', 'grant', 'revoke',
  'flag', 'unflag', 'amendment_request', 'amendment_approved', 'amendment_rejected',
  'index', 'reindex', 'entity_confirmed', 'entity_conflict',
  'attachment_url_issued',
  'detail_view', 'amendment_view', 'pdf_generated', 'pdf_downloaded',
  'export_generated', 'explicit_grant_used', 'unauthorized_attempt',
  'access_request_rejected'
));

create or replace function public.list_report_access_requests_secure(p_status text default null, p_page integer default 1, p_page_size integer default 25)
returns table (
  id uuid, requester_profile_id uuid, requester_name text, requester_staff_no text, source_table text, operating_entity_code text,
  flight_number text, report_date date, business_reason text, requested_duration_days integer, status text, decision_reason text,
  created_at timestamptz, reviewed_at timestamptz, total_count bigint
)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_page integer := greatest(coalesce(p_page, 1), 1);
  v_size integer := least(greatest(coalesce(p_page_size, 25), 1), 100);
begin
  if not public.has_active_role('global_reporting_controller') then
    raise exception 'Only the Global Reporting Controller may view the report-request queue.';
  end if;
  if p_status is not null and p_status not in ('pending', 'approved', 'rejected') then
    raise exception 'Unsupported status filter.';
  end if;
  return query
  with q as (
    select r.*, p.name as pname, p.staff_no as pstaff, c.source_table as src_table, c.source_id as src_id, c.operating_entity_code as ent
    from public.report_access_requests r
    join public.profiles p on p.id = r.requester_id
    join public.central_reports_index c on c.id = r.repository_report_id
    where p_status is null or r.status = p_status
  ), n as (select count(*) as c from q)
  select q.id, q.requester_id, q.pname, q.pstaff, q.src_table, q.ent, f.flight, f.report_date, q.business_reason, q.requested_duration_days,
         q.status, q.decision_reason, q.created_at, q.reviewed_at, n.c
  from q cross join n
  cross join lateral public.report_source_flight_date(q.src_table, q.src_id) f
  order by (q.status = 'pending') desc, q.created_at desc
  limit v_size offset (v_page - 1) * v_size;
end;
$function$;
revoke execute on function public.list_report_access_requests_secure(text, integer, integer) from public, anon;
grant execute on function public.list_report_access_requests_secure(text, integer, integer) to authenticated, service_role;

create or replace function public.list_report_access_grants_secure(p_state text default null, p_page integer default 1, p_page_size integer default 25)
returns table (
  id uuid, grantee_profile_id uuid, grantee_name text, grantee_staff_no text, granted_by_name text, source_table text,
  operating_entity_code text, reason text, starts_at timestamptz, expires_at timestamptz, revoked_at timestamptz, state text,
  created_at timestamptz, total_count bigint
)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_page integer := greatest(coalesce(p_page, 1), 1);
  v_size integer := least(greatest(coalesce(p_page_size, 25), 1), 100);
begin
  if not public.has_active_role('global_reporting_controller') then
    raise exception 'Only the Global Reporting Controller may view grants.';
  end if;
  if p_state is not null and p_state not in ('active', 'scheduled', 'expired', 'revoked') then
    raise exception 'Unsupported state filter.';
  end if;
  return query
  with g as (
    select x.*, gp.name as gname, gp.staff_no as gstaff, bp.name as bname, c.source_table as src_table, c.operating_entity_code as ent,
           case when x.revoked_at is not null then 'revoked'
                when x.starts_at > now() then 'scheduled'
                when x.expires_at is not null and x.expires_at <= now() then 'expired'
                else 'active' end as st
    from public.report_access_grants x
    join public.profiles gp on gp.id = x.grantee_profile_id
    join public.profiles bp on bp.id = x.granted_by
    join public.central_reports_index c on c.id = x.repository_report_id
  ), f as (select * from g where p_state is null or g.st = p_state), n as (select count(*) as c from f)
  select f.id, f.grantee_profile_id, f.gname, f.gstaff, f.bname, f.src_table, f.ent, f.reason, f.starts_at, f.expires_at, f.revoked_at, f.st, f.created_at, n.c
  from f cross join n
  order by f.created_at desc
  limit v_size offset (v_page - 1) * v_size;
end;
$function$;
revoke execute on function public.list_report_access_grants_secure(text, integer, integer) from public, anon;
grant execute on function public.list_report_access_grants_secure(text, integer, integer) to authenticated, service_role;

create or replace function public.list_report_access_audit_secure(p_scope text default 'export', p_page integer default 1, p_page_size integer default 25)
returns table (id uuid, actor_name text, actor_staff_no text, action text, source_table text, operating_entity_code text, reason text, created_at timestamptz, total_count bigint)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_page integer := greatest(coalesce(p_page, 1), 1);
  v_size integer := least(greatest(coalesce(p_page_size, 25), 1), 100);
  v_actions text[];
begin
  if not public.has_active_role('global_reporting_controller') then
    raise exception 'Only the Global Reporting Controller may view the access and export audit.';
  end if;
  v_actions := case coalesce(p_scope, 'export')
    when 'export' then array['export', 'export_generated', 'download', 'pdf_generated', 'pdf_downloaded', 'attachment_url_issued']
    when 'grants' then array['access_request', 'grant', 'revoke', 'access_request_rejected', 'explicit_grant_used']
    when 'denied' then array['unauthorized_attempt']
    else null end;
  if v_actions is null then
    raise exception 'Unsupported audit scope.';
  end if;
  return query
  with a as (
    select x.id, x.actor_id, x.action, x.reason, x.created_at, c.source_table as src_table, c.operating_entity_code as ent
    from public.report_access_audit x
    left join public.central_reports_index c on c.id = x.repository_report_id
    where x.action = any (v_actions)
  ), n as (select count(*) as c from a)
  select a.id, p.name, p.staff_no, a.action, a.src_table, a.ent, a.reason, a.created_at, n.c
  from a cross join n left join public.profiles p on p.id = a.actor_id
  order by a.created_at desc
  limit v_size offset (v_page - 1) * v_size;
end;
$function$;
revoke execute on function public.list_report_access_audit_secure(text, integer, integer) from public, anon;
grant execute on function public.list_report_access_audit_secure(text, integer, integer) to authenticated, service_role;

create or replace function public.reject_report_access_request(p_request_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_request record;
begin
  if not public.has_active_role('global_reporting_controller') then
    raise exception 'Only the Global Reporting Controller may reject a report-access request.';
  end if;
  if p_reason is null or length(btrim(p_reason)) < 3 then
    raise exception 'A rejection reason is required.';
  end if;
  select * into v_request from public.report_access_requests where id = p_request_id for update;
  if v_request is null then
    raise exception 'Access request not found.';
  end if;
  if v_request.status <> 'pending' then
    raise exception 'Access request has already been reviewed (status=%).', v_request.status;
  end if;
  update public.report_access_requests
  set status = 'rejected', reviewed_by = auth.uid(), reviewed_at = now(), decision_reason = btrim(p_reason)
  where id = p_request_id;
  insert into public.report_access_audit (actor_id, repository_report_id, action, reason, request_id)
  values (auth.uid(), v_request.repository_report_id, 'access_request_rejected', btrim(p_reason), p_request_id);
end;
$function$;
revoke execute on function public.reject_report_access_request(uuid, text) from public, anon;
grant execute on function public.reject_report_access_request(uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- D. a request needs an approved profile with an ACTIVE assignment
-- ---------------------------------------------------------------------------------------------
create or replace function public.request_report_access(
  p_repository_report_id uuid,
  p_business_reason text,
  p_requested_duration_days integer default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Must be signed in to request report access.';
  end if;
  if not exists (select 1 from public.profiles where id = auth.uid() and status = 'approved')
     or not exists (select 1 from public.get_my_active_role_assignments()) then
    raise exception 'Only an approved account with an active role assignment may request report access.';
  end if;
  if p_business_reason is null or length(trim(p_business_reason)) = 0 then
    raise exception 'A business reason is required.';
  end if;

  insert into public.report_access_requests (requester_id, repository_report_id, business_reason, requested_duration_days)
  values (auth.uid(), p_repository_report_id, p_business_reason, p_requested_duration_days)
  returning id into v_id;

  insert into public.report_access_audit (actor_id, repository_report_id, action, reason, request_id)
  values (auth.uid(), p_repository_report_id, 'access_request', p_business_reason, v_id);

  return v_id;
end;
$function$;
revoke execute on function public.request_report_access(uuid, text, integer) from public, anon;
grant execute on function public.request_report_access(uuid, text, integer) to authenticated, service_role;
