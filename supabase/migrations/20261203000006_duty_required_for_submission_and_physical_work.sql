-- Off-duty browsing is allowed (the middleware gate is removed), so the check-in rule must hold where it matters: in the database, for any direct request.
--
-- 1. A security report (SEC013, SEC014, SEC016, SEC018, SEC029, SEC033, Makeup, Breakup) cannot become SUBMITTED by a signed-in user without an open duty
--    check-in for today (Malaysia date): checked in and not yet checked out. Saving drafts is unaffected (drafts are a separate table and a status other than
--    submitted). Service-side jobs with no signed-in user are unaffected.
-- 2. Finishing an aircraft search is physical work and needs an open duty check-in, like starting it (start, handover completion and the CaterLink checkpoint
--    already require it).
-- The server actions keep their own friendly check; this is the control that a crafted request cannot skip.

create or replace function public.report_submit_requires_open_duty()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if auth.uid() is null then
    return new;
  end if;
  if new.status::text is distinct from 'submitted' then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.status::text = 'submitted' then
    return new;
  end if;
  if not exists (
    select 1 from public.duty_records d
     where d.profile_id = auth.uid()
       and d.duty_date = (now() at time zone 'Asia/Kuala_Lumpur')::date
       and d.check_in_at is not null
       and d.check_out_at is null
  ) then
    raise exception 'You must check in for duty before submitting a report.' using errcode = 'P0001';
  end if;
  return new;
end;
$function$;
revoke execute on function public.report_submit_requires_open_duty() from public, anon, authenticated;

drop trigger if exists trg_report_submit_requires_open_duty on public.report_sec013;
create trigger trg_report_submit_requires_open_duty before insert or update of status on public.report_sec013 for each row execute function public.report_submit_requires_open_duty();
drop trigger if exists trg_report_submit_requires_open_duty on public.report_sec014;
create trigger trg_report_submit_requires_open_duty before insert or update of status on public.report_sec014 for each row execute function public.report_submit_requires_open_duty();
drop trigger if exists trg_report_submit_requires_open_duty on public.report_sec016;
create trigger trg_report_submit_requires_open_duty before insert or update of status on public.report_sec016 for each row execute function public.report_submit_requires_open_duty();
drop trigger if exists trg_report_submit_requires_open_duty on public.report_sec018;
create trigger trg_report_submit_requires_open_duty before insert or update of status on public.report_sec018 for each row execute function public.report_submit_requires_open_duty();
drop trigger if exists trg_report_submit_requires_open_duty on public.report_sec029;
create trigger trg_report_submit_requires_open_duty before insert or update of status on public.report_sec029 for each row execute function public.report_submit_requires_open_duty();
drop trigger if exists trg_report_submit_requires_open_duty on public.report_sec033;
create trigger trg_report_submit_requires_open_duty before insert or update of status on public.report_sec033 for each row execute function public.report_submit_requires_open_duty();
drop trigger if exists trg_report_submit_requires_open_duty on public.report_makeup;
create trigger trg_report_submit_requires_open_duty before insert or update of status on public.report_makeup for each row execute function public.report_submit_requires_open_duty();
drop trigger if exists trg_report_submit_requires_open_duty on public.report_breakup;
create trigger trg_report_submit_requires_open_duty before insert or update of status on public.report_breakup for each row execute function public.report_submit_requires_open_duty();

create or replace function public.finish_aircraft_search_secure(
  p_record_id uuid, p_lat double precision, p_lng double precision, p_accuracy_m double precision, p_unavailable_reason text
)
returns table (duration_minutes numeric, below_minimum boolean, minimum_minutes integer, presence_status text)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_caller uuid := auth.uid();
  r record;
  v_fix boolean := public.aircraft_search_valid_fix(p_lat, p_lng, p_accuracy_m);
  v_now timestamptz := clock_timestamp();
  v_min integer;
  v_minutes numeric;
  v_below boolean;
  v_presence text;
begin
  if v_caller is null then raise exception 'Must be signed in.'; end if;
  select * into r from public.aircraft_search_records where id = p_record_id for update;
  if r.id is null or r.submitter_id is distinct from v_caller or r.kind <> 'search' then raise exception 'This search record is not available to you.'; end if;
  if public.handover_open_duty(v_caller, r.station) is null then raise exception 'You must be checked in for duty to record an aircraft search.'; end if;
  if r.finished_at is not null then raise exception 'This search was already finished.'; end if;
  if r.sec029_id is not null then raise exception 'This search is already attached to a submitted report.'; end if;
  if not v_fix and char_length(btrim(coalesce(p_unavailable_reason, ''))) < 5 then raise exception 'A reason is required when location is unavailable.'; end if;

  v_min := public.aircraft_search_minimum_minutes(r.aircraft_type);
  v_minutes := round(extract(epoch from (v_now - r.started_at)) / 60.0, 2);
  v_below := v_min is not null and (v_now - r.started_at) < make_interval(mins => v_min);
  v_presence := case when v_fix and r.start_lat is not null then 'reported' else 'unverified' end;

  update public.aircraft_search_records
     set finished_at = v_now, finish_lat = case when v_fix then p_lat end, finish_lng = case when v_fix then p_lng end, finish_accuracy_m = case when v_fix then p_accuracy_m end,
         gps_unavailable_reason = nullif(btrim(concat_ws(' | ', gps_unavailable_reason, case when v_fix then null else btrim(p_unavailable_reason) end)), ''),
         presence_status = v_presence, duration_minutes = v_minutes, below_minimum = v_below
   where id = r.id;
  perform public.phase8_write_audit('aircraft_search_finished', 'aircraft_search', r.id, jsonb_build_object('minutes', v_minutes, 'below_minimum', v_below, 'presence', v_presence));
  return query select v_minutes, v_below, v_min, v_presence;
end;
$function$;
revoke execute on function public.finish_aircraft_search_secure(uuid, double precision, double precision, double precision, text) from public, anon;
grant execute on function public.finish_aircraft_search_secure(uuid, double precision, double precision, double precision, text) to authenticated, service_role;
