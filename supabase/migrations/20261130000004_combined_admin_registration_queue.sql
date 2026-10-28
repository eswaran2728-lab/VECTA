-- Migration: 20261130000004_combined_admin_registration_queue.sql
-- Description:
--   1. Support combined / unassigned registration requests in both MAA Admin and AAX Admin queues.
--   2. Update list_entity_registration_requests_detailed_secure to show unassigned pending requests in both MAA & AAX Admin queues.
--   3. Update list_registration_assignment_options_secure to resolve unassigned requests to caller's administered entity & AOC.
--   4. Update approve_registration_request to permit assigning entity & AOC for unassigned requests.
--   5. Update reject_registration_request to permit rejection by either entity admin.
--   6. Recover missing registration request for eswaran3561@gmail.com, preserving it as pending.

-- -------------------------------------------------------------------------------------------------
-- 1. Detailed pending list for Admin queues: show unassigned requests to both MAA and AAX admins
-- -------------------------------------------------------------------------------------------------
create or replace function public.list_entity_registration_requests_detailed_secure()
returns table (
  id uuid,
  staff_name text,
  staff_no text,
  requested_role_code text,
  requested_hub_code text,
  requested_station_code text,
  requested_team_name text,
  applicant_notes text,
  submitted_at timestamptz,
  operating_entity_code text,
  is_transfer boolean
)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_codes text[] := array[]::text[];
begin
  if auth.uid() is null then
    raise exception 'Must be signed in.';
  end if;

  if public.is_entity_admin('MAA') then
    v_codes := array_append(v_codes, 'MAA');
  end if;
  if public.is_entity_admin('AAX') then
    v_codes := array_append(v_codes, 'AAX');
  end if;

  if array_length(v_codes, 1) is null then
    raise exception 'Only an approved MAA or AAX Admin may list entity registration requests.';
  end if;

  return query
  select
    urr.id,
    p.name,
    p.staff_no,
    urr.requested_role_code,
    h.code,
    s.code,
    t.name,
    urr.applicant_notes,
    urr.submitted_at,
    coalesce(oe.code, 'MAA / AAX') as operating_entity_code,
    urr.transfer_of_assignment_id is not null
  from public.user_registration_requests urr
  left join public.operating_entities oe on oe.id = urr.requested_operating_entity_id
  join public.profiles p on p.id = urr.profile_id
  left join public.hubs h on h.id = urr.requested_hub_id
  left join public.org_stations s on s.id = urr.requested_station_id
  left join public.org_teams t on t.id = urr.requested_team_id
  where urr.status = 'pending'
    and (oe.code = any(v_codes) or urr.requested_operating_entity_id is null)
  order by urr.submitted_at asc;
end;
$function$;

revoke execute on function public.list_entity_registration_requests_detailed_secure() from public, anon;
grant execute on function public.list_entity_registration_requests_detailed_secure() to authenticated, service_role;

-- -------------------------------------------------------------------------------------------------
-- 2. Assignment options: resolve entity & AOC dynamically for unassigned requests
-- -------------------------------------------------------------------------------------------------
create or replace function public.list_registration_assignment_options_secure(p_request_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_request record;
  v_entity_code text;
  v_entity_id uuid;
  v_aoc_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Must be signed in.';
  end if;

  select * into v_request from public.user_registration_requests where id = p_request_id;
  if v_request is null or v_request.status <> 'pending' then
    raise exception 'Registration request not found.';
  end if;

  if v_request.requested_operating_entity_id is not null then
    select oe.code, oe.id, oe.aoc_id into v_entity_code, v_entity_id, v_aoc_id
    from public.operating_entities oe where oe.id = v_request.requested_operating_entity_id;
    if v_entity_code is null or not public.is_entity_admin(v_entity_code) then
      raise exception 'Registration request not found.';
    end if;
  else
    -- Unassigned request: resolve to the caller's administered entity and AOC
    if public.is_entity_admin('MAA') then
      select oe.code, oe.id, oe.aoc_id into v_entity_code, v_entity_id, v_aoc_id
      from public.operating_entities oe where oe.code = 'MAA';
    elsif public.is_entity_admin('AAX') then
      select oe.code, oe.id, oe.aoc_id into v_entity_code, v_entity_id, v_aoc_id
      from public.operating_entities oe where oe.code = 'AAX';
    else
      raise exception 'Registration request not found.';
    end if;
  end if;

  return jsonb_build_object(
    'request', jsonb_build_object(
      'id', v_request.id,
      'entity_code', v_entity_code,
      'entity_id', v_entity_id,
      'aoc_id', coalesce(v_request.requested_aoc_id, v_aoc_id),
      'aoc_code', (select a.code from public.aocs a where a.id = coalesce(v_request.requested_aoc_id, v_aoc_id)),
      'requested_role_code', v_request.requested_role_code,
      'requested_department_id', v_request.requested_department_id,
      'requested_unit_id', v_request.requested_unit_id,
      'requested_hub_id', v_request.requested_hub_id,
      'requested_station_id', v_request.requested_station_id,
      'requested_team_id', v_request.requested_team_id
    ),
    'roles', (
      select coalesce(jsonb_agg(jsonb_build_object('code', rd.code, 'name', rd.display_name, 'category', rd.role_category) order by rd.display_name), '[]'::jsonb)
      from public.role_definitions rd
      where rd.is_active
        and rd.code not in (
          'airasia_management', 'ghod', 'global_reporting_controller', 'super_admin', 'maa_boss', 'aax_boss', 'maa_admin', 'aax_admin',
          'operation_manager', 'main_enforcement', 'compliance', 'caterlink_management'
        )
    ),
    'departments', (select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'code', d.code, 'name', d.name) order by d.name), '[]'::jsonb) from public.departments d where d.aoc_id = coalesce(v_request.requested_aoc_id, v_aoc_id)),
    'units', (select coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'department_id', u.department_id, 'code', u.code, 'name', u.name) order by u.name), '[]'::jsonb) from public.units u join public.departments d on d.id = u.department_id where d.aoc_id = coalesce(v_request.requested_aoc_id, v_aoc_id)),
    'hubs', (select coalesce(jsonb_agg(jsonb_build_object('id', h.id, 'code', h.code, 'name', h.name) order by h.name), '[]'::jsonb) from public.hubs h where h.aoc_id = coalesce(v_request.requested_aoc_id, v_aoc_id)),
    'stations', (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'hub_id', s.hub_id, 'code', s.code, 'name', s.name) order by s.code), '[]'::jsonb) from public.org_stations s join public.hubs h on h.id = s.hub_id where h.aoc_id = coalesce(v_request.requested_aoc_id, v_aoc_id) and s.is_active),
    'teams', (select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'station_id', t.station_id, 'name', t.name) order by t.name), '[]'::jsonb) from public.org_teams t join public.org_stations s on s.id = t.station_id join public.hubs h on h.id = s.hub_id where h.aoc_id = coalesce(v_request.requested_aoc_id, v_aoc_id))
  );
end;
$function$;

revoke execute on function public.list_registration_assignment_options_secure(uuid) from public, anon;
grant execute on function public.list_registration_assignment_options_secure(uuid) to authenticated, service_role;

-- -------------------------------------------------------------------------------------------------
-- 3. Approval: bind to request's entity if specified; permit entity assignment if unassigned
-- -------------------------------------------------------------------------------------------------
create or replace function public.approve_registration_request(
  p_request_id uuid,
  p_operating_entity_id uuid,
  p_aoc_id uuid,
  p_department_id uuid default null,
  p_unit_id uuid default null,
  p_hub_id uuid default null,
  p_station_id uuid default null,
  p_team_id uuid default null,
  p_role_code text default 'aso',
  p_ops_group text default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_request record;
  v_entity_code text;
  v_admin_id uuid := auth.uid();
  v_assignment_id uuid;
  v_membership_id uuid;
  v_old_membership_orphaned boolean;
  v_old_membership_was_primary boolean;
begin
  if p_role_code = any(array[
    'airasia_management', 'ghod', 'global_reporting_controller', 'super_admin',
    'maa_boss', 'aax_boss', 'maa_admin', 'aax_admin',
    'operation_manager', 'main_enforcement', 'compliance', 'caterlink_management'
  ]) then
    raise exception 'Protected role % cannot be granted through entity-admin approval; use the Super Admin-controlled path.', p_role_code;
  end if;

  select * into v_request from public.user_registration_requests where id = p_request_id for update;
  if v_request is null then
    raise exception 'Registration request not found.';
  end if;
  if v_request.status <> 'pending' then
    raise exception 'Request has already been reviewed (status=%).', v_request.status;
  end if;
  if v_request.profile_id = v_admin_id then
    raise exception 'Cannot approve your own registration request.';
  end if;

  -- The approval must match the entity and AOC if already specified; if unassigned, caller assigns their entity.
  if v_request.requested_operating_entity_id is not null and v_request.requested_operating_entity_id is distinct from p_operating_entity_id then
    raise exception 'The approval entity does not match the registration request (cross-entity approval refused).';
  end if;
  if v_request.requested_aoc_id is not null and v_request.requested_aoc_id is distinct from p_aoc_id then
    raise exception 'The approval AOC does not match the registration request (cross-AOC approval refused).';
  end if;

  select oe.code into v_entity_code from public.operating_entities oe where oe.id = p_operating_entity_id;
  if v_entity_code is null or not public.is_entity_admin(v_entity_code) then
    raise exception 'Not an authorized, approved entity Admin for the requested operating entity.';
  end if;

  -- Validate that p_aoc_id belongs to the operating entity
  if not exists (select 1 from public.operating_entities oe where oe.id = p_operating_entity_id and oe.aoc_id = p_aoc_id) then
    raise exception 'Operating entity does not belong to the specified AOC.';
  end if;

  v_membership_id := public.get_or_create_active_membership(v_request.profile_id, p_aoc_id, p_operating_entity_id, v_admin_id);

  insert into public.user_role_assignments (
    profile_id, role_definition_id, aoc_id, operating_entity_id, department_id,
    unit_id, hub_id, station_id, team_id, granted_by, grant_reason, entity_membership_id
  )
  select
    v_request.profile_id, rd.id, p_aoc_id,
    case when rd.code in ('maa_boss', 'maa_admin', 'aax_boss', 'aax_admin') then p_operating_entity_id else null end,
    p_department_id,
    p_unit_id, p_hub_id, p_station_id, p_team_id, v_admin_id,
    'Approved from registration request ' || p_request_id::text, v_membership_id
  from public.role_definitions rd
  where rd.code = p_role_code and rd.is_active
  returning id into v_assignment_id;

  if v_assignment_id is null then
    raise exception 'Unknown or inactive role code %.', p_role_code;
  end if;

  update public.user_registration_requests
  set status = 'approved',
      reviewer_id = v_admin_id,
      reviewed_at = now(),
      final_assignment_id = v_assignment_id,
      requested_operating_entity_id = coalesce(v_request.requested_operating_entity_id, p_operating_entity_id),
      requested_aoc_id = coalesce(v_request.requested_aoc_id, p_aoc_id)
  where id = p_request_id;

  perform public.apply_compatibility_profile_fields(
    v_request.profile_id, p_role_code, p_hub_id, p_station_id, p_team_id, p_ops_group, v_admin_id
  );

  if v_request.transfer_of_assignment_id is not null then
    update public.user_role_assignments
    set revoked_at = now()
    where id = v_request.transfer_of_assignment_id and revoked_at is null;

    if v_request.transfer_of_membership_id is not null then
      select not exists (
        select 1 from public.user_role_assignments
        where entity_membership_id = v_request.transfer_of_membership_id
          and revoked_at is null
          and id <> v_request.transfer_of_assignment_id
      ) into v_old_membership_orphaned;

      if v_old_membership_orphaned then
        select is_primary into v_old_membership_was_primary
        from public.user_entity_memberships
        where id = v_request.transfer_of_membership_id and status = 'active';

        update public.user_entity_memberships
        set status = 'ended', ends_at = now(), is_primary = false
        where id = v_request.transfer_of_membership_id and status = 'active';

        if coalesce(v_old_membership_was_primary, false) then
          update public.user_entity_memberships set is_primary = true where id = v_membership_id;
        end if;
      end if;
    end if;

    perform public.sync_primary_operating_entity(v_request.profile_id);

    insert into public.user_admin_audit_log (actor_id, target_profile_id, action, previous_state, new_state, request_id, assignment_id)
    values (
      v_admin_id, v_request.profile_id, 'transfer_accepted',
      jsonb_build_object('old_assignment_id', v_request.transfer_of_assignment_id),
      jsonb_build_object('new_assignment_id', v_assignment_id, 'new_membership_id', v_membership_id),
      p_request_id, v_assignment_id
    );

    perform public.notify(
      v_request.profile_id, 'transfer_accepted', 'transfer_accepted:' || p_request_id::text,
      p_request_id, v_assignment_id, v_membership_id, jsonb_build_object('role_code', p_role_code)
    );
  else
    insert into public.user_admin_audit_log (actor_id, target_profile_id, action, previous_state, new_state, request_id, assignment_id)
    values (
      v_admin_id, v_request.profile_id, 'request_approved',
      jsonb_build_object('status', 'pending'),
      jsonb_build_object('status', 'approved', 'assignment_id', v_assignment_id, 'membership_id', v_membership_id, 'role_code', p_role_code),
      p_request_id, v_assignment_id
    );

    perform public.notify(
      v_request.profile_id, 'request_approved', 'request_approved:' || p_request_id::text,
      p_request_id, v_assignment_id, v_membership_id, jsonb_build_object('role_code', p_role_code)
    );
  end if;

  return v_assignment_id;
end;
$function$;

revoke execute on function public.approve_registration_request(uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, text) from public, anon;
grant execute on function public.approve_registration_request(uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, text) to authenticated, service_role;

-- -------------------------------------------------------------------------------------------------
-- 4. Rejection: permit rejection by either entity admin for unassigned requests
-- -------------------------------------------------------------------------------------------------
create or replace function public.reject_registration_request(
  p_request_id uuid,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_request record;
  v_admin_id uuid := auth.uid();
  v_entity_code text;
  v_is_transfer boolean;
begin
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'A rejection reason is required.';
  end if;

  select * into v_request from public.user_registration_requests where id = p_request_id for update;
  if v_request is null then
    raise exception 'Registration request not found.';
  end if;
  if v_request.status <> 'pending' then
    raise exception 'Request has already been reviewed (status=%).', v_request.status;
  end if;
  if v_request.profile_id = v_admin_id then
    raise exception 'Cannot reject your own registration request.';
  end if;

  if v_request.requested_operating_entity_id is not null then
    select oe.code into v_entity_code from public.operating_entities oe where oe.id = v_request.requested_operating_entity_id;
    if v_entity_code is null or not public.is_entity_admin(v_entity_code) then
      raise exception 'Not an authorized, approved entity Admin for the requested operating entity.';
    end if;
  else
    if not (public.is_entity_admin('MAA') or public.is_entity_admin('AAX')) then
      raise exception 'Not an authorized, approved entity Admin for MAA or AAX.';
    end if;
  end if;

  v_is_transfer := v_request.transfer_of_assignment_id is not null;

  update public.user_registration_requests
  set status = 'rejected',
      reviewer_id = v_admin_id,
      reviewed_at = now(),
      rejection_reason = p_reason
  where id = p_request_id;

  insert into public.user_admin_audit_log (actor_id, target_profile_id, action, previous_state, new_state, request_id)
  values (
    v_admin_id, v_request.profile_id,
    case when v_is_transfer then 'transfer_rejected' else 'request_rejected' end,
    jsonb_build_object('status', 'pending'),
    jsonb_build_object('status', 'rejected', 'reason', p_reason),
    p_request_id
  );

  perform public.notify(
    v_request.profile_id,
    case when v_is_transfer then 'transfer_rejected' else 'request_rejected' end,
    'request_rejected:' || p_request_id::text,
    p_request_id, null, null, jsonb_build_object('reason', p_reason)
  );
end;
$function$;

revoke execute on function public.reject_registration_request(uuid, text) from public, anon;
grant execute on function public.reject_registration_request(uuid, text) to authenticated, service_role;

-- -------------------------------------------------------------------------------------------------
-- 5. Recover missing registration request for eswaran3561@gmail.com
--    CRITICAL: Preserved as 'pending'. Do not approve directly.
-- -------------------------------------------------------------------------------------------------
insert into public.user_registration_requests (
  id, profile_id, requested_operating_entity_id, requested_aoc_id,
  requested_role_code, status, applicant_notes, submitted_at
)
select
  gen_random_uuid(),
  p.id,
  null,
  null,
  'aso',
  'pending',
  'Account registration recovery - pending admin review',
  now()
from public.profiles p
where p.email = 'eswaran3561@gmail.com'
  and not exists (
    select 1 from public.user_registration_requests urr
    where urr.profile_id = p.id and urr.status = 'pending'
  );
