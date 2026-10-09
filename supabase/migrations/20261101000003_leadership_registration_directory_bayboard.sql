-- MAA / AAX leadership, part 3: registration administration, Malaysia directory and workforce, Bay Board read path.
-- Additive and forward-only; no data is rewritten. Hosted application needs separate authorisation.
--
-- * approve_registration_request(): the approval is now bound to THE REQUEST'S OWN entity and AOC. Before, an MAA Admin could approve
--   an AAX applicant by passing the MAA entity id (the admin check used the argument, not the request). The protected-role refusal,
--   self-approval refusal and the assignment scope-shape trigger are unchanged and remain authoritative.
-- * list_entity_registration_requests_detailed_secure(): names and requested scope for the Admin's own entity only.
-- * list_registration_assignment_options_secure(): the roles an entity Admin may grant for a request and the scope selectors for
--   the request's AOC -- so the page never asks for raw ids.
-- * caller_entity_leadership_aoc(): the AOC of the caller's active, approved MAA/AAX Boss/Admin assignment (NULL otherwise).
-- * list_malaysia_staff_directory_secure(): combined MAA + AAX directory, safe fields only. It does NOT widen report access.
-- * get_malaysia_workforce_summary_secure(): combined workforce oversight for the two Boss roles (totals only).
-- * list_bay_board_scopes_secure() / get_bay_board_secure(): Bay Board hub/station read path for the four entity roles. It does not
--   infer a report entity from a station and does not alter the existing station-scoped row policy.

-- ---------------------------------------------------------------------------------------------
-- Shared helper: the caller's leadership AOC
-- ---------------------------------------------------------------------------------------------
create or replace function public.caller_entity_leadership_aoc()
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
    and rd.code in ('maa_boss', 'maa_admin', 'aax_boss', 'aax_admin')
    and ura.aoc_id is not null
    and ura.revoked_at is null
    and ura.starts_at <= now()
    and (ura.ends_at is null or ura.ends_at > now())
  order by ura.starts_at
  limit 1;
$function$;
revoke execute on function public.caller_entity_leadership_aoc() from public, anon;
grant execute on function public.caller_entity_leadership_aoc() to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Registration: approval bound to the request's own entity and AOC
-- ---------------------------------------------------------------------------------------------
create or replace function public.approve_registration_request(
  p_request_id uuid, p_role_code text, p_aoc_id uuid, p_operating_entity_id uuid, p_department_id uuid,
  p_unit_id uuid, p_hub_id uuid, p_station_id uuid, p_team_id uuid, p_ops_group text default null
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

  -- The approval must be for the entity and AOC the request itself names (never an argument the caller picked).
  if v_request.requested_operating_entity_id is distinct from p_operating_entity_id then
    raise exception 'The approval entity does not match the registration request (cross-entity approval refused).';
  end if;
  if v_request.requested_aoc_id is distinct from p_aoc_id then
    raise exception 'The approval AOC does not match the registration request (cross-AOC approval refused).';
  end if;

  select oe.code into v_entity_code from public.operating_entities oe where oe.id = p_operating_entity_id;
  if v_entity_code is null or not public.is_entity_admin(v_entity_code) then
    raise exception 'Not an authorized, approved entity Admin for the requested operating entity.';
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
  set status = 'approved', reviewer_id = v_admin_id, reviewed_at = now(), final_assignment_id = v_assignment_id
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

-- Detailed pending list for the caller's own entity only (names and requested scope, no private contact fields)
create or replace function public.list_entity_registration_requests_detailed_secure()
returns table (
  id uuid, staff_name text, staff_no text, requested_role_code text, requested_hub_code text, requested_station_code text,
  requested_team_name text, applicant_notes text, submitted_at timestamptz, operating_entity_code text, is_transfer boolean
)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_codes text[] := array[]::text[];
begin
  if auth.uid() is null then raise exception 'Must be signed in.'; end if;
  if public.is_entity_admin('MAA') then v_codes := array_append(v_codes, 'MAA'); end if;
  if public.is_entity_admin('AAX') then v_codes := array_append(v_codes, 'AAX'); end if;
  if array_length(v_codes, 1) is null then
    raise exception 'Only an approved MAA or AAX Admin may list entity registration requests.';
  end if;
  return query
  select urr.id, p.name, p.staff_no, urr.requested_role_code, h.code, s.code, t.name, urr.applicant_notes, urr.submitted_at, oe.code,
         urr.transfer_of_assignment_id is not null
  from public.user_registration_requests urr
  join public.operating_entities oe on oe.id = urr.requested_operating_entity_id
  join public.profiles p on p.id = urr.profile_id
  left join public.hubs h on h.id = urr.requested_hub_id
  left join public.org_stations s on s.id = urr.requested_station_id
  left join public.org_teams t on t.id = urr.requested_team_id
  where urr.status = 'pending' and oe.code = any(v_codes)
  order by urr.submitted_at asc;
end;
$function$;
revoke execute on function public.list_entity_registration_requests_detailed_secure() from public, anon;
grant execute on function public.list_entity_registration_requests_detailed_secure() to authenticated, service_role;

-- Assignment options for one request: eligible roles (never a protected role) and the scope selectors of the request's AOC.
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
begin
  if auth.uid() is null then raise exception 'Must be signed in.'; end if;
  select * into v_request from public.user_registration_requests where id = p_request_id;
  if v_request is null or v_request.status <> 'pending' then
    raise exception 'Registration request not found.';
  end if;
  select oe.code into v_entity_code from public.operating_entities oe where oe.id = v_request.requested_operating_entity_id;
  if v_entity_code is null or not public.is_entity_admin(v_entity_code) then
    raise exception 'Registration request not found.';
  end if;

  return jsonb_build_object(
    'request', jsonb_build_object(
      'id', v_request.id, 'entity_code', v_entity_code, 'entity_id', v_request.requested_operating_entity_id,
      'aoc_id', v_request.requested_aoc_id,
      'aoc_code', (select a.code from public.aocs a where a.id = v_request.requested_aoc_id),
      'requested_role_code', v_request.requested_role_code,
      'requested_department_id', v_request.requested_department_id, 'requested_unit_id', v_request.requested_unit_id,
      'requested_hub_id', v_request.requested_hub_id, 'requested_station_id', v_request.requested_station_id,
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
    'departments', (select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'code', d.code, 'name', d.name) order by d.name), '[]'::jsonb) from public.departments d where d.aoc_id = v_request.requested_aoc_id),
    'units', (select coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'department_id', u.department_id, 'code', u.code, 'name', u.name) order by u.name), '[]'::jsonb) from public.units u join public.departments d on d.id = u.department_id where d.aoc_id = v_request.requested_aoc_id),
    'hubs', (select coalesce(jsonb_agg(jsonb_build_object('id', h.id, 'code', h.code, 'name', h.name) order by h.name), '[]'::jsonb) from public.hubs h where h.aoc_id = v_request.requested_aoc_id),
    'stations', (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'hub_id', s.hub_id, 'code', s.code, 'name', s.name) order by s.code), '[]'::jsonb) from public.org_stations s join public.hubs h on h.id = s.hub_id where h.aoc_id = v_request.requested_aoc_id and s.is_active),
    'teams', (select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'station_id', t.station_id, 'name', t.name) order by t.name), '[]'::jsonb) from public.org_teams t join public.org_stations s on s.id = t.station_id join public.hubs h on h.id = s.hub_id where h.aoc_id = v_request.requested_aoc_id)
  );
end;
$function$;
revoke execute on function public.list_registration_assignment_options_secure(uuid) from public, anon;
grant execute on function public.list_registration_assignment_options_secure(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Combined Malaysia staff directory (safe fields only) -- never a report-access grant
-- ---------------------------------------------------------------------------------------------
create or replace function public.list_malaysia_staff_directory_secure(
  p_search text default null,
  p_entity_code text default null,
  p_page integer default 1,
  p_page_size integer default 50
)
returns table (
  staff_no text, staff_name text, entity_code text, role_code text, department_code text, unit_code text, hub_code text,
  station_code text, team_name text, account_state text, total_count bigint
)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_aoc uuid := public.caller_entity_leadership_aoc();
  v_page integer := greatest(coalesce(p_page, 1), 1);
  v_page_size integer := least(greatest(coalesce(p_page_size, 50), 1), 200);
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
begin
  if v_aoc is null then
    raise exception 'Only an approved MAA or AAX Boss/Admin may view the Malaysia staff directory.';
  end if;
  if p_entity_code is not null and p_entity_code not in ('MAA', 'AAX') then
    raise exception 'Unsupported entity filter.';
  end if;
  return query
  with rows as (
    select p.staff_no, p.name as staff_name, oe.code as entity_code, rd.code as role_code, d.code as department_code,
           u.code as unit_code, h.code as hub_code, s.code as station_code, t.name as team_name, p.status::text as account_state
    from (
      select uem.profile_id, uem.operating_entity_id, uem.id as membership_id
      from public.user_entity_memberships uem
      where uem.status = 'active' and uem.starts_at <= now() and (uem.ends_at is null or uem.ends_at > now())
      union
      -- leadership roles carry their entity on the assignment (protected roles have no membership)
      select ura.profile_id, ura.operating_entity_id, null::uuid
      from public.user_role_assignments ura
      where ura.operating_entity_id is not null and ura.revoked_at is null
        and ura.starts_at <= now() and (ura.ends_at is null or ura.ends_at > now())
    ) ent
    join public.operating_entities oe on oe.id = ent.operating_entity_id and oe.aoc_id = v_aoc
    join public.profiles p on p.id = ent.profile_id
    left join lateral (
      select ura.* from public.user_role_assignments ura
      where ura.profile_id = p.id and ura.revoked_at is null
        and ura.starts_at <= now() and (ura.ends_at is null or ura.ends_at > now())
        and ((ent.membership_id is not null and ura.entity_membership_id = ent.membership_id)
             or (ent.membership_id is null and ura.operating_entity_id = ent.operating_entity_id))
      order by ura.starts_at desc limit 1
    ) ra on true
    left join public.role_definitions rd on rd.id = ra.role_definition_id
    left join public.departments d on d.id = ra.department_id
    left join public.units u on u.id = ra.unit_id
    left join public.hubs h on h.id = ra.hub_id
    left join public.org_stations s on s.id = ra.station_id
    left join public.org_teams t on t.id = ra.team_id
    where (p_entity_code is null or oe.code = p_entity_code)
      and (v_search is null or p.name ilike '%' || v_search || '%' or p.staff_no ilike '%' || v_search || '%')
  ), counted as (select count(*) as n from rows)
  select r.staff_no, r.staff_name, r.entity_code, r.role_code, r.department_code, r.unit_code, r.hub_code, r.station_code,
         r.team_name, r.account_state, c.n
  from rows r, counted c
  order by r.entity_code, r.staff_name, r.staff_no
  limit v_page_size offset (v_page - 1) * v_page_size;
end;
$function$;
revoke execute on function public.list_malaysia_staff_directory_secure(text, text, integer, integer) from public, anon;
grant execute on function public.list_malaysia_staff_directory_secure(text, text, integer, integer) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Combined workforce oversight (totals only) for the two Boss roles
-- ---------------------------------------------------------------------------------------------
create or replace function public.get_malaysia_workforce_summary_secure(p_duty_date date default current_date)
returns table (entity_code text, active_staff bigint, checked_in bigint, pending bigint, absent bigint, generated_at timestamptz)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_aoc uuid;
begin
  if not (public.has_active_role('maa_boss') or public.has_active_role('aax_boss')) then
    raise exception 'Only an approved MAA or AAX Boss may view the Malaysia workforce summary.';
  end if;
  v_aoc := public.caller_entity_leadership_aoc();
  if v_aoc is null then
    raise exception 'Only an approved MAA or AAX Boss may view the Malaysia workforce summary.';
  end if;
  return query
  select oe.code,
    (select count(*)::bigint from public.user_entity_memberships uem
      where uem.operating_entity_id = oe.id and uem.status = 'active' and uem.starts_at <= now() and (uem.ends_at is null or uem.ends_at > now())),
    count(dr.id) filter (where dr.status in ('present', 'late'))::bigint,
    count(dr.id) filter (where dr.status = 'pending')::bigint,
    count(dr.id) filter (where dr.status = 'absent')::bigint,
    now()
  from public.operating_entities oe
  left join public.duty_records dr on dr.duty_date = p_duty_date and exists (
    select 1 from public.user_entity_memberships uem2
    where uem2.profile_id = dr.profile_id and uem2.operating_entity_id = oe.id and uem2.status = 'active'
      and uem2.starts_at <= now() and (uem2.ends_at is null or uem2.ends_at > now())
  )
  where oe.aoc_id = v_aoc and oe.code in ('MAA', 'AAX')
  group by oe.id, oe.code
  order by oe.code;
end;
$function$;
revoke execute on function public.get_malaysia_workforce_summary_secure(date) from public, anon;
grant execute on function public.get_malaysia_workforce_summary_secure(date) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Bay Board read path for MAA/AAX Boss and Admin: hub/station selectors, Malaysia-wide, no entity inference
-- ---------------------------------------------------------------------------------------------
create or replace function public.list_bay_board_scopes_secure()
returns table (hub_code text, hub_name text, station_code text, station_name text)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_aoc uuid := public.caller_entity_leadership_aoc();
begin
  if v_aoc is null then
    raise exception 'Only an approved MAA or AAX Boss/Admin may use the Bay Board selectors.';
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
  v_aoc uuid := public.caller_entity_leadership_aoc();
begin
  if v_aoc is null then
    raise exception 'Only an approved MAA or AAX Boss/Admin may view the Bay Board through this path.';
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
