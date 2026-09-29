-- ===========================================================================
-- Phase 7 closure: entity-scoped staffing (MAA/AAX Boss/Admin) and Super
-- Admin technical-status aggregates.
--
-- Corrects a real gap left by 20260928000006: resolve_ops_dashboard_
-- station_scope() returned an UNRESTRICTED (Malaysia-wide) scope for
-- maa_boss/aax_boss/maa_admin/aax_admin, on the stated grounds that
-- org_stations carries no operating_entity_id. That reasoning is true for
-- STATIONS, but incomplete: user_entity_memberships (Phase 4) already
-- records which operating entity each individual STAFF MEMBER (profile)
-- actively belongs to. Staffing rows (duty_records) are per-profile, so
-- they CAN be correctly entity-scoped by joining through the staff
-- member's own active membership -- no station-level entity linkage is
-- needed for this. This migration replaces the over-broad fallback with
-- that real, derivable scope.
-- ===========================================================================

-- Resolves the calling profile's own operating_entity_id for MAA/AAX
-- Boss/Admin roles, read directly off their own assignment row (Phase 3's
-- scope-shape trigger requires operating_entity_id to be set and correct
-- for these four role codes -- see 20260928000002 lines ~312-326). Returns
-- NULL if the caller holds none of these roles (not an error -- callers
-- combine this with other scope resolvers).
create or replace function public.resolve_caller_entity_scope()
returns uuid
language sql
stable
security definer
set search_path to 'public'
as $function$
  select ura.operating_entity_id
  from public.user_role_assignments ura
  join public.role_definitions rd on rd.id = ura.role_definition_id
  where ura.profile_id = auth.uid()
    and rd.is_active
    and rd.code in ('maa_boss', 'maa_admin', 'aax_boss', 'aax_admin')
    and ura.revoked_at is null
    and ura.starts_at <= now()
    and (ura.ends_at is null or ura.ends_at > now())
  limit 1;
$function$;

revoke execute on function public.resolve_caller_entity_scope() from public, anon;
grant execute on function public.resolve_caller_entity_scope() to authenticated, service_role;

-- Staffing + Bay Board summary for MAA/AAX Boss, entity-scoped via each
-- staff member's own active user_entity_memberships row -- never via
-- station (no such column exists) and never inferred from station name,
-- email, or legacy role string. A staff member with no active membership
-- to ANY entity is correctly excluded from every entity-scoped view (fails
-- closed, not counted as "unclassified -> visible anyway").
--
-- Bay Board has no per-aircraft entity owner (bay_board.station only), so
-- entity-scoped Bay Board overdue counts are NOT computed here -- doing so
-- would require guessing an entity from station, which the CORE RULE
-- forbids. overdue_bay_board_count is always 0 with is_bay_board_scoped =
-- false for this function, so a caller can render "not available for this
-- scope" rather than a misleading real-looking number. See the Phase 7
-- closure report's Known Limitations for the schema addition that would
-- resolve this (bay_board.operating_entity_id, or a flight-to-entity
-- mapping).
create or replace function public.get_entity_dashboard_aggregate_secure(p_duty_date date default current_date)
returns table (
  entity_code text,
  checked_in_count bigint,
  pending_count bigint,
  absent_count bigint,
  total_staff bigint,
  is_bay_board_scoped boolean,
  overdue_bay_board_count bigint,
  generated_at timestamptz
)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_entity_id uuid;
  v_entity_code text;
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and status = 'approved') then
    raise exception 'not authorized';
  end if;

  v_entity_id := public.resolve_caller_entity_scope();
  if v_entity_id is null then
    raise exception 'caller holds no MAA/AAX Boss or Admin assignment';
  end if;

  select code into v_entity_code from public.operating_entities where id = v_entity_id;

  return query
  select
    v_entity_code,
    count(*) filter (where dr.status in ('present', 'late'))::bigint,
    count(*) filter (where dr.status = 'pending')::bigint,
    count(*) filter (where dr.status = 'absent')::bigint,
    count(*)::bigint,
    false,
    0::bigint,
    now()
  from public.duty_records dr
  where dr.duty_date = p_duty_date
    and exists (
      select 1 from public.user_entity_memberships uem
      where uem.profile_id = dr.profile_id
        and uem.operating_entity_id = v_entity_id
        and uem.status = 'active'
        and uem.starts_at <= now()
        and (uem.ends_at is null or uem.ends_at > now())
    );
end;
$function$;

revoke execute on function public.get_entity_dashboard_aggregate_secure(date) from public, anon;
grant execute on function public.get_entity_dashboard_aggregate_secure(date) to authenticated, service_role;

-- Directory/registration-queue summary for MAA/AAX Admin. Entity-scoped
-- the same way (via each profile's own active membership), never via
-- station. Registration requests (Phase 4's user_registration_requests)
-- have no operating_entity_id of their own in this schema, so the
-- pending-registration count here is deliberately NOT entity-filtered --
-- it is the Malaysia-wide pending count, labeled as such, rather than a
-- fabricated per-entity split. See Known Limitations.
create or replace function public.get_entity_admin_summary_secure()
returns table (
  entity_code text,
  active_staff_count bigint,
  malaysia_wide_pending_registration_count bigint,
  generated_at timestamptz
)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_entity_id uuid;
  v_entity_code text;
  v_pending bigint;
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and status = 'approved') then
    raise exception 'not authorized';
  end if;

  if not (public.has_active_role('maa_admin') or public.has_active_role('aax_admin')) then
    raise exception 'caller holds no MAA/AAX Admin assignment';
  end if;

  v_entity_id := public.resolve_caller_entity_scope();
  if v_entity_id is null then
    raise exception 'caller holds no MAA/AAX Admin assignment';
  end if;
  select code into v_entity_code from public.operating_entities where id = v_entity_id;

  select count(*) into v_pending
  from public.user_registration_requests urr
  where urr.status = 'pending';

  return query
  select
    v_entity_code,
    (
      select count(*)::bigint from public.user_entity_memberships uem
      where uem.operating_entity_id = v_entity_id
        and uem.status = 'active'
        and uem.starts_at <= now()
        and (uem.ends_at is null or uem.ends_at > now())
    ),
    coalesce(v_pending, 0)::bigint,
    now();
end;
$function$;

revoke execute on function public.get_entity_admin_summary_secure() from public, anon;
grant execute on function public.get_entity_admin_summary_secure() to authenticated, service_role;

-- Super Admin technical status: queue/indexing health counts only -- no
-- report content, no secrets, no credentials, no environment values. Only
-- callable by an active super_admin assignment; every other caller is
-- denied, never given a partial/empty result that could be mistaken for a
-- real (if boring) status.
create or replace function public.get_super_admin_technical_status_secure()
returns table (
  queue_pending bigint,
  queue_processing bigint,
  queue_completed bigint,
  queue_failed bigint,
  queue_permanently_failed bigint,
  pending_registration_count bigint,
  pending_profile_approval_count bigint,
  generated_at timestamptz
)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and status = 'approved') then
    raise exception 'not authorized';
  end if;
  if not public.has_active_role('super_admin') then
    raise exception 'caller holds no super_admin assignment';
  end if;

  return query
  select
    count(*) filter (where riq.status = 'pending')::bigint,
    count(*) filter (where riq.status = 'processing')::bigint,
    count(*) filter (where riq.status = 'completed')::bigint,
    count(*) filter (where riq.status = 'failed')::bigint,
    count(*) filter (where riq.status = 'permanently_failed')::bigint,
    (select count(*)::bigint from public.user_registration_requests where status = 'pending'),
    (select count(*)::bigint from public.profiles where status = 'pending'),
    now()
  from public.report_index_queue riq;
end;
$function$;

revoke execute on function public.get_super_admin_technical_status_secure() from public, anon;
grant execute on function public.get_super_admin_technical_status_secure() to authenticated, service_role;

-- Correct resolve_ops_dashboard_station_scope(): MAA/AAX Boss/Admin no
-- longer fall into the Malaysia-wide "unrestricted" branch (that was this
-- migration's starting bug -- see the header comment). They now raise,
-- directing callers to get_entity_dashboard_aggregate_secure()/
-- get_entity_admin_summary_secure() instead, which apply the real
-- entity-membership-based scope. Every other branch is unchanged.
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

  if public.has_active_role('airasia_management')
     or public.has_active_role('ghod')
     or public.has_active_role('global_reporting_controller')
  then
    return null;
  end if;

  if public.has_active_role('super_admin') then
    raise exception 'super_admin has no automatic operational dashboard access';
  end if;

  -- MAA/AAX Boss/Admin: entity-scoped, not station-scoped -- use
  -- get_entity_dashboard_aggregate_secure() / get_entity_admin_summary_secure().
  if public.has_active_role('maa_boss')
     or public.has_active_role('aax_boss')
     or public.has_active_role('maa_admin')
     or public.has_active_role('aax_admin')
  then
    raise exception 'maa/aax boss and admin roles use the entity-scoped dashboard functions, not this one';
  end if;

  -- Malaysia-wide department roles: no station restriction.
  if public.has_active_role('operation_manager')
     or public.has_active_role('main_enforcement')
     or public.has_active_role('compliance')
     or public.has_active_role('investigation_sso')
     or public.has_active_role('investigation_so')
     or public.has_active_role('investigation_aso')
     or public.has_active_role('profiling_so')
     or public.has_active_role('profiling_aso')
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
