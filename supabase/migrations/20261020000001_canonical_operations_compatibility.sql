-- =======================================================================
-- Canonical operations compatibility (merged operations model)
-- =======================================================================
-- Decision (2026-10-05): IFC AVSEC and Operation AVSEC are one operational
-- structure. Canonical Phase 3 role assignments and organisational scope are
-- the only authority; ops_group is DEPRECATED for authorization. Legacy
-- profile rank and ops_group must neither grant nor deny anything.
--
-- What this migration does (additive / replacing, never destructive of data):
--   1. canonical_compat_role_for(profile): the legacy-RLS identity helpers now
--      derive from ACTIVE canonical assignments, so every pre-existing policy
--      that calls current_role_name()/current_role_rank()/current_status()/
--      current_station()/current_team()/submitter_role_rank() becomes
--      canonical without editing each policy. A forged profiles.role /
--      station / team / ops_group value can no longer grant or deny anything.
--      Compatibility mapping (display/legacy-table rank ONLY):
--        aso->ASO, so/sso->SO, dse/hub_se->DSE, operation_manager->MANAGEMENT,
--        main_enforcement->ENFORCEMENT. Every other role maps to NULL (no
--        invented legacy rank) and fails closed in legacy-rank policies.
--   2. Fail-closed status: current_status() reports 'approved' only for an
--      approved profile that ALSO holds an active, non-revoked, effective
--      assignment of an active role definition.
--   3. Inline legacy-rank policies on absence_notices and can_acknowledge_report
--      replaced with canonical equivalents.
--   4. ops_group removed from apply_compatibility_profile_fields and
--      needs_your_action_secure (the parameter stays only for signature
--      compatibility and is ignored).
--   5. Canonical supervising-officer eligibility RPCs (no other user's legacy
--      rank is trusted).
--   6. Staff Profiling can file SEC013 through a canonical policy.
--   7. Every FOR ALL policy in public is split into operation-specific
--      policies with identical predicates.
--   8. anon loses all table and function privileges in public (RLS remains
--      enabled everywhere); authenticated/service_role grants are preserved.
--
-- Rollback / recovery: this migration only replaces function bodies and
-- policies. Restore the previous bodies from the earlier migrations listed in
-- docs/dashboard-review/canonical-compat-migration-plan.md and re-grant anon
-- if ever required.
-- =======================================================================

-- ---------- 1. canonical compatibility role ----------
create or replace function public.canonical_compat_role_for(p_profile_id uuid)
returns user_role
language sql
stable
security definer
set search_path to 'public'
as $function$
  select (array_agg(m.compat order by public.role_rank(m.compat) desc))[1]
  from (
    select (case rd.code
              when 'aso' then 'ASO'
              when 'so' then 'SO'
              when 'sso' then 'SO'
              when 'dse' then 'DSE'
              when 'hub_se' then 'DSE'
              when 'operation_manager' then 'MANAGEMENT'
              when 'main_enforcement' then 'ENFORCEMENT'
            end)::user_role as compat
    from public.user_role_assignments ura
    join public.role_definitions rd on rd.id = ura.role_definition_id
    join public.profiles p on p.id = ura.profile_id
    -- The legacy tables and their RLS are Malaysia-only and not AOC-scoped, so a compatibility
    -- rank is derived ONLY from assignments inside the legacy (Malaysia) AOC. An assignment in
    -- any other AOC never maps to a legacy rank and therefore cannot reach legacy rows.
    join public.aocs legacy_aoc on legacy_aoc.id = ura.aoc_id and legacy_aoc.code = 'MY'
    where ura.profile_id = p_profile_id
      and p.status = 'approved'
      and rd.is_active
      and ura.revoked_at is null
      and ura.starts_at <= now()
      and (ura.ends_at is null or ura.ends_at > now())
  ) m
  where m.compat is not null;
$function$;

revoke execute on function public.canonical_compat_role_for(uuid) from public, anon, authenticated;
grant execute on function public.canonical_compat_role_for(uuid) to service_role;

-- ---------- 1b. canonical scope helpers (the ONLY identity source for legacy-table RLS) ----------
-- Every helper reads the caller's ACTIVE Phase 3 assignments inside the legacy (Malaysia) AOC and
-- nothing else: not profiles.role, not the compatibility rank, not ops_group. Each is SECURITY
-- DEFINER with a pinned search_path, checks auth.uid() internally (NULL -> no rows / false), requires
-- an approved profile and an active role definition, and respects revoked / expired / future-dated
-- assignments. EXECUTE is granted to authenticated and service_role only (never PUBLIC / anon),
-- except the internal level lookup which is callable only by other definers.
create or replace function public.canon_assignments()
returns table(role_code text, department_code text, hub_id uuid, station_code text, team_name text)
language sql
stable
security definer
set search_path to 'public'
as $function$
  select rd.code::text, d.code::text, coalesce(ura.hub_id, s.hub_id), s.code::text, t.name::text
  from public.user_role_assignments ura
  join public.role_definitions rd on rd.id = ura.role_definition_id and rd.is_active
  join public.profiles p on p.id = ura.profile_id and p.status = 'approved'
  join public.aocs a on a.id = ura.aoc_id and a.code = 'MY'
  left join public.departments d on d.id = ura.department_id
  left join public.org_stations s on s.id = ura.station_id
  left join public.org_teams t on t.id = ura.team_id
  where auth.uid() is not null
    and ura.profile_id = auth.uid()
    and ura.revoked_at is null
    and ura.starts_at <= now()
    and (ura.ends_at is null or ura.ends_at > now());
$function$;

create or replace function public.canon_is_active()
returns boolean language sql stable security definer set search_path to 'public'
as $function$ select exists (select 1 from public.canon_assignments()); $function$;

create or replace function public.canon_has_role(p_codes text[])
returns boolean language sql stable security definer set search_path to 'public'
as $function$ select exists (select 1 from public.canon_assignments() a where a.role_code = any (p_codes)); $function$;

-- Canonical role level used ONLY for supervisory ordering inside this migration's predicates
-- (derived from role CODES; it is not the legacy compatibility rank).
create or replace function public.canon_role_level(p_code text)
returns integer language sql immutable
as $function$
  select case p_code
    when 'aso' then 1
    when 'so' then 2 when 'sso' then 2
    when 'dse' then 3 when 'hub_se' then 3
    when 'main_enforcement' then 4
    when 'operation_manager' then 5
    else 0
  end;
$function$;

create or replace function public.canon_my_level()
returns integer language sql stable security definer set search_path to 'public'
as $function$ select coalesce(max(public.canon_role_level(a.role_code)), 0) from public.canon_assignments() a; $function$;

-- Internal: another profile's level. Callable only by other definers (not granted to clients).
create or replace function public.canon_profile_level(p_profile_id uuid)
returns integer language sql stable security definer set search_path to 'public'
as $function$
  select coalesce(max(public.canon_role_level(rd.code)), 0)
  from public.user_role_assignments ura
  join public.role_definitions rd on rd.id = ura.role_definition_id and rd.is_active
  join public.profiles p on p.id = ura.profile_id and p.status = 'approved'
  join public.aocs a on a.id = ura.aoc_id and a.code = 'MY'
  where ura.profile_id = p_profile_id
    and ura.revoked_at is null
    and ura.starts_at <= now()
    and (ura.ends_at is null or ura.ends_at > now());
$function$;

-- Station visibility: org-wide Operation/Enforcement leadership, an assignment AT the station, or a
-- Hub SE whose hub contains the station. (Hub SE has hub-wide oversight, no station assignment.)
create or replace function public.canon_station_visible(p_station text)
returns boolean language sql stable security definer set search_path to 'public'
as $function$
  select p_station is not null and exists (
    select 1 from public.canon_assignments() a
    where a.role_code in ('operation_manager', 'main_enforcement')
       or a.station_code = p_station
       or (a.role_code = 'hub_se' and a.hub_id is not null
           and a.hub_id = (select s.hub_id from public.org_stations s where s.code = p_station))
  );
$function$;

create or replace function public.canon_team_visible(p_station text, p_team text)
returns boolean language sql stable security definer set search_path to 'public'
as $function$
  select p_station is not null and exists (
    select 1 from public.canon_assignments() a
    where a.role_code in ('operation_manager', 'main_enforcement')
       or (a.role_code = 'hub_se' and a.hub_id is not null
           and a.hub_id = (select s.hub_id from public.org_stations s where s.code = p_station))
       or (a.station_code = p_station and upper(coalesce(a.team_name, '')) = upper(coalesce(p_team, '')))
  );
$function$;

create or replace function public.canon_same_team(p_station text, p_team text)
returns boolean language sql stable security definer set search_path to 'public'
as $function$
  select p_station is not null and exists (
    select 1 from public.canon_assignments() a
    where a.station_code = p_station and upper(coalesce(a.team_name, '')) = upper(coalesce(p_team, ''))
  );
$function$;

create or replace function public.canon_has_role_at_station(p_codes text[], p_station text)
returns boolean language sql stable security definer set search_path to 'public'
as $function$
  select p_station is not null and exists (
    select 1 from public.canon_assignments() a where a.role_code = any (p_codes) and a.station_code = p_station
  );
$function$;

-- Station administration (zones etc.): Operation Manager anywhere, Hub SE inside the hub, DSE at the station.
create or replace function public.canon_can_admin_station(p_station text)
returns boolean language sql stable security definer set search_path to 'public'
as $function$
  select p_station is not null and exists (
    select 1 from public.canon_assignments() a
    where a.role_code = 'operation_manager'
       or (a.role_code = 'dse' and a.station_code = p_station)
       or (a.role_code = 'hub_se' and a.hub_id is not null
           and a.hub_id = (select s.hub_id from public.org_stations s where s.code = p_station))
  );
$function$;

-- Supervisory read: the caller strictly outranks the submitter AND the row is inside the caller's scope.
create or replace function public.canon_oversees(p_submitter uuid, p_station text, p_team text)
returns boolean language sql stable security definer set search_path to 'public'
as $function$
  select auth.uid() is not null
     and public.canon_my_level() > public.canon_profile_level(p_submitter)
     and public.canon_team_visible(p_station, p_team);
$function$;

-- Profile visibility: self; org-wide Operation/Enforcement leadership; otherwise a supervisor
-- (level >= 2) for staff whose assignment station/team is inside the supervisor's scope.
create or replace function public.canon_can_view_profile(p_profile_id uuid)
returns boolean language sql stable security definer set search_path to 'public'
as $function$
  select auth.uid() is not null and (
    p_profile_id = auth.uid()
    or (public.canon_my_level() >= 2 and (
          public.canon_has_role(array['operation_manager', 'main_enforcement'])
          or exists (
            select 1
            from public.user_role_assignments ta
            join public.role_definitions rd on rd.id = ta.role_definition_id and rd.is_active
            join public.org_stations s on s.id = ta.station_id
            left join public.org_teams t on t.id = ta.team_id
            where ta.profile_id = p_profile_id
              and ta.revoked_at is null
              and ta.starts_at <= now()
              and (ta.ends_at is null or ta.ends_at > now())
              and public.canon_team_visible(s.code, t.name)
          )))
  );
$function$;

do $grants$
declare
  f text;
begin
  foreach f in array array[
    'canon_assignments()', 'canon_is_active()', 'canon_has_role(text[])', 'canon_my_level()',
    'canon_station_visible(text)', 'canon_team_visible(text,text)', 'canon_same_team(text,text)',
    'canon_has_role_at_station(text[],text)', 'canon_can_admin_station(text)',
    'canon_oversees(uuid,text,text)', 'canon_can_view_profile(uuid)'
  ] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
  revoke execute on function public.canon_profile_level(uuid) from public, anon, authenticated;
  grant execute on function public.canon_profile_level(uuid) to service_role;
  revoke execute on function public.canon_role_level(text) from public, anon;
  grant execute on function public.canon_role_level(text) to authenticated, service_role;
end
$grants$;

-- ---------- 2. canonical identity helpers used by legacy RLS ----------
create or replace function public.current_role_name()
returns user_role
language sql
stable
security definer
set search_path to 'public'
as $function$
  select public.canonical_compat_role_for(auth.uid());
$function$;

create or replace function public.current_status()
returns profile_status
language sql
stable
security definer
set search_path to 'public'
as $function$
  select case
           when exists (
             select 1
             from public.user_role_assignments ura
             join public.role_definitions rd on rd.id = ura.role_definition_id
             where ura.profile_id = auth.uid()
               and rd.is_active
               and ura.revoked_at is null
               and ura.starts_at <= now()
               and (ura.ends_at is null or ura.ends_at > now())
           ) then p.status
           else 'pending'::profile_status
         end
  from public.profiles p
  where p.id = auth.uid();
$function$;

create or replace function public.current_station()
returns text
language sql
stable
security definer
set search_path to 'public'
as $function$
  select case when count(distinct s.code) = 1 then min(s.code) end
  from public.user_role_assignments ura
  join public.role_definitions rd on rd.id = ura.role_definition_id
  join public.profiles p on p.id = ura.profile_id and p.status = 'approved'
  join public.org_stations s on s.id = ura.station_id
  where ura.profile_id = auth.uid()
    and rd.is_active
    and ura.revoked_at is null
    and ura.starts_at <= now()
    and (ura.ends_at is null or ura.ends_at > now());
$function$;

create or replace function public.current_team()
returns text
language sql
stable
security definer
set search_path to 'public'
as $function$
  select case when count(distinct t.name) = 1 then min(t.name) end
  from public.user_role_assignments ura
  join public.role_definitions rd on rd.id = ura.role_definition_id
  join public.profiles p on p.id = ura.profile_id and p.status = 'approved'
  join public.org_teams t on t.id = ura.team_id
  where ura.profile_id = auth.uid()
    and rd.is_active
    and ura.revoked_at is null
    and ura.starts_at <= now()
    and (ura.ends_at is null or ura.ends_at > now());
$function$;

create or replace function public.is_monitor_or_above()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select coalesce(public.current_role_name() in ('SO', 'DSE', 'ENFORCEMENT', 'MANAGEMENT', 'ADMIN'), false);
$function$;

create or replace function public.submitter_role_rank(p_profile_id uuid)
returns integer
language sql
stable
security definer
set search_path to 'public'
as $function$
  select public.role_rank(public.canonical_compat_role_for(p_profile_id));
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

  -- One canonical level above the submitter; SEC014 Daily Report: SO, SSO or DSE may acknowledge an
  -- ASO's report. Station and team must match the caller's own assignment. Nothing here reads the
  -- compatibility rank, profiles.role or ops_group.
  return coalesce(
    (
      v_caller = v_sub + 1
      or (p_report_type = 'sec014' and v_sub = 1 and public.canon_has_role(array['so', 'sso', 'dse']))
    )
    and public.canon_same_team(sub.station, sub.team),
    false
  );
end;
$function$;

-- ---------- 3. canonical absence_notices policies ----------
drop policy if exists absence_notices_dse_management_update on public.absence_notices;
create policy absence_notices_dse_management_update on public.absence_notices
  for update to authenticated
  using (
    public.canon_has_role(array['operation_manager'])
    or (public.canon_has_role(array['dse']) and (absence_notices.station is null or public.canon_has_role_at_station(array['dse'], absence_notices.station)))
  )
  with check (
    public.canon_has_role(array['operation_manager'])
    or (public.canon_has_role(array['dse']) and (absence_notices.station is null or public.canon_has_role_at_station(array['dse'], absence_notices.station)))
  );

drop policy if exists absence_notices_select_elevated on public.absence_notices;
create policy absence_notices_select_elevated on public.absence_notices
  for select to authenticated
  using (
    public.canon_has_role(array['operation_manager', 'main_enforcement'])
    or public.canon_has_role_at_station(array['dse'], absence_notices.station)
  );

-- ---------- 4. ops_group removed from compatibility functions ----------
create or replace function public.apply_compatibility_profile_fields(
  p_profile_id uuid,
  p_role_code text,
  p_hub_id uuid,
  p_station_id uuid,
  p_team_id uuid,
  p_ops_group text,
  p_actor_id uuid
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_station_code text;
  v_team_name text;
  v_legacy_role text;
  v_mapped boolean := false;
begin
  -- p_ops_group is DEPRECATED and ignored: ops_group never decides anything.
  select s.code into v_station_code from public.org_stations s where s.id = p_station_id;
  select t.name into v_team_name from public.org_teams t where t.id = p_team_id;

  v_legacy_role := case p_role_code
    when 'aso' then 'ASO' when 'so' then 'SO' when 'sso' then 'SO'
    when 'dse' then 'DSE' when 'hub_se' then 'DSE'
    when 'operation_manager' then 'MANAGEMENT' when 'main_enforcement' then 'ENFORCEMENT'
    else null end;

  if v_legacy_role is not null then
    -- Display/compatibility fields only; canonical assignments remain authoritative.
    update public.profiles
    set role = v_legacy_role::user_role,
        station = coalesce(v_station_code, station),
        team = coalesce(v_team_name, team),
        status = 'approved',
        approval_state = 'active'
    where id = p_profile_id;

    if (
      select count(*) from information_schema.columns
      where table_schema = 'public' and table_name = 'profiles'
        and column_name in ('approved_by', 'approved_at', 'rejection_reason')
    ) = 3 then
      execute 'update public.profiles set approved_by = $1, approved_at = now(), rejection_reason = null where id = $2'
        using p_actor_id, p_profile_id;
    end if;
    v_mapped := true;
  else
    update public.profiles
    set approval_state = 'approved_pending_activation'
    where id = p_profile_id;
  end if;

  insert into public.user_admin_audit_log (actor_id, target_profile_id, action, new_state)
  values (p_actor_id, p_profile_id, 'compatibility_sync', jsonb_build_object('role_code', p_role_code, 'mapped', v_mapped));
end;
$function$;

create or replace function public.needs_your_action_secure()
returns table(report_id uuid, staff_name text, staff_id text, team text, submitted_at timestamp with time zone)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_station text;
  v_team text;
begin
  if auth.uid() is null then
    raise exception 'Must be signed in.';
  end if;

  select a.station_code, a.team_name into v_station, v_team
  from public.canon_assignments() a
  where a.role_code in ('so', 'sso', 'dse') and a.station_code is not null and a.team_name is not null
  limit 1;

  if v_station is null or v_team is null then
    return;
  end if;

  return query
  select r.id, r.staff_name, r.staff_id, r.team, r.submitted_at
  from public.report_sec014 r
  where r.status = 'submitted'
    and r.station = v_station
    and r.team = v_team
    and not exists (
      select 1 from public.report_acknowledgements a
      where a.report_type = 'sec014' and a.report_id = r.id
    );
end;
$function$;

-- ---------- 5. canonical supervising-officer eligibility ----------
create or replace function public.list_eligible_supervising_officers_secure()
returns table(id uuid, name text, staff_no text)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_station text;
  v_team text;
begin
  if auth.uid() is null then
    raise exception 'Must be signed in.';
  end if;
  if public.current_status() is distinct from 'approved' then
    return;
  end if;
  v_station := public.current_station();
  v_team := public.current_team();
  if v_station is null or v_team is null then
    return;
  end if;

  return query
  select p.id, p.name, p.staff_no
  from public.profiles p
  where p.status = 'approved'
    and p.id <> auth.uid()
    and exists (
      select 1
      from public.user_role_assignments ura
      join public.role_definitions rd on rd.id = ura.role_definition_id
      join public.org_stations s on s.id = ura.station_id and s.code = v_station
      join public.org_teams t on t.id = ura.team_id and t.name = v_team
      where ura.profile_id = p.id
        and rd.code in ('so', 'sso', 'dse')
        and rd.is_active
        and ura.revoked_at is null
        and ura.starts_at <= now()
        and (ura.ends_at is null or ura.ends_at > now())
    )
  order by p.name;
end;
$function$;

create or replace function public.is_eligible_supervising_officer_secure(p_officer_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select exists (select 1 from public.list_eligible_supervising_officers_secure() e where e.id = p_officer_id);
$function$;

revoke execute on function public.list_eligible_supervising_officers_secure() from public, anon;
grant execute on function public.list_eligible_supervising_officers_secure() to authenticated, service_role;
revoke execute on function public.is_eligible_supervising_officer_secure(uuid) from public, anon;
grant execute on function public.is_eligible_supervising_officer_secure(uuid) to authenticated, service_role;

-- ---------- 6. Staff Profiling files SEC013 (canonical, additive) ----------
drop policy if exists sec013_profiling_canonical_insert on public.report_sec013;
create policy sec013_profiling_canonical_insert on public.report_sec013
  for insert to authenticated
  with check (
    profile_id = auth.uid()
    and public.current_status() = 'approved'
    and (public.has_active_role('profiling_so') or public.has_active_role('profiling_aso'))
  );

-- ---------- 6b. canonical roster authority and reads ----------
-- Roster write/read authority is canonical (Phase 8 rules): operation_manager
-- (any station), hub_se (stations of the assigned hub), dse (own station AND
-- team). p_team NULL asks the station-level question (any dse at the station).
create or replace function public.can_manage_roster_secure(p_station text, p_team text default null)
returns boolean
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_station_id uuid;
  v_hub_id uuid;
  v_team_id uuid;
  v_aoc_id uuid;
begin
  if auth.uid() is null or p_station is null then
    return false;
  end if;
  select station_id, hub_id into v_station_id, v_hub_id from public.resolve_legacy_station(p_station);
  if v_station_id is null then
    return false;
  end if;
  select id into v_aoc_id from public.aocs where code = 'MY';

  if public.has_active_role_for_aoc('operation_manager', v_aoc_id) then
    return true;
  end if;
  if v_hub_id is not null and public.has_role_in_scope('hub_se', v_aoc_id, null, null, null, v_hub_id) then
    return true;
  end if;
  if p_team is null then
    return public.has_role_in_scope('dse', v_aoc_id, null, null, null, v_hub_id, v_station_id);
  end if;
  v_team_id := public.resolve_legacy_team(v_station_id, p_team);
  return v_team_id is not null
    and public.has_role_in_scope('dse', v_aoc_id, null, null, null, v_hub_id, v_station_id, v_team_id);
end;
$function$;

revoke execute on function public.can_manage_roster_secure(text, text) from public, anon;
grant execute on function public.can_manage_roster_secure(text, text) to authenticated, service_role;

create or replace function public.clear_roster_cell_secure(p_station text, p_team text, p_roster_date date)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if not public.can_manage_roster_secure(p_station, p_team) then
    raise exception 'No active Phase 3 role assignment grants roster-write authority for %/%.', p_station, p_team;
  end if;
  delete from public.team_rosters where station = p_station and team = p_team and roster_date = p_roster_date;
  perform public.phase8_write_audit('roster_clear', 'team_roster', null,
    jsonb_build_object('station', p_station, 'team', p_team, 'roster_date', p_roster_date));
end;
$function$;

revoke execute on function public.clear_roster_cell_secure(text, text, date) from public, anon;
grant execute on function public.clear_roster_cell_secure(text, text, date) to authenticated, service_role;

create or replace function public.list_roster_officers_secure(p_station text)
returns table(id uuid, name text, staff_no text, team text)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
begin
  if not public.can_manage_roster_secure(p_station, null) then
    return;
  end if;
  return query
  select distinct p.id, p.name, p.staff_no, t.name
  from public.user_role_assignments ura
  join public.role_definitions rd on rd.id = ura.role_definition_id
  join public.profiles p on p.id = ura.profile_id and p.status = 'approved'
  join public.org_stations s on s.id = ura.station_id and s.code = p_station
  join public.org_teams t on t.id = ura.team_id
  where rd.code in ('aso', 'so', 'sso', 'dse', 'sat_aso', 'profiling_so', 'profiling_aso')
    and rd.is_active
    and ura.revoked_at is null
    and ura.starts_at <= now()
    and (ura.ends_at is null or ura.ends_at > now())
    and (public.can_manage_roster_secure(p_station, t.name))
  order by t.name, p.name;
end;
$function$;

revoke execute on function public.list_roster_officers_secure(text) from public, anon;
grant execute on function public.list_roster_officers_secure(text) to authenticated, service_role;

create or replace function public.list_roster_teams_secure(p_station text)
returns table(team text, display_order integer)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
begin
  if not public.can_manage_roster_secure(p_station, null) then
    return;
  end if;
  return query
  select t.name, (row_number() over (order by t.name))::integer
  from public.org_teams t
  join public.org_stations s on s.id = t.station_id and s.code = p_station
  where public.can_manage_roster_secure(p_station, t.name)
  order by t.name;
end;
$function$;

revoke execute on function public.list_roster_teams_secure(text) from public, anon;
grant execute on function public.list_roster_teams_secure(text) to authenticated, service_role;

drop policy if exists roster_canonical_scope_select on public.team_rosters;
create policy roster_canonical_scope_select on public.team_rosters
  for select to authenticated
  using (public.can_manage_roster_secure(station, team));

-- ---------- 6c. profile guard: canonical registration review ----------
create or replace function public.enforce_profile_self_update()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  -- Trusted backend writes (createAdminClient() / auth admin flows,
  -- shadow-user backfill) bypass all of the below.
  if auth.role() = 'service_role' then
    return new;
  end if;

  -- Canonical registration review (merged operations model): the entity Admin who is authorised to
  -- review this profile's registration request (is_entity_admin, the same check approve_registration_request
  -- and reject_registration_request make) may write the review fields. This replaces the former
  -- dependency on a legacy ADMIN rank. It can never assign super_admin, and it applies only to a
  -- profile that has a registration request in that Admin's own entity.
  if auth.uid() is not null
     and old.id is distinct from auth.uid()
     and coalesce(lower(new.unified_role::text), '') <> 'super_admin'
     and exists (
       select 1
       from public.user_registration_requests r
       join public.operating_entities oe on oe.id = r.requested_operating_entity_id
       where r.profile_id = old.id
         and (r.status = 'pending' or r.reviewer_id = auth.uid())
         and public.is_entity_admin(oe.code)
     ) then
    return new;
  end if;

  ----------------------------------------------------------------
  -- SELF-UPDATE (old.id = auth.uid())
  ----------------------------------------------------------------
  if old.id = auth.uid() then
    -- C-01 containment: these are server-controlled identity/audit
    -- fields. None of them are ever legitimately written by a
    -- self-update (lib/avsec/profile-actions.ts's updateProfile() only
    -- ever writes name/staff_no/station/team/role) -- deny by default,
    -- regardless of the row's current status. id and created_at are
    -- listed explicitly even though "profiles self update"'s WITH CHECK
    -- (id = auth.uid()) already makes id practically immutable here --
    -- this is the trigger's own independent guarantee, not reliant on
    -- that policy staying correct. updated_at is deliberately NOT in
    -- this list: profiles_set_updated_at (a separate BEFORE UPDATE
    -- trigger, name-ordered after this one -- Postgres fires same-table
    -- BEFORE triggers in trigger-name order, "profiles_enforce_self_update"
    -- < "profiles_set_updated_at") unconditionally sets NEW.updated_at =
    -- now() on every update; comparing it here would reject that
    -- legitimate, automatic write. This function only ever inspects OLD/
    -- NEW as they stand when IT runs, before that second trigger touches
    -- updated_at, so there is no ordering conflict either way.
    if new.id is distinct from old.id
       or new.created_at is distinct from old.created_at
       or new.unified_role is distinct from old.unified_role
       or new.status is distinct from old.status
       or new.ops_group is distinct from old.ops_group
       or new.org_id is distinct from old.org_id
       or new.approved_by is distinct from old.approved_by
       or new.approved_at is distinct from old.approved_at
       or new.rejection_reason is distinct from old.rejection_reason
       or new.email is distinct from old.email
       or new.duty_post is distinct from old.duty_post
    then
      raise exception 'Not authorized to modify this field on your own profile.';
    end if;

    if old.status = 'pending' then
      -- Explicit allowlist for the profile-setup workflow: only name,
      -- staff_no, station, team, role are writable here (all still
      -- permitted; the check above already excludes everything else).
      -- Role itself still can't self-escalate to ADMIN/SUPER_ADMIN.
      if new.role = 'ADMIN' or new.role::text = 'SUPER_ADMIN' then
        raise exception 'Cannot self-assign this role.';
      end if;
    else
      -- Approved / rejected / deactivated: fully reviewed, fully locked.
      -- Was previously role/status/station/team/ops_group only --
      -- staff_no now locks too (status/ops_group already covered above).
      if new.role is distinct from old.role
         or new.station is distinct from old.station
         or new.team is distinct from old.team
         or new.staff_no is distinct from old.staff_no
      then
        raise exception 'Your account has already been reviewed. Contact an admin to change your role, station, team, or staff ID.';
      end if;
    end if;

    return new;
  end if;

  -- (The former legacy-MANAGEMENT branch is removed: the compatibility rank grants nothing.)

  raise exception 'Not authorized to modify this profile.';
end;
$function$;

-- ---------- 6d. canonical rewrite of every legacy-rank-dependent function and policy ----------
-- After this section NO policy and NO authorization function references current_role_name,
-- current_role_rank, is_monitor_or_above, is_approved_management, submitter_role_rank or a legacy
-- ADMIN role. The compatibility helpers remain only as display/compat values and grant nothing.

create or replace function public.can_view_report(p_report_type text, p_report_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  sub record;
begin
  if auth.uid() is null then
    return false;
  end if;
  select * into sub from public.get_report_submitter(p_report_type, p_report_id);
  if sub is null then
    return false;
  end if;
  return sub.profile_id = auth.uid() or public.canon_oversees(sub.profile_id, sub.station, sub.team);
end;
$function$;

create or replace function public.enforce_overtime_transition()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_station_id uuid;
  v_hub_id uuid;
  v_aoc_id uuid;
  v_submitter_dept text;
begin
  if new.status = old.status then
    return new;
  end if;

  select station_id, hub_id into v_station_id, v_hub_id from public.resolve_legacy_station(old.station);
  select id into v_aoc_id from public.aocs where code = 'MY';
  v_submitter_dept := public.submitter_department_code(old.profile_id);

  if new.status = 'endorsed' then
    if not (
      (old.status = 'pending' and public.canon_has_role_at_station(array['dse'], old.station))
      or (old.status = 'pending' and v_hub_id is not null and public.has_role_in_scope('hub_se', v_aoc_id, null, null, null, v_hub_id))
    ) then
      raise exception 'Only DSE (own station) or Hub SE (own hub) can endorse a pending overtime request.';
    end if;
  elsif new.status = 'approved' then
    if not (
      (old.status = 'endorsed' and v_submitter_dept = 'operation' and public.has_active_role_for_aoc('operation_manager', v_aoc_id))
      or (old.status = 'endorsed' and v_submitter_dept = 'enforcement' and public.has_active_role_for_aoc('main_enforcement', v_aoc_id))
    ) then
      raise exception 'Only the department-correct Operation Manager/Main Enforcement can approve, and only once endorsed.';
    end if;
  elsif new.status = 'rejected' then
    if not (
      (old.status = 'pending' and public.canon_has_role_at_station(array['dse'], old.station))
      or (old.status = 'pending' and v_hub_id is not null and public.has_role_in_scope('hub_se', v_aoc_id, null, null, null, v_hub_id))
      or (old.status in ('pending', 'endorsed') and v_submitter_dept = 'operation' and public.has_active_role_for_aoc('operation_manager', v_aoc_id))
      or (old.status in ('pending', 'endorsed') and v_submitter_dept = 'enforcement' and public.has_active_role_for_aoc('main_enforcement', v_aoc_id))
    ) then
      raise exception 'You are not authorized to reject this overtime request at its current stage.';
    end if;
  elsif new.status = 'cancelled' then
    if not (old.profile_id = auth.uid() and old.status = 'pending') then
      raise exception 'Only the claimant can withdraw their own pending request.';
    end if;
  end if;

  perform public.phase8_write_audit(
    'ot_' || new.status, 'overtime_request', new.id,
    jsonb_build_object('from_status', old.status, 'submitter_department', v_submitter_dept)
  );
  if new.status in ('approved', 'rejected') then
    perform public.notify(
      old.profile_id, 'ot_status_changed',
      'phase8_ot_' || new.id || '_' || new.status,
      null, null, null,
      jsonb_build_object('request_id', new.id, 'status', new.status)
    );
  end if;

  return new;
end;
$function$;

create or replace function public.enforce_registration_request_self_write()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_is_admin boolean := false;
begin
  if auth.role() = 'service_role' then
    return new;
  end if;

  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'is_entity_admin') then
    execute 'select public.is_entity_admin(''MAA'') or public.is_entity_admin(''AAX'')' into v_is_admin;
    if coalesce(v_is_admin, false) then
      return new;
    end if;
  end if;

  if old.status <> 'pending' then
    raise exception 'Cannot modify a registration request that has already been reviewed (status=%).', old.status;
  end if;

  if new.status is distinct from old.status
     or new.reviewer_id is distinct from old.reviewer_id
     or new.reviewed_at is distinct from old.reviewed_at
     or new.rejection_reason is distinct from old.rejection_reason
     or new.final_assignment_id is distinct from old.final_assignment_id
     or new.profile_id is distinct from old.profile_id
  then
    raise exception 'Administrative and review fields on user_registration_requests can only be updated by authorized administrative procedures.';
  end if;

  return new;
end;
$function$;

create or replace function public.run_attendance_sweep()
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if not public.canon_has_role(array['operation_manager']) then
    raise exception 'Only an active Operation Manager can run the attendance sweep.';
  end if;
  perform flag_attendance_anomalies();
end;
$function$;

create or replace function public.search_flight_attendance(p_flight_no text, p_date date default null::date)
returns setof v_flight_attendance
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_flight_no text := trim(coalesce(p_flight_no, ''));
  v_count int;
begin
  if not public.canon_has_role(array['main_enforcement', 'operation_manager']) then
    raise exception 'Not authorized to search flight attendance.';
  end if;
  if v_flight_no = '' then
    raise exception 'Flight number is required.';
  end if;

  select count(*) into v_count
  from v_flight_attendance
  where flight_no ilike ('%' || v_flight_no || '%')
    and (p_date is null or flight_date = p_date);

  insert into enforcement_search_log (searched_by, flight_no, search_date, result_count)
  values (auth.uid(), v_flight_no, p_date, v_count);

  return query
    select * from v_flight_attendance
    where flight_no ilike ('%' || v_flight_no || '%')
      and (p_date is null or flight_date = p_date)
    order by flight_date desc nulls last, submitted_at desc nulls last;
end;
$function$;

create or replace function public.search_flight_attendance(p_flight_no text, p_date_from date, p_date_to date default null::date)
returns table(flight_no text, duty_date date, std text, parking_bay text, aircraft_type text, aircraft_registration text, staff_name text, staff_id text, team text, report_type text, report_id uuid, submitted_at timestamp with time zone)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
begin
  if not public.canon_has_role(array['main_enforcement', 'operation_manager']) then
    raise exception 'Permission denied: Flight Attendance Search is restricted to Enforcement and Operation Management.';
  end if;

  return query
  select
    r.flight as flight_no,
    r.duty_date::date as duty_date,
    r.sta_std as std,
    r.bay_no as parking_bay,
    r.aircraft_type,
    r.reg_no as aircraft_registration,
    r.staff_name,
    r.staff_no as staff_id,
    r.team,
    'sec016'::text as report_type,
    r.id as report_id,
    r.submitted_at
  from report_sec016 r
  where r.status = 'submitted'
    and upper(r.flight) = upper(p_flight_no)
    and r.duty_date::date >= p_date_from
    and (p_date_to is null or r.duty_date::date <= p_date_to)

  union all

  select
    r.flight_no,
    (r.date_time_in at time zone 'Asia/Kuala_Lumpur')::date as duty_date,
    r.std,
    r.parking_bay,
    r.aircraft_type::text,
    r.aircraft_registration,
    r.staff_name,
    r.staff_id,
    r.team,
    'sec029'::text as report_type,
    r.id as report_id,
    r.submitted_at
  from report_sec029 r
  where r.status = 'submitted'
    and upper(r.flight_no) = upper(p_flight_no)
    and (r.date_time_in at time zone 'Asia/Kuala_Lumpur')::date >= p_date_from
    and (p_date_to is null or (r.date_time_in at time zone 'Asia/Kuala_Lumpur')::date <= p_date_to)

  order by submitted_at desc;
end;
$function$;

-- ---- policies: drop every legacy-rank / ADMIN policy, recreate canonical operation-specific ones ----
do $pol$
declare
  d record;
begin
  for d in
    select * from (values
      ('aircraft_types', 'reference aircraft_types admin write'), ('aircraft_types', 'reference aircraft_types readable'),
      ('stations', 'reference stations admin write'), ('stations', 'reference stations readable'),
      ('teams', 'reference teams admin write'), ('teams', 'reference teams readable'),
      ('duty_zones', 'duty_zones admin write'), ('duty_zones', 'duty_zones readable'),
      ('shifts', 'shifts admin write'), ('shifts', 'shifts readable'),
      ('station_teams', 'station_teams admin write'), ('station_teams', 'station_teams readable'),
      ('sheet_sync_config', 'sheet sync config admin all'),
      ('sheet_sync_queue', 'sheet sync queue admin select'), ('sheet_sync_queue', 'sheet sync queue admin update'),
      ('profiles', 'profiles admin manage'), ('profiles', 'profiles self select'),
      ('team_rosters', 'roster admin all'), ('team_rosters', 'roster org wide select'), ('team_rosters', 'roster own team select'),
      ('bay_board', 'bay_board station insert'), ('bay_board', 'bay_board station select'), ('bay_board', 'bay_board station update'),
      ('duty_audit_log', 'duty_audit insert'), ('duty_audit_log', 'duty_audit monitor select'),
      ('duty_records', 'duty monitor select'), ('duty_records', 'duty own insert'),
      ('enforcement_search_log', 'search log select'),
      ('offload_records', 'offload own insert'),
      ('overtime_requests', 'overtime monitor select'), ('overtime_requests', 'overtime own insert'), ('overtime_requests', 'overtime settle update'),
      ('report_acknowledgements', 'ack insert'), ('report_acknowledgements', 'ack select'),
      ('report_sec013', 'sec013 own insert'), ('report_sec014', 'sec014 own insert'), ('report_sec016', 'sec016 own insert'),
      ('report_sec018', 'sec018 own insert'), ('report_sec029', 'sec029 own insert'), ('report_sec033', 'sec033 own insert'),
      ('catering_companies', 'catering_companies_bootstrap_read'), ('drivers', 'drivers_bootstrap_read'), ('vehicles', 'vehicles_bootstrap_read')
    ) as v(t, n)
  loop
    if to_regclass('public.' || d.t) is not null then
      execute format('drop policy if exists %I on public.%I', d.n, d.t);
    end if;
  end loop;
end
$pol$;

-- reference data: readable only by an approved profile with an active canonical assignment
drop policy if exists aircraft_types_active_read on public.aircraft_types;
create policy aircraft_types_active_read on public.aircraft_types for select to authenticated using (public.canon_is_active());
drop policy if exists stations_active_read on public.stations;
create policy stations_active_read on public.stations for select to authenticated using (public.canon_is_active());
drop policy if exists teams_active_read on public.teams;
create policy teams_active_read on public.teams for select to authenticated using (public.canon_is_active());
drop policy if exists station_teams_active_read on public.station_teams;
create policy station_teams_active_read on public.station_teams for select to authenticated using (public.canon_is_active());
drop policy if exists shifts_active_read on public.shifts;
create policy shifts_active_read on public.shifts for select to authenticated using (public.canon_is_active());
drop policy if exists shifts_operation_manager_insert on public.shifts;
create policy shifts_operation_manager_insert on public.shifts for insert to authenticated with check (public.canon_has_role(array['operation_manager']));
drop policy if exists shifts_operation_manager_update on public.shifts;
create policy shifts_operation_manager_update on public.shifts for update to authenticated
  using (public.canon_has_role(array['operation_manager'])) with check (public.canon_has_role(array['operation_manager']));
drop policy if exists shifts_operation_manager_delete on public.shifts;
create policy shifts_operation_manager_delete on public.shifts for delete to authenticated using (public.canon_has_role(array['operation_manager']));

-- duty zones: station-scoped read; station administration by Operation Manager / Hub SE / DSE
drop policy if exists duty_zones_scoped_read on public.duty_zones;
create policy duty_zones_scoped_read on public.duty_zones for select to authenticated using (public.canon_station_visible(station));
drop policy if exists duty_zones_admin_insert on public.duty_zones;
create policy duty_zones_admin_insert on public.duty_zones for insert to authenticated with check (public.canon_can_admin_station(station));
drop policy if exists duty_zones_admin_update on public.duty_zones;
create policy duty_zones_admin_update on public.duty_zones for update to authenticated
  using (public.canon_can_admin_station(station)) with check (public.canon_can_admin_station(station));
drop policy if exists duty_zones_admin_delete on public.duty_zones;
create policy duty_zones_admin_delete on public.duty_zones for delete to authenticated using (public.canon_can_admin_station(station));

-- sheet sync + profile administration: service_role only (no client policy)

drop policy if exists profiles_canonical_select on public.profiles;
create policy profiles_canonical_select on public.profiles for select to authenticated using (public.canon_can_view_profile(id));

drop policy if exists roster_canonical_visible_select on public.team_rosters;
create policy roster_canonical_visible_select on public.team_rosters for select to authenticated using (public.canon_team_visible(station, team));

drop policy if exists bay_board_scoped_select on public.bay_board;
create policy bay_board_scoped_select on public.bay_board for select to authenticated using (public.canon_station_visible(station));
drop policy if exists bay_board_scoped_insert on public.bay_board;
create policy bay_board_scoped_insert on public.bay_board for insert to authenticated with check (public.canon_station_visible(station));
drop policy if exists bay_board_scoped_update on public.bay_board;
create policy bay_board_scoped_update on public.bay_board for update to authenticated
  using (public.canon_station_visible(station)) with check (public.canon_station_visible(station));

drop policy if exists duty_audit_insert_own on public.duty_audit_log;
create policy duty_audit_insert_own on public.duty_audit_log for insert to authenticated
  with check (actor_id = auth.uid() and public.canon_is_active());
drop policy if exists duty_audit_leadership_select on public.duty_audit_log;
create policy duty_audit_leadership_select on public.duty_audit_log for select to authenticated
  using (actor_id = auth.uid() or public.canon_has_role(array['operation_manager', 'main_enforcement']));

drop policy if exists duty_records_supervisor_select on public.duty_records;
create policy duty_records_supervisor_select on public.duty_records for select to authenticated using (public.canon_oversees(profile_id, station, team));
drop policy if exists duty_records_own_insert on public.duty_records;
create policy duty_records_own_insert on public.duty_records for insert to authenticated
  with check (profile_id = auth.uid() and public.canon_is_active());

drop policy if exists search_log_leadership_select on public.enforcement_search_log;
create policy search_log_leadership_select on public.enforcement_search_log for select to authenticated
  using (public.canon_has_role(array['main_enforcement', 'operation_manager']));

drop policy if exists offload_own_insert_canonical on public.offload_records;
create policy offload_own_insert_canonical on public.offload_records for insert to authenticated
  with check (profile_id = auth.uid() and public.canon_has_role(array['aso', 'so', 'sso', 'dse']));

drop policy if exists overtime_supervisor_select on public.overtime_requests;
create policy overtime_supervisor_select on public.overtime_requests for select to authenticated using (public.canon_oversees(profile_id, station, team));
drop policy if exists overtime_own_insert_canonical on public.overtime_requests;
create policy overtime_own_insert_canonical on public.overtime_requests for insert to authenticated
  with check (profile_id = auth.uid() and public.canon_is_active());
drop policy if exists overtime_supervisor_update on public.overtime_requests;
create policy overtime_supervisor_update on public.overtime_requests for update to authenticated
  using (public.canon_oversees(profile_id, station, team)) with check (public.canon_oversees(profile_id, station, team));

drop policy if exists ack_insert_canonical on public.report_acknowledgements;
create policy ack_insert_canonical on public.report_acknowledgements for insert to authenticated
  with check (acknowledged_by = auth.uid() and public.canon_is_active() and public.can_acknowledge_report(report_type, report_id));
drop policy if exists ack_select_canonical on public.report_acknowledgements;
create policy ack_select_canonical on public.report_acknowledgements for select to authenticated
  using (public.canon_is_active() and (acknowledged_by = auth.uid() or public.can_view_report(report_type, report_id)));

drop policy if exists sec013_own_insert_canonical on public.report_sec013;
create policy sec013_own_insert_canonical on public.report_sec013 for insert to authenticated
  with check (profile_id = auth.uid() and public.canon_has_role(array['aso']));
drop policy if exists sec014_own_insert_canonical on public.report_sec014;
create policy sec014_own_insert_canonical on public.report_sec014 for insert to authenticated
  with check (profile_id = auth.uid() and public.canon_has_role(array['aso', 'so', 'sso', 'dse', 'hub_se', 'main_enforcement']));
drop policy if exists sec016_own_insert_canonical on public.report_sec016;
create policy sec016_own_insert_canonical on public.report_sec016 for insert to authenticated
  with check (profile_id = auth.uid() and public.canon_has_role(array['aso']));
drop policy if exists sec018_own_insert_canonical on public.report_sec018;
create policy sec018_own_insert_canonical on public.report_sec018 for insert to authenticated
  with check (profile_id = auth.uid() and public.canon_has_role(array['aso']));
drop policy if exists sec029_own_insert_canonical on public.report_sec029;
create policy sec029_own_insert_canonical on public.report_sec029 for insert to authenticated
  with check (profile_id = auth.uid() and public.canon_has_role(array['aso']));
drop policy if exists sec033_own_insert_canonical on public.report_sec033;
create policy sec033_own_insert_canonical on public.report_sec033 for insert to authenticated
  with check (profile_id = auth.uid() and public.canon_has_role(array['aso']));

-- CaterLink whitelist reference rows (replace the former blanket bootstrap reads): active assigned
-- station operators, CaterLink Management and Operation Manager, inside an AOC they hold.
drop policy if exists catering_companies_canonical_read on public.catering_companies;
create policy catering_companies_canonical_read on public.catering_companies for select to authenticated
  using (public.canon_has_role(array['aso', 'so', 'sso', 'dse', 'caterlink_management', 'operation_manager'])
         and (aoc_id is null or public.has_any_active_assignment_in_aoc(aoc_id)));
drop policy if exists drivers_canonical_read on public.drivers;
create policy drivers_canonical_read on public.drivers for select to authenticated
  using (public.canon_has_role(array['aso', 'so', 'sso', 'dse', 'caterlink_management', 'operation_manager'])
         and (aoc_id is null or public.has_any_active_assignment_in_aoc(aoc_id)));
drop policy if exists vehicles_canonical_read on public.vehicles;
create policy vehicles_canonical_read on public.vehicles for select to authenticated
  using (public.canon_has_role(array['aso', 'so', 'sso', 'dse', 'caterlink_management', 'operation_manager'])
         and (aoc_id is null or public.has_any_active_assignment_in_aoc(aoc_id)));

-- minimum columns for the three whitelist reference tables (no IC numbers, pass numbers or audit fields)
revoke select on public.catering_companies from authenticated;
revoke select on public.drivers from authenticated;
revoke select on public.vehicles from authenticated;
grant select (id, name, code, is_active, pass_expiry_date, aoc_id, status) on public.catering_companies to authenticated;
grant select (id, name, staff_id, catering_company_id, pass_expiry_date, is_active, aoc_id, status) on public.drivers to authenticated;
grant select (id, vehicle_number, catering_company_id, pass_expiry_date, truck_type, is_active, aoc_id, status) on public.vehicles to authenticated;

-- ---- 6e. generic closure: nothing left may authorize from a legacy rank, and every policy is explicit ----
do $close$
declare
  p record;
  hints text[] := array['current_role_name', 'current_role_rank', 'is_monitor_or_above', 'is_approved_management',
                        'submitter_role_rank', 'canonical_compat_role_for'];
begin
  -- (i) any remaining policy that still authorizes from a compatibility rank / legacy profile role is
  --     removed (fail closed); reads/writes it used to grant now require a canonical policy.
  for p in
    select schemaname, tablename, policyname
    from pg_policies
    where schemaname = 'public'
      and (exists (select 1 from unnest(hints) h where position(h in coalesce(qual, '') || coalesce(with_check, '')) > 0)
           or (coalesce(qual, '') || coalesce(with_check, '')) ~ '(profiles|p)[.](role|ops_group|unified_role)')
  loop
    execute format('drop policy %I on %I.%I', p.policyname, p.schemaname, p.tablename);
  end loop;

  -- (ii) knowledge-base reads: assigned users only (was a blanket authenticated read)
  if to_regclass('public.kb_documents') is not null then
    drop policy if exists kb_documents_read_auth on public.kb_documents;
    drop policy if exists kb_documents_active_read on public.kb_documents;
    create policy kb_documents_active_read on public.kb_documents for select to authenticated using (public.canon_is_active());
  end if;
  if to_regclass('public.kb_chunks') is not null then
    drop policy if exists kb_chunks_read_auth on public.kb_chunks;
    drop policy if exists kb_chunks_active_read on public.kb_chunks;
    create policy kb_chunks_active_read on public.kb_chunks for select to authenticated using (public.canon_is_active());
  end if;

  -- (iii) UPDATE policies get an explicit WITH CHECK equal to their USING; no policy targets PUBLIC.
  for p in select schemaname, tablename, policyname, qual from pg_policies
           where schemaname = 'public' and cmd = 'UPDATE' and with_check is null and qual is not null
  loop
    execute format('alter policy %I on %I.%I with check (%s)', p.policyname, p.schemaname, p.tablename, p.qual);
  end loop;
  for p in select schemaname, tablename, policyname from pg_policies
           where schemaname = 'public' and 'public' = any (roles)
  loop
    execute format('alter policy %I on %I.%I to authenticated', p.policyname, p.schemaname, p.tablename);
  end loop;
end
$close$;

-- ---- 6f. retire ops_group-based filing check; internal helpers are not client-callable ----
create or replace function public.can_file_report(p_form_type text, p_profile_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
begin
  -- Only the caller's own canonical assignments count; another profile is never probed.
  if auth.uid() is null or p_profile_id is distinct from auth.uid() then
    return false;
  end if;
  if p_form_type = 'sec014' then
    return public.canon_has_role(array['aso', 'so', 'sso', 'dse', 'hub_se', 'main_enforcement']);
  end if;
  if p_form_type in ('sec016', 'sec029', 'sec018', 'sec033', 'sec013', 'offload') then
    return public.canon_has_role(array['aso']);
  end if;
  return false;
end;
$function$;

drop function if exists public.get_report_submitter_ops_group(text, uuid);

do $internal$
declare
  f record;
begin
  -- These helpers reveal another user's report ownership, rank, department or whitelist entries.
  -- They are called only from other SECURITY DEFINER functions and triggers, never directly by a client.
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f'
      and p.proname in ('get_report_submitter', 'submitter_department_code', 'submitter_role_rank',
                        'is_monitor_or_above', 'is_approved_management', 'current_role_name', 'current_role_rank',
                        'resolve_usable_caterlink_driver', 'resolve_usable_caterlink_vehicle',
                        'resolve_legacy_station', 'resolve_legacy_team',
                        'can_file_report')
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end
$internal$;

-- ---------- 7. operation-specific policies (FOR ALL split, predicates unchanged) ----------
do $split$
declare
  p record;
  op text;
  pname text;
  role_list text;
  using_sql text;
  check_sql text;
begin
  for p in
    select schemaname, tablename, policyname, permissive, roles, qual, with_check
    from pg_policies
    where schemaname = 'public' and cmd = 'ALL'
  loop
    role_list := case when p.roles::text[] && array['public'] then 'authenticated' else array_to_string(p.roles, ', ') end;
    foreach op in array array['select', 'insert', 'update', 'delete'] loop
      pname := left(p.policyname, 50) || ' (' || op || ')';
      using_sql := case when p.qual is not null then ' using (' || p.qual || ')' else '' end;
      check_sql := case when coalesce(p.with_check, p.qual) is not null then ' with check (' || coalesce(p.with_check, p.qual) || ')' else '' end;
      execute format('drop policy if exists %I on %I.%I', pname, p.schemaname, p.tablename);
      if op = 'select' or op = 'delete' then
        execute format('create policy %I on %I.%I as %s for %s to %s%s', pname, p.schemaname, p.tablename, p.permissive, op, role_list, using_sql);
      elsif op = 'insert' then
        execute format('create policy %I on %I.%I as %s for insert to %s%s', pname, p.schemaname, p.tablename, p.permissive, role_list, check_sql);
      else
        execute format('create policy %I on %I.%I as %s for update to %s%s%s', pname, p.schemaname, p.tablename, p.permissive, role_list, using_sql, check_sql);
      end if;
    end loop;
    execute format('drop policy %I on %I.%I', p.policyname, p.schemaname, p.tablename);
  end loop;
end
$split$;

-- ---------- 8. RLS safety net + grant alignment + anon hardening ----------
-- Every public table keeps RLS. A table found without it becomes deny-by-default (no blanket read
-- policy is created). Reference tables that need client reads get an explicit canonical policy below.
do $rls$
declare
  t record;
begin
  for t in
    select c.oid::regclass as tbl
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      and not c.relrowsecurity
      and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype = 'e')
  loop
    execute format('alter table %s enable row level security', t.tbl);
  end loop;
end
$rls$;

do $chk$
begin
  if to_regclass('public.sec029_checklist_items') is not null then
    drop policy if exists sec029_checklist_items_active_read on public.sec029_checklist_items;
    -- non-sensitive checklist wording; needed by every assigned reporter, not AOC-specific
    create policy sec029_checklist_items_active_read on public.sec029_checklist_items
      for select to authenticated using (public.canon_is_active());
  end if;
end
$chk$;

-- Grant alignment: authenticated keeps only the operations that have a matching policy. (RLS and
-- grants are both required; neither substitutes for the other.) seals / seal_verifications keep
-- SELECT so the not-yet-activated legacy ICMS pages see an empty result instead of an error.
do $align$
declare
  t record;
  op text;
  has_pol boolean;
begin
  for t in
    select c.oid::regclass as tbl, c.relname
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p')
      and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype = 'e')
  loop
    foreach op in array array['select', 'insert', 'update', 'delete'] loop
      continue when not has_table_privilege('authenticated', t.tbl, upper(op));
      select exists (
        select 1 from pg_policies p
        where p.schemaname = 'public' and p.tablename = t.relname
          and (p.cmd = upper(op) or p.cmd = 'ALL'
               or (op = 'select' and p.cmd in ('UPDATE', 'DELETE')))
          and (p.roles::text[] && array['authenticated', 'public'])
      ) into has_pol;
      if not has_pol and not (op = 'select' and t.relname in ('seals', 'seal_verifications')) then
        execute format('revoke %s on %s from authenticated', op, t.tbl);
      end if;
    end loop;
  end loop;
end
$align$;

revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on sequences from anon;

do $fn$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as sig,
           has_function_privilege('authenticated', p.oid, 'execute') as auth_exec
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prokind = 'f'
      and has_function_privilege('anon', p.oid, 'execute')
      and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
  loop
    execute format('revoke execute on function %s from public, anon', f.sig);
    if f.auth_exec then
      execute format('grant execute on function %s to authenticated', f.sig);
    end if;
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end
$fn$;

alter default privileges in schema public revoke execute on functions from anon;
alter default privileges in schema public revoke execute on functions from public;
