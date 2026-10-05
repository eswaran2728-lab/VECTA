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
begin
  select * into sub from public.get_report_submitter(p_report_type, p_report_id);
  if sub is null then
    return false;
  end if;

  -- SEC014 Daily Report: either SO or DSE may acknowledge an ASO's report (both are the ASO's
  -- operational supervisors); every other report keeps the strict one-rank-up chain.
  return coalesce(
    (
      public.role_rank(public.current_role_name()) = public.submitter_role_rank(sub.profile_id) + 1
      or (
        p_report_type = 'sec014'
        and public.submitter_role_rank(sub.profile_id) = 1
        and public.current_role_name() in ('SO', 'DSE')
      )
    )
    and public.current_station() = sub.station
    and coalesce(public.current_team(), '') = coalesce(sub.team, ''),
    false
  );
end;
$function$;

-- ---------- 3. canonical absence_notices policies ----------
drop policy if exists absence_notices_dse_management_update on public.absence_notices;
create policy absence_notices_dse_management_update on public.absence_notices
  for update to authenticated
  using (
    public.current_role_name() = 'MANAGEMENT'
    or (public.current_role_name() = 'DSE' and (absence_notices.station is null or absence_notices.station = public.current_station()))
  )
  with check (
    public.current_role_name() = 'MANAGEMENT'
    or (public.current_role_name() = 'DSE' and (absence_notices.station is null or absence_notices.station = public.current_station()))
  );

drop policy if exists absence_notices_select_elevated on public.absence_notices;
create policy absence_notices_select_elevated on public.absence_notices
  for select to authenticated
  using (
    public.current_role_name() in ('MANAGEMENT', 'ENFORCEMENT')
    or (public.current_role_name() = 'DSE' and absence_notices.station = public.current_station())
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
  v_role user_role;
  v_station text;
  v_team text;
begin
  if auth.uid() is null then
    raise exception 'Must be signed in.';
  end if;

  v_role := public.current_role_name();
  v_station := public.current_station();
  v_team := public.current_team();

  if v_role is null or v_role not in ('SO', 'DSE') or v_station is null or v_team is null then
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

  -- Legacy ADMIN role: no accounts currently hold it (merged into
  -- MANAGEMENT, see 20260911000002/20260911000009) -- kept only so this
  -- trigger doesn't regress if that merge is ever reversed.
  if current_role_name() = 'ADMIN' then
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

  ----------------------------------------------------------------
  -- MANAGEMENT acting on someone else's (non-ADMIN) row
  ----------------------------------------------------------------
  if current_role_name() = 'MANAGEMENT' and new.role <> 'ADMIN' then
    -- C-01 containment: Management may never grant unified_role
    -- 'super_admin', and may not set it to 'management' through this
    -- generic write path either -- that needs its own dedicated, audited
    -- promotion workflow (not yet built; out of scope here). Every
    -- ordinary AVSEC-role transition Management currently performs
    -- (aso/so/dse/enforcement, via updateUserAssignment /
    -- approveUserWithAssignment's mapAvsecRoleToUnifiedRole mapping)
    -- keeps working.
    if new.unified_role is distinct from old.unified_role
       and new.unified_role in ('super_admin', 'management')
    then
      raise exception 'Management cannot assign this unified_role value through a generic profile update.';
    end if;

    -- Defense in depth: the application layer already refuses to target
    -- a Super Admin account (lib/avsec/admin/actions.ts) -- back it at
    -- the trigger layer too.
    if old.role::text = 'SUPER_ADMIN' or old.unified_role = 'super_admin' then
      raise exception 'Cannot modify a Super Admin account.';
    end if;

    -- org_id and the approval-audit fields are only ever legitimately
    -- written together with a pending -> approved/rejected transition
    -- (approveUserWithAssignment / rejectUser) -- never as a standalone
    -- edit on an already-reviewed row.
    if new.org_id is distinct from old.org_id then
      raise exception 'Management cannot change org_id.';
    end if;
    if old.status <> 'pending'
       and (new.approved_by is distinct from old.approved_by
            or new.approved_at is distinct from old.approved_at
            or new.rejection_reason is distinct from old.rejection_reason)
    then
      raise exception 'Management cannot modify approval audit fields outside the approval workflow.';
    end if;

    return new;
  end if;

  raise exception 'Not authorized to modify this profile.';
end;
$function$;

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
    role_list := array_to_string(p.roles, ', ');
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

-- ---------- 8. RLS safety net + anon grant hardening ----------
-- Every user-facing table in public must keep RLS. Nothing is changed where RLS
-- is already enabled; a table found without it becomes deny-by-default for
-- clients (service_role and the owner are unaffected).
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
    -- Reference tables that clients could already read keep exactly that read access
    -- (select-only, authenticated); every write path stays deny-by-default.
    if has_table_privilege('authenticated', t.tbl, 'SELECT') then
      execute format('create policy %I on %s for select to authenticated using (true)',
        left(replace(t.tbl::text, '.', '_'), 40) || '_authenticated_read', t.tbl);
    end if;
  end loop;
end
$rls$;

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
