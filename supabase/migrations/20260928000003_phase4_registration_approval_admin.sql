-- PHASE 4 -- MALAYSIA REGISTRATION, APPROVAL, ASSIGNMENT, TRANSFER,
-- DEACTIVATION AND ENTITY-ADMIN USER ADMINISTRATION (2026-09-28)
-- Additive only, same guarantee as Phases 2-3: no existing table/column/
-- policy/function/grant is touched, renamed or dropped, and NO existing
-- legacy permission is broadened. The current Google SSO/password
-- registration and Management approval workflow is completely untouched
-- -- this migration adds a parallel, new path, not a replacement.
--
-- Covers:
--   Part A: user_registration_requests (pending-assignment/request model)
--   Part B: user_admin_audit_log (append-only, no client read/write)
--   Part C: is_entity_admin() -- entity-authorization helper
--   Part D: apply_compatibility_profile_fields() -- the SINGLE controlled
--           compatibility-mapping layer (see its own header for the
--           safe-subset decision and why)
--   Part E: submit_registration_request() / list-my-request self-service
--   Part F: list_pending_registration_requests() -- entity-scoped read
--   Part G: approve_registration_request() -- the atomic approval
--           transaction
--   Part H: reject_registration_request()
--   Part I: deactivate_assignment()
--   Part J: transfer_assignment_same_entity()
--   Part K: initiate_cross_entity_transfer() / accept_cross_entity_transfer()
--   Part L: export_entity_user_directory()
--   Part M: RLS / grants summary
--
-- DESIGN DECISION recorded here, not guessed silently: Phase 3's
-- approved scope matrix correctly leaves operating_entity_id NULL on
-- every ordinary Operation/Enforcement role assignment (those roles are
-- AOC+department scoped, never entity scoped -- an Operation ASO's
-- assignment row has no entity column at all). But Phase 4 requires
-- "MAA Admin manages MAA ordinary users" / "AAX Admin manages AAX
-- ordinary users" / MAA<->AAX transfer, which needs SOME durable
-- per-person entity affiliation. Rather than reopening or bending
-- Phase 3's already-approved assignment-scope matrix, this phase uses
-- profiles.operating_entity_id (a nullable FK added in Phase 2, never
-- touched by Phase 3) as the person's organizational entity affiliation,
-- kept entirely separate from the assignment's own (correctly NULL)
-- entity column. Entity-admin authority over an ordinary user is
-- therefore always resolved via profiles.operating_entity_id, never via
-- user_role_assignments.operating_entity_id, for ordinary roles.

-- =======================================================================
-- PART A: user_registration_requests
-- =======================================================================
create table if not exists public.user_registration_requests (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id),

  requested_aoc_id uuid references public.aocs(id),
  requested_operating_entity_id uuid references public.operating_entities(id),
  requested_department_id uuid references public.departments(id),
  requested_unit_id uuid references public.units(id),
  requested_hub_id uuid references public.hubs(id),
  requested_station_id uuid references public.org_stations(id),
  requested_team_id uuid references public.org_teams(id),
  requested_role_code text references public.role_definitions(code),

  applicant_notes text,

  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  reviewer_id uuid references public.profiles(id),
  reviewed_at timestamptz,
  rejection_reason text,
  final_assignment_id uuid references public.user_role_assignments(id),

  submitted_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- At most one OPEN (pending) request per profile -- resubmission after a
-- rejection creates a brand-new row (a clear new review cycle), it never
-- overwrites or erases the rejected row's history.
create unique index if not exists user_registration_requests_one_pending_per_profile
  on public.user_registration_requests (profile_id)
  where status = 'pending';

create index if not exists user_registration_requests_status_entity_idx
  on public.user_registration_requests (status, requested_operating_entity_id)
  where status = 'pending';

create or replace function public.set_updated_at_user_registration_requests()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  new.updated_at = now();
  return new;
end;
$function$;

drop trigger if exists trg_user_registration_requests_updated_at on public.user_registration_requests;
create trigger trg_user_registration_requests_updated_at
  before update on public.user_registration_requests
  for each row execute function public.set_updated_at_user_registration_requests();

-- Enforces every "pending users may..." / "may not..." rule from the
-- spec at the database layer, independent of RLS: a self-write can only
-- ever create/update a still-pending row with every review-outcome
-- column left null, and can never touch profile_id or submitted_at once
-- created. service_role (used by the approve/reject/transfer RPCs below)
-- bypasses this, matching the established service-role-bypass pattern
-- from the C-02 containment migration earlier in this project.
create or replace function public.enforce_registration_request_self_write()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if auth.role() = 'service_role' then
    return new;
  end if;

  if new.profile_id <> auth.uid() then
    raise exception 'Not authorized to write another user''s registration request.';
  end if;

  if tg_op = 'INSERT' then
    if new.status <> 'pending'
       or new.reviewer_id is not null
       or new.reviewed_at is not null
       or new.rejection_reason is not null
       or new.final_assignment_id is not null
    then
      raise exception 'A self-submitted request must start pending with no review fields set.';
    end if;
    return new;
  end if;

  if old.status <> 'pending' then
    raise exception 'Cannot modify a request that has already been reviewed.';
  end if;
  if new.status <> 'pending'
     or new.reviewer_id is not null
     or new.reviewed_at is not null
     or new.rejection_reason is not null
     or new.final_assignment_id is not null
  then
    raise exception 'Cannot self-approve, self-reject, or otherwise set review fields on your own request.';
  end if;
  if new.profile_id is distinct from old.profile_id or new.submitted_at is distinct from old.submitted_at then
    raise exception 'Cannot change profile_id or submitted_at.';
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_enforce_registration_request_self_write on public.user_registration_requests;
create trigger trg_enforce_registration_request_self_write
  before insert or update on public.user_registration_requests
  for each row execute function public.enforce_registration_request_self_write();

-- =======================================================================
-- PART B: user_admin_audit_log
-- =======================================================================
-- Append-only. No SELECT, UPDATE, or DELETE grant exists for anyone but
-- service_role in this phase -- an ordinary user's or entity Admin's own
-- scoped read of their relevant audit trail is Phase 5+ work (a narrow
-- RPC, never direct table access), so this structurally satisfies
-- "prevent ordinary users and entity Admins from editing/deleting audit
-- records" by removing the capability entirely rather than relying on a
-- policy that could later be loosened by mistake.
create table if not exists public.user_admin_audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references public.profiles(id),
  target_profile_id uuid references public.profiles(id),
  action text not null check (action in (
    'request_submitted', 'request_updated', 'request_approved', 'request_rejected',
    'assignment_created', 'assignment_revoked', 'assignment_expired',
    'transfer_initiated', 'transfer_accepted', 'transfer_rejected',
    'deactivation', 'reactivation', 'export', 'compatibility_sync', 'shadow_sync'
  )),
  previous_state jsonb,
  new_state jsonb,
  reason text,
  request_id uuid references public.user_registration_requests(id),
  assignment_id uuid references public.user_role_assignments(id),
  created_at timestamptz not null default now()
);

create index if not exists user_admin_audit_log_target_idx on public.user_admin_audit_log (target_profile_id);
create index if not exists user_admin_audit_log_actor_idx on public.user_admin_audit_log (actor_id);

-- =======================================================================
-- PART C: is_entity_admin() -- entity-authorization helper
-- =======================================================================
-- Reuses Phase 3's has_role_in_scope() rather than inventing a parallel
-- authorization primitive. Reads only auth.uid() (via has_role_in_scope,
-- which itself reads only auth.uid()) -- never trusts a client-supplied
-- caller identity.
create or replace function public.is_entity_admin(p_entity_code text)
returns boolean
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_entity_id uuid;
  v_aoc_id uuid;
  v_admin_role text;
begin
  select id, aoc_id into v_entity_id, v_aoc_id from public.operating_entities where code = p_entity_code;
  if v_entity_id is null then
    return false;
  end if;

  v_admin_role := case p_entity_code
    when 'MAA' then 'maa_admin'
    when 'AAX' then 'aax_admin'
    else null
  end;
  if v_admin_role is null then
    return false;
  end if;

  return public.has_role_in_scope(v_admin_role, v_aoc_id, v_entity_id);
end;
$function$;

revoke execute on function public.is_entity_admin(text) from public, anon;
grant execute on function public.is_entity_admin(text) to authenticated, service_role;

-- =======================================================================
-- PART D: apply_compatibility_profile_fields()
-- =======================================================================
-- THE single controlled compatibility-mapping layer. No other function
-- in this migration writes profiles.role/unified_role/ops_group/station/
-- team/status/approved_by/approved_at/rejection_reason directly -- every
-- write to those columns goes through this one function, so no action
-- can independently invent its own mapping rule.
--
-- SAFE SUBSET DECISION: profiles.role is a fixed Postgres enum
-- ('ASO','SO','DSE','ADMIN','ENFORCEMENT','MANAGEMENT') and
-- profiles.ops_group is constrained to
-- ('operation_avsec','ifc_avsec','hub_avsec') -- neither has a slot for
-- most of the 11 ordinary roles entity Admins may assign. Only
-- dse/so/aso, and only when hub = KUL, map onto an EXISTING legacy value
-- with EXACTLY the same real-world meaning the legacy system already
-- uses (KUL DSE/SO/ASO, ops_group-aware). For those three (KUL-only),
-- this function requires an explicit p_ops_group argument (constrained
-- to operation_avsec/ifc_avsec -- never hub_avsec, which is a distinct
-- branch not modelled by Phase 3's org hierarchy yet) and writes the
-- full legacy compatibility set.
--
-- Every other role -- sso (no legacy enum value exists at all: neither
-- 'SSO' nor a safe substitute), hub_se (would require ADMIN/MANAGEMENT/
-- ENFORCEMENT, all of which grant far more than hub-scoped duty
-- authority -- explicitly the "no broad ENFORCEMENT mapping unless
-- proven safe" and "Hub SE must not accidentally inherit Malaysia-wide
-- Enforcement/Management access" cases), investigation_sso/so/aso and
-- sat_aso and profiling_so/aso (same reasoning -- ENFORCEMENT is too
-- broad, and Investigation/SAT/Profiling must stay distinguishable,
-- which a single legacy ENFORCEMENT value cannot do), caterlink_management
-- (must never map to a scanning role, and has no operational duty
-- surface to map to anyway), and dse/so/aso OUTSIDE KUL (ops_group has
-- no per-hub concept yet -- that is Phase 7 wiring) -- get their scoped
-- Phase 3 assignment row and a full audit trail, but NO legacy
-- profiles.role/ops_group/station/team write, and profiles.status is
-- LEFT UNCHANGED (not flipped to 'approved') for these, per instruction
-- to record deferred roles as requiring Phase 5-9 wiring rather than
-- silently granting access through a stale or default legacy role value.
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
  v_hub_code text;
  v_station_code text;
  v_team_name text;
  v_legacy_role text;
  v_mapped boolean := false;
begin
  select h.code into v_hub_code from public.hubs h where h.id = p_hub_id;
  select s.code into v_station_code from public.org_stations s where s.id = p_station_id;
  select t.name into v_team_name from public.org_teams t where t.id = p_team_id;

  if p_role_code in ('dse', 'so', 'aso') and v_hub_code = 'kul' then
    if p_ops_group not in ('operation_avsec', 'ifc_avsec') then
      raise exception 'A KUL dse/so/aso approval requires an explicit ops_group of operation_avsec or ifc_avsec.';
    end if;
    v_legacy_role := case p_role_code when 'dse' then 'DSE' when 'so' then 'SO' when 'aso' then 'ASO' end;
    update public.profiles
    set role = v_legacy_role::user_role,
        unified_role = lower(p_role_code),
        ops_group = p_ops_group,
        station = v_station_code,
        team = v_team_name,
        status = 'approved',
        approved_by = p_actor_id,
        approved_at = now(),
        rejection_reason = null
    where id = p_profile_id;
    v_mapped := true;
  end if;
  -- No else branch: for every deferred role, profiles.status/role/
  -- ops_group/station/team/approved_by/approved_at are left exactly as
  -- they were -- the new user_role_assignments row is the sole source
  -- of authority for that person's new role until Phase 5-9 wiring
  -- exists to give it a live application surface.

  insert into public.user_admin_audit_log (actor_id, target_profile_id, action, new_state)
  values (p_actor_id, p_profile_id, 'compatibility_sync', jsonb_build_object('role_code', p_role_code, 'mapped', v_mapped));
end;
$function$;

revoke execute on function public.apply_compatibility_profile_fields(uuid, text, uuid, uuid, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.apply_compatibility_profile_fields(uuid, text, uuid, uuid, uuid, text, uuid) to service_role;

-- =======================================================================
-- PART E: submit_registration_request()
-- =======================================================================
-- Thin, validated wrapper around the INSERT that RLS/the trigger above
-- already constrain to self-only, pending-only. Exists so the applicant
-- form has one clear entry point rather than each caller composing its
-- own INSERT. Explicit revalidation of the "no writing profile
-- role/unified_role/status/organization fields" boundary: this function
-- writes ONLY to user_registration_requests, never to profiles.
create or replace function public.submit_registration_request(
  p_requested_aoc_id uuid,
  p_requested_operating_entity_id uuid,
  p_requested_department_id uuid,
  p_requested_unit_id uuid,
  p_requested_hub_id uuid,
  p_requested_station_id uuid,
  p_requested_team_id uuid,
  p_requested_role_code text,
  p_applicant_notes text default null
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
    raise exception 'Must be signed in to submit a registration request.';
  end if;

  insert into public.user_registration_requests (
    profile_id, requested_aoc_id, requested_operating_entity_id, requested_department_id,
    requested_unit_id, requested_hub_id, requested_station_id, requested_team_id,
    requested_role_code, applicant_notes
  ) values (
    auth.uid(), p_requested_aoc_id, p_requested_operating_entity_id, p_requested_department_id,
    p_requested_unit_id, p_requested_hub_id, p_requested_station_id, p_requested_team_id,
    p_requested_role_code, p_applicant_notes
  )
  returning id into v_id;

  insert into public.user_admin_audit_log (actor_id, target_profile_id, action, new_state, request_id)
  values (auth.uid(), auth.uid(), 'request_submitted', jsonb_build_object('role_code', p_requested_role_code), v_id);

  return v_id;
end;
$function$;

revoke execute on function public.submit_registration_request(uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, text) from public, anon;
grant execute on function public.submit_registration_request(uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, text) to authenticated, service_role;

-- Self-read: the applicant's own current request (any status), never
-- another user's -- mirrors Phase 3's get_my_active_role_assignments()
-- self-read pattern rather than granting a SELECT policy on the table.
create or replace function public.get_my_registration_request()
returns table (
  id uuid,
  status text,
  requested_role_code text,
  rejection_reason text,
  submitted_at timestamptz,
  reviewed_at timestamptz
)
language sql
stable
security definer
set search_path to 'public'
as $function$
  select urr.id, urr.status, urr.requested_role_code, urr.rejection_reason, urr.submitted_at, urr.reviewed_at
  from public.user_registration_requests urr
  where urr.profile_id = auth.uid()
  order by urr.submitted_at desc
  limit 1;
$function$;

revoke execute on function public.get_my_registration_request() from public, anon;
grant execute on function public.get_my_registration_request() to authenticated, service_role;

-- =======================================================================
-- PART F: list_pending_registration_requests() -- entity-scoped read
-- =======================================================================
-- Returns pending requests ONLY for the entity/entities the caller
-- actually administers (checked via is_entity_admin() for both MAA and
-- AAX independently -- a caller who is neither sees zero rows). No
-- client-supplied entity filter is trusted; the WHERE clause is the sole
-- authorization boundary.
create or replace function public.list_pending_registration_requests()
returns table (
  id uuid,
  profile_id uuid,
  requested_operating_entity_code text,
  requested_department_code text,
  requested_unit_code text,
  requested_hub_code text,
  requested_station_code text,
  requested_team_name text,
  requested_role_code text,
  applicant_notes text,
  submitted_at timestamptz
)
language sql
stable
security definer
set search_path to 'public'
as $function$
  select
    urr.id, urr.profile_id, oe.code, d.code, u.code, h.code, s.code, t.name,
    urr.requested_role_code, urr.applicant_notes, urr.submitted_at
  from public.user_registration_requests urr
  left join public.operating_entities oe on oe.id = urr.requested_operating_entity_id
  left join public.departments d on d.id = urr.requested_department_id
  left join public.units u on u.id = urr.requested_unit_id
  left join public.hubs h on h.id = urr.requested_hub_id
  left join public.org_stations s on s.id = urr.requested_station_id
  left join public.org_teams t on t.id = urr.requested_team_id
  where urr.status = 'pending'
    and oe.code is not null
    and public.is_entity_admin(oe.code);
$function$;

revoke execute on function public.list_pending_registration_requests() from public, anon;
grant execute on function public.list_pending_registration_requests() to authenticated, service_role;

-- =======================================================================
-- PART G: approve_registration_request() -- the atomic approval transaction
-- =======================================================================
-- Single PL/pgSQL function = single transaction. Order of operations
-- matches the spec's step 7 exactly: validate Admin authority, validate
-- entity scope, validate role/scope shape (delegated to Phase 3's own
-- trigger by inserting into user_role_assignments -- never duplicated
-- here), create the assignment, update compatibility profile fields
-- (Part D, safe-subset only), record approved_by/approved_at (inside
-- Part D), change status to approved, and write one audit event -- all
-- in one function invocation, so a failure at any step rolls back the
-- entire operation (Postgres function bodies are transactional by
-- default; there is no partial-commit path here).
--
-- Race safety: `for update` on the request row means a second concurrent
-- approve/reject call for the same request blocks until the first
-- commits, then sees status <> 'pending' and raises -- two Admins can
-- never both successfully approve (or one approve while another
-- rejects) the same request. Approval submitted twice by the same Admin
-- hits the same guard on the second call.
create or replace function public.approve_registration_request(
  p_request_id uuid,
  p_role_code text,
  p_aoc_id uuid,
  p_operating_entity_id uuid,
  p_department_id uuid,
  p_unit_id uuid,
  p_hub_id uuid,
  p_station_id uuid,
  p_team_id uuid,
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

  select oe.code into v_entity_code from public.operating_entities oe where oe.id = p_operating_entity_id;
  if v_entity_code is null or not public.is_entity_admin(v_entity_code) then
    raise exception 'Not an authorized, approved entity Admin for the requested operating entity.';
  end if;

  insert into public.user_role_assignments (
    profile_id, role_definition_id, aoc_id, operating_entity_id, department_id,
    unit_id, hub_id, station_id, team_id, granted_by, grant_reason
  )
  select
    v_request.profile_id, rd.id, p_aoc_id, p_operating_entity_id, p_department_id,
    p_unit_id, p_hub_id, p_station_id, p_team_id, v_admin_id,
    'Approved from registration request ' || p_request_id::text
  from public.role_definitions rd
  where rd.code = p_role_code
  returning id into v_assignment_id;

  if v_assignment_id is null then
    raise exception 'Unknown role code %.', p_role_code;
  end if;

  update public.user_registration_requests
  set status = 'approved', reviewer_id = v_admin_id, reviewed_at = now(), final_assignment_id = v_assignment_id
  where id = p_request_id;

  -- Person-level entity affiliation (see this migration's header design
  -- decision) -- independent of the assignment row's own, correctly
  -- NULL, entity column for ordinary roles.
  update public.profiles set operating_entity_id = p_operating_entity_id where id = v_request.profile_id;

  perform public.apply_compatibility_profile_fields(
    v_request.profile_id, p_role_code, p_hub_id, p_station_id, p_team_id, p_ops_group, v_admin_id
  );

  insert into public.user_admin_audit_log (actor_id, target_profile_id, action, previous_state, new_state, request_id, assignment_id)
  values (
    v_admin_id, v_request.profile_id, 'request_approved',
    jsonb_build_object('status', 'pending'),
    jsonb_build_object('status', 'approved', 'role_code', p_role_code, 'assignment_id', v_assignment_id),
    p_request_id, v_assignment_id
  );

  return v_assignment_id;
end;
$function$;

revoke execute on function public.approve_registration_request(uuid, text, uuid, uuid, uuid, uuid, uuid, uuid, uuid, text) from public, anon;
grant execute on function public.approve_registration_request(uuid, text, uuid, uuid, uuid, uuid, uuid, uuid, uuid, text) to authenticated, service_role;

-- =======================================================================
-- PART H: reject_registration_request()
-- =======================================================================
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

  select oe.code into v_entity_code from public.operating_entities oe where oe.id = v_request.requested_operating_entity_id;
  if v_entity_code is null or not public.is_entity_admin(v_entity_code) then
    raise exception 'Not an authorized, approved entity Admin for the requested operating entity.';
  end if;

  update public.user_registration_requests
  set status = 'rejected', reviewer_id = v_admin_id, reviewed_at = now(), rejection_reason = p_reason
  where id = p_request_id;

  update public.profiles set status = 'rejected', rejection_reason = p_reason where id = v_request.profile_id;

  insert into public.user_admin_audit_log (actor_id, target_profile_id, action, previous_state, new_state, reason, request_id)
  values (
    v_admin_id, v_request.profile_id, 'request_rejected',
    jsonb_build_object('status', 'pending'), jsonb_build_object('status', 'rejected'),
    p_reason, p_request_id
  );
end;
$function$;

revoke execute on function public.reject_registration_request(uuid, text) from public, anon;
grant execute on function public.reject_registration_request(uuid, text) to authenticated, service_role;

-- =======================================================================
-- PART I: deactivate_assignment()
-- =======================================================================
create or replace function public.deactivate_assignment(
  p_assignment_id uuid,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_assignment record;
  v_role_code text;
  v_admin_id uuid := auth.uid();
  v_target_entity_id uuid;
  v_entity_code text;
begin
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'A deactivation reason is required.';
  end if;

  select ura.*, rd.code as role_code into v_assignment
  from public.user_role_assignments ura
  join public.role_definitions rd on rd.id = ura.role_definition_id
  where ura.id = p_assignment_id
  for update of ura;

  if v_assignment is null then
    raise exception 'Assignment not found.';
  end if;
  if v_assignment.revoked_at is not null then
    raise exception 'Assignment is already revoked.';
  end if;
  if v_assignment.role_code = any(array[
    'airasia_management', 'ghod', 'global_reporting_controller', 'super_admin',
    'maa_boss', 'aax_boss', 'maa_admin', 'aax_admin',
    'operation_manager', 'main_enforcement', 'compliance', 'caterlink_management'
  ]) then
    raise exception 'Protected role % cannot be deactivated through entity-admin authority.', v_assignment.role_code;
  end if;
  if v_assignment.profile_id = v_admin_id then
    raise exception 'Cannot deactivate your own assignment.';
  end if;

  select p.operating_entity_id into v_target_entity_id from public.profiles p where p.id = v_assignment.profile_id;
  select oe.code into v_entity_code from public.operating_entities oe where oe.id = v_target_entity_id;
  if v_entity_code is null or not public.is_entity_admin(v_entity_code) then
    raise exception 'Not an authorized, approved entity Admin for this user''s entity.';
  end if;

  update public.user_role_assignments set revoked_at = now() where id = p_assignment_id;

  -- The account itself is never force-deactivated here -- only this one
  -- assignment is revoked. profiles.status is left untouched: if the
  -- person holds another valid, unrevoked assignment (or a legacy
  -- compatibility grant), that access is completely unaffected, per the
  -- explicit "account remains usable if another valid approved
  -- assignment exists" requirement.
  insert into public.user_admin_audit_log (actor_id, target_profile_id, action, previous_state, new_state, reason, assignment_id)
  values (
    v_admin_id, v_assignment.profile_id, 'deactivation',
    jsonb_build_object('revoked_at', null), jsonb_build_object('revoked_at', now()),
    p_reason, p_assignment_id
  );
end;
$function$;

revoke execute on function public.deactivate_assignment(uuid, text) from public, anon;
grant execute on function public.deactivate_assignment(uuid, text) to authenticated, service_role;

-- =======================================================================
-- PART J: transfer_assignment_same_entity()
-- =======================================================================
-- Team/station/hub/role-within-permitted-roles transfer, all within the
-- SAME entity -- ends the old assignment and creates a new one (never
-- overwrites assignment history in place), per the "prefer ending/
-- revoking the old assignment and creating a new assignment rather than
-- overwriting assignment history" instruction. Historical reports,
-- attendance, approvals and transactions already reference the OLD
-- assignment's scope by their own stored values at the time they were
-- created (this migration adds no retroactive rewrite of any existing
-- report/attendance/transaction table), so they remain correct as-is.
create or replace function public.transfer_assignment_same_entity(
  p_old_assignment_id uuid,
  p_new_role_code text,
  p_new_department_id uuid,
  p_new_unit_id uuid,
  p_new_hub_id uuid,
  p_new_station_id uuid,
  p_new_team_id uuid,
  p_reason text
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_old record;
  v_admin_id uuid := auth.uid();
  v_target_entity_id uuid;
  v_entity_code text;
  v_new_assignment_id uuid;
begin
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'A transfer reason is required.';
  end if;
  if p_new_role_code = any(array[
    'airasia_management', 'ghod', 'global_reporting_controller', 'super_admin',
    'maa_boss', 'aax_boss', 'maa_admin', 'aax_admin',
    'operation_manager', 'main_enforcement', 'compliance', 'caterlink_management'
  ]) then
    raise exception 'Protected role % cannot be granted through entity-admin transfer.', p_new_role_code;
  end if;

  select ura.*, rd.code as role_code into v_old
  from public.user_role_assignments ura
  join public.role_definitions rd on rd.id = ura.role_definition_id
  where ura.id = p_old_assignment_id
  for update of ura;

  if v_old is null then
    raise exception 'Assignment not found.';
  end if;
  if v_old.revoked_at is not null then
    raise exception 'Assignment is already revoked and cannot be transferred.';
  end if;
  if v_old.profile_id = v_admin_id then
    raise exception 'Cannot transfer your own assignment.';
  end if;

  select p.operating_entity_id into v_target_entity_id from public.profiles p where p.id = v_old.profile_id;
  select oe.code into v_entity_code from public.operating_entities oe where oe.id = v_target_entity_id;
  if v_entity_code is null or not public.is_entity_admin(v_entity_code) then
    raise exception 'Not an authorized, approved entity Admin for this user''s entity.';
  end if;

  update public.user_role_assignments set revoked_at = now() where id = p_old_assignment_id;

  insert into public.user_role_assignments (
    profile_id, role_definition_id, aoc_id, operating_entity_id, department_id,
    unit_id, hub_id, station_id, team_id, granted_by, grant_reason
  )
  select
    v_old.profile_id, rd.id, v_old.aoc_id, v_old.operating_entity_id, p_new_department_id,
    p_new_unit_id, p_new_hub_id, p_new_station_id, p_new_team_id, v_admin_id,
    'Transferred from assignment ' || p_old_assignment_id::text || ': ' || p_reason
  from public.role_definitions rd
  where rd.code = p_new_role_code
  returning id into v_new_assignment_id;

  insert into public.user_admin_audit_log (actor_id, target_profile_id, action, previous_state, new_state, reason, assignment_id)
  values (
    v_admin_id, v_old.profile_id, 'transfer_initiated',
    jsonb_build_object('assignment_id', p_old_assignment_id, 'role_code', v_old.role_code),
    jsonb_build_object('assignment_id', v_new_assignment_id, 'role_code', p_new_role_code),
    p_reason, v_new_assignment_id
  );

  return v_new_assignment_id;
end;
$function$;

revoke execute on function public.transfer_assignment_same_entity(uuid, text, uuid, uuid, uuid, uuid, uuid, text) from public, anon;
grant execute on function public.transfer_assignment_same_entity(uuid, text, uuid, uuid, uuid, uuid, uuid, text) to authenticated, service_role;

-- =======================================================================
-- PART K: MAA <-> AAX cross-entity transfer (two-step)
-- =======================================================================
-- Step 1 (originating entity Admin): revokes the current assignment and
-- opens a new registration request addressed to the RECEIVING entity's
-- queue (surfaced to that entity's Admin via
-- list_pending_registration_requests(), same as an ordinary applicant
-- request). Step 2 (receiving entity Admin): calls the ordinary
-- approve_registration_request() on that request -- there is
-- deliberately no separate "accept" function duplicating that logic;
-- this keeps exactly one approval code path in the whole migration.
-- During the gap between step 1 and step 2, the person holds no active
-- assignment for that role -- a real, intentional handover window
-- (a transferring person's OTHER, unrelated assignments, if any, are
-- completely unaffected, since only the one named assignment is
-- touched). profiles.operating_entity_id is only updated at step 2
-- (inside approve_registration_request()), matching "one entity
-- approval must not automatically approve the other."
create or replace function public.initiate_cross_entity_transfer(
  p_assignment_id uuid,
  p_to_entity_code text,
  p_reason text
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_old record;
  v_admin_id uuid := auth.uid();
  v_from_entity_id uuid;
  v_from_entity_code text;
  v_to_entity_id uuid;
  v_to_aoc_id uuid;
  v_request_id uuid;
begin
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'A transfer reason is required.';
  end if;
  if p_to_entity_code not in ('MAA', 'AAX') then
    raise exception 'Unknown target operating entity %.', p_to_entity_code;
  end if;

  select ura.*, rd.code as role_code into v_old
  from public.user_role_assignments ura
  join public.role_definitions rd on rd.id = ura.role_definition_id
  where ura.id = p_assignment_id
  for update of ura;

  if v_old is null then
    raise exception 'Assignment not found.';
  end if;
  if v_old.revoked_at is not null then
    raise exception 'Assignment is already revoked and cannot be transferred.';
  end if;
  if v_old.role_code = any(array[
    'airasia_management', 'ghod', 'global_reporting_controller', 'super_admin',
    'maa_boss', 'aax_boss', 'maa_admin', 'aax_admin',
    'operation_manager', 'main_enforcement', 'compliance', 'caterlink_management'
  ]) then
    raise exception 'Protected role % cannot be transferred through entity-admin authority.', v_old.role_code;
  end if;
  if v_old.profile_id = v_admin_id then
    raise exception 'Cannot transfer your own assignment.';
  end if;

  select p.operating_entity_id into v_from_entity_id from public.profiles p where p.id = v_old.profile_id;
  select oe.code into v_from_entity_code from public.operating_entities oe where oe.id = v_from_entity_id;
  if v_from_entity_code is null or not public.is_entity_admin(v_from_entity_code) then
    raise exception 'Not an authorized, approved entity Admin for this user''s current entity.';
  end if;
  if v_from_entity_code = p_to_entity_code then
    raise exception 'Target entity must differ from the current entity for a cross-entity transfer.';
  end if;

  select id, aoc_id into v_to_entity_id, v_to_aoc_id from public.operating_entities where code = p_to_entity_code;

  update public.user_role_assignments set revoked_at = now() where id = p_assignment_id;

  insert into public.user_registration_requests (
    profile_id, requested_aoc_id, requested_operating_entity_id, requested_department_id,
    requested_unit_id, requested_hub_id, requested_station_id, requested_team_id,
    requested_role_code, applicant_notes
  ) values (
    v_old.profile_id, v_to_aoc_id, v_to_entity_id, v_old.department_id,
    v_old.unit_id, v_old.hub_id, v_old.station_id, v_old.team_id,
    v_old.role_code, 'Cross-entity transfer from ' || v_from_entity_code || ' to ' || p_to_entity_code || ': ' || p_reason
  )
  returning id into v_request_id;

  insert into public.user_admin_audit_log (actor_id, target_profile_id, action, previous_state, new_state, reason, request_id, assignment_id)
  values (
    v_admin_id, v_old.profile_id, 'transfer_initiated',
    jsonb_build_object('entity', v_from_entity_code, 'assignment_id', p_assignment_id),
    jsonb_build_object('entity', p_to_entity_code, 'request_id', v_request_id),
    p_reason, v_request_id, p_assignment_id
  );

  return v_request_id;
end;
$function$;

revoke execute on function public.initiate_cross_entity_transfer(uuid, text, text) from public, anon;
grant execute on function public.initiate_cross_entity_transfer(uuid, text, text) to authenticated, service_role;

-- =======================================================================
-- PART L: export_entity_user_directory()
-- =======================================================================
-- Returns ONLY the calling entity Admin's own entity's approved,
-- unrevoked ordinary-role assignments, with no auth secrets, tokens,
-- internal security metadata, the other entity's users, anonymous-
-- discussion identity data, or any personal field beyond name/staff
-- number/contact fields already exposed elsewhere in the app. Every
-- call is audited.
create or replace function public.export_entity_user_directory(p_entity_code text)
returns table (
  profile_id uuid,
  name text,
  staff_no text,
  role_code text,
  department_code text,
  unit_code text,
  hub_code text,
  station_code text,
  team_name text,
  assignment_starts_at timestamptz
)
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if not public.is_entity_admin(p_entity_code) then
    raise exception 'Not an authorized, approved entity Admin for %.', p_entity_code;
  end if;

  insert into public.user_admin_audit_log (actor_id, action, new_state)
  values (auth.uid(), 'export', jsonb_build_object('entity', p_entity_code));

  return query
  select
    p.id, p.name, p.staff_no, rd.code, d.code, u.code, h.code, s.code, t.name, ura.starts_at
  from public.user_role_assignments ura
  join public.role_definitions rd on rd.id = ura.role_definition_id
  join public.profiles p on p.id = ura.profile_id
  join public.operating_entities oe on oe.id = p.operating_entity_id
  left join public.departments d on d.id = ura.department_id
  left join public.units u on u.id = ura.unit_id
  left join public.hubs h on h.id = ura.hub_id
  left join public.org_stations s on s.id = ura.station_id
  left join public.org_teams t on t.id = ura.team_id
  where oe.code = p_entity_code
    and ura.revoked_at is null
    and p.status = 'approved'
    and rd.code not in (
      'airasia_management', 'ghod', 'global_reporting_controller', 'super_admin',
      'maa_boss', 'aax_boss', 'maa_admin', 'aax_admin',
      'operation_manager', 'main_enforcement', 'compliance', 'caterlink_management'
    );
end;
$function$;

revoke execute on function public.export_entity_user_directory(text) from public, anon;
grant execute on function public.export_entity_user_directory(text) to authenticated, service_role;

-- =======================================================================
-- PART M: RLS / grants summary
-- =======================================================================
alter table public.user_registration_requests enable row level security;
alter table public.user_admin_audit_log enable row level security;

revoke all on public.user_registration_requests from public, anon;
grant select, insert, update on public.user_registration_requests to authenticated;
grant all on public.user_registration_requests to service_role;

create policy "registration_requests: self select" on public.user_registration_requests
for select using (profile_id = auth.uid());

create policy "registration_requests: self insert" on public.user_registration_requests
for insert with check (profile_id = auth.uid());

create policy "registration_requests: self update while pending" on public.user_registration_requests
for update using (profile_id = auth.uid()) with check (profile_id = auth.uid());

-- Deliberately NO select/update/delete policy for entity Admins on this
-- table -- they read pending requests exclusively through
-- list_pending_registration_requests() and act exclusively through the
-- approve/reject/transfer/deactivate RPCs above, all of which are
-- SECURITY DEFINER and validate authority internally. This mirrors
-- Phase 3's user_role_assignments design (no direct table access, only
-- narrow RPCs) rather than introducing a second access pattern.

revoke all on public.user_admin_audit_log from public, anon, authenticated;
grant all on public.user_admin_audit_log to service_role;

revoke execute on function public.set_updated_at_user_registration_requests() from public, anon, authenticated;
grant execute on function public.set_updated_at_user_registration_requests() to service_role;
revoke execute on function public.enforce_registration_request_self_write() from public, anon, authenticated;
grant execute on function public.enforce_registration_request_self_write() to service_role;

-- =======================================================================
-- DOCUMENTED ROLLBACK (not executed by this file -- reference only, run
-- manually and only against a target where this migration was actually
-- applied). Dependency-safe order: triggers/functions before tables;
-- user_admin_audit_log and user_registration_requests before
-- user_role_assignments only if this migration also added a real FK
-- from user_role_assignments back into these new tables (it does NOT --
-- the reference direction is one-way, request/audit -> assignment), so
-- user_role_assignments (Phase 3) never needs to change for this
-- rollback. Only Phase 4's own two new tables and their functions are
-- touched here.
--
-- 1. Drop triggers and their functions:
--      drop trigger if exists trg_enforce_registration_request_self_write on public.user_registration_requests;
--      drop trigger if exists trg_user_registration_requests_updated_at on public.user_registration_requests;
--      drop function if exists public.enforce_registration_request_self_write();
--      drop function if exists public.set_updated_at_user_registration_requests();
--
-- 2. Drop the RPC functions (all reference user_registration_requests
--    and/or user_admin_audit_log, so must go before those tables):
--      drop function if exists public.export_entity_user_directory(text);
--      drop function if exists public.initiate_cross_entity_transfer(uuid, text, text);
--      drop function if exists public.transfer_assignment_same_entity(uuid, text, uuid, uuid, uuid, uuid, uuid, text);
--      drop function if exists public.deactivate_assignment(uuid, text);
--      drop function if exists public.reject_registration_request(uuid, text);
--      drop function if exists public.approve_registration_request(uuid, text, uuid, uuid, uuid, uuid, uuid, uuid, uuid, text);
--      drop function if exists public.list_pending_registration_requests();
--      drop function if exists public.get_my_registration_request();
--      drop function if exists public.submit_registration_request(uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, text);
--      drop function if exists public.apply_compatibility_profile_fields(uuid, text, uuid, uuid, uuid, text, uuid);
--      drop function if exists public.is_entity_admin(text);
--
-- 3. Drop the two new tables (user_registration_requests references
--    user_role_assignments via final_assignment_id and
--    user_admin_audit_log references user_registration_requests via
--    request_id -- drop the audit log first):
--      drop table if exists public.user_admin_audit_log;
--      drop table if exists public.user_registration_requests;
--
-- This rolls back cleanly independent of Phase 2/3, and rolling back
-- Phase 3 while Phase 4 is still applied would fail on
-- user_registration_requests' FKs into role_definitions/aocs/
-- operating_entities/etc -- Phase 4 must always be rolled back before
-- Phase 3 if both are ever reverted, exactly mirroring the Phase 2/3
-- ordering rule already established.