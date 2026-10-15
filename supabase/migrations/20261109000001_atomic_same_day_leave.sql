-- Same-day leave atomicity (additive; no earlier migration is edited).
--
-- Defect: the application recorded the absence notice and then upserted the same-day absent duty record as two separate calls with the
-- service-role client, and never inspected the duty upsert's returned { error }. Supabase returns errors rather than throwing, so the
-- action could report success after recording leave without marking attendance absent.
--
-- Correction: ONE authenticated, security-definer RPC performs the complete submission in one transaction. Identity, station and team are
-- derived inside the database from auth.uid() and the canonical assignment; the client supplies only the leave type, the dates and the
-- remarks. The direct client INSERT path to absence_notices (an "insert own" policy that let any authenticated user write a row with any
-- approval_status) is closed, so this function is the only way a notice is created.
--
-- Preserved: approved profile + active canonical assignment (current_status()/current_station()/current_team()), the rostered-actor
-- trigger on both tables, roster/shift lookup, the already-checked-in prohibition, leave date validation, the three-hour compliance gap
-- (green when the notice is at least 180 minutes before the rostered start), future-dated applications (no gap, no duty row), and the
-- response contract the UI uses. Added: duplicate prevention (one active notice per user and shift for a same-day application, one per
-- user/type/date range for a future application) serialised with a transaction-scoped advisory lock, and an audit entry.

create or replace function public.submit_leave_application_secure(
  p_leave_type text default 'absent',
  p_start_date date default null,
  p_end_date date default null,
  p_remarks text default null
)
returns table (
  notice_id uuid,
  result_approval_status text,
  result_status text,
  result_gap_minutes integer,
  result_formatted_gap text,
  result_submitted_at timestamptz,
  result_start_date date,
  result_end_date date,
  result_leave_type text,
  result_same_day boolean,
  result_shift_code text
)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_p record;
  v_station text;
  v_team text;
  v_today date := (now() at time zone 'Asia/Kuala_Lumpur')::date;
  v_now timestamptz := now();
  v_start date;
  v_end date;
  v_remarks text := btrim(coalesce(p_remarks, ''));
  v_type text := coalesce(nullif(btrim(p_leave_type), ''), 'absent');
  v_same boolean;
  v_shift text := 'DUTY';
  v_roster record;
  v_shift_start timestamptz;
  v_gap integer := null;
  v_status text := null;
  v_fmt text := 'Advance Planned Leave · Pending Review';
  v_label text;
  v_id uuid;
  v_abs integer;
  v_rows integer;
  v_existing_checkin timestamptz;
begin
  if v_uid is null then
    raise exception 'You must be signed in to submit a leave application.';
  end if;
  select * into v_p from public.profiles where id = v_uid;
  if v_p.id is null or v_p.status is distinct from 'approved' then
    raise exception 'Only an approved account may submit a leave application.';
  end if;
  v_station := public.current_station();
  v_team := public.current_team();
  if public.current_status() is distinct from 'approved' or v_station is null then
    raise exception 'You need an active station assignment to submit a leave application.';
  end if;

  if v_type not in ('absent', 'mc', 'emergency', 'annual', 'compassionate', 'hospitalization', 'maternity_paternity', 'parental', 'unpaid', 'representative') then
    raise exception 'Select a valid leave type.';
  end if;
  if v_remarks = '' then
    raise exception 'Remarks are required. Please provide an explanation for your leave.';
  end if;
  if char_length(v_remarks) > 2000 then
    raise exception 'Remarks are too long (2000 characters at most).';
  end if;
  v_start := coalesce(p_start_date, v_today);
  v_end := coalesce(p_end_date, v_start);
  if v_end < v_start then
    raise exception 'End date cannot be earlier than start date.';
  end if;
  v_same := (v_start = v_today);

  if v_same then
    select r.shift_code, r.start_time, r.end_time into v_roster
    from public.team_rosters r
    where r.station = v_station and r.team = v_team and r.roster_date = v_today
    order by r.updated_at desc limit 1;
    v_shift := coalesce(v_roster.shift_code, 'DUTY');
    -- serialise the same user/day/shift so two simultaneous submissions have exactly one authoritative result
    perform pg_advisory_xact_lock(hashtextextended('leave:' || v_uid::text || ':' || v_today::text || ':' || v_shift, 0));

    -- the attendance row is locked while it is inspected; a recorded check-in forbids the application
    select d.check_in_at into v_existing_checkin from public.duty_records d
    where d.profile_id = v_uid and d.duty_date = v_today and d.shift_code = v_shift for update;
    if v_existing_checkin is not null then
      raise exception 'Cannot apply for leave covering today after checking in. Check-in already confirms attendance for this shift.';
    end if;
    if exists (select 1 from public.absence_notices n where n.user_id = v_uid and n.start_date = v_today and n.shift_code = v_shift
               and n.approval_status in ('pending', 'approved', 'pending_cancellation')) then
      raise exception 'You have already submitted a leave application for today''s shift.';
    end if;

    if v_roster.start_time is not null and v_roster.end_time is not null then
      v_shift_start := ((v_today + v_roster.start_time) at time zone 'Asia/Kuala_Lumpur');
    else
      v_shift_start := ((v_today + time '08:00') at time zone 'Asia/Kuala_Lumpur');
    end if;
    -- Math.round semantics of the previous client calculation (half rounds up)
    v_gap := floor(extract(epoch from (v_shift_start - v_now)) / 60.0 + 0.5)::integer;
    v_status := case when v_gap >= 180 then 'green' else 'red' end;
    v_abs := abs(v_gap);
    v_fmt := case
      when v_gap = 0 then 'Requested at exact shift start'
      when v_gap > 0 and v_abs / 60 > 0 and v_abs % 60 > 0 then 'Requested ' || (v_abs / 60) || 'h ' || (v_abs % 60) || 'm before shift'
      when v_gap > 0 and v_abs / 60 > 0 then 'Requested ' || (v_abs / 60) || 'h before shift'
      when v_gap > 0 then 'Requested ' || (v_abs % 60) || 'm before shift'
      when v_abs / 60 > 0 and v_abs % 60 > 0 then 'Requested ' || (v_abs / 60) || 'h ' || (v_abs % 60) || 'm after shift start'
      when v_abs / 60 > 0 then 'Requested ' || (v_abs / 60) || 'h after shift start'
      else 'Requested ' || (v_abs % 60) || 'm after shift start'
    end;
  else
    v_shift_start := ((v_start + time '08:00') at time zone 'Asia/Kuala_Lumpur');
    perform pg_advisory_xact_lock(hashtextextended('leave:' || v_uid::text || ':' || v_start::text || ':' || v_end::text || ':' || v_type, 0));
    if exists (select 1 from public.absence_notices n where n.user_id = v_uid and n.leave_type = v_type and n.start_date = v_start and n.end_date = v_end
               and n.approval_status in ('pending', 'approved', 'pending_cancellation')) then
      raise exception 'You have already submitted this leave application.';
    end if;
  end if;

  insert into public.absence_notices (
    user_id, staff_name, staff_id, role, station, team, ops_group, shift_code, duty_date, leave_type, start_date, end_date,
    shift_start_time, submitted_at, gap_minutes, status, approval_status, remarks
  ) values (
    v_uid, v_p.name, v_p.staff_no, v_p.role, v_station, v_team, null, v_shift, v_today, v_type, v_start, v_end,
    v_shift_start, v_now, v_gap, v_status, 'pending', v_remarks
  ) returning id into v_id;

  if v_same then
    v_label := case v_type
      when 'absent' then 'Absent / Uninformed' when 'mc' then 'Sick Leave' when 'emergency' then 'Emergency Leave' when 'annual' then 'Annual Leave'
      when 'compassionate' then 'Compassionate / Bereavement Leave' when 'hospitalization' then 'Hospitalization Leave'
      when 'maternity_paternity' then 'Maternity / Paternity Leave' when 'parental' then 'Parental Leave' when 'unpaid' then 'Unpaid Leave'
      when 'representative' then 'Representative Leave' else v_type end;
    insert into public.duty_records (profile_id, duty_date, shift_code, station, team, status, late_remark)
    values (v_uid, v_today, v_shift, v_station, v_team, 'absent', 'Leave [' || v_label || ']: ' || v_remarks || ' (' || v_fmt || ')')
    on conflict (profile_id, duty_date, shift_code) do update
      set status = 'absent', station = excluded.station, team = excluded.team, late_remark = excluded.late_remark
      where public.duty_records.check_in_at is null;
    get diagnostics v_rows = row_count;
    if v_rows <> 1 then
      raise exception 'The attendance record could not be updated.';
    end if;
  end if;

  perform public.phase8_write_audit('absence_notice_submit', 'absence_notice', v_id,
    jsonb_build_object('leave_type', v_type, 'start_date', v_start, 'end_date', v_end, 'same_day', v_same, 'shift_code', v_shift, 'status', v_status));

  return query select v_id, 'pending'::text, v_status, v_gap, v_fmt, v_now, v_start, v_end, v_type, v_same, v_shift;
end;
$function$;
revoke execute on function public.submit_leave_application_secure(text, date, date, text) from public, anon;
grant execute on function public.submit_leave_application_secure(text, date, date, text) to authenticated;

-- The RPC is the only way to create a notice: no client may insert one directly (the policy accepted any approval_status).
drop policy if exists absence_notices_insert_own on public.absence_notices;
revoke insert on public.absence_notices from public, anon, authenticated;
