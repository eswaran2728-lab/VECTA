-- Leave authority and cancellation (product owner approval 2026-11-03).
--
-- 1. Unpaid leave: final approval is derived on the server from the inclusive Malaysia calendar days. 1-2 days: Operation Manager. 3 or more: the Boss of the
--    submitter's own operating entity (MAA or AAX). Neither the route nor the entity comes from the client. DSE and Hub SE cannot finalise unpaid leave.
-- 2. Annual leave capacity is judged day by day: the applicant is the fourth-or-later officer only if four DISTINCT officers are absent on at least one same
--    day. Such an approval is an exception only the Operation Manager may grant, and it is recorded on the row (overlap_exception).
-- 3. Approved annual leave can be cancelled directly: a DSE for their own station and team, the Operation Manager only for a recorded exception. A reason is
--    required. Leave still in the future is released in full; leave underway keeps today and every earlier Malaysia day as taken and releases only tomorrow
--    onward; completed leave and repeat cancellations are refused. One transaction, audited, the officer is notified.

alter table public.absence_notices add column if not exists overlap_exception boolean not null default false;
alter table public.absence_notices add column if not exists cancelled_at timestamptz;
alter table public.absence_notices add column if not exists cancelled_by uuid references public.profiles(id);
alter table public.absence_notices add column if not exists cancellation_kind text;
alter table public.absence_notices add column if not exists original_end_date date;
alter table public.absence_notices add constraint absence_notices_cancellation_kind_check check (cancellation_kind is null or cancellation_kind in ('full', 'partial'));

create or replace function public.leave_submitter_entity(p_profile uuid)
returns text
language sql
stable
security definer
set search_path to 'public'
as $function$
  select case when count(*) = 1 then min(oe.code) else null end
  from public.user_entity_memberships m
  join public.operating_entities oe on oe.id = m.operating_entity_id
  where m.profile_id = p_profile and m.status = 'active' and m.revoked_at is null
    and m.starts_at <= now() and (m.ends_at is null or m.ends_at > now());
$function$;

-- Highest number of OTHER distinct officers with approved annual leave on any single day of the span, same station and team.
create or replace function public.leave_peak_overlap(p_station text, p_team text, p_start date, p_end date, p_exclude_user uuid)
returns integer
language sql
stable
security definer
set search_path to 'public'
as $function$
  select coalesce(max(c), 0)::integer
  from (
    select g.d::date as d, count(distinct n.user_id) as c
    from generate_series(p_start, least(p_end, p_start + 400), interval '1 day') g(d)
    join public.absence_notices n
      on n.leave_type = 'annual' and n.approval_status = 'approved'
     and n.start_date <= g.d::date and n.end_date >= g.d::date
     and n.user_id <> p_exclude_user
     and coalesce(n.station, '') = coalesce(p_station, '')
     and coalesce(n.team, '') = coalesce(p_team, '')
    group by g.d
  ) x;
$function$;

create or replace function public.review_leave_request_secure(p_notice_id uuid, p_action text, p_review_notes text default null::text)
returns table(row_id uuid, result_status text)
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
  v_peak integer;
  v_exception boolean := false;
  v_new_status text;
  v_days integer;
  v_entity text;
  v_route text;
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

  -- Enforcement department: Main Enforcement is the sole and final authority (unchanged).
  if v_submitter_dept = 'enforcement' then
    v_is_main_enforcement := public.has_active_role_for_aoc('main_enforcement', v_aoc_id);
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
    set approval_status = v_new_status, reviewed_by = auth.uid(), reviewed_at = now(), review_notes = nullif(trim(coalesce(p_review_notes, '')), '')
    where absence_notices.id = p_notice_id;

    perform public.phase8_write_audit('leave_' || v_new_status, 'absence_notice', p_notice_id,
      jsonb_build_object('leave_type', v_notice.leave_type, 'station', v_notice.station, 'team', v_notice.team, 'reviewer_route', 'main_enforcement', 'department', 'enforcement'));
    perform public.notify(v_notice.user_id, 'leave_status_changed', 'phase8_leave_' || p_notice_id || '_' || v_new_status, null, null, null,
      jsonb_build_object('notice_id', p_notice_id, 'status', v_new_status));

    return query select p_notice_id, v_new_status;
    return;
  end if;

  v_is_operation_manager := public.has_active_role_for_aoc('operation_manager', v_aoc_id);
  if v_hub_id is not null then
    v_is_hub_se := public.has_role_in_scope('hub_se', v_aoc_id, null, null, null, v_hub_id);
  end if;
  if v_station_id is not null and v_team_id is not null then
    v_is_dse := public.has_role_in_scope('dse', v_aoc_id, null, null, null, v_hub_id, v_station_id, v_team_id);
  end if;

  if v_notice.leave_type = 'unpaid' then
    -- Final authority comes only from the applicant's own dates and entity, never from the caller.
    v_days := (v_notice.end_date - v_notice.start_date) + 1;
    if v_days <= 2 then
      if not v_is_operation_manager then
        raise exception 'Unpaid leave of 1 to 2 calendar days is finally decided by the Operation Manager.';
      end if;
      v_route := 'operation_manager';
    else
      v_entity := public.leave_submitter_entity(v_notice.user_id);
      if v_entity is null then
        raise exception 'The applicant has no single active operating entity, so no Boss can finalise this unpaid leave. Ask an administrator to correct the entity membership.';
      end if;
      if not public.has_role_in_scope(lower(v_entity) || '_boss', v_aoc_id, (select oe.id from public.operating_entities oe where oe.code = v_entity)) then
        raise exception 'Unpaid leave of 3 or more calendar days is finally decided by the % Boss.', v_entity;
      end if;
      v_route := lower(v_entity) || '_boss';
    end if;
    v_new_status := case when p_action = 'reject' then 'rejected' else 'approved' end;
  else
    if not (v_is_dse or v_is_hub_se or v_is_operation_manager) then
      raise exception 'No active Phase 3 role assignment grants authority to review this leave request.';
    end if;
    v_route := case when v_is_operation_manager then 'operation_manager' when v_is_hub_se then 'hub_se' else 'dse' end;

    if p_action = 'reject' then
      v_new_status := 'rejected';
    else
      perform pg_advisory_xact_lock(hashtext(coalesce(v_notice.station, '') || '|' || coalesce(v_notice.team, '') || '|' || v_notice.leave_type));

      if v_notice.leave_type = 'annual' then
        v_peak := public.leave_peak_overlap(v_notice.station, v_notice.team, v_notice.start_date, v_notice.end_date, v_notice.user_id);
        if v_peak >= 3 then
          if not v_is_operation_manager then
            raise exception 'Team Annual Leave capacity reached: % other officers are already absent on the same day. This request must be escalated to the Operation Manager for final decision.', v_peak;
          end if;
          v_exception := true;
        end if;
      end if;
      v_new_status := 'approved';
    end if;
  end if;

  update public.absence_notices
  set approval_status = v_new_status,
      reviewed_by = auth.uid(),
      reviewed_at = now(),
      review_notes = nullif(trim(coalesce(p_review_notes, '')), ''),
      overlap_exception = case when v_new_status = 'approved' then v_exception else overlap_exception end
  where absence_notices.id = p_notice_id;

  perform public.phase8_write_audit('leave_' || v_new_status, 'absence_notice', p_notice_id,
    jsonb_build_object('leave_type', v_notice.leave_type, 'station', v_notice.station, 'team', v_notice.team, 'reviewer_route', v_route, 'overlap_exception', v_exception));
  perform public.notify(v_notice.user_id, 'leave_status_changed', 'phase8_leave_' || p_notice_id || '_' || v_new_status, null, null, null,
    jsonb_build_object('notice_id', p_notice_id, 'status', v_new_status));

  return query select p_notice_id, v_new_status;
end;
$function$;

create or replace function public.cancel_approved_leave_secure(p_notice_id uuid, p_reason text)
returns table(row_id uuid, result_kind text, kept_through date, released_from date)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_caller uuid := auth.uid();
  v_notice record;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_today date := (now() at time zone 'Asia/Kuala_Lumpur')::date;
  v_station_id uuid;
  v_hub_id uuid;
  v_team_id uuid;
  v_aoc_id uuid;
  v_is_dse boolean := false;
  v_is_om boolean := false;
  v_kind text;
  v_keep date;
  v_release date;
begin
  if v_caller is null then raise exception 'Must be signed in.'; end if;
  if not exists (select 1 from public.profiles where id = v_caller and status = 'approved') then raise exception 'Only an approved account may cancel leave.'; end if;
  if char_length(v_reason) < 5 then raise exception 'A reason of at least 5 characters is required to cancel leave.'; end if;
  if char_length(v_reason) > 1000 then raise exception 'The reason is too long (1000 characters at most).'; end if;

  select * into v_notice from public.absence_notices where id = p_notice_id for update;
  if v_notice.id is null then raise exception 'Leave application record not found.'; end if;
  if v_notice.user_id = v_caller then raise exception 'You cannot cancel your own leave this way. Request cancellation for review instead.'; end if;
  if v_notice.leave_type <> 'annual' then raise exception 'Only annual leave can be cancelled this way.'; end if;
  if v_notice.cancelled_at is not null or v_notice.approval_status = 'cancelled' then raise exception 'This leave has already been cancelled.'; end if;
  if v_notice.approval_status <> 'approved' then raise exception 'Only approved leave can be cancelled this way.'; end if;

  select id into v_aoc_id from public.aocs where code = 'MY';
  select station_id, hub_id into v_station_id, v_hub_id from public.resolve_legacy_station(v_notice.station);
  if v_station_id is not null then v_team_id := public.resolve_legacy_team(v_station_id, v_notice.team); end if;
  if v_station_id is not null and v_team_id is not null then
    v_is_dse := public.has_role_in_scope('dse', v_aoc_id, null, null, null, v_hub_id, v_station_id, v_team_id);
  end if;
  v_is_om := public.has_active_role_for_aoc('operation_manager', v_aoc_id);

  if v_is_dse then
    null; -- a DSE may cancel any approved annual leave of their own station and team
  elsif v_is_om then
    if not v_notice.overlap_exception then
      raise exception 'The Operation Manager may directly cancel only a leave approved as a fourth-or-later same-day overlap exception.';
    end if;
  else
    raise exception 'You do not have authority to cancel this leave.';
  end if;

  if v_notice.end_date < v_today then raise exception 'Completed leave cannot be cancelled.'; end if;
  if v_notice.start_date > v_today then
    v_kind := 'full'; v_keep := null; v_release := v_notice.start_date;
  elsif v_notice.end_date <= v_today then
    raise exception 'No days remain after today to release.';
  else
    v_kind := 'partial'; v_keep := v_today; v_release := v_today + 1;
  end if;

  update public.absence_notices
     set cancelled_at = now(),
         cancelled_by = v_caller,
         cancellation_kind = v_kind,
         cancellation_reason = v_reason,
         original_end_date = v_notice.end_date,
         approval_status = case when v_kind = 'full' then 'cancelled' else approval_status end,
         end_date = case when v_kind = 'partial' then v_today else end_date end
   where id = v_notice.id;

  perform public.phase8_write_audit('leave_cancelled_directly', 'absence_notice', v_notice.id,
    jsonb_build_object('kind', v_kind, 'kept_through', v_keep, 'released_from', v_release, 'original_end_date', v_notice.end_date, 'reason', v_reason,
      'route', case when v_is_dse then 'dse' else 'operation_manager_exception' end));
  perform public.notify(v_notice.user_id, 'leave_status_changed', 'phase8_leave_' || v_notice.id || '_cancelled', null, null, null,
    jsonb_build_object('notice_id', v_notice.id, 'status', 'cancelled', 'kind', v_kind, 'released_from', v_release));

  return query select v_notice.id, v_kind, v_keep, v_release;
end;
$function$;

revoke execute on function public.leave_submitter_entity(uuid) from public, anon, authenticated;
revoke execute on function public.leave_peak_overlap(text, text, date, date, uuid) from public, anon, authenticated;
grant execute on function public.leave_submitter_entity(uuid) to service_role;
grant execute on function public.leave_peak_overlap(text, text, date, date, uuid) to service_role;
revoke execute on function public.cancel_approved_leave_secure(uuid, text) from public, anon;
grant execute on function public.cancel_approved_leave_secure(uuid, text) to authenticated, service_role;
