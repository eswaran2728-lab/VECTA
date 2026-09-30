-- ===========================================================================
-- PHASE 8 -- OPERATIONAL WORKFORCE AND ENFORCEMENT WORKFLOWS (2026-09-30)
-- Malaysia AOC upgrade. Additive only, same guarantee as Phases 2-7: no
-- existing table/column/policy/function/grant is touched, renamed or
-- dropped, and no existing legacy permission is broadened. Every new
-- authorization path added here is IN ADDITION TO the existing legacy
-- rank/role paths (DSE endorse, MANAGEMENT approve, ADMIN roster write,
-- etc.), which remain exactly as they were -- this migration never maps a
-- new Phase 3 role back onto MANAGEMENT/ADMIN/ENFORCEMENT, and never
-- removes a legacy account's existing access.
--
-- Covers:
--   Part A: shared helpers (department/scope resolution from free-text
--           station/team columns, generic audit log, generic in-app
--           notifications)
--   Part B: leave-request routing (Part D of the spec) -- concurrency-safe
--           "first 3 / 4th+ escalates to Operation Manager" rule via a
--           real transaction-scoped advisory lock, replacing the
--           check-then-act race in lib/avsec/duty/absence-actions.ts's
--           reviewLeaveApplication() with a DB-enforced equivalent
--   Part C: overtime approval routing (Part E) -- additive branches on
--           enforce_overtime_transition() for Hub SE endorsement and for
--           department-correct final approval (operation_manager only for
--           Operation-department submitters, main_enforcement only for
--           Enforcement-department submitters) -- the existing DSE-endorse
--           / rank>=MANAGEMENT-approve path is untouched
--   Part D: roster ownership (Parts B/C) -- a new secure RPC for DSE
--           (own team only)/Hub SE (own hub only)/Operation Manager
--           (Malaysia-wide Operation) roster writes, additive to the
--           existing ADMIN/MANAGEMENT write policies on team_rosters
--   Part E: duty-zone draw (Part F) -- new tables + RPCs, Operation
--           Manager owns configure/initiate/finalize/history; everyone
--           else gets read-only access to their own scope's published
--           result
--   Part F: Investigation case workflow (Part G) -- new tables + RPCs;
--           every report link goes through has_report_access(), never a
--           direct table read
--   Part G: SAT combined-PDF workflow (Part H) -- new table + RPCs; one
--           active combined PDF per SAT team per operational day,
--           audited replacement path, private storage path only
--   Part H: Staff Profiling SEC013 acknowledgement (Part I) -- a new
--           secure RPC for Profiling SO to acknowledge a Profiling ASO's
--           SEC013 report, scoped by Phase 3 station+team
--
-- NOT done in this migration (explicitly out of scope for Phase 8, per
-- the approved scope document):
--   - CaterLink station-access policy (Phase 9)
--   - Anonymous discussion board (Phase 10)
--   - Global/AOC announcement authoring (Phase 11)
--   - WOIS AI 2.0 (Phase 12)
--   - Legacy removal / final production rollout (Phase 13)
--   - No production user is migrated or assigned any new role
--   - No existing RLS policy, requireRole() call, ROLE_RANK constant, or
--     legacy helper (current_role_name, current_role_rank, role_rank,
--     submitter_role_rank, current_station, current_team, current_status)
--     is modified or replaced
-- ===========================================================================

-- =======================================================================
-- PART A: SHARED HELPERS
-- =======================================================================

-- Resolves a legacy free-text station code (as stored on absence_notices/
-- overtime_requests/team_rosters/report_sec013) to its Phase 2
-- org_stations id and hub_id. Returns NULL station_id/hub_id if the
-- station code has no Phase 2 row yet (e.g. legacy/unclassified stations
-- not yet reconciled) -- callers must treat that as "cannot resolve scope
-- for this record", never as "grant access anyway".
create or replace function public.resolve_legacy_station(p_station_code text)
returns table (station_id uuid, hub_id uuid)
language sql
stable
security definer
set search_path to 'public'
as $function$
  select s.id, s.hub_id from public.org_stations s where s.code = p_station_code;
$function$;

revoke execute on function public.resolve_legacy_station(text) from public, anon;
grant execute on function public.resolve_legacy_station(text) to authenticated, service_role;

-- Resolves a legacy free-text team name, scoped to a station, to its
-- Phase 2 org_teams id. Returns NULL if no matching row exists.
create or replace function public.resolve_legacy_team(p_station_id uuid, p_team_name text)
returns uuid
language sql
stable
security definer
set search_path to 'public'
as $function$
  select t.id from public.org_teams t where t.station_id = p_station_id and t.name = p_team_name;
$function$;

revoke execute on function public.resolve_legacy_team(uuid, text) from public, anon;
grant execute on function public.resolve_legacy_team(uuid, text) to authenticated, service_role;

-- Resolves a profile's own active Phase 3 assignment's department code
-- ('operation' or 'enforcement', etc.) -- used to route OT/leave final
-- approval to the department-correct authority. NULL if the profile holds
-- no active department-scoped assignment (fails closed: callers must not
-- treat NULL as either department).
create or replace function public.submitter_department_code(p_profile_id uuid)
returns text
language sql
stable
security definer
set search_path to 'public'
as $function$
  select d.code
  from public.user_role_assignments ura
  join public.role_definitions rd on rd.id = ura.role_definition_id
  join public.departments d on d.id = ura.department_id
  where ura.profile_id = p_profile_id
    and rd.is_active
    and ura.revoked_at is null
    and ura.starts_at <= now()
    and (ura.ends_at is null or ura.ends_at > now())
    and ura.department_id is not null
  limit 1;
$function$;

revoke execute on function public.submitter_department_code(uuid) from public, anon;
grant execute on function public.submitter_department_code(uuid) to authenticated, service_role;

-- Generic, append-only audit log for every Phase 8 privileged transition
-- (leave/OT decisions, roster writes, duty-draw actions, investigation
-- case actions, SAT PDF uploads/replacements, Profiling acknowledgement).
-- No UPDATE/DELETE policy exists for anyone except service_role -- rows
-- are immutable once written, mirroring central_reports_index's own
-- immutability pattern.
create table if not exists public.phase8_audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references public.profiles(id),
  action text not null,
  entity_type text not null,
  entity_id uuid,
  -- Snapshot of every active Phase 3 role assignment the actor held AT
  -- THE MOMENT of this transition -- captured automatically inside
  -- phase8_write_audit() below, not by each individual call site, so
  -- "which role/scope authorized this" can never be omitted by a caller
  -- that forgets to pass it. A revoked-after-the-fact assignment does
  -- not retroactively change what this row says was true at the time.
  actor_role_snapshot jsonb not null default '[]'::jsonb,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists phase8_audit_log_entity_idx on public.phase8_audit_log (entity_type, entity_id);
create index if not exists phase8_audit_log_actor_idx on public.phase8_audit_log (actor_id);

alter table public.phase8_audit_log enable row level security;
revoke all on public.phase8_audit_log from public, anon, authenticated;
grant select, insert on public.phase8_audit_log to service_role;

-- Callers never insert into phase8_audit_log directly (no authenticated
-- grant above) -- every Phase 8 RPC below writes its own audit row
-- internally, as the same SECURITY DEFINER transaction that performs the
-- privileged action, so an audit row can never be skipped by a client
-- that simply doesn't bother calling a separate "log this" endpoint.
create or replace function public.phase8_write_audit(
  p_action text, p_entity_type text, p_entity_id uuid, p_detail jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_role_snapshot jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
    'role_code', rd.code,
    'aoc_id', ura.aoc_id,
    'department_id', ura.department_id,
    'unit_id', ura.unit_id,
    'hub_id', ura.hub_id,
    'station_id', ura.station_id,
    'team_id', ura.team_id
  )), '[]'::jsonb)
  into v_role_snapshot
  from public.user_role_assignments ura
  join public.role_definitions rd on rd.id = ura.role_definition_id
  where ura.profile_id = auth.uid()
    and ura.revoked_at is null
    and ura.starts_at <= now()
    and (ura.ends_at is null or ura.ends_at > now());

  insert into public.phase8_audit_log (actor_id, action, entity_type, entity_id, actor_role_snapshot, detail)
  values (auth.uid(), p_action, p_entity_type, p_entity_id, v_role_snapshot, coalesce(p_detail, '{}'::jsonb));
end;
$function$;

revoke execute on function public.phase8_write_audit(text, text, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.phase8_write_audit(text, text, uuid, jsonb) to service_role;

-- Notifications: Round 2, Slice 7 replaces the first Phase 8 pass's own
-- separate phase8_notifications table with the ALREADY-ESTABLISHED
-- Phase 4 public.user_notifications system (public.notify(), dedup_key-
-- unique retry-safety, recipient-only select/mark-read RLS, no client
-- INSERT grant). Since this migration has never been applied anywhere,
-- correcting it here is a plain edit, not a production migration -- there
-- is no phase8_notifications table or data to migrate away from. A
-- second, disconnected notification inbox was never justified: Phase 8
-- events are ordinary durable in-app notifications with no requirement
-- Phase 4's system doesn't already meet.
alter table public.user_notifications drop constraint if exists user_notifications_event_type_check;
alter table public.user_notifications add constraint user_notifications_event_type_check
  check (event_type in (
    'request_submitted', 'request_approved', 'request_rejected',
    'transfer_initiated', 'transfer_accepted', 'transfer_rejected',
    'membership_ended', 'assignment_ended', 'deactivation',
    'leave_status_changed', 'ot_status_changed', 'investigation_case_assigned'
  ));

-- Certification finding (multi-AOC pass): has_active_role(p_role_code) is
-- has_role_in_scope(p_role_code) with EVERY scope parameter, including
-- aoc_id, left null -- meaning it performs NO AOC filtering whatsoever.
-- Every Phase 8 RPC below is Malaysia-only by design (each one resolves
-- its own v_aoc_id via `select id from aocs where code = 'MY'` for the
-- DATA it operates on), but dozens of authorization checks throughout
-- this file called the AOC-blind has_active_role() directly -- meaning
-- a role assignment scoped to any OTHER AOC (e.g. a future 'ZZ' AOC's
-- own operation_manager) would still satisfy the gate and be able to
-- act on Malaysia's data. Confirmed empirically by
-- supabase/tests/integration/verify_phase8_multi_aoc.mjs before this
-- fix (a synthetic ZZ-AOC Operation Manager successfully approved a
-- real MY staff member's leave request). This helper is the fix: every
-- has_active_role(...) call in this file is replaced with
-- has_active_role_my(...), which additionally requires the caller's
-- assignment to belong to the Malaysia AOC specifically (or have a null
-- aoc_id, matching has_role_in_scope's own existing null-means-
-- unscoped semantics for any future genuinely international role).
create or replace function public.has_active_role_my(p_role_code text)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select public.has_role_in_scope(p_role_code, (select id from public.aocs where code = 'MY'));
$function$;

revoke execute on function public.has_active_role_my(text) from public, anon;
grant execute on function public.has_active_role_my(text) to authenticated, service_role;

-- =======================================================================
-- PART B: LEAVE-REQUEST ROUTING (concurrency-safe)
-- =======================================================================
-- Replaces the check-then-act race in lib/avsec/duty/absence-actions.ts's
-- reviewLeaveApplication() (SELECT overlapping approved count, THEN
-- UPDATE -- two round trips, no lock between them) with a single
-- SECURITY DEFINER transaction that takes a transaction-scoped advisory
-- lock keyed by (station, team, leave_type) BEFORE counting, so two
-- concurrent approval attempts for the same team/leave-type serialize
-- instead of both reading the same pre-approval count and both
-- succeeding past the cap. The OLD app-layer function is NOT modified or
-- removed -- existing legacy MANAGEMENT/ENFORCEMENT/ADMIN reviewers keep
-- using it exactly as before. This new RPC is the Phase 3-scoped,
-- correctly-routed replacement path for DSE/Hub SE/Operation Manager.
create or replace function public.review_leave_request_secure(
  p_notice_id uuid,
  p_action text, -- 'approve' | 'reject'
  p_review_notes text default null
)
returns table (row_id uuid, result_status text)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_notice record;
  v_station_id uuid;
  v_hub_id uuid;
  v_team_id uuid;
  v_aoc_id uuid;
  v_is_dse boolean := false;
  v_is_hub_se boolean := false;
  v_is_operation_manager boolean := false;
  v_is_main_enforcement boolean := false;
  v_submitter_dept text;
  v_overlap_count integer;
  v_new_status text;
begin
  if auth.uid() is null then
    raise exception 'Must be signed in.';
  end if;
  if not exists (select 1 from public.profiles where id = auth.uid() and status = 'approved') then
    raise exception 'Only an approved account may review leave requests.';
  end if;
  if p_action not in ('approve', 'reject') then
    raise exception 'Invalid action: must be approve or reject.';
  end if;

  -- Lock the target row itself first (blocks a second reviewer from
  -- deciding the SAME request twice concurrently).
  select * into v_notice from public.absence_notices where absence_notices.id = p_notice_id for update;
  if v_notice is null then
    raise exception 'Leave application record not found.';
  end if;
  if v_notice.approval_status not in ('pending') then
    raise exception 'This leave application is not awaiting a first-stage decision (current status: %).', v_notice.approval_status;
  end if;

  select station_id, hub_id into v_station_id, v_hub_id from public.resolve_legacy_station(v_notice.station);
  if v_station_id is not null then
    v_team_id := public.resolve_legacy_team(v_station_id, v_notice.team);
  end if;
  select id into v_aoc_id from public.aocs where code = 'MY';
  v_submitter_dept := public.submitter_department_code(v_notice.user_id);

  -- Enforcement dept (Investigation / SAT / Profiling) has no DSE/Hub SE
  -- equivalent -- Main Enforcement is the sole and final leave authority
  -- for its own department's staff, per Phase 8 Round 2 Slice 1. This
  -- branch is evaluated BEFORE the Operation-side scope resolution below
  -- and is mutually exclusive with it: an Enforcement submitter's request
  -- can never be decided by an Operation Manager/Hub SE/DSE, and an
  -- Operation submitter's request can never be decided by Main
  -- Enforcement (department separation, checked explicitly).
  if v_submitter_dept = 'enforcement' then
    v_is_main_enforcement := public.has_active_role_my('main_enforcement');
    if not v_is_main_enforcement then
      raise exception 'No active Phase 3 role assignment grants authority to review this Enforcement leave request. Only Main Enforcement may decide Enforcement-department leave.';
    end if;

    if p_action = 'reject' then
      v_new_status := 'rejected';
    else
      perform pg_advisory_xact_lock(hashtext(coalesce(v_notice.station, '') || '|' || coalesce(v_notice.team, '') || '|' || v_notice.leave_type || '|enforcement'));
      v_new_status := 'approved';
    end if;

    update public.absence_notices
    set approval_status = v_new_status,
        reviewed_by = auth.uid(),
        reviewed_at = now(),
        review_notes = nullif(trim(coalesce(p_review_notes, '')), '')
    where absence_notices.id = p_notice_id;

    perform public.phase8_write_audit(
      'leave_' || v_new_status, 'absence_notice', p_notice_id,
      jsonb_build_object('leave_type', v_notice.leave_type, 'station', v_notice.station, 'team', v_notice.team, 'reviewer_route', 'main_enforcement', 'department', 'enforcement')
    );
    perform public.notify(
      v_notice.user_id, 'leave_status_changed',
      'phase8_leave_' || p_notice_id || '_' || v_new_status,
      null, null, null,
      jsonb_build_object('notice_id', p_notice_id, 'status', v_new_status)
    );

    return query select p_notice_id, v_new_status;
    return;
  end if;

  v_is_operation_manager := public.has_active_role_my('operation_manager');
  if v_hub_id is not null then
    v_is_hub_se := public.has_role_in_scope('hub_se', v_aoc_id, null, null, null, v_hub_id);
  end if;
  if v_station_id is not null and v_team_id is not null then
    v_is_dse := public.has_role_in_scope('dse', v_aoc_id, null, null, null, v_hub_id, v_station_id, v_team_id);
  end if;

  if not (v_is_dse or v_is_hub_se or v_is_operation_manager) then
    raise exception 'No active Phase 3 role assignment grants authority to review this leave request.';
  end if;

  if p_action = 'reject' then
    v_new_status := 'rejected';
  else
    -- Serialize concurrent approval decisions for this exact
    -- station+team+leave_type: two requests approved in the same instant
    -- for different people cannot both read the same "count so far".
    perform pg_advisory_xact_lock(hashtext(coalesce(v_notice.station, '') || '|' || coalesce(v_notice.team, '') || '|' || v_notice.leave_type));

    if v_notice.leave_type = 'annual' then
      select count(distinct user_id) into v_overlap_count
      from public.absence_notices
      where leave_type = 'annual'
        and approval_status = 'approved'
        and start_date <= v_notice.end_date
        and end_date >= v_notice.start_date
        and user_id <> v_notice.user_id
        and coalesce(station, '') = coalesce(v_notice.station, '')
        and coalesce(team, '') = coalesce(v_notice.team, '');

      if v_overlap_count >= 3 and not v_is_operation_manager then
        raise exception 'Team Annual Leave capacity reached (% already approved for overlapping dates). This request must be escalated to the Operation Manager for final decision.', v_overlap_count;
      end if;
    end if;

    v_new_status := 'approved';
  end if;

  update public.absence_notices
  set approval_status = v_new_status,
      reviewed_by = auth.uid(),
      reviewed_at = now(),
      review_notes = nullif(trim(coalesce(p_review_notes, '')), '')
  where absence_notices.id = p_notice_id;

  perform public.phase8_write_audit(
    'leave_' || v_new_status, 'absence_notice', p_notice_id,
    jsonb_build_object('leave_type', v_notice.leave_type, 'station', v_notice.station, 'team', v_notice.team, 'reviewer_route',
      case when v_is_operation_manager then 'operation_manager' when v_is_hub_se then 'hub_se' else 'dse' end)
  );
  perform public.notify(
    v_notice.user_id, 'leave_status_changed',
    'phase8_leave_' || p_notice_id || '_' || v_new_status,
    null, null, null,
    jsonb_build_object('notice_id', p_notice_id, 'status', v_new_status)
  );

  return query select p_notice_id, v_new_status;
end;
$function$;

revoke execute on function public.review_leave_request_secure(uuid, text, text) from public, anon;
grant execute on function public.review_leave_request_secure(uuid, text, text) to authenticated, service_role;

-- Pending Operation-department leave requests visible to the CALLER's
-- own active scope (Phase 8 Round 2, Slice 6) -- mirrors review_leave_
-- request_secure()'s own scope resolution exactly (DSE: own KUL team
-- only; Hub SE: own hub; Operation Manager: Malaysia Operation-wide),
-- so a request never appears in this list unless the SAME caller could
-- also decide it via review_leave_request_secure(). Enforcement-
-- department leave is deliberately excluded here -- see
-- list_enforcement_pending_actions_secure() for that queue.
create or replace function public.list_pending_leave_for_reviewer_secure()
returns setof public.absence_notices
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_aoc_id uuid;
  v_is_operation_manager boolean;
  v_is_hub_se boolean;
  v_hub_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Must be signed in.';
  end if;
  select id into v_aoc_id from public.aocs where code = 'MY';

  v_is_operation_manager := public.has_active_role_my('operation_manager');
  if v_is_operation_manager then
    return query select * from public.absence_notices where approval_status in ('pending', 'pending_cancellation') order by submitted_at asc;
    return;
  end if;

  -- Hub SE: every station within their own hub.
  select ura.hub_id into v_hub_id
  from public.user_role_assignments ura
  join public.role_definitions rd on rd.id = ura.role_definition_id
  where ura.profile_id = auth.uid() and rd.code = 'hub_se'
    and ura.revoked_at is null and ura.starts_at <= now() and (ura.ends_at is null or ura.ends_at > now())
  limit 1;

  if v_hub_id is not null then
    v_is_hub_se := true;
    return query
    select an.*
    from public.absence_notices an
    where an.approval_status in ('pending', 'pending_cancellation')
      and exists (
        select 1 from public.resolve_legacy_station(an.station) rs where rs.hub_id = v_hub_id
      )
    order by an.submitted_at asc;
    return;
  end if;

  -- DSE (legacy compatibility path already handled by the existing
  -- station/team-scoped UI query -- this RPC only covers Phase 3
  -- hub_se/operation_manager; a caller with neither gets an empty set,
  -- never an error, so this can be called speculatively by any page).
  return;
end;
$function$;

revoke execute on function public.list_pending_leave_for_reviewer_secure() from public, anon;
grant execute on function public.list_pending_leave_for_reviewer_secure() to authenticated, service_role;

-- =======================================================================
-- PART C: OVERTIME APPROVAL ROUTING
-- =======================================================================
-- A companion SELECT policy: PostgreSQL RLS's UPDATE evaluation locates
-- candidate rows using the UPDATE policies' own USING clauses, but this
-- new Phase 3 role also needs to be able to SEE the request (list it,
-- confirm the endorsement took effect) -- the pre-existing SELECT
-- policies ("overtime own select"/"overtime monitor select") are both
-- legacy-rank-based and do not recognize hub_se/operation_manager/
-- main_enforcement at all. Without this, a caller who passes the UPDATE
-- policy still cannot read back the row it just changed.
create policy "overtime phase8 scoped select" on public.overtime_requests for select
  using (
    public.has_active_role_my('hub_se')
    or public.has_active_role_my('operation_manager')
    or public.has_active_role_my('main_enforcement')
  );

-- Multiple PERMISSIVE UPDATE policies on the same table have their USING
-- clauses OR'd and their WITH CHECK clauses OR'd INDEPENDENTLY -- exactly
-- the bug avsec/0026 already fixed once for this same table (see that
-- migration's own header). Adding a second broad "attempt" policy here,
-- in the SAME shape as the existing "overtime settle update" policy
-- (attempt-only, not transition-specific), reuses 0026's fix rather than
-- reintroducing its bug: the trigger below remains the SOLE authority on
-- which specific status transition is valid, regardless of which policy
-- admitted the UPDATE attempt.
create policy "overtime phase8 scoped update" on public.overtime_requests for update
  using (
    profile_id <> auth.uid()
    and (
      public.has_active_role_my('hub_se')
      or public.has_active_role_my('operation_manager')
      or public.has_active_role_my('main_enforcement')
    )
  )
  with check (
    profile_id <> auth.uid()
    and (
      public.has_active_role_my('hub_se')
      or public.has_active_role_my('operation_manager')
      or public.has_active_role_my('main_enforcement')
    )
  );

-- CREATE OR REPLACE of the existing trigger function (avsec/0026). Every
-- original condition is preserved verbatim, OR'd with new alternatives --
-- none removed, none narrowed. New alternatives:
--   - endorse: also allowed for an active Hub SE, scoped to the
--     submitting request's own hub (resolved from its legacy station
--     text via Phase 2's org_stations).
--   - approve: also allowed for Operation Manager, but ONLY when the
--     submitter's own active Phase 3 assignment resolves to the
--     Operation department; also allowed for Main Enforcement, but ONLY
--     when the submitter resolves to Enforcement. A submitter with no
--     resolvable Phase 3 department (the common case today -- production
--     has zero Phase 3 assignments) simply cannot use either new path --
--     the legacy rank>=MANAGEMENT path is unaffected and keeps working.
--     This is the concrete enforcement of "Operation Manager must not
--     approve SAT/Profiling OT" and "Main Enforcement must not approve
--     Operation-department OT" -- structurally, not by convention.
--   - reject: same two new alternatives, at either pending or endorsed
--     stage, matching the existing rank>=MANAGEMENT reject shape.
-- Also newly writes a phase8_audit_log row and a phase8_notification on
-- every transition -- neither existed before this migration.
create or replace function public.enforce_overtime_transition()
returns trigger as $$
declare
  actor_role user_role;
  v_station_id uuid;
  v_hub_id uuid;
  v_aoc_id uuid;
  v_submitter_dept text;
begin
  if new.status = old.status then
    return new;
  end if;

  actor_role := current_role_name();

  select station_id, hub_id into v_station_id, v_hub_id from public.resolve_legacy_station(old.station);
  select id into v_aoc_id from public.aocs where code = 'MY';
  v_submitter_dept := public.submitter_department_code(old.profile_id);

  if new.status = 'endorsed' then
    if not (
      (actor_role = 'DSE' and old.status = 'pending')
      or (old.status = 'pending' and v_hub_id is not null and public.has_role_in_scope('hub_se', v_aoc_id, null, null, null, v_hub_id))
    ) then
      raise exception 'Only DSE (own team) or Hub SE (own hub) can endorse a pending overtime request.';
    end if;
  elsif new.status = 'approved' then
    if not (
      (role_rank(actor_role) >= role_rank('MANAGEMENT') and old.status = 'endorsed')
      or (old.status = 'endorsed' and v_submitter_dept = 'operation' and public.has_active_role_my('operation_manager'))
      or (old.status = 'endorsed' and v_submitter_dept = 'enforcement' and public.has_active_role_my('main_enforcement'))
    ) then
      raise exception 'Only Management/Admin, or the department-correct Operation Manager/Main Enforcement, can approve, and only once endorsed.';
    end if;
  elsif new.status = 'rejected' then
    if not (
      (actor_role = 'DSE' and old.status = 'pending')
      or (role_rank(actor_role) >= role_rank('MANAGEMENT') and old.status in ('pending', 'endorsed'))
      or (old.status = 'pending' and v_hub_id is not null and public.has_role_in_scope('hub_se', v_aoc_id, null, null, null, v_hub_id))
      or (old.status in ('pending', 'endorsed') and v_submitter_dept = 'operation' and public.has_active_role_my('operation_manager'))
      or (old.status in ('pending', 'endorsed') and v_submitter_dept = 'enforcement' and public.has_active_role_my('main_enforcement'))
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
$$ language plpgsql security definer set search_path = public;

-- =======================================================================
-- PART D: ROSTER OWNERSHIP
-- =======================================================================
-- team_rosters' only existing write policies are "roster admin all"
-- (ADMIN) and "roster management manage" (MANAGEMENT, org-wide --
-- exactly the generic Management authority Phase 8 must replace with
-- scoped roles). There is currently NO write policy for DSE at all
-- (lib/avsec/duty/roster-actions.ts's own comment confirms: "there's no
-- DSE-facing roster UI in the app yet... not yet reachable from any
-- page"), so this is new authorization, not a broadening of an existing
-- one. Implemented as a SECURITY DEFINER RPC rather than new raw RLS
-- policies -- avoids stacking a third permissive UPDATE/ALL policy onto
-- a table that has already had one real multi-policy interaction bug
-- (see Part C's own comment on overtime_requests) and keeps the
-- station/team/hub scope check in one auditable place.
create or replace function public.upsert_roster_cell_secure(
  p_station text,
  p_team text,
  p_roster_date date,
  p_shift_code text,
  p_start_time time default null,
  p_end_time time default null,
  p_notes text default null
)
returns table (row_id uuid)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_station_id uuid;
  v_hub_id uuid;
  v_team_id uuid;
  v_aoc_id uuid;
  v_ops_group text;
  v_row_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Must be signed in.';
  end if;
  if not exists (select 1 from public.profiles where id = auth.uid() and status = 'approved') then
    raise exception 'Only an approved account may write rosters.';
  end if;
  if p_station is null or p_team is null or p_roster_date is null or p_shift_code is null then
    raise exception 'station, team, roster_date and shift_code are all required.';
  end if;

  select station_id, hub_id into v_station_id, v_hub_id from public.resolve_legacy_station(p_station);
  if v_station_id is not null then
    v_team_id := public.resolve_legacy_team(v_station_id, p_team);
  end if;
  select id into v_aoc_id from public.aocs where code = 'MY';

  if public.has_active_role_my('operation_manager') then
    v_ops_group := 'operation_avsec';
  elsif v_hub_id is not null and public.has_role_in_scope('hub_se', v_aoc_id, null, null, null, v_hub_id) then
    v_ops_group := 'operation_avsec';
  elsif v_station_id is not null and v_team_id is not null
        and public.has_role_in_scope('dse', v_aoc_id, null, null, null, v_hub_id, v_station_id, v_team_id) then
    v_ops_group := 'operation_avsec';
  else
    raise exception 'No active Phase 3 role assignment grants roster-write authority for %/%.', p_station, p_team;
  end if;

  insert into public.team_rosters (station, team, roster_date, shift_code, start_time, end_time, notes, set_by, ops_group)
  values (p_station, p_team, p_roster_date, p_shift_code, p_start_time, p_end_time, p_notes, auth.uid(), v_ops_group)
  on conflict (station, team, roster_date, ops_group)
  do update set shift_code = excluded.shift_code, start_time = excluded.start_time, end_time = excluded.end_time,
                notes = excluded.notes, set_by = excluded.set_by, updated_at = now()
  returning public.team_rosters.id into v_row_id;

  perform public.phase8_write_audit('roster_upsert', 'team_roster', v_row_id,
    jsonb_build_object('station', p_station, 'team', p_team, 'roster_date', p_roster_date, 'shift_code', p_shift_code));

  return query select v_row_id;
end;
$function$;

revoke execute on function public.upsert_roster_cell_secure(text, text, date, text, time, time, text) from public, anon;
grant execute on function public.upsert_roster_cell_secure(text, text, date, text, time, time, text) to authenticated, service_role;

-- =======================================================================
-- PART E: DUTY-ZONE DRAW
-- =======================================================================
-- New functionality -- no "duty-zone draw" (a roster/zone assignment
-- lottery, distinct from the existing GPS-geofence duty_zones table used
-- for check-in) exists anywhere in the pre-Phase-8 schema. RLS is
-- deny-all by default (no policy grants unauthenticated/anon/authenticated
-- access); every read/write goes through the RPCs below, which enforce
-- Operation Manager ownership and station-scoped read for everyone else.
create table if not exists public.duty_draws (
  id uuid primary key default gen_random_uuid(),
  aoc_id uuid not null references public.aocs(id),
  station_id uuid not null references public.org_stations(id),
  draw_date date not null,
  status text not null default 'draft' check (status in ('draft', 'finalized')),
  initiated_by uuid not null references public.profiles(id),
  finalized_by uuid references public.profiles(id),
  finalized_at timestamptz,
  created_at timestamptz not null default now(),
  unique (station_id, draw_date)
);

create table if not exists public.duty_draw_assignments (
  id uuid primary key default gen_random_uuid(),
  draw_id uuid not null references public.duty_draws(id) on delete cascade,
  profile_id uuid not null references public.profiles(id),
  zone_id uuid references public.duty_zones(id),
  assigned_at timestamptz not null default now(),
  unique (draw_id, profile_id)
);

alter table public.duty_draws enable row level security;
alter table public.duty_draw_assignments enable row level security;
revoke all on public.duty_draws from public, anon, authenticated;
revoke all on public.duty_draw_assignments from public, anon, authenticated;
grant all on public.duty_draws to service_role;
grant all on public.duty_draw_assignments to service_role;

-- Only Operation Manager may initiate a draw (Malaysia-wide Operation
-- authority, per Part A of the spec). A station code that doesn't resolve
-- to a Phase 2 org_stations row fails closed (cannot initiate a draw for
-- a station this schema doesn't recognize).
create or replace function public.initiate_duty_draw_secure(p_station text, p_draw_date date)
returns table (row_id uuid)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_station_id uuid;
  v_aoc_id uuid;
  v_draw_id uuid;
begin
  if not public.has_active_role_my('operation_manager') then
    raise exception 'Only Operation Manager may initiate a duty-zone draw.';
  end if;
  select id into v_station_id from public.org_stations where code = p_station;
  if v_station_id is null then
    raise exception 'Unknown station: %.', p_station;
  end if;
  select id into v_aoc_id from public.aocs where code = 'MY';

  insert into public.duty_draws (aoc_id, station_id, draw_date, initiated_by)
  values (v_aoc_id, v_station_id, p_draw_date, auth.uid())
  on conflict (station_id, draw_date) do nothing
  returning id into v_draw_id;

  if v_draw_id is null then
    raise exception 'A draw already exists for this station and date. Use the existing draw rather than re-initiating.';
  end if;

  perform public.phase8_write_audit('duty_draw_initiate', 'duty_draw', v_draw_id,
    jsonb_build_object('station', p_station, 'draw_date', p_draw_date));

  return query select v_draw_id;
end;
$function$;

revoke execute on function public.initiate_duty_draw_secure(text, date) from public, anon;
grant execute on function public.initiate_duty_draw_secure(text, date) to authenticated, service_role;

-- Records (or replaces, while the draw is still 'draft') one assignment.
-- Only Operation Manager, and only before finalization -- finalized draws
-- are immutable except via an explicit, audited reset (not implemented
-- in this pass -- see the Phase 8 report's Known Limitations).
create or replace function public.record_duty_draw_assignment_secure(p_draw_id uuid, p_profile_id uuid, p_zone_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_status text;
begin
  if not public.has_active_role_my('operation_manager') then
    raise exception 'Only Operation Manager may configure a duty-zone draw.';
  end if;
  select status into v_status from public.duty_draws where id = p_draw_id for update;
  if v_status is null then
    raise exception 'Draw not found.';
  end if;
  if v_status <> 'draft' then
    raise exception 'This draw is already finalized -- cannot change assignments without an authorized reset process.';
  end if;

  insert into public.duty_draw_assignments (draw_id, profile_id, zone_id)
  values (p_draw_id, p_profile_id, p_zone_id)
  on conflict (draw_id, profile_id) do update set zone_id = excluded.zone_id, assigned_at = now();

  perform public.phase8_write_audit('duty_draw_assign', 'duty_draw', p_draw_id,
    jsonb_build_object('profile_id', p_profile_id, 'zone_id', p_zone_id));
end;
$function$;

revoke execute on function public.record_duty_draw_assignment_secure(uuid, uuid, uuid) from public, anon;
grant execute on function public.record_duty_draw_assignment_secure(uuid, uuid, uuid) to authenticated, service_role;

-- Finalizes a draw -- irreversible in this pass (no reset RPC exists
-- yet). Explicitly blocks re-finalizing an already-finalized draw.
create or replace function public.finalize_duty_draw_secure(p_draw_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_status text;
begin
  if not public.has_active_role_my('operation_manager') then
    raise exception 'Only Operation Manager may finalize a duty-zone draw.';
  end if;
  select status into v_status from public.duty_draws where id = p_draw_id for update;
  if v_status is null then
    raise exception 'Draw not found.';
  end if;
  if v_status = 'finalized' then
    raise exception 'This draw is already finalized.';
  end if;

  update public.duty_draws set status = 'finalized', finalized_by = auth.uid(), finalized_at = now() where id = p_draw_id;

  perform public.phase8_write_audit('duty_draw_finalize', 'duty_draw', p_draw_id,
    jsonb_build_object('previous_status', v_status, 'new_status', 'finalized'));
end;
$function$;

revoke execute on function public.finalize_duty_draw_secure(uuid) from public, anon;
grant execute on function public.finalize_duty_draw_secure(uuid) to authenticated, service_role;

-- Read: Operation Manager sees every draw; anyone else sees only a
-- FINALIZED draw for their own currently-assigned station (resolved from
-- their own active Phase 3 assignment's station_id, or, for legacy
-- accounts with no Phase 3 assignment, their own profiles.station --
-- LEGACY UI COMPATIBILITY, not an independent authorization source: it
-- only ever narrows to that exact station, never broadens). A draft draw
-- is never visible to anyone but Operation Manager (protects the result
-- from being seen or inferred before publication).
create or replace function public.get_duty_draw_secure(p_station text, p_draw_date date)
returns table (
  draw_id uuid, status text, profile_id uuid, zone_id uuid, assigned_at timestamptz
)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_station_id uuid;
  v_own_station text;
begin
  if auth.uid() is null then
    raise exception 'Must be signed in.';
  end if;

  if not public.has_active_role_my('operation_manager') then
    select station into v_own_station from public.profiles where id = auth.uid();
    if v_own_station is distinct from p_station then
      raise exception 'You may only view the duty-zone draw for your own station.';
    end if;
  end if;

  select id into v_station_id from public.org_stations where code = p_station;
  if v_station_id is null then
    return;
  end if;

  return query
  select d.id, d.status, a.profile_id, a.zone_id, a.assigned_at
  from public.duty_draws d
  left join public.duty_draw_assignments a on a.draw_id = d.id
  where d.station_id = v_station_id
    and d.draw_date = p_draw_date
    and (d.status = 'finalized' or public.has_active_role_my('operation_manager'));
end;
$function$;

revoke execute on function public.get_duty_draw_secure(text, date) from public, anon;
grant execute on function public.get_duty_draw_secure(text, date) to authenticated, service_role;

-- Draw HISTORY for a station (Phase 8 Round 2, Slice 5): draw headers
-- only, never per-assignment detail (use get_duty_draw_secure for that,
-- one date at a time). Same visibility rule as get_duty_draw_secure --
-- Operation Manager sees every draw including drafts; anyone else sees
-- only finalized draws for their own station.
create or replace function public.list_duty_draw_history_secure(p_station text)
returns table (
  draw_id uuid, draw_date date, status text, initiated_by uuid, finalized_by uuid, finalized_at timestamptz
)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_station_id uuid;
  v_own_station text;
  v_is_operation_manager boolean;
begin
  if auth.uid() is null then
    raise exception 'Must be signed in.';
  end if;

  v_is_operation_manager := public.has_active_role_my('operation_manager');
  if not v_is_operation_manager then
    select station into v_own_station from public.profiles where id = auth.uid();
    if v_own_station is distinct from p_station then
      raise exception 'You may only view the duty-zone draw history for your own station.';
    end if;
  end if;

  select id into v_station_id from public.org_stations where code = p_station;
  if v_station_id is null then
    return;
  end if;

  return query
  select d.id, d.draw_date, d.status, d.initiated_by, d.finalized_by, d.finalized_at
  from public.duty_draws d
  where d.station_id = v_station_id
    and (v_is_operation_manager or d.status = 'finalized')
  order by d.draw_date desc;
end;
$function$;

revoke execute on function public.list_duty_draw_history_secure(text) from public, anon;
grant execute on function public.list_duty_draw_history_secure(text) to authenticated, service_role;

-- Operation Manager-only staff directory for a station, driving the
-- duty-draw assignment picker. Legacy profiles.station-based (the same
-- field team_rosters/absence_notices already key off), not a broader
-- disclosure than Operation Manager's existing Malaysia-Operation-wide
-- read authority already implies.
create or replace function public.list_station_staff_for_draw_secure(p_station text)
returns table (profile_id uuid, name text, staff_no text)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
begin
  if not public.has_active_role_my('operation_manager') then
    raise exception 'Only Operation Manager may view the station staff directory.';
  end if;

  return query
  select p.id, p.name, p.staff_no
  from public.profiles p
  where p.station = p_station and p.status = 'approved'
  order by p.name;
end;
$function$;

revoke execute on function public.list_station_staff_for_draw_secure(text) from public, anon;
grant execute on function public.list_station_staff_for_draw_secure(text) to authenticated, service_role;

-- =======================================================================
-- PART J: AUDITED WORKFORCE EXPORTS (Phase 8 Round 2, Slice 8)
-- =======================================================================
-- Capped, authorized, audited exports -- never credentials/tokens, never
-- personal data outside the workforce directory fields already exposed
-- by list_enforcement_workforce_secure()/the roster pickers. Each call
-- writes its own audit row (action 'export_generated') BEFORE returning
-- data, inside the same transaction, so an export can never be taken
-- without a corresponding audit row (fail-open on the read would leave
-- an untracked export; this fails closed instead -- if the audit insert
-- fails, the whole export fails with it).
create or replace function public.export_operation_workforce_secure()
returns table (
  profile_id uuid, name text, staff_no text, role_code text, hub_id uuid, station_id uuid, team_id uuid, status text
)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_row_count integer;
begin
  if not public.has_active_role_my('operation_manager') then
    raise exception 'Only Operation Manager may export the Operation workforce directory.';
  end if;

  select count(*) into v_row_count
  from public.user_role_assignments ura
  join public.role_definitions rd on rd.id = ura.role_definition_id
  join public.departments d on d.id = ura.department_id
  where d.code = 'operation'
    and ura.revoked_at is null and ura.starts_at <= now() and (ura.ends_at is null or ura.ends_at > now());

  perform public.phase8_write_audit('export_generated', 'workforce_export', null,
    jsonb_build_object('department', 'operation', 'row_count', least(v_row_count, 1000)));

  return query
  select p.id, p.name, p.staff_no, rd.code, ura.hub_id, ura.station_id, ura.team_id, p.status::text
  from public.user_role_assignments ura
  join public.role_definitions rd on rd.id = ura.role_definition_id
  join public.departments d on d.id = ura.department_id
  join public.profiles p on p.id = ura.profile_id
  where d.code = 'operation'
    and ura.revoked_at is null and ura.starts_at <= now() and (ura.ends_at is null or ura.ends_at > now())
  order by p.name
  limit 1000;
end;
$function$;

revoke execute on function public.export_operation_workforce_secure() from public, anon;
grant execute on function public.export_operation_workforce_secure() to authenticated, service_role;

create or replace function public.export_enforcement_workforce_secure()
returns table (
  profile_id uuid, name text, staff_no text, role_code text, unit_code text, hub_id uuid, station_id uuid, team_id uuid, status text
)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_row_count integer;
begin
  if not public.has_active_role_my('main_enforcement') then
    raise exception 'Only Main Enforcement may export the Enforcement workforce directory.';
  end if;

  select count(*) into v_row_count
  from public.user_role_assignments ura
  join public.role_definitions rd on rd.id = ura.role_definition_id
  join public.departments d on d.id = ura.department_id
  where d.code = 'enforcement'
    and ura.revoked_at is null and ura.starts_at <= now() and (ura.ends_at is null or ura.ends_at > now());

  perform public.phase8_write_audit('export_generated', 'workforce_export', null,
    jsonb_build_object('department', 'enforcement', 'row_count', least(v_row_count, 1000)));

  return query
  select p.id, p.name, p.staff_no, rd.code, u.code, ura.hub_id, ura.station_id, ura.team_id, p.status::text
  from public.user_role_assignments ura
  join public.role_definitions rd on rd.id = ura.role_definition_id
  join public.departments d on d.id = ura.department_id
  join public.profiles p on p.id = ura.profile_id
  left join public.units u on u.id = ura.unit_id
  where d.code = 'enforcement'
    and ura.revoked_at is null and ura.starts_at <= now() and (ura.ends_at is null or ura.ends_at > now())
  order by u.code, p.name
  limit 1000;
end;
$function$;

revoke execute on function public.export_enforcement_workforce_secure() from public, anon;
grant execute on function public.export_enforcement_workforce_secure() to authenticated, service_role;

-- =======================================================================
-- PART F: INVESTIGATION CASE WORKFLOW
-- =======================================================================
-- New functionality -- no investigation-case table exists anywhere in the
-- pre-Phase-8 schema (confirmed by exhaustive grep). Every report link
-- goes through has_report_access() (Phase 6) -- never a direct
-- central_reports_index/report_sec0XX read. RLS is deny-all by default;
-- every read/write goes through the RPCs below.
create table if not exists public.investigation_cases (
  id uuid primary key default gen_random_uuid(),
  case_no text not null unique,
  aoc_id uuid not null references public.aocs(id),
  title text not null,
  classification text,
  description text,
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high', 'critical')),
  status text not null default 'open' check (status in ('open', 'resolved', 'closed', 'reopened')),
  opened_by uuid not null references public.profiles(id),
  assigned_to uuid references public.profiles(id),
  resolution text,
  resolved_by uuid references public.profiles(id),
  resolved_at timestamptz,
  reopened_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.investigation_case_reports (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.investigation_cases(id) on delete cascade,
  repository_report_id uuid not null references public.central_reports_index(id),
  linked_by uuid not null references public.profiles(id),
  linked_at timestamptz not null default now(),
  unique (case_id, repository_report_id)
);

create table if not exists public.investigation_case_notes (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.investigation_cases(id) on delete cascade,
  author_id uuid not null references public.profiles(id),
  note text not null,
  created_at timestamptz not null default now()
);

create index if not exists investigation_cases_status_idx on public.investigation_cases (status);
create index if not exists investigation_case_reports_case_idx on public.investigation_case_reports (case_id);
create index if not exists investigation_case_notes_case_idx on public.investigation_case_notes (case_id);

alter table public.investigation_cases enable row level security;
alter table public.investigation_case_reports enable row level security;
alter table public.investigation_case_notes enable row level security;
revoke all on public.investigation_cases from public, anon, authenticated;
revoke all on public.investigation_case_reports from public, anon, authenticated;
revoke all on public.investigation_case_notes from public, anon, authenticated;
grant all on public.investigation_cases to service_role;
grant all on public.investigation_case_reports to service_role;
grant all on public.investigation_case_notes to service_role;

-- Authorization shared by every Investigation RPC below: any active
-- investigation_sso/investigation_so/investigation_aso, or main_enforcement
-- (Malaysia-wide monitoring authority over Investigation). No station/hub
-- narrowing -- matches Phase 3's own scope-shape rule for these roles
-- ("Malaysia-wide within Investigation").
create or replace function public.is_investigation_authorized()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select public.has_active_role_my('investigation_sso')
    or public.has_active_role_my('investigation_so')
    or public.has_active_role_my('investigation_aso')
    or public.has_active_role_my('main_enforcement');
$function$;

revoke execute on function public.is_investigation_authorized() from public, anon;
grant execute on function public.is_investigation_authorized() to authenticated, service_role;

create or replace function public.open_investigation_case_secure(
  p_title text, p_classification text default null, p_description text default null, p_priority text default 'normal'
)
returns table (row_id uuid, case_no text)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_aoc_id uuid;
  v_case_id uuid;
  v_case_no text;
begin
  if not (
    public.has_active_role_my('investigation_sso')
    or public.has_active_role_my('investigation_so')
    or public.has_active_role_my('investigation_aso')
  ) then
    raise exception 'Only Investigation SSO/SO/ASO may open a case.';
  end if;
  if p_title is null or trim(p_title) = '' then
    raise exception 'Case title is required.';
  end if;
  if p_priority not in ('low', 'normal', 'high', 'critical') then
    raise exception 'Invalid priority.';
  end if;

  select id into v_aoc_id from public.aocs where code = 'MY';
  v_case_no := 'INV-' || to_char(now(), 'YYYYMMDD') || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6);

  insert into public.investigation_cases (case_no, aoc_id, title, classification, description, priority, opened_by)
  values (v_case_no, v_aoc_id, trim(p_title), p_classification, p_description, p_priority, auth.uid())
  returning id into v_case_id;

  perform public.phase8_write_audit('investigation_case_open', 'investigation_case', v_case_id,
    jsonb_build_object('case_no', v_case_no, 'title', p_title));

  return query select v_case_id, v_case_no;
end;
$function$;

revoke execute on function public.open_investigation_case_secure(text, text, text, text) from public, anon;
grant execute on function public.open_investigation_case_secure(text, text, text, text) to authenticated, service_role;

-- Links a report to a case. Requires the caller to ALSO independently
-- pass has_report_access() for that specific report -- being an
-- Investigation rank does not, by itself, guarantee has_report_access()
-- returns true for every report (see Phase 6: Investigation gets
-- Malaysia-wide read authority via has_role_in_scope('investigation_*',
-- aoc_id) already; this is a defense-in-depth re-check, not a broadening).
create or replace function public.link_report_to_case_secure(p_case_id uuid, p_repository_report_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if not public.is_investigation_authorized() then
    raise exception 'Only Investigation or Main Enforcement may link reports to a case.';
  end if;
  if not exists (select 1 from public.investigation_cases where id = p_case_id) then
    raise exception 'Case not found.';
  end if;
  if not public.has_report_access(p_repository_report_id) then
    raise exception 'You are not authorized to access this report.';
  end if;

  insert into public.investigation_case_reports (case_id, repository_report_id, linked_by)
  values (p_case_id, p_repository_report_id, auth.uid())
  on conflict (case_id, repository_report_id) do nothing;

  perform public.phase8_write_audit('investigation_case_link_report', 'investigation_case', p_case_id,
    jsonb_build_object('repository_report_id', p_repository_report_id));
end;
$function$;

revoke execute on function public.link_report_to_case_secure(uuid, uuid) from public, anon;
grant execute on function public.link_report_to_case_secure(uuid, uuid) to authenticated, service_role;

create or replace function public.add_investigation_case_note_secure(p_case_id uuid, p_note text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_note_id uuid;
begin
  if not public.is_investigation_authorized() then
    raise exception 'Only Investigation or Main Enforcement may add case notes.';
  end if;
  if p_note is null or trim(p_note) = '' then
    raise exception 'Note text is required.';
  end if;
  if not exists (select 1 from public.investigation_cases where id = p_case_id) then
    raise exception 'Case not found.';
  end if;

  insert into public.investigation_case_notes (case_id, author_id, note) values (p_case_id, auth.uid(), trim(p_note))
  returning id into v_note_id;

  perform public.phase8_write_audit('investigation_case_note', 'investigation_case', p_case_id,
    jsonb_build_object('note_id', v_note_id));
end;
$function$;

revoke execute on function public.add_investigation_case_note_secure(uuid, text) from public, anon;
grant execute on function public.add_investigation_case_note_secure(uuid, text) to authenticated, service_role;

create or replace function public.assign_investigation_case_secure(p_case_id uuid, p_assignee_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_now timestamptz := now();
begin
  if not public.is_investigation_authorized() then
    raise exception 'Only Investigation or Main Enforcement may assign a case.';
  end if;
  if not exists (
    select 1 from public.user_role_assignments ura
    join public.role_definitions rd on rd.id = ura.role_definition_id
    where ura.profile_id = p_assignee_id and rd.code in ('investigation_sso', 'investigation_so', 'investigation_aso')
      and rd.is_active and ura.revoked_at is null and ura.starts_at <= now() and (ura.ends_at is null or ura.ends_at > now())
  ) then
    raise exception 'Assignee does not hold an active Investigation role assignment.';
  end if;

  update public.investigation_cases set assigned_to = p_assignee_id, updated_at = v_now where id = p_case_id;
  if not found then
    raise exception 'Case not found.';
  end if;

  perform public.phase8_write_audit('investigation_case_assign', 'investigation_case', p_case_id,
    jsonb_build_object('assignee_id', p_assignee_id));
  perform public.notify(
    p_assignee_id, 'investigation_case_assigned',
    'phase8_invcase_assign_' || p_case_id || '_' || p_assignee_id || '_' || extract(epoch from v_now)::text,
    null, null, null,
    jsonb_build_object('case_id', p_case_id)
  );
end;
$function$;

revoke execute on function public.assign_investigation_case_secure(uuid, uuid) from public, anon;
grant execute on function public.assign_investigation_case_secure(uuid, uuid) to authenticated, service_role;

create or replace function public.resolve_investigation_case_secure(p_case_id uuid, p_resolution text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_status text;
begin
  if not public.is_investigation_authorized() then
    raise exception 'Only Investigation or Main Enforcement may resolve a case.';
  end if;
  if p_resolution is null or trim(p_resolution) = '' then
    raise exception 'A resolution is required to close a case.';
  end if;
  select status into v_status from public.investigation_cases where id = p_case_id for update;
  if v_status is null then
    raise exception 'Case not found.';
  end if;
  if v_status in ('resolved', 'closed') then
    raise exception 'Case is already %.', v_status;
  end if;

  update public.investigation_cases
  set status = 'resolved', resolution = trim(p_resolution), resolved_by = auth.uid(), resolved_at = now(), updated_at = now()
  where id = p_case_id;

  perform public.phase8_write_audit('investigation_case_resolve', 'investigation_case', p_case_id,
    jsonb_build_object('previous_status', v_status, 'new_status', 'resolved'));
end;
$function$;

revoke execute on function public.resolve_investigation_case_secure(uuid, text) from public, anon;
grant execute on function public.resolve_investigation_case_secure(uuid, text) to authenticated, service_role;

-- Reopen is deliberately narrower than resolve/assign/note: only an
-- Investigation SSO (senior rank) or Main Enforcement, matching the
-- spec's "only through an authorized and audited action" for this
-- specific transition.
create or replace function public.reopen_investigation_case_secure(p_case_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_status text;
begin
  if not (public.has_active_role_my('investigation_sso') or public.has_active_role_my('main_enforcement')) then
    raise exception 'Only Investigation SSO or Main Enforcement may reopen a case.';
  end if;
  if p_reason is null or trim(p_reason) = '' then
    raise exception 'A reason is required to reopen a case.';
  end if;
  select status into v_status from public.investigation_cases where id = p_case_id for update;
  if v_status is null then
    raise exception 'Case not found.';
  end if;
  if v_status not in ('resolved', 'closed') then
    raise exception 'Only a resolved or closed case can be reopened (current status: %).', v_status;
  end if;

  update public.investigation_cases
  set status = 'reopened', reopened_count = reopened_count + 1, updated_at = now()
  where id = p_case_id;

  perform public.phase8_write_audit('investigation_case_reopen', 'investigation_case', p_case_id,
    jsonb_build_object('reason', trim(p_reason)));
end;
$function$;

revoke execute on function public.reopen_investigation_case_secure(uuid, text) from public, anon;
grant execute on function public.reopen_investigation_case_secure(uuid, text) to authenticated, service_role;

create or replace function public.list_investigation_cases_secure()
returns setof public.investigation_cases
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
begin
  if not public.is_investigation_authorized() then
    raise exception 'Only Investigation or Main Enforcement may list cases.';
  end if;
  return query select * from public.investigation_cases order by created_at desc;
end;
$function$;

revoke execute on function public.list_investigation_cases_secure() from public, anon;
grant execute on function public.list_investigation_cases_secure() to authenticated, service_role;

-- Single-case detail fetch (Phase 8 Round 2, Slice 4 -- the case
-- workspace UI needs a per-case read, not only the full list above).
-- Raises -- never silently returns null -- for an unauthorized caller or
-- a nonexistent case, matching this migration's existing fail-closed
-- convention.
create or replace function public.get_investigation_case_secure(p_case_id uuid)
returns setof public.investigation_cases
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
begin
  if not public.is_investigation_authorized() then
    raise exception 'Only Investigation or Main Enforcement may view a case.';
  end if;
  if not exists (select 1 from public.investigation_cases where id = p_case_id) then
    raise exception 'Case not found.';
  end if;
  return query select * from public.investigation_cases where id = p_case_id;
end;
$function$;

revoke execute on function public.get_investigation_case_secure(uuid) from public, anon;
grant execute on function public.get_investigation_case_secure(uuid) to authenticated, service_role;

create or replace function public.list_investigation_case_notes_secure(p_case_id uuid)
returns setof public.investigation_case_notes
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
begin
  if not public.is_investigation_authorized() then
    raise exception 'Only Investigation or Main Enforcement may view case notes.';
  end if;
  return query select * from public.investigation_case_notes where case_id = p_case_id order by created_at asc;
end;
$function$;

revoke execute on function public.list_investigation_case_notes_secure(uuid) from public, anon;
grant execute on function public.list_investigation_case_notes_secure(uuid) to authenticated, service_role;

-- Linked-report summaries for a case, via central_reports_index only
-- (never a direct report-table read) -- report existence/access was
-- already re-verified via has_report_access() at LINK time
-- (link_report_to_case_secure); this only reads the already-linked,
-- already-authorized set for an is_investigation_authorized() caller.
create or replace function public.list_investigation_case_reports_secure(p_case_id uuid)
returns table (
  repository_report_id uuid,
  source_table text,
  report_type text,
  flight_number text,
  report_date date,
  status text,
  linked_by uuid,
  linked_at timestamptz
)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
begin
  if not public.is_investigation_authorized() then
    raise exception 'Only Investigation or Main Enforcement may view linked case reports.';
  end if;

  return query
  select cri.id, cri.source_table, cri.report_type, cri.flight_number, cri.report_date, cri.status, icr.linked_by, icr.linked_at
  from public.investigation_case_reports icr
  join public.central_reports_index cri on cri.id = icr.repository_report_id
  where icr.case_id = p_case_id
  order by icr.linked_at desc;
end;
$function$;

revoke execute on function public.list_investigation_case_reports_secure(uuid) from public, anon;
grant execute on function public.list_investigation_case_reports_secure(uuid) to authenticated, service_role;

-- Active Investigation staff directory, for the case-assignment picker.
-- Any is_investigation_authorized() caller may see it (the same set
-- assign_investigation_case_secure() itself validates an assignee
-- against) -- not a broader disclosure than assignment already implies.
create or replace function public.list_investigation_staff_secure()
returns table (profile_id uuid, name text, role_code text)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
begin
  if not public.is_investigation_authorized() then
    raise exception 'Only Investigation or Main Enforcement may view the Investigation staff directory.';
  end if;

  return query
  select distinct p.id, p.name, rd.code
  from public.user_role_assignments ura
  join public.role_definitions rd on rd.id = ura.role_definition_id
  join public.profiles p on p.id = ura.profile_id
  where rd.code in ('investigation_sso', 'investigation_so', 'investigation_aso')
    and ura.revoked_at is null
    and ura.starts_at <= now()
    and (ura.ends_at is null or ura.ends_at > now())
  order by p.name;
end;
$function$;

revoke execute on function public.list_investigation_staff_secure() from public, anon;
grant execute on function public.list_investigation_staff_secure() to authenticated, service_role;

-- =======================================================================
-- PART G: SAT COMBINED-PDF WORKFLOW
-- =======================================================================
-- New functionality. Storage-backed, private bucket, signed URLs only --
-- mirrors avsec/0020_report_attachments.sql's established pattern. At
-- most one ACTIVE combined PDF per (team, operational_date): the partial
-- unique index below enforces that structurally, not just in application
-- code, while still allowing an audited replacement (the old row is
-- superseded, never deleted, and the new row references it).
create table if not exists public.sat_combined_reports (
  id uuid primary key default gen_random_uuid(),
  aoc_id uuid not null references public.aocs(id),
  station_id uuid not null references public.org_stations(id),
  team_id uuid not null references public.org_teams(id),
  operational_date date not null,
  shift_coverage text not null,
  storage_path text not null unique,
  uploaded_by uuid not null references public.profiles(id),
  uploaded_at timestamptz not null default now(),
  status text not null default 'active' check (status in ('active', 'superseded')),
  version integer not null default 1,
  supersedes uuid references public.sat_combined_reports(id)
);

-- Structural duplicate-prevention: only one row with status='active' may
-- exist per (team_id, operational_date) at a time. Replacing a report
-- must first mark the old row 'superseded' (in the same transaction as
-- inserting the new one -- see replace_sat_combined_report_secure()),
-- which the partial index allows.
create unique index if not exists sat_combined_reports_one_active_per_team_day
  on public.sat_combined_reports (team_id, operational_date)
  where status = 'active';

create index if not exists sat_combined_reports_team_date_idx on public.sat_combined_reports (team_id, operational_date);

alter table public.sat_combined_reports enable row level security;
revoke all on public.sat_combined_reports from public, anon, authenticated;
grant all on public.sat_combined_reports to service_role;

insert into storage.buckets (id, name, public)
values ('sat-combined-reports', 'sat-combined-reports', false)
on conflict (id) do nothing;

-- Storage object visibility mirrors the metadata row's own authorization:
-- the uploader, SAT ASOs on that exact team, Main Enforcement (Malaysia-
-- wide monitor of all three Enforcement units), and Investigation
-- (explicit read access per the spec, no acknowledgement). No public URL
-- is ever stored -- only this private-bucket relative path.
create or replace function public.can_view_sat_combined_report(p_report_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  r record;
  v_aoc_id uuid;
begin
  select * into r from public.sat_combined_reports where id = p_report_id;
  if r is null then return false; end if;
  if r.uploaded_by = auth.uid() then return true; end if;
  if public.has_active_role_my('main_enforcement') or public.is_investigation_authorized() then return true; end if;
  select id into v_aoc_id from public.aocs where code = 'MY';
  return public.has_role_in_scope('sat_aso', v_aoc_id, null, null, null, null, r.station_id, r.team_id);
end;
$function$;

revoke execute on function public.can_view_sat_combined_report(uuid) from public, anon;
grant execute on function public.can_view_sat_combined_report(uuid) to authenticated, service_role;

create policy "sat combined report object select" on storage.objects for select
  using (
    bucket_id = 'sat-combined-reports'
    and public.can_view_sat_combined_report(nullif((storage.foldername(name))[1], '')::uuid)
  );

-- Object INSERT itself stays SECURITY DEFINER-gated: the client never
-- inserts a storage.objects row directly with an arbitrary path -- the
-- upload_sat_combined_report_secure() RPC below is the only path that
-- creates BOTH the metadata row and hands back the exact, pre-authorized
-- path the client must upload to. Storage INSERT is intentionally left
-- with no permissive policy for `authenticated` -- uploads happen via the
-- server (service-role) after the RPC has validated authorization,
-- exactly like report-attachments' own server-side upload flow.

-- Uploads a new combined PDF. Only an active SAT ASO on the exact
-- (station, team) may upload for that team. Fails closed (raises) if a
-- row already exists for this team/date -- callers must use
-- replace_sat_combined_report_secure() for a correction, never silently
-- overwrite.
create or replace function public.upload_sat_combined_report_secure(
  p_station text, p_team text, p_operational_date date, p_shift_coverage text, p_storage_path text
)
returns table (row_id uuid)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_station_id uuid;
  v_hub_id uuid;
  v_team_id uuid;
  v_aoc_id uuid;
  v_id uuid;
begin
  select station_id, hub_id into v_station_id, v_hub_id from public.resolve_legacy_station(p_station);
  if v_station_id is null then raise exception 'Unknown station: %.', p_station; end if;
  v_team_id := public.resolve_legacy_team(v_station_id, p_team);
  if v_team_id is null then raise exception 'Unknown team % at station %.', p_team, p_station; end if;
  select id into v_aoc_id from public.aocs where code = 'MY';

  if not public.has_role_in_scope('sat_aso', v_aoc_id, null, null, null, v_hub_id, v_station_id, v_team_id) then
    raise exception 'Only an active SAT ASO on this exact team may upload its combined report.';
  end if;
  if exists (select 1 from public.sat_combined_reports where team_id = v_team_id and operational_date = p_operational_date and status = 'active') then
    raise exception 'A combined report for this team and date already exists. Use the replacement path for a correction.';
  end if;

  insert into public.sat_combined_reports (aoc_id, station_id, team_id, operational_date, shift_coverage, storage_path, uploaded_by)
  values (v_aoc_id, v_station_id, v_team_id, p_operational_date, p_shift_coverage, p_storage_path, auth.uid())
  returning id into v_id;

  perform public.phase8_write_audit('sat_combined_report_upload', 'sat_combined_report', v_id,
    jsonb_build_object('station', p_station, 'team', p_team, 'operational_date', p_operational_date));

  return query select v_id;
end;
$function$;

revoke execute on function public.upload_sat_combined_report_secure(text, text, date, text, text) from public, anon;
grant execute on function public.upload_sat_combined_report_secure(text, text, date, text, text) to authenticated, service_role;

-- Audited replacement: marks the old row 'superseded' and inserts a new
-- 'active' row referencing it via supersedes/version, in one transaction
-- -- the partial unique index never sees two 'active' rows at once.
create or replace function public.replace_sat_combined_report_secure(
  p_old_report_id uuid, p_shift_coverage text, p_storage_path text, p_reason text
)
returns table (row_id uuid)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_old record;
  v_aoc_id uuid;
  v_new_id uuid;
begin
  select * into v_old from public.sat_combined_reports where sat_combined_reports.id = p_old_report_id for update;
  if v_old is null then raise exception 'Original combined report not found.'; end if;
  if v_old.status <> 'active' then raise exception 'Only the currently active combined report may be replaced.'; end if;
  if p_reason is null or trim(p_reason) = '' then raise exception 'A reason is required to replace a combined report.'; end if;

  select id into v_aoc_id from public.aocs where code = 'MY';
  if not public.has_role_in_scope('sat_aso', v_aoc_id, null, null, null, null, v_old.station_id, v_old.team_id) then
    raise exception 'Only an active SAT ASO on this exact team may replace its combined report.';
  end if;

  update public.sat_combined_reports set status = 'superseded' where sat_combined_reports.id = p_old_report_id;

  insert into public.sat_combined_reports
    (aoc_id, station_id, team_id, operational_date, shift_coverage, storage_path, uploaded_by, version, supersedes)
  values
    (v_old.aoc_id, v_old.station_id, v_old.team_id, v_old.operational_date, p_shift_coverage, p_storage_path, auth.uid(), v_old.version + 1, p_old_report_id)
  returning id into v_new_id;

  perform public.phase8_write_audit('sat_combined_report_replace', 'sat_combined_report', v_new_id,
    jsonb_build_object('supersedes', p_old_report_id, 'reason', trim(p_reason)));

  return query select v_new_id;
end;
$function$;

revoke execute on function public.replace_sat_combined_report_secure(uuid, text, text, text) from public, anon;
grant execute on function public.replace_sat_combined_report_secure(uuid, text, text, text) to authenticated, service_role;

create or replace function public.list_sat_combined_reports_secure(p_station text default null, p_team text default null)
returns setof public.sat_combined_reports
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_station_id uuid;
  v_team_id uuid;
begin
  if p_station is not null then
    select id into v_station_id from public.org_stations where code = p_station;
    if p_team is not null and v_station_id is not null then
      v_team_id := public.resolve_legacy_team(v_station_id, p_team);
    end if;
  end if;

  return query
  select r.* from public.sat_combined_reports r
  where public.can_view_sat_combined_report(r.id)
    and (v_station_id is null or r.station_id = v_station_id)
    and (v_team_id is null or r.team_id = v_team_id)
  order by r.operational_date desc, r.uploaded_at desc;
end;
$function$;

revoke execute on function public.list_sat_combined_reports_secure(text, text) from public, anon;
grant execute on function public.list_sat_combined_reports_secure(text, text) to authenticated, service_role;

-- =======================================================================
-- PART H: STAFF PROFILING SEC013 ACKNOWLEDGEMENT
-- =======================================================================
-- report_sec013's own `acknowledgement boolean` column is a staff SELF-
-- acknowledgement checkbox on the submission form (per 0014's header),
-- not a supervisor review step, and is immutable once the report is
-- submitted (report_sec013_immutable trigger, 0014) -- writing to it here
-- would simply fail. 0014 already wired report_sec013 into the SAME
-- generic report_acknowledgements table sec014/016/018/029 use (its own
-- check constraint was widened to include 'sec013', and
-- get_report_submitter() already has a sec013 branch), and that generic
-- mechanism's legacy rank+1-same-station/team rule
-- (can_acknowledge_report()) already technically permits a Profiling SO
-- to acknowledge a Profiling ASO's report IF their legacy profiles.role
-- ranks (SO=rank+1 of ASO) and profiles.station/team happen to line up --
-- but that is incidental legacy-rank matching, not a Phase-3-scoped
-- Profiling-unit-specific rule. This RPC adds the Phase-3-scoped
-- equivalent, inserting into the SAME report_acknowledgements table
-- (never the immutable boolean column), so acknowledgement state is read
-- consistently by any existing code that already queries that table for
-- other report types.
create or replace function public.acknowledge_sec013_report_secure(p_report_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_report record;
  v_station_id uuid;
  v_hub_id uuid;
  v_team_id uuid;
  v_aoc_id uuid;
begin
  select id, station, team into v_report from public.report_sec013 where id = p_report_id;
  if v_report is null then
    raise exception 'SEC013 report not found.';
  end if;
  if exists (select 1 from public.report_acknowledgements where report_type = 'sec013' and report_id = p_report_id) then
    raise exception 'This report is already acknowledged.';
  end if;

  select station_id, hub_id into v_station_id, v_hub_id from public.resolve_legacy_station(v_report.station);
  if v_station_id is not null then
    v_team_id := public.resolve_legacy_team(v_station_id, v_report.team);
  end if;
  select id into v_aoc_id from public.aocs where code = 'MY';

  if v_station_id is null or v_team_id is null
     or not public.has_role_in_scope('profiling_so', v_aoc_id, null, null, null, v_hub_id, v_station_id, v_team_id)
  then
    raise exception 'Only an active Profiling SO on this exact team may acknowledge this report.';
  end if;

  insert into public.report_acknowledgements (report_type, report_id, acknowledged_by)
  values ('sec013', p_report_id, auth.uid());

  perform public.phase8_write_audit('sec013_acknowledge', 'report_sec013', p_report_id,
    jsonb_build_object('station', v_report.station, 'team', v_report.team));
end;
$function$;

revoke execute on function public.acknowledge_sec013_report_secure(uuid) from public, anon;
grant execute on function public.acknowledge_sec013_report_secure(uuid) to authenticated, service_role;

-- List SEC013 reports for the caller's OWN Profiling SO team awaiting
-- acknowledgement, driving the Profiling SO workspace's action list --
-- never a broader listing than acknowledge_sec013_report_secure() would
-- itself allow the same caller to act on.
create or replace function public.list_pending_sec013_acknowledgements_secure()
returns table (
  report_id uuid,
  staff_name text,
  station text,
  team text,
  submitted_at timestamptz
)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_aoc_id uuid;
begin
  select id into v_aoc_id from public.aocs where code = 'MY';

  return query
  select r.id, r.staff_name, r.station, r.team, r.submitted_at
  from public.report_sec013 r
  where r.status = 'submitted'
    and not exists (select 1 from public.report_acknowledgements ra where ra.report_type = 'sec013' and ra.report_id = r.id)
    and exists (
      select 1
      from public.resolve_legacy_station(r.station) rs
      cross join lateral (select public.resolve_legacy_team(rs.station_id, r.team) as team_id) rt
      where rs.station_id is not null
        and rt.team_id is not null
        and public.has_role_in_scope('profiling_so', v_aoc_id, null, null, null, rs.hub_id, rs.station_id, rt.team_id)
    )
  order by r.submitted_at asc;
end;
$function$;

revoke execute on function public.list_pending_sec013_acknowledgements_secure() from public, anon;
grant execute on function public.list_pending_sec013_acknowledgements_secure() to authenticated, service_role;

-- =======================================================================
-- PART I: MAIN ENFORCEMENT WORKFORCE AUTHORITY (Phase 8 Round 2, Slice 1)
-- =======================================================================
-- Main Enforcement is the sole and final Malaysia-wide workforce
-- authority for Investigation, SAT and Profiling (Enforcement dept).
-- Every function below is main_enforcement-only, resolved via the same
-- has_active_role() every other Phase 8 RPC uses -- never a legacy rank
-- check -- and is strictly read-only for staffing/roster VISIBILITY
-- (the actual roster-editing surface for SAT/Profiling teams is Slice 2/3
-- work; Investigation is Malaysia-wide and has no station/team roster
-- concept at all per the Phase 3 scope-shape rules). This deliberately
-- does NOT grant any Operation-department visibility -- department
-- separation is enforced by filtering strictly to department code
-- 'enforcement', never by trusting a client-supplied department claim.

create or replace function public.list_enforcement_workforce_secure()
returns table (
  profile_id uuid,
  name text,
  staff_no text,
  role_code text,
  unit_code text,
  hub_id uuid,
  station_id uuid,
  team_id uuid,
  status text
)
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if not public.has_active_role_my('main_enforcement') then
    raise exception 'Only Main Enforcement may view the Enforcement workforce roster.';
  end if;

  return query
  select p.id, p.name, p.staff_no, rd.code, u.code, ura.hub_id, ura.station_id, ura.team_id, p.status::text
  from public.user_role_assignments ura
  join public.role_definitions rd on rd.id = ura.role_definition_id
  join public.departments d on d.id = ura.department_id
  join public.profiles p on p.id = ura.profile_id
  left join public.units u on u.id = ura.unit_id
  where d.code = 'enforcement'
    and ura.revoked_at is null
    and ura.starts_at <= now()
    and (ura.ends_at is null or ura.ends_at > now())
  order by u.code, p.name;
end;
$function$;

revoke execute on function public.list_enforcement_workforce_secure() from public, anon;
grant execute on function public.list_enforcement_workforce_secure() to authenticated, service_role;

-- Attendance/check-in exceptions (late, absent, no-show) for any staff
-- member currently holding an active Enforcement-department role
-- assignment -- resolved via the same department filter as above, never
-- by matching on legacy free-text role/station values.
create or replace function public.list_enforcement_attendance_exceptions_secure(p_since date default (current_date - 7))
returns table (
  profile_id uuid,
  staff_name text,
  duty_date date,
  shift_code text,
  status text,
  late_remark text
)
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if not public.has_active_role_my('main_enforcement') then
    raise exception 'Only Main Enforcement may view Enforcement attendance exceptions.';
  end if;

  return query
  select dr.profile_id, p.name, dr.duty_date, dr.shift_code, dr.status, dr.late_remark
  from public.duty_records dr
  join public.profiles p on p.id = dr.profile_id
  where dr.duty_date >= p_since
    and dr.status in ('absent', 'late', 'early_out')
    and exists (
      select 1 from public.user_role_assignments ura
      join public.departments d on d.id = ura.department_id
      where ura.profile_id = dr.profile_id
        and d.code = 'enforcement'
        and ura.revoked_at is null
        and ura.starts_at <= now()
        and (ura.ends_at is null or ura.ends_at > now())
    )
  order by dr.duty_date desc, p.name;
end;
$function$;

revoke execute on function public.list_enforcement_attendance_exceptions_secure(date) from public, anon;
grant execute on function public.list_enforcement_attendance_exceptions_secure(date) to authenticated, service_role;

-- Pending decisions awaiting Main Enforcement action: leave requests and
-- OT requests submitted by Enforcement-department staff. Used to drive
-- the Main Enforcement dashboard's pending-action indicators. Read-only,
-- department-filtered the same way as the two functions above.
create or replace function public.list_enforcement_pending_actions_secure()
returns table (
  kind text,
  record_id uuid,
  staff_name text,
  detail text,
  submitted_at timestamptz
)
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if not public.has_active_role_my('main_enforcement') then
    raise exception 'Only Main Enforcement may view Enforcement pending actions.';
  end if;

  return query
  select 'leave'::text, an.id, an.staff_name,
    an.leave_type || ' (' || an.start_date::text || ' to ' || an.end_date::text || ')',
    an.submitted_at
  from public.absence_notices an
  where an.approval_status = 'pending'
    and public.submitter_department_code(an.user_id) = 'enforcement'
  union all
  select 'overtime'::text, ot.id, p.name,
    coalesce(ot.status, 'pending'),
    ot.created_at
  from public.overtime_requests ot
  join public.profiles p on p.id = ot.profile_id
  where ot.status in ('pending', 'endorsed')
    and public.submitter_department_code(ot.profile_id) = 'enforcement'
  order by submitted_at desc;
end;
$function$;

revoke execute on function public.list_enforcement_pending_actions_secure() from public, anon;
grant execute on function public.list_enforcement_pending_actions_secure() to authenticated, service_role;
