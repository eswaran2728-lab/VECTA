-- ===========================================================================
-- Phase 7: Executive, AOC, Department and Operational Dashboards
--
-- Secure, server-side scoped aggregate RPCs for dashboard staffing and Bay
-- Board summary cards. Mirrors get_report_dashboard_aggregate_secure's
-- (Phase 6) authorization pattern: authorization and aggregation happen
-- together inside one SECURITY DEFINER function, so the client never
-- supplies scope and a null/absent scope never silently becomes global.
-- ===========================================================================

-- Resolves the calling profile's own active-assignment scope to a concrete
-- set of station codes it may see staffing/Bay Board data for, or NULL to
-- mean "no station restriction" (Malaysia-wide / international). Raises if
-- the caller holds no role assignment usable for this dashboard family --
-- callers must not fall back to an implicit global view on failure.
--
-- Known limitation (documented, not silently assumed): MAA/AAX entity-level
-- isolation is NOT applied here. org_stations is deliberately not
-- entity-scoped (Phase 2: "any Malaysia entity may operate at any
-- station"), and profiles carry no operating_entity_id column today, so
-- there is no field to filter duty/staffing rows by entity. maa_boss,
-- aax_boss, maa_admin and aax_admin therefore see the Malaysia-wide figure
-- through this function, not an MAA-only or AAX-only figure, until a later
-- phase adds that linkage.
create or replace function public.resolve_ops_dashboard_station_scope()
returns text[]
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_stations text[];
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and status = 'approved') then
    raise exception 'not authorized';
  end if;

  -- International executive roles and the global reporting controller see
  -- every Malaysia station -- no restriction.
  if public.has_active_role('airasia_management')
     or public.has_active_role('ghod')
     or public.has_active_role('global_reporting_controller')
  then
    return null;
  end if;

  -- Super Admin is technical-administration only -- explicitly no automatic
  -- operational dashboard access (Phase 7 spec section 3).
  if public.has_active_role('super_admin') then
    raise exception 'super_admin has no automatic operational dashboard access';
  end if;

  -- Malaysia-wide department/leadership roles: no station restriction. See
  -- the entity-isolation limitation documented above for the MAA/AAX rows.
  if public.has_active_role('operation_manager')
     or public.has_active_role('main_enforcement')
     or public.has_active_role('compliance')
     or public.has_active_role('investigation_sso')
     or public.has_active_role('investigation_so')
     or public.has_active_role('investigation_aso')
     or public.has_active_role('profiling_so')
     or public.has_active_role('profiling_aso')
     or public.has_active_role('maa_boss')
     or public.has_active_role('aax_boss')
     or public.has_active_role('maa_admin')
     or public.has_active_role('aax_admin')
  then
    return null;
  end if;

  -- Hub-scoped: Hub SE (assigned hub), SAT ASO (fixed KUL hub scope).
  select array_agg(s.code) into v_stations
  from public.user_role_assignments ura
  join public.role_definitions rd on rd.id = ura.role_definition_id
  join public.hubs h on h.id = ura.hub_id
  join public.org_stations s on s.hub_id = h.id
  where ura.profile_id = auth.uid()
    and rd.is_active
    and ura.revoked_at is null
    and ura.starts_at <= now()
    and (ura.ends_at is null or ura.ends_at > now())
    and rd.code in ('hub_se', 'sat_aso');

  if v_stations is not null then
    return v_stations;
  end if;

  -- Station-scoped: DSE, SSO, SO, ASO -- restricted to their own assigned
  -- station(s) only.
  select array_agg(distinct s.code) into v_stations
  from public.user_role_assignments ura
  join public.role_definitions rd on rd.id = ura.role_definition_id
  join public.org_stations s on s.id = ura.station_id
  where ura.profile_id = auth.uid()
    and rd.is_active
    and ura.revoked_at is null
    and ura.starts_at <= now()
    and (ura.ends_at is null or ura.ends_at > now())
    and rd.code in ('dse', 'sso', 'so', 'aso');

  if v_stations is not null then
    return v_stations;
  end if;

  raise exception 'no active role assignment grants operational dashboard access';
end;
$function$;

revoke execute on function public.resolve_ops_dashboard_station_scope() from public, anon;
grant execute on function public.resolve_ops_dashboard_station_scope() to authenticated, service_role;

-- Single-row staffing + Bay Board summary for the caller's own resolved
-- scope. Aggregation and authorization happen together inside this one
-- function -- the client supplies only p_duty_date, never a scope.
create or replace function public.get_ops_dashboard_aggregate_secure(p_duty_date date default current_date)
returns table (
  scope_kind text,
  checked_in_count bigint,
  pending_count bigint,
  absent_count bigint,
  total_staff bigint,
  overdue_bay_board_count bigint,
  generated_at timestamptz
)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_scope text[];
begin
  v_scope := public.resolve_ops_dashboard_station_scope();

  return query
  select
    case when v_scope is null then 'unrestricted' else 'station_scoped' end,
    count(*) filter (where dr.status in ('present', 'late'))::bigint,
    count(*) filter (where dr.status = 'pending')::bigint,
    count(*) filter (where dr.status = 'absent')::bigint,
    count(*)::bigint,
    (
      select count(*)::bigint from public.bay_board bb
      where bb.cleared_at is null
        and bb.on_ground_since <= now() - interval '4 hours'
        and (v_scope is null or bb.station = any (v_scope))
    ),
    now()
  from public.duty_records dr
  where dr.duty_date = p_duty_date
    and (v_scope is null or dr.station = any (v_scope));
end;
$function$;

revoke execute on function public.get_ops_dashboard_aggregate_secure(date) from public, anon;
grant execute on function public.get_ops_dashboard_aggregate_secure(date) to authenticated, service_role;

-- Hub-level staffing breakdown for the caller's own resolved scope, with
-- small-group suppression: any hub whose station set (after scope
-- restriction) contributes fewer than 3 duty_records rows for the day is
-- folded into a single 'combined_below_threshold' bucket instead of being
-- shown individually, so a near-empty hub is never an implicit per-person
-- staffing disclosure.
create or replace function public.get_ops_dashboard_hub_breakdown_secure(p_duty_date date default current_date)
returns table (
  hub_code text,
  checked_in_count bigint,
  total_staff bigint
)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_scope text[];
begin
  v_scope := public.resolve_ops_dashboard_station_scope();

  return query
  with per_hub as (
    select
      coalesce(h.code, 'unclassified') as hub_code,
      count(*) filter (where dr.status in ('present', 'late'))::bigint as checked_in_count,
      count(*)::bigint as total_staff
    from public.duty_records dr
    left join public.org_stations s on s.code = dr.station
    left join public.hubs h on h.id = s.hub_id
    where dr.duty_date = p_duty_date
      and (v_scope is null or dr.station = any (v_scope))
    group by coalesce(h.code, 'unclassified')
  )
  select
    case when per_hub.total_staff < 3 then 'combined_below_threshold' else per_hub.hub_code end,
    sum(per_hub.checked_in_count)::bigint,
    sum(per_hub.total_staff)::bigint
  from per_hub
  group by case when per_hub.total_staff < 3 then 'combined_below_threshold' else per_hub.hub_code end;
end;
$function$;

revoke execute on function public.get_ops_dashboard_hub_breakdown_secure(date) from public, anon;
grant execute on function public.get_ops_dashboard_hub_breakdown_secure(date) to authenticated, service_role;
