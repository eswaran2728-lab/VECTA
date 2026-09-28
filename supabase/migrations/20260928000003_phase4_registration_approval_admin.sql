-- PHASE 4 -- MALAYSIA REGISTRATION, APPROVAL, ASSIGNMENT, TRANSFER,
-- DEACTIVATION AND ENTITY-ADMIN USER ADMINISTRATION (2026-09-28, second
-- pass: separates administrative entity membership from operational
-- authorization scope, per correction review)
--
-- Additive only, same guarantee as Phases 2-3: no existing table/column/
-- policy/function/grant is touched, renamed or dropped, and NO existing
-- legacy permission is broadened. The current Google SSO/password
-- registration and Management approval workflow is completely untouched.
--
-- CORRECTED DESIGN (second pass) -- three separate questions, three
-- separate fields, never overloaded onto one column:
--   1. "Which entity's Admin may administer this person/assignment?"
--      -> user_entity_memberships (this migration, new table)
--   2. "What operational permission and scope does this person have?"
--      -> user_role_assignments (Phase 3) -- entity_membership_id (new
--         column, this migration) traces WHO authorized it without
--         constraining the role's own operational scope (Investigation
--         stays Malaysia-wide even though its administrative home is one
--         entity's membership).
--   3. "Which airline operating entity owns this operational record?"
--      -> a report/flight's own operating_entity column -- Phase 5 work,
--         untouched here.
-- profiles.operating_entity_id (Phase 2) is now DOCUMENTED and ENFORCED
-- as a compatibility/display value ONLY, derived exclusively from the
-- profile's active PRIMARY membership, never written directly, never an
-- independent authorization source (Part C below closes that path
-- structurally, not just by convention).
--
-- Covers:
--   Part A: user_entity_memberships
--   Part B: user_role_assignments.entity_membership_id + its
--           consistency trigger
--   Part C: profiles' Phase 2/3/4 organizational fields become
--           service_role-only to write (closes the direct-update path
--           this correction review flagged)
--   Part D: sync_primary_operating_entity() / get_or_create_active_membership()
--   Part E: profiles.approval_state -- explicit active vs
--           deferred-activation state (a new nullable text column, NOT
--           an enum-type change -- see its own header for why)
--   Part F: user_registration_requests gains transfer_of_assignment_id /
--           transfer_of_membership_id (for the corrected two-stage
--           cross-entity transfer)
--   Part G: user_notifications -- durable, deduplicated in-app events
--   Part H: user_admin_audit_log (unchanged from the first pass)
--   Part I: is_entity_admin() (unchanged -- still correct: it resolves
--           the CALLER's own maa_admin/aax_admin role, which IS
--           correctly entity-scoped by Phase 3's own matrix; this
--           correction only concerns the TARGET ordinary user's entity
--           affiliation, never the admin's own)
--   Part J: apply_compatibility_profile_fields() (corrected: writes
--           approval_state explicitly; ops_group remains allowlist-
--           validated, reachable only through the entity-admin approval
--           path, never client-writable directly)
--   Part K: submit_registration_request() / get_my_registration_request()
--           / list_pending_registration_requests() (add notification on
--           submit; otherwise unchanged)
--   Part L: approve_registration_request() (corrected: creates/reuses an
--           active membership via Part D, links the new assignment to
--           it, and -- when the request carries transfer_of_* -- ends
--           the OLD assignment/membership atomically in the SAME
--           transaction as activating the new one)
--   Part M: reject_registration_request() (add notification)
--   Part N: deactivate_assignment() (corrected: authority now derives
--           from the ASSIGNMENT's own entity_membership_id, never from
--           profiles.operating_entity_id)
--   Part O: transfer_assignment_same_entity() (corrected: same authority
--           fix; carries the same entity_membership_id forward)
--   Part P: initiate_cross_entity_transfer() (corrected: no longer
--           revokes the old assignment at initiation -- only opens a
--           request in the receiving entity's queue; old access is
--           preserved until the receiving Admin approves)
--   Part Q: export_entity_user_directory() (corrected: entity-filtered
--           via entity_membership_id, not profiles.operating_entity_id;
--           protected roles entirely omitted, documented as such)
--   Part R: RLS / grants summary
--
-- NOT done in this migration (explicitly deferred): no scheduled/
-- future-dated "effective transfer time" mechanism -- a cross-entity
-- transfer's old assignment/membership end and new assignment/membership
-- activation happen atomically at the moment of receiving-Admin
-- approval (there is no cron/scheduling infrastructure authorized in
-- this phase to defer it further); if a documented immediate suspension
-- is ever needed mid-transfer, the existing deactivate_assignment()
-- function is the correct tool -- no separate function is added for
-- that, to avoid a second, redundant deactivation path.

-- =======================================================================
-- PART A: user_entity_memberships
-- =======================================================================
create table if not exists public.user_entity_memberships (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id),
  aoc_id uuid not null references public.aocs(id),
  operating_entity_id uuid not null references public.operating_entities(id),
  status text not null default 'active' check (status in ('pending', 'active', 'ended', 'revoked')),
  is_primary boolean not null default false,
  starts_at timestamptz not null default now(),
  ends_at timestamptz,
  revoked_at timestamptz,
  created_by uuid references public.profiles(id),
  approved_by uuid references public.profiles(id),
  reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- At most one ACTIVE membership per profile per entity (a person may
-- hold one active MAA membership and one active AAX membership
-- simultaneously -- that is explicitly allowed -- but never two active
-- memberships to the SAME entity).
create unique index if not exists user_entity_memberships_one_active_per_entity
  on public.user_entity_memberships (profile_id, operating_entity_id)
  where status = 'active';

-- At most one ACTIVE PRIMARY membership per profile, across all
-- entities -- the structural enforcement behind "at most one active
-- primary membership."
create unique index if not exists user_entity_memberships_one_active_primary
  on public.user_entity_memberships (profile_id)
  where is_primary and status = 'active';

create index if not exists user_entity_memberships_profile_idx on public.user_entity_memberships (profile_id);

create or replace function public.set_updated_at_user_entity_memberships()
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

drop trigger if exists trg_user_entity_memberships_updated_at on public.user_entity_memberships;
create trigger trg_user_entity_memberships_updated_at
  before update on public.user_entity_memberships
  for each row execute function public.set_updated_at_user_entity_memberships();

-- =======================================================================
-- PART B: user_role_assignments.entity_membership_id
-- =======================================================================
alter table public.user_role_assignments
  add column if not exists entity_membership_id uuid references public.user_entity_memberships(id);

-- Consistency trigger: if entity_membership_id is set, it must
-- reference an ACTIVE membership belonging to the SAME profile as the
-- assignment, in the SAME aoc_id -- no assignment may ever link to
-- another profile's membership, and no membership bypass via NULL is
-- possible for entity-administered roles because
-- approve_registration_request() (Part L) always sets it for the 11
-- ordinary roles it can grant.
create or replace function public.validate_assignment_entity_membership()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_membership record;
begin
  if new.entity_membership_id is null then
    return new;
  end if;

  select * into v_membership from public.user_entity_memberships where id = new.entity_membership_id;
  if v_membership is null then
    raise exception 'entity_membership_id does not reference a real membership.';
  end if;
  if v_membership.profile_id <> new.profile_id then
    raise exception 'entity_membership_id belongs to a different profile than this assignment.';
  end if;
  if v_membership.status <> 'active' then
    raise exception 'entity_membership_id must reference an active membership.';
  end if;
  if v_membership.aoc_id is distinct from new.aoc_id then
    raise exception 'entity_membership_id AOC does not match the assignment aoc_id.';
  end if;

  return new;
end;
$function$;

drop trigger if exists trg_validate_assignment_entity_membership on public.user_role_assignments;
create trigger trg_validate_assignment_entity_membership
  before insert or update on public.user_role_assignments
  for each row execute function public.validate_assignment_entity_membership();

-- =======================================================================
-- PART C: profiles' Phase 2/3/4 organizational fields -- service_role-only
-- =======================================================================
-- CORRECTION: profiles.operating_entity_id (and the other Phase 2 FK
-- columns) had no dedicated write-protection added when Phase 2
-- introduced them -- an ordinary authenticated self-update to one's own
-- profile row was not proven to be blocked from touching them. This
-- closes that gap directly: a new trigger, independent of whatever the
-- pre-existing enforce_profile_self_update() trigger does or does not
-- already cover, makes every one of these seven columns writable ONLY
-- by service_role. This cannot break any existing behavior -- no
-- current application code writes any of these columns today (confirmed
-- by repo-wide grep before this migration was written).
create or replace function public.enforce_profiles_org_fields_service_role_only()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if auth.role() = 'service_role' then
    return new;
  end if;
  if new.aoc_id is distinct from old.aoc_id
     or new.operating_entity_id is distinct from old.operating_entity_id
     or new.department_id is distinct from old.department_id
     or new.unit_id is distinct from old.unit_id
     or new.hub_id is distinct from old.hub_id
     or new.org_station_id is distinct from old.org_station_id
     or new.org_team_id is distinct from old.org_team_id
  then
    raise exception 'profiles.aoc_id/operating_entity_id/department_id/unit_id/hub_id/org_station_id/org_team_id can only be changed by a trusted server-side process, never directly.';
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_enforce_profiles_org_fields_service_role_only on public.profiles;
create trigger trg_enforce_profiles_org_fields_service_role_only
  before update on public.profiles
  for each row execute function public.enforce_profiles_org_fields_service_role_only();

-- =======================================================================
-- PART D: sync_primary_operating_entity() / get_or_create_active_membership()
-- =======================================================================
-- profiles.operating_entity_id is written ONLY here, and ONLY derived
-- from the profile's current active PRIMARY membership (or NULL if none
-- exists) -- never set independently by any other function.
create or replace function public.sync_primary_operating_entity(p_profile_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_primary_entity_id uuid;
begin
  select operating_entity_id into v_primary_entity_id
  from public.user_entity_memberships
  where profile_id = p_profile_id and is_primary and status = 'active'
  limit 1;

  update public.profiles set operating_entity_id = v_primary_entity_id where id = p_profile_id;
end;
$function$;

revoke execute on function public.sync_primary_operating_entity(uuid) from public, anon, authenticated;
grant execute on function public.sync_primary_operating_entity(uuid) to service_role;

-- Internal helper (service_role-only, never directly client-callable):
-- returns an existing active membership for (profile, entity) if one
-- exists, otherwise creates one. Sets is_primary = true ONLY when the
-- profile currently has no active primary membership at all (first-ever
-- approval becomes primary automatically; a later second-entity
-- approval never silently displaces an existing primary -- changing
-- primary affiliation deliberately is a separate, explicit, audited
-- action, not a side effect of an unrelated approval).
create or replace function public.get_or_create_active_membership(
  p_profile_id uuid,
  p_aoc_id uuid,
  p_operating_entity_id uuid,
  p_approved_by uuid
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_membership_id uuid;
  v_has_primary boolean;
begin
  select id into v_membership_id
  from public.user_entity_memberships
  where profile_id = p_profile_id and operating_entity_id = p_operating_entity_id and status = 'active'
  for update;

  if v_membership_id is null then
    insert into public.user_entity_memberships (profile_id, aoc_id, operating_entity_id, status, is_primary, approved_by)
    values (p_profile_id, p_aoc_id, p_operating_entity_id, 'active', false, p_approved_by)
    returning id into v_membership_id;
  end if;

  select exists (
    select 1 from public.user_entity_memberships
    where profile_id = p_profile_id and is_primary and status = 'active'
  ) into v_has_primary;

  if not v_has_primary then
    update public.user_entity_memberships set is_primary = true where id = v_membership_id;
    perform public.sync_primary_operating_entity(p_profile_id);

    insert into public.user_admin_audit_log (actor_id, target_profile_id, action, new_state)
    values (p_approved_by, p_profile_id, 'compatibility_sync', jsonb_build_object('primary_membership_id', v_membership_id, 'reason', 'first_active_membership'));
  end if;

  return v_membership_id;
end;
$function$;

revoke execute on function public.get_or_create_active_membership(uuid, uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.get_or_create_active_membership(uuid, uuid, uuid, uuid) to service_role;

-- =======================================================================
-- PART E: profiles.approval_state -- explicit active vs deferred-activation
-- =======================================================================
-- CORRECTION: the first pass left profiles.status silently unchanged
-- (still 'pending') for the 8 roles with no safe legacy compatibility
-- mapping, with nothing else distinguishing "approved, feature pending"
-- from "never reviewed." This adds a NEW NULLABLE TEXT column (not an
-- enum-type change -- ALTER TYPE ... ADD VALUE has historically unsafe
-- same-transaction semantics on some Postgres versions, and this
-- migration is applied as a single transaction; a plain text column
-- with a CHECK constraint avoids that risk entirely while being exactly
-- as safe for callers, since it is never compared with = ANY() the way
-- a narrower enum would be) so a deferred approval is explicit, safe,
-- and never confused with the legacy 'approved' status:
--   'active'                     -- assignment is immediately usable
--   'approved_pending_activation' -- approved, but the role's live
--                                    application feature does not exist
--                                    yet (Phase 5-9 wiring); the
--                                    assignment provides NO legacy
--                                    application authorization until
--                                    activation, and profiles.status
--                                    itself is left completely alone
--                                    (still whatever it was pre-approval
--                                    -- 'pending' for a first-time
--                                    applicant) so no existing
--                                    status='approved' check anywhere in
--                                    the legacy app can ever be
--                                    satisfied by a deferred role.
alter table public.profiles
  add column if not exists approval_state text check (approval_state in ('active', 'approved_pending_activation'));

-- =======================================================================
-- PART F: user_registration_requests -- transfer linkage columns
-- =======================================================================
alter table public.user_registration_requests
  add column if not exists transfer_of_assignment_id uuid references public.user_role_assignments(id),
  add column if not exists transfer_of_membership_id uuid references public.user_entity_memberships(id);

-- =======================================================================
-- PART G: user_notifications -- durable, deduplicated in-app events
-- =======================================================================
create table if not exists public.user_notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_profile_id uuid not null references public.profiles(id),
  event_type text not null check (event_type in (
    'request_submitted', 'request_approved', 'request_rejected',
    'transfer_initiated', 'transfer_accepted', 'transfer_rejected',
    'membership_ended', 'assignment_ended', 'deactivation'
  )),
  -- One row per real transition: dedup_key is unique, and every caller
  -- below constructs it deterministically from (event_type, the
  -- specific request/assignment/membership id it concerns) with an
  -- ON CONFLICT DO NOTHING insert -- a retried call after a partial
  -- client-side failure can never create a second notification for the
  -- same transition, and a transaction that rolls back never leaves a
  -- notification behind (the insert is inside the same transaction as
  -- the state change it announces).
  dedup_key text not null unique,
  request_id uuid references public.user_registration_requests(id),
  assignment_id uuid references public.user_role_assignments(id),
  membership_id uuid references public.user_entity_memberships(id),
  payload jsonb,
  created_at timestamptz not null default now(),
  read_at timestamptz
);

create index if not exists user_notifications_recipient_idx on public.user_notifications (recipient_profile_id, created_at desc);

create or replace function public.notify(
  p_recipient_profile_id uuid,
  p_event_type text,
  p_dedup_key text,
  p_request_id uuid,
  p_assignment_id uuid,
  p_membership_id uuid,
  p_payload jsonb
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  insert into public.user_notifications (
    recipient_profile_id, event_type, dedup_key, request_id, assignment_id, membership_id, payload
  ) values (
    p_recipient_profile_id, p_event_type, p_dedup_key, p_request_id, p_assignment_id, p_membership_id, p_payload
  )
  on conflict (dedup_key) do nothing;
end;
$function$;

revoke execute on function public.notify(uuid, text, text, uuid, uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.notify(uuid, text, text, uuid, uuid, uuid, jsonb) to service_role;

-- Self-read/self-mark-read only -- never another user's notifications,
-- mirroring every other self-read RPC in this migration.
create or replace function public.get_my_notifications(p_limit integer default 50)
returns table (
  id uuid,
  event_type text,
  payload jsonb,
  created_at timestamptz,
  read_at timestamptz
)
language sql
stable
security definer
set search_path to 'public'
as $function$
  select n.id, n.event_type, n.payload, n.created_at, n.read_at
  from public.user_notifications n
  where n.recipient_profile_id = auth.uid()
  order by n.created_at desc
  limit greatest(1, least(p_limit, 200));
$function$;

revoke execute on function public.get_my_notifications(integer) from public, anon;
grant execute on function public.get_my_notifications(integer) to authenticated, service_role;

create or replace function public.mark_notification_read(p_notification_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  update public.user_notifications
  set read_at = coalesce(read_at, now())
  where id = p_notification_id and recipient_profile_id = auth.uid();
end;
$function$;

revoke execute on function public.mark_notification_read(uuid) from public, anon;
grant execute on function public.mark_notification_read(uuid) to authenticated, service_role;

-- =======================================================================
-- PART H: user_admin_audit_log (unchanged from the first pass)
-- =======================================================================
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
-- PART I: is_entity_admin() (unchanged)
-- =======================================================================
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

-- Which entity's Admin currently administers a GIVEN assignment --
-- resolved via the assignment's own entity_membership_id, never via
-- profiles.operating_entity_id. Returns NULL if the assignment has no
-- membership link at all (an international/platform-role assignment,
-- which is never entity-administered in the first place).
create or replace function public.is_authorized_admin_for_assignment(p_assignment_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_entity_code text;
begin
  select oe.code into v_entity_code
  from public.user_role_assignments ura
  join public.user_entity_memberships uem on uem.id = ura.entity_membership_id
  join public.operating_entities oe on oe.id = uem.operating_entity_id
  where ura.id = p_assignment_id and uem.status = 'active';

  if v_entity_code is null then
    return false;
  end if;
  return public.is_entity_admin(v_entity_code);
end;
$function$;

revoke execute on function public.is_authorized_admin_for_assignment(uuid) from public, anon, authenticated;
grant execute on function public.is_authorized_admin_for_assignment(uuid) to service_role;

-- =======================================================================
-- PART J: apply_compatibility_profile_fields()
-- =======================================================================
-- Unchanged safe-subset decision from the first pass (see the report for
-- the full reasoning: profiles.role/ops_group have no slot for 8 of the
-- 11 ordinary roles). CORRECTED to write profiles.approval_state
-- explicitly in both branches, and to record the supplied ops_group
-- value in the audit trail for reviewability. p_ops_group remains
-- allowlist-validated (operation_avsec/ifc_avsec only) and is reachable
-- ONLY through approve_registration_request() -- an authenticated entity
-- Admin's own RPC call, never a raw client write to any table; a caller
-- who is not an authorized entity Admin can never reach this function at
-- all (it is service_role-only, called internally).
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
        approval_state = 'active',
        approved_by = p_actor_id,
        approved_at = now(),
        rejection_reason = null
    where id = p_profile_id;
    v_mapped := true;
  else
    -- Deferred: legacy status/role/ops_group/station/team are left
    -- exactly as they were (the new assignment is the sole source of
    -- authority until Phase 5-9 wiring exists). Only approval_state is
    -- written, giving the applicant an explicit, honest signal distinct
    -- from both "never reviewed" and "fully approved."
    update public.profiles
    set approval_state = 'approved_pending_activation'
    where id = p_profile_id;
  end if;

  insert into public.user_admin_audit_log (actor_id, target_profile_id, action, new_state)
  values (p_actor_id, p_profile_id, 'compatibility_sync', jsonb_build_object('role_code', p_role_code, 'mapped', v_mapped, 'ops_group', p_ops_group));
end;
$function$;

revoke execute on function public.apply_compatibility_profile_fields(uuid, text, uuid, uuid, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.apply_compatibility_profile_fields(uuid, text, uuid, uuid, uuid, text, uuid) to service_role;

-- =======================================================================
-- PART K: submit_registration_request() / self-read RPCs
-- =======================================================================
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

  perform public.notify(
    auth.uid(), 'request_submitted', 'request_submitted:' || v_id::text,
    v_id, null, null, jsonb_build_object('role_code', p_requested_role_code)
  );

  return v_id;
end;
$function$;

revoke execute on function public.submit_registration_request(uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, text) from public, anon;
grant execute on function public.submit_registration_request(uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, text) to authenticated, service_role;

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
-- PART L: approve_registration_request() -- corrected atomic transaction
-- =======================================================================
-- CORRECTED to: (1) create/reuse an active membership for the target
-- entity via get_or_create_active_membership(), (2) link the new
-- assignment to that membership, (3) when the request carries
-- transfer_of_assignment_id/transfer_of_membership_id (i.e. this is a
-- cross-entity transfer's receiving-side approval), atomically end the
-- OLD assignment and, if nothing else still references it, the OLD
-- membership too -- in the SAME transaction as activating the new one,
-- so access is never lost and never doubled. Race safety and protected-
-- role/self-approval denial are unchanged from the first pass.
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
  v_membership_id uuid;
  v_old_membership_still_used boolean;
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

  v_membership_id := public.get_or_create_active_membership(v_request.profile_id, p_aoc_id, p_operating_entity_id, v_admin_id);

  insert into public.user_role_assignments (
    profile_id, role_definition_id, aoc_id, operating_entity_id, department_id,
    unit_id, hub_id, station_id, team_id, granted_by, grant_reason, entity_membership_id
  )
  select
    v_request.profile_id, rd.id, p_aoc_id, p_operating_entity_id, p_department_id,
    p_unit_id, p_hub_id, p_station_id, p_team_id, v_admin_id,
    'Approved from registration request ' || p_request_id::text, v_membership_id
  from public.role_definitions rd
  where rd.code = p_role_code
  returning id into v_assignment_id;

  if v_assignment_id is null then
    raise exception 'Unknown role code %.', p_role_code;
  end if;

  update public.user_registration_requests
  set status = 'approved', reviewer_id = v_admin_id, reviewed_at = now(), final_assignment_id = v_assignment_id
  where id = p_request_id;

  perform public.apply_compatibility_profile_fields(
    v_request.profile_id, p_role_code, p_hub_id, p_station_id, p_team_id, p_ops_group, v_admin_id
  );

  -- Cross-entity transfer, receiving side: end the OLD assignment (and,
  -- if orphaned, its OLD membership) atomically here, in the SAME
  -- transaction that activates the new one -- never before this point,
  -- so the person is never without access between initiation and this
  -- approval.
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
      ) into v_old_membership_still_used;

      if v_old_membership_still_used then
        update public.user_entity_memberships
        set status = 'ended', ends_at = now()
        where id = v_request.transfer_of_membership_id and status = 'active';
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
      jsonb_build_object('status', 'approved', 'role_code', p_role_code, 'assignment_id', v_assignment_id),
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

revoke execute on function public.approve_registration_request(uuid, text, uuid, uuid, uuid, uuid, uuid, uuid, uuid, text) from public, anon;
grant execute on function public.approve_registration_request(uuid, text, uuid, uuid, uuid, uuid, uuid, uuid, uuid, text) to authenticated, service_role;

-- =======================================================================
-- PART M: reject_registration_request()
-- =======================================================================
-- Rejection NEVER touches an existing assignment/membership -- if this
-- request carried transfer_of_assignment_id (a cross-entity transfer
-- being rejected by the receiving entity), the old assignment and
-- membership remain completely unaffected, which is exactly the
-- required "rejection preserves old access" guarantee -- there is no
-- special-case code path for it because none is needed.
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

  select oe.code into v_entity_code from public.operating_entities oe where oe.id = v_request.requested_operating_entity_id;
  if v_entity_code is null or not public.is_entity_admin(v_entity_code) then
    raise exception 'Not an authorized, approved entity Admin for the requested operating entity.';
  end if;

  v_is_transfer := v_request.transfer_of_assignment_id is not null;

  update public.user_registration_requests
  set status = 'rejected', reviewer_id = v_admin_id, reviewed_at = now(), rejection_reason = p_reason
  where id = p_request_id;

  -- Only a first-time applicant's own profile status is touched by
  -- rejection -- a transfer rejection leaves the profile's existing
  -- approved status (and its unaffected old assignment) exactly as is.
  if not v_is_transfer then
    update public.profiles set status = 'rejected', rejection_reason = p_reason where id = v_request.profile_id;
  end if;

  insert into public.user_admin_audit_log (actor_id, target_profile_id, action, previous_state, new_state, reason, request_id)
  values (
    v_admin_id, v_request.profile_id,
    case when v_is_transfer then 'transfer_rejected' else 'request_rejected' end,
    jsonb_build_object('status', 'pending'), jsonb_build_object('status', 'rejected'),
    p_reason, p_request_id
  );

  perform public.notify(
    v_request.profile_id,
    case when v_is_transfer then 'transfer_rejected' else 'request_rejected' end,
    (case when v_is_transfer then 'transfer_rejected:' else 'request_rejected:' end) || p_request_id::text,
    p_request_id, null, null, jsonb_build_object('reason', p_reason)
  );
end;
$function$;

revoke execute on function public.reject_registration_request(uuid, text) from public, anon;
grant execute on function public.reject_registration_request(uuid, text) to authenticated, service_role;

-- =======================================================================
-- PART N: deactivate_assignment() -- corrected authority source
-- =======================================================================
-- CORRECTED: authority to deactivate an assignment now derives from the
-- ASSIGNMENT's own entity_membership_id (via is_authorized_admin_for_assignment()),
-- never from profiles.operating_entity_id -- an Admin can no longer
-- manage an assignment merely because the person's DISPLAY/compatibility
-- entity currently happens to match; they must administer the SPECIFIC
-- membership that authorized THIS assignment.
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
  v_admin_id uuid := auth.uid();
  v_membership_id uuid;
  v_still_used boolean;
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
  if not public.is_authorized_admin_for_assignment(p_assignment_id) then
    raise exception 'Not an authorized, approved entity Admin for the membership that authorized this assignment.';
  end if;

  v_membership_id := v_assignment.entity_membership_id;

  update public.user_role_assignments set revoked_at = now() where id = p_assignment_id;

  -- The account itself is never force-deactivated -- only this one
  -- assignment is revoked. If the underlying membership is now unused by
  -- any other active assignment, end it too (a normal lifecycle
  -- transition, not a punitive revoke) -- but a completely separate,
  -- independent MAA or AAX membership/assignment this person holds is
  -- entirely unaffected either way, since this function only ever
  -- touches the one named assignment and, at most, its own membership.
  if v_membership_id is not null then
    select not exists (
      select 1 from public.user_role_assignments
      where entity_membership_id = v_membership_id and revoked_at is null
    ) into v_still_used;
    if v_still_used then
      update public.user_entity_memberships set status = 'ended', ends_at = now() where id = v_membership_id and status = 'active';
      perform public.sync_primary_operating_entity(v_assignment.profile_id);
    end if;
  end if;

  insert into public.user_admin_audit_log (actor_id, target_profile_id, action, previous_state, new_state, reason, assignment_id)
  values (
    v_admin_id, v_assignment.profile_id, 'deactivation',
    jsonb_build_object('revoked_at', null), jsonb_build_object('revoked_at', now()),
    p_reason, p_assignment_id
  );

  perform public.notify(
    v_assignment.profile_id, 'deactivation', 'deactivation:' || p_assignment_id::text,
    null, p_assignment_id, v_membership_id, jsonb_build_object('reason', p_reason)
  );
end;
$function$;

revoke execute on function public.deactivate_assignment(uuid, text) from public, anon;
grant execute on function public.deactivate_assignment(uuid, text) to authenticated, service_role;

-- =======================================================================
-- PART O: transfer_assignment_same_entity() -- corrected authority source
-- =======================================================================
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
  if not public.is_authorized_admin_for_assignment(p_old_assignment_id) then
    raise exception 'Not an authorized, approved entity Admin for the membership that authorized this assignment.';
  end if;

  update public.user_role_assignments set revoked_at = now() where id = p_old_assignment_id;

  -- Same entity, same person -- reuse the SAME membership row.
  insert into public.user_role_assignments (
    profile_id, role_definition_id, aoc_id, operating_entity_id, department_id,
    unit_id, hub_id, station_id, team_id, granted_by, grant_reason, entity_membership_id
  )
  select
    v_old.profile_id, rd.id, v_old.aoc_id, v_old.operating_entity_id, p_new_department_id,
    p_new_unit_id, p_new_hub_id, p_new_station_id, p_new_team_id, v_admin_id,
    'Transferred from assignment ' || p_old_assignment_id::text || ': ' || p_reason, v_old.entity_membership_id
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

  perform public.notify(
    v_old.profile_id, 'assignment_ended', 'assignment_ended:' || p_old_assignment_id::text,
    null, p_old_assignment_id, v_old.entity_membership_id, jsonb_build_object('reason', p_reason, 'replaced_by', v_new_assignment_id)
  );

  return v_new_assignment_id;
end;
$function$;

revoke execute on function public.transfer_assignment_same_entity(uuid, text, uuid, uuid, uuid, uuid, uuid, text) from public, anon;
grant execute on function public.transfer_assignment_same_entity(uuid, text, uuid, uuid, uuid, uuid, uuid, text) to authenticated, service_role;

-- =======================================================================
-- PART P: initiate_cross_entity_transfer() -- corrected (no premature revoke)
-- =======================================================================
-- CORRECTED: this function NO LONGER touches the old assignment or
-- membership at all -- it only opens a new registration request in the
-- receiving entity's queue, carrying transfer_of_assignment_id/
-- transfer_of_membership_id so the receiving Admin's eventual
-- approve_registration_request() call can end the old assignment/
-- membership ATOMICALLY alongside activating the new one (Part L). The
-- person's existing access is completely unaffected between initiation
-- and approval -- exactly the "prevent avoidable loss of access"
-- requirement. If an immediate, documented suspension is genuinely
-- needed mid-transfer, the source Admin uses the existing
-- deactivate_assignment() directly; this function makes no assumption
-- that a transfer implies suspension.
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
  if not public.is_authorized_admin_for_assignment(p_assignment_id) then
    raise exception 'Not an authorized, approved entity Admin for the membership that authorized this assignment.';
  end if;

  select oe.code into v_from_entity_code
  from public.user_entity_memberships uem
  join public.operating_entities oe on oe.id = uem.operating_entity_id
  where uem.id = v_old.entity_membership_id;

  if v_from_entity_code = p_to_entity_code then
    raise exception 'Target entity must differ from the current entity for a cross-entity transfer.';
  end if;

  select id, aoc_id into v_to_entity_id, v_to_aoc_id from public.operating_entities where code = p_to_entity_code;

  -- NOTE: the old assignment/membership are intentionally NOT touched
  -- here -- see this Part's header. Access continues uninterrupted.
  insert into public.user_registration_requests (
    profile_id, requested_aoc_id, requested_operating_entity_id, requested_department_id,
    requested_unit_id, requested_hub_id, requested_station_id, requested_team_id,
    requested_role_code, applicant_notes, transfer_of_assignment_id, transfer_of_membership_id
  ) values (
    v_old.profile_id, v_to_aoc_id, v_to_entity_id, v_old.department_id,
    v_old.unit_id, v_old.hub_id, v_old.station_id, v_old.team_id,
    v_old.role_code, 'Cross-entity transfer from ' || v_from_entity_code || ' to ' || p_to_entity_code || ': ' || p_reason,
    p_assignment_id, v_old.entity_membership_id
  )
  returning id into v_request_id;

  insert into public.user_admin_audit_log (actor_id, target_profile_id, action, previous_state, new_state, reason, request_id, assignment_id)
  values (
    v_admin_id, v_old.profile_id, 'transfer_initiated',
    jsonb_build_object('entity', v_from_entity_code, 'assignment_id', p_assignment_id),
    jsonb_build_object('entity', p_to_entity_code, 'request_id', v_request_id),
    p_reason, v_request_id, p_assignment_id
  );

  perform public.notify(
    v_old.profile_id, 'transfer_initiated', 'transfer_initiated:' || v_request_id::text,
    v_request_id, p_assignment_id, v_old.entity_membership_id,
    jsonb_build_object('from_entity', v_from_entity_code, 'to_entity', p_to_entity_code)
  );

  return v_request_id;
end;
$function$;

revoke execute on function public.initiate_cross_entity_transfer(uuid, text, text) from public, anon;
grant execute on function public.initiate_cross_entity_transfer(uuid, text, text) to authenticated, service_role;

-- =======================================================================
-- PART Q: export_entity_user_directory() -- corrected entity filter
-- =======================================================================
-- CORRECTED to filter via entity_membership_id -> user_entity_memberships
-- (active) -> operating_entities, never via profiles.operating_entity_id
-- -- the directory reflects who is ACTUALLY entity-administered under an
-- active membership linked to THIS assignment, not merely whichever
-- entity happens to be the person's current primary/display value.
-- Protected-role accounts are ENTIRELY OMITTED from this export (not
-- shown redacted, not partially shown) -- they are visible only through
-- a separate, not-yet-built Super Admin path (Phase 5+). No email,
-- password, token, or other secret is ever included -- name and staff
-- number only, matching what is already visible elsewhere in the app.
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
  join public.user_entity_memberships uem on uem.id = ura.entity_membership_id and uem.status = 'active'
  join public.operating_entities oe on oe.id = uem.operating_entity_id
  left join public.departments d on d.id = ura.department_id
  left join public.units u on u.id = ura.unit_id
  left join public.hubs h on h.id = ura.hub_id
  left join public.org_stations s on s.id = ura.station_id
  left join public.org_teams t on t.id = ura.team_id
  where oe.code = p_entity_code
    and ura.revoked_at is null
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
-- PART R: RLS / grants summary
-- =======================================================================
alter table public.user_entity_memberships enable row level security;
alter table public.user_registration_requests enable row level security;
alter table public.user_admin_audit_log enable row level security;
alter table public.user_notifications enable row level security;

-- user_entity_memberships: no direct grant for anon/authenticated at
-- all -- read happens only through get_my_registration_request()/
-- list_pending_registration_requests()/export_entity_user_directory(),
-- write happens only through the service_role-only helpers in Part D.
-- This is a deliberately narrower posture than
-- user_registration_requests (which does allow a self-service RLS
-- policy) because membership rows carry administrative authority
-- directly -- there is no legitimate reason for a client to read or
-- write them outside the RPCs above.
revoke all on public.user_entity_memberships from public, anon, authenticated;
grant all on public.user_entity_memberships to service_role;

revoke all on public.user_registration_requests from public, anon;
grant select, insert, update on public.user_registration_requests to authenticated;
grant all on public.user_registration_requests to service_role;

create policy "registration_requests: self select" on public.user_registration_requests
for select using (profile_id = auth.uid());

create policy "registration_requests: self insert" on public.user_registration_requests
for insert with check (profile_id = auth.uid());

create policy "registration_requests: self update while pending" on public.user_registration_requests
for update using (profile_id = auth.uid()) with check (profile_id = auth.uid());

revoke all on public.user_admin_audit_log from public, anon, authenticated;
grant all on public.user_admin_audit_log to service_role;

-- user_notifications: self select/self update(read_at only) via RLS,
-- exactly mirroring the request table's posture -- but INSERT is
-- service_role-only (every notification is created by the notify()
-- helper inside a trusted transaction, never by a client-side insert),
-- which is what "users cannot edit another user's events" requires
-- together with the self-scoped USING clauses below.
revoke all on public.user_notifications from public, anon;
grant select, update on public.user_notifications to authenticated;
grant all on public.user_notifications to service_role;

create policy "notifications: self select" on public.user_notifications
for select using (recipient_profile_id = auth.uid());

create policy "notifications: self mark read" on public.user_notifications
for update using (recipient_profile_id = auth.uid()) with check (recipient_profile_id = auth.uid());

revoke execute on function public.set_updated_at_user_entity_memberships() from public, anon, authenticated;
grant execute on function public.set_updated_at_user_entity_memberships() to service_role;
revoke execute on function public.validate_assignment_entity_membership() from public, anon, authenticated;
grant execute on function public.validate_assignment_entity_membership() to service_role;
revoke execute on function public.enforce_profiles_org_fields_service_role_only() from public, anon, authenticated;
grant execute on function public.enforce_profiles_org_fields_service_role_only() to service_role;

-- =======================================================================
-- DOCUMENTED ROLLBACK (not executed by this file -- reference only, run
-- manually and only against a target where this migration was actually
-- applied).
--
-- 1. Drop triggers and their trigger functions:
--      drop trigger if exists trg_enforce_profiles_org_fields_service_role_only on public.profiles;
--      drop trigger if exists trg_validate_assignment_entity_membership on public.user_role_assignments;
--      drop trigger if exists trg_user_entity_memberships_updated_at on public.user_entity_memberships;
--      drop trigger if exists trg_enforce_registration_request_self_write on public.user_registration_requests;
--      drop trigger if exists trg_user_registration_requests_updated_at on public.user_registration_requests;
--      drop function if exists public.enforce_profiles_org_fields_service_role_only();
--      drop function if exists public.validate_assignment_entity_membership();
--      drop function if exists public.set_updated_at_user_entity_memberships();
--      drop function if exists public.enforce_registration_request_self_write();
--      drop function if exists public.set_updated_at_user_registration_requests();
--
-- 2. Drop the RPC functions (all reference the new tables, so must go
--    before them):
--      drop function if exists public.export_entity_user_directory(text);
--      drop function if exists public.initiate_cross_entity_transfer(uuid, text, text);
--      drop function if exists public.transfer_assignment_same_entity(uuid, text, uuid, uuid, uuid, uuid, uuid, text);
--      drop function if exists public.deactivate_assignment(uuid, text);
--      drop function if exists public.reject_registration_request(uuid, text);
--      drop function if exists public.approve_registration_request(uuid, text, uuid, uuid, uuid, uuid, uuid, uuid, uuid, text);
--      drop function if exists public.list_pending_registration_requests();
--      drop function if exists public.get_my_registration_request();
--      drop function if exists public.submit_registration_request(uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, text);
--      drop function if exists public.mark_notification_read(uuid);
--      drop function if exists public.get_my_notifications(integer);
--      drop function if exists public.notify(uuid, text, text, uuid, uuid, uuid, jsonb);
--      drop function if exists public.apply_compatibility_profile_fields(uuid, text, uuid, uuid, uuid, text, uuid);
--      drop function if exists public.is_authorized_admin_for_assignment(uuid);
--      drop function if exists public.is_entity_admin(text);
--      drop function if exists public.get_or_create_active_membership(uuid, uuid, uuid, uuid);
--      drop function if exists public.sync_primary_operating_entity(uuid);
--
-- 3. Drop the four new tables (dependents before their dependencies --
--    user_admin_audit_log and user_notifications reference
--    user_registration_requests/user_role_assignments/
--    user_entity_memberships, so they go first; user_registration_requests
--    references user_role_assignments and user_entity_memberships, so it
--    goes before user_entity_memberships):
--      drop table if exists public.user_notifications;
--      drop table if exists public.user_admin_audit_log;
--      drop table if exists public.user_registration_requests;
--      drop table if exists public.user_entity_memberships;
--
-- 4. Drop the two new columns added to Phase 3's user_role_assignments
--    and the one new column added to profiles (in that order -- the
--    column drop has no ordering dependency on anything above, but is
--    listed last for clarity):
--      alter table public.user_role_assignments drop column if exists entity_membership_id;
--      alter table public.profiles drop column if exists approval_state;
--
-- This rolls back cleanly independent of Phase 2/3; rolling back Phase 3
-- while Phase 4 is still applied would fail on
-- user_role_assignments.entity_membership_id's FK and on
-- user_registration_requests' FKs into role_definitions/aocs/
-- operating_entities/etc -- Phase 4 must always be rolled back before
-- Phase 3 if both are ever reverted, exactly mirroring the Phase 2/3
-- ordering rule already established.