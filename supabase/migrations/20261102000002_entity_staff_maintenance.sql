-- Entity-admin staff maintenance read path (additive). The maintenance ACTIONS already exist and are authorized in the database
-- (deactivate_assignment, transfer_assignment_same_entity, initiate_cross_entity_transfer: own-entity admin only, protected roles refused,
-- no self-deactivation / self-transfer). What was missing is a way for a MAA/AAX Admin to FIND the assignment ids of their OWN entity's
-- staff and to load safe selectors, without any client table access.
--
--  * list_entity_staff_for_admin_secure(): own-entity, currently effective, non-protected assignments of approved profiles, with the
--    assignment id the maintenance RPCs need. MAA/AAX Admin only. Safe fields only (no e-mail / contact data).
--  * list_entity_assignment_options_secure(): the same selector payload as the registration options (roles minus protected roles,
--    departments, units, hubs, stations, teams), scoped to the admin's own AOC.

create or replace function public.caller_entity_admin_context()
returns table (aoc_id uuid, entity_id uuid, entity_code text)
language sql
stable
security definer
set search_path to 'public'
as $function$
  select ura.aoc_id, ura.operating_entity_id, oe.code
  from public.user_role_assignments ura
  join public.role_definitions rd on rd.id = ura.role_definition_id and rd.is_active
  join public.profiles p on p.id = ura.profile_id and p.status = 'approved'
  join public.operating_entities oe on oe.id = ura.operating_entity_id
  where ura.profile_id = auth.uid()
    and rd.code in ('maa_admin', 'aax_admin')
    and ura.aoc_id is not null
    and ura.revoked_at is null
    and ura.starts_at <= now()
    and (ura.ends_at is null or ura.ends_at > now())
  order by ura.starts_at
  limit 1;
$function$;
revoke execute on function public.caller_entity_admin_context() from public, anon;
grant execute on function public.caller_entity_admin_context() to authenticated, service_role;

create or replace function public.list_entity_staff_for_admin_secure(p_search text default null, p_page integer default 1, p_page_size integer default 50)
returns table (
  assignment_id uuid, profile_id uuid, staff_no text, staff_name text, role_code text, department_code text, unit_code text,
  hub_code text, station_code text, team_name text, starts_at timestamptz, is_self boolean, total_count bigint
)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_ctx record;
  v_page integer := greatest(coalesce(p_page, 1), 1);
  v_size integer := least(greatest(coalesce(p_page_size, 50), 1), 200);
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
begin
  select * into v_ctx from public.caller_entity_admin_context();
  if v_ctx.entity_id is null then
    raise exception 'Only an approved MAA or AAX Admin may list entity staff for maintenance.';
  end if;
  return query
  with s as (
    select ura.id as aid, p.id as pid, p.staff_no as sno, p.name as sname, rd.code as rcode, d.code as dcode, u.code as ucode,
           h.code as hcode, st.code as scode, t.name as tname, ura.starts_at as sat
    from public.user_role_assignments ura
    join public.role_definitions rd on rd.id = ura.role_definition_id and rd.is_active
    join public.profiles p on p.id = ura.profile_id and p.status = 'approved'
    join public.user_entity_memberships uem on uem.id = ura.entity_membership_id and uem.status = 'active'
         and uem.starts_at <= now() and (uem.ends_at is null or uem.ends_at > now())
    left join public.departments d on d.id = ura.department_id
    left join public.units u on u.id = ura.unit_id
    left join public.hubs h on h.id = ura.hub_id
    left join public.org_stations st on st.id = ura.station_id
    left join public.org_teams t on t.id = ura.team_id
    where uem.operating_entity_id = v_ctx.entity_id
      and ura.revoked_at is null and ura.starts_at <= now() and (ura.ends_at is null or ura.ends_at > now())
      and rd.code not in (
        'airasia_management', 'ghod', 'global_reporting_controller', 'super_admin', 'maa_boss', 'aax_boss', 'maa_admin', 'aax_admin',
        'operation_manager', 'main_enforcement', 'compliance', 'caterlink_management'
      )
      and (v_search is null or p.name ilike '%' || v_search || '%' or p.staff_no ilike '%' || v_search || '%')
  ), n as (select count(*) as c from s)
  select s.aid, s.pid, s.sno, s.sname, s.rcode, s.dcode, s.ucode, s.hcode, s.scode, s.tname, s.sat, (s.pid = auth.uid()), n.c
  from s cross join n
  order by s.sname, s.sno
  limit v_size offset (v_page - 1) * v_size;
end;
$function$;
revoke execute on function public.list_entity_staff_for_admin_secure(text, integer, integer) from public, anon;
grant execute on function public.list_entity_staff_for_admin_secure(text, integer, integer) to authenticated, service_role;

create or replace function public.list_entity_assignment_options_secure()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_ctx record;
begin
  select * into v_ctx from public.caller_entity_admin_context();
  if v_ctx.entity_id is null then
    raise exception 'Only an approved MAA or AAX Admin may load assignment options.';
  end if;
  return jsonb_build_object(
    'entity_code', v_ctx.entity_code,
    'roles', (
      select coalesce(jsonb_agg(jsonb_build_object('code', rd.code, 'name', rd.display_name, 'category', rd.role_category) order by rd.display_name), '[]'::jsonb)
      from public.role_definitions rd
      where rd.is_active
        and rd.code not in (
          'airasia_management', 'ghod', 'global_reporting_controller', 'super_admin', 'maa_boss', 'aax_boss', 'maa_admin', 'aax_admin',
          'operation_manager', 'main_enforcement', 'compliance', 'caterlink_management'
        )
    ),
    'departments', (select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'code', d.code, 'name', d.name) order by d.name), '[]'::jsonb) from public.departments d where d.aoc_id = v_ctx.aoc_id),
    'units', (select coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'department_id', u.department_id, 'code', u.code, 'name', u.name) order by u.name), '[]'::jsonb) from public.units u join public.departments d on d.id = u.department_id where d.aoc_id = v_ctx.aoc_id),
    'hubs', (select coalesce(jsonb_agg(jsonb_build_object('id', h.id, 'code', h.code, 'name', h.name) order by h.name), '[]'::jsonb) from public.hubs h where h.aoc_id = v_ctx.aoc_id),
    'stations', (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'hub_id', s.hub_id, 'code', s.code, 'name', s.name) order by s.code), '[]'::jsonb) from public.org_stations s join public.hubs h on h.id = s.hub_id where h.aoc_id = v_ctx.aoc_id and s.is_active),
    'teams', (select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'station_id', t.station_id, 'name', t.name) order by t.name), '[]'::jsonb) from public.org_teams t join public.org_stations s on s.id = t.station_id join public.hubs h on h.id = s.hub_id where h.aoc_id = v_ctx.aoc_id)
  );
end;
$function$;
revoke execute on function public.list_entity_assignment_options_secure() from public, anon;
grant execute on function public.list_entity_assignment_options_secure() to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Latent defect: an entity Admin's deactivation / transfer failed with "Not authorized to modify this profile."
-- ---------------------------------------------------------------------------------------------
-- deactivate_assignment() and transfer_assignment_same_entity() call sync_primary_operating_entity(), which updates
-- profiles.operating_entity_id of ANOTHER person. The profile guard only admitted an entity Admin who held a pending registration request
-- for that profile, so ordinary maintenance by an authenticated Admin was refused. The guard below adds one narrow branch (see inline)
-- and is otherwise identical to the previous definition.
CREATE OR REPLACE FUNCTION public.enforce_profile_self_update()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  -- Entity-admin maintenance (deactivate / transfer an own-entity assignment): the database helper that re-derives the person's PRIMARY
  -- operating entity touches profiles.operating_entity_id and nothing else. The entity Admin who holds authority over a membership of this
  -- profile in their own entity may cause exactly that derived-field write; any other changed column falls through to the denial below.
  if auth.uid() is not null
     and old.id is distinct from auth.uid()
     and (to_jsonb(new) - 'operating_entity_id' - 'updated_at') = (to_jsonb(old) - 'operating_entity_id' - 'updated_at')
     and exists (
       select 1
       from public.user_entity_memberships m
       join public.operating_entities oe on oe.id = m.operating_entity_id
       where m.profile_id = old.id
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
