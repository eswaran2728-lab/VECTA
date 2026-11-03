-- Aircraft Search Verification (product owner approval 2026-11-03). See docs/superpowers/plans/2026-11-03-aircraft-search-verification.md.
--
-- * A search is required for a departure only when the aircraft was on ground 4 h or more, had a night stop (on ground across 00:00 Malaysia time) or was
--   towed from a hangar.
-- * The officer's search is recorded with SERVER time and reported GPS at its start and finish. GPS is reported-location evidence, never proof of physical
--   presence. Without GPS the SEC029 is still accepted with a required reason, presence is 'unverified' and it goes to review.
-- * A different on-duty SO/SSO/DSE of the same station and entity reviews it. SEC029 submission alone never clears the Bay Board search; the states are
--   pending, confirmed and exception. Historical SEC029 are never marked GPS verified.
-- * At SEC016 departure both gaps (SEC029 submission to the staff-entered STD, and to SEC016 submission) are computed and flagged under 45 min (AK) / 90 min
--   (D7); a missing or late search is recorded and escalated to the reviewer. Nothing here blocks the SEC016 itself.

alter table public.bay_board add column if not exists towed_from_hangar boolean not null default false;
alter table public.bay_board add column if not exists search_state text not null default 'pending';
alter table public.bay_board add column if not exists search_reasons text[] not null default '{}';
alter table public.bay_board add column if not exists departed_without_confirmed_search boolean not null default false;
alter table public.bay_board add constraint bay_board_search_state_check check (search_state in ('not_required', 'pending', 'submitted', 'confirmed', 'exception'));

create table if not exists public.aircraft_search_records (
  id uuid primary key default gen_random_uuid(),
  kind text not null default 'search' check (kind in ('search', 'missing')),
  station text not null,
  entity text not null,
  flight text not null,
  registration text not null,
  aircraft_type text,
  submitter_id uuid references public.profiles(id),
  sec029_id uuid unique references public.report_sec029(id),
  started_at timestamptz,
  start_lat double precision,
  start_lng double precision,
  start_accuracy_m double precision,
  finished_at timestamptz,
  finish_lat double precision,
  finish_lng double precision,
  finish_accuracy_m double precision,
  gps_unavailable_reason text,
  presence_status text not null default 'historical_unverified' check (presence_status in ('reported', 'unverified', 'historical_unverified')),
  duration_minutes numeric,
  below_minimum boolean not null default false,
  below_minimum_reason text,
  review_state text not null default 'pending' check (review_state in ('pending', 'confirmed', 'exception')),
  reviewed_by uuid references public.profiles(id),
  reviewed_at timestamptz,
  review_note text,
  departure_report_id uuid references public.report_sec016(id),
  required_reasons text[] not null default '{}',
  std_entered time,
  std_gap_minutes numeric,
  departure_gap_minutes numeric,
  late_flag boolean not null default false,
  late_reason text,
  duplicate_ids uuid[] not null default '{}',
  created_at timestamptz not null default now()
);
create index if not exists aircraft_search_records_station_idx on public.aircraft_search_records (station, created_at desc);
create index if not exists aircraft_search_records_lookup_idx on public.aircraft_search_records (station, upper(registration), upper(flight));
alter table public.aircraft_search_records enable row level security;
revoke all on public.aircraft_search_records from public, anon, authenticated;
grant select on public.aircraft_search_records to authenticated;
grant all on public.aircraft_search_records to service_role;
create policy "aircraft_search_records station read" on public.aircraft_search_records for select to authenticated
  using (canon_station_visible(station));

-- ---------------------------------------------------------------------------------------------------------------------------------------------------------
-- Internal helpers
-- ---------------------------------------------------------------------------------------------------------------------------------------------------------

create or replace function public.aircraft_search_valid_fix(p_lat double precision, p_lng double precision, p_accuracy double precision)
returns boolean
language sql
immutable
set search_path to 'public'
as $function$
  select p_lat is not null and p_lng is not null and p_accuracy is not null
     and p_lat between -90 and 90 and p_lng between -180 and 180 and p_accuracy >= 0 and p_accuracy < 100000;
$function$;

create or replace function public.aircraft_search_minimum_minutes(p_type text)
returns integer
language sql
immutable
set search_path to 'public'
as $function$
  select case upper(regexp_replace(coalesce(p_type, ''), '\s+', '', 'g')) when 'A320' then 30 when 'A321' then 30 when 'A330' then 45 else null end;
$function$;

-- 'AK' for MAA and 'D7' for AAX; a flight prefix of AK or D7 decides when it is present.
create or replace function public.aircraft_search_carrier(p_flight text, p_entity text)
returns text
language sql
immutable
set search_path to 'public'
as $function$
  select case when upper(left(btrim(coalesce(p_flight, '')), 2)) in ('AK', 'D7') then upper(left(btrim(p_flight), 2)) when p_entity = 'AAX' then 'D7' else 'AK' end;
$function$;

-- ---------------------------------------------------------------------------------------------------------------------------------------------------------
-- Recording the physical search (called by the SEC029 form at the moment the search starts and finishes)
-- ---------------------------------------------------------------------------------------------------------------------------------------------------------

create or replace function public.start_aircraft_search_secure(
  p_flight text, p_registration text, p_station text, p_aircraft_type text,
  p_lat double precision, p_lng double precision, p_accuracy_m double precision, p_unavailable_reason text
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_caller uuid := auth.uid();
  v_entity text;
  v_fix boolean := public.aircraft_search_valid_fix(p_lat, p_lng, p_accuracy_m);
  v_id uuid;
begin
  if v_caller is null then raise exception 'Must be signed in.'; end if;
  if not exists (select 1 from public.profiles where id = v_caller and status = 'approved') then raise exception 'Only an approved account may record an aircraft search.'; end if;
  if btrim(coalesce(p_flight, '')) = '' or btrim(coalesce(p_registration, '')) = '' or btrim(coalesce(p_station, '')) = '' then raise exception 'Station, flight and registration are required.'; end if;
  if p_station is distinct from public.current_station() then raise exception 'You can only record a search at your own station.'; end if;
  if public.handover_open_duty(v_caller, p_station) is null then raise exception 'You must be checked in for duty to record an aircraft search.'; end if;
  v_entity := public.leave_submitter_entity(v_caller);
  if v_entity is null then raise exception 'Your operating entity could not be determined. Ask an administrator to correct your entity membership.'; end if;
  if not v_fix and char_length(btrim(coalesce(p_unavailable_reason, ''))) < 5 then raise exception 'A reason is required when location is unavailable.'; end if;

  select r.id into v_id from public.aircraft_search_records r
   where r.submitter_id = v_caller and r.kind = 'search' and r.finished_at is null and r.sec029_id is null
     and upper(r.registration) = upper(btrim(p_registration)) and upper(r.flight) = upper(btrim(p_flight)) and r.station = p_station
     and r.started_at > clock_timestamp() - interval '12 hours'
   order by r.started_at desc limit 1;
  if v_id is not null then return v_id; end if;

  insert into public.aircraft_search_records (station, entity, flight, registration, aircraft_type, submitter_id, started_at, start_lat, start_lng, start_accuracy_m, gps_unavailable_reason, presence_status)
  values (p_station, v_entity, upper(btrim(p_flight)), upper(btrim(p_registration)), p_aircraft_type, v_caller, clock_timestamp(),
          case when v_fix then p_lat end, case when v_fix then p_lng end, case when v_fix then p_accuracy_m end,
          case when v_fix then null else btrim(p_unavailable_reason) end, case when v_fix then 'reported' else 'unverified' end)
  returning id into v_id;
  perform public.phase8_write_audit('aircraft_search_started', 'aircraft_search', v_id, jsonb_build_object('flight', upper(btrim(p_flight)), 'registration', upper(btrim(p_registration)), 'gps', v_fix));
  return v_id;
end;
$function$;

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

-- Called by the SEC029 submit action right after the report row exists. Links the evidence, requires a reason when the search was short or location was
-- unavailable, and puts the search on the Bay Board as SUBMITTED (not cleared): only a reviewer's confirmation clears it.
create or replace function public.attach_search_to_sec029(p_sec029_id uuid, p_record_id uuid, p_below_minimum_reason text, p_gps_reason text)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_caller uuid := auth.uid();
  s record;
  r record;
  v_entity text;
  v_id uuid;
begin
  if v_caller is null then raise exception 'Must be signed in.'; end if;
  select * into s from public.report_sec029 where id = p_sec029_id;
  if s.id is null or s.profile_id <> v_caller then raise exception 'This SEC029 is not available to you.'; end if;

  if p_record_id is not null then
    select * into r from public.aircraft_search_records where id = p_record_id for update;
    if r.id is null or r.submitter_id is distinct from v_caller or r.kind <> 'search' then raise exception 'This search record is not available to you.'; end if;
    if r.sec029_id is not null then raise exception 'This search record was already used by another report.'; end if;
    if r.finished_at is null then raise exception 'Finish the search before submitting the report.'; end if;
    if upper(r.registration) <> upper(btrim(s.aircraft_registration)) or upper(r.flight) <> upper(btrim(s.flight_no)) or r.station <> s.station then
      raise exception 'The recorded search is for a different flight or aircraft than this report.';
    end if;
    if r.below_minimum and char_length(btrim(coalesce(p_below_minimum_reason, ''))) < 5 then raise exception 'The search was shorter than the minimum duration: a reason is required.'; end if;
    update public.aircraft_search_records
       set sec029_id = s.id, aircraft_type = coalesce(aircraft_type, s.aircraft_type), below_minimum_reason = nullif(btrim(coalesce(p_below_minimum_reason, '')), ''),
           review_state = 'pending'
     where id = r.id;
    v_id := r.id;
  else
    -- no live evidence (offline, or location refused before the search started): accepted with a reason, presence unverified, times not recorded
    if char_length(btrim(coalesce(p_gps_reason, ''))) < 5 then raise exception 'A reason is required when the search start and finish could not be recorded.'; end if;
    v_entity := coalesce(s.operating_entity_code, public.leave_submitter_entity(v_caller));
    if v_entity is null then raise exception 'Your operating entity could not be determined.'; end if;
    insert into public.aircraft_search_records (station, entity, flight, registration, aircraft_type, submitter_id, sec029_id, gps_unavailable_reason, presence_status, review_state)
    values (s.station, v_entity, upper(btrim(s.flight_no)), upper(btrim(s.aircraft_registration)), s.aircraft_type, v_caller, s.id, btrim(p_gps_reason), 'unverified', 'pending')
    returning id into v_id;
  end if;

  -- SEC029 alone never clears the board: it shows SUBMITTED until a reviewer confirms
  update public.bay_board set search_state = 'submitted'
   where station = s.station and upper(reg_no) = upper(btrim(s.aircraft_registration)) and cleared_at is null and search_state in ('pending', 'submitted');
  perform public.phase8_write_audit('aircraft_search_submitted', 'aircraft_search', v_id, jsonb_build_object('sec029_id', s.id));
  return v_id;
end;
$function$;

-- ---------------------------------------------------------------------------------------------------------------------------------------------------------
-- Review
-- ---------------------------------------------------------------------------------------------------------------------------------------------------------

create or replace function public.aircraft_search_refuse(p_id uuid, p_code text, p_message text)
returns table (ok boolean, code text, message text)
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  perform public.phase8_write_audit('aircraft_search_review_refused', 'aircraft_search', p_id, jsonb_build_object('code', p_code));
  return query select false, p_code, p_message;
end;
$function$;

create or replace function public.review_aircraft_search_secure(p_record_id uuid, p_decision text, p_note text)
returns table (ok boolean, code text, message text)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_caller uuid := auth.uid();
  r record;
  s record;
  me record;
  v_dep uuid;
  v_note text := btrim(coalesce(p_note, ''));
  v_flagged boolean;
  v_role text;
begin
  if v_caller is null then raise exception 'Must be signed in.'; end if;
  if p_decision not in ('confirm', 'exception') then raise exception 'Decision must be confirm or exception.'; end if;
  select * into r from public.aircraft_search_records where id = p_record_id for update;
  if r.id is null then return query select false, 'NOT_FOUND', 'Search record not found.'; return; end if;
  select * into me from public.profiles where id = v_caller and status = 'approved';
  if me.id is null then return query select * from public.aircraft_search_refuse(r.id, 'NOT_APPROVED', 'Only an approved account may review.'); return; end if;

  select rd.code into v_role
    from public.user_role_assignments ura join public.role_definitions rd on rd.id = ura.role_definition_id and rd.is_active and rd.code in ('so', 'sso', 'dse')
    join public.org_stations st on st.id = ura.station_id and st.code = r.station
   where ura.profile_id = v_caller and ura.revoked_at is null and ura.starts_at <= now() and (ura.ends_at is null or ura.ends_at > now())
   order by rd.code limit 1;
  if v_role is null then return query select * from public.aircraft_search_refuse(r.id, 'NOT_ELIGIBLE', 'Only an SO, SSO or DSE of this station may review an aircraft search.'); return; end if;
  if public.leave_submitter_entity(v_caller) is distinct from r.entity then return query select * from public.aircraft_search_refuse(r.id, 'WRONG_ENTITY', 'The reviewer must belong to the same operating entity.'); return; end if;
  if public.handover_open_duty(v_caller, r.station) is null then return query select * from public.aircraft_search_refuse(r.id, 'OFF_DUTY', 'The reviewer must be checked in for duty.'); return; end if;

  select * into s from public.report_sec029 where id = r.sec029_id;
  select profile_id into v_dep from public.report_sec016 where id = r.departure_report_id;
  if v_caller = r.submitter_id then return query select * from public.aircraft_search_refuse(r.id, 'SELF_REVIEW', 'You cannot review your own search.'); return; end if;
  if s.id is not null and nullif(upper(btrim(s.assisted_by_id)), '') is not null and upper(btrim(s.assisted_by_id)) = upper(btrim(coalesce(me.staff_no, ''))) then
    return query select * from public.aircraft_search_refuse(r.id, 'ASSISTANT', 'The assisting officer cannot review the search.'); return;
  end if;
  if v_dep is not null and v_dep = v_caller then return query select * from public.aircraft_search_refuse(r.id, 'DEPARTURE_SUBMITTER', 'The officer who filed the departure cannot review the search.'); return; end if;
  if r.reviewed_at is not null then return query select * from public.aircraft_search_refuse(r.id, 'ALREADY_DECIDED', 'This search has already been reviewed.'); return; end if;
  if r.kind = 'missing' and p_decision = 'confirm' then return query select * from public.aircraft_search_refuse(r.id, 'NO_SEARCH', 'There is no search to confirm. Record an exception with a note.'); return; end if;

  v_flagged := r.late_flag or r.below_minimum or r.presence_status <> 'reported' or coalesce(array_length(r.duplicate_ids, 1), 0) > 0;
  if (p_decision = 'exception' or v_flagged) and char_length(v_note) < 5 then
    return query select * from public.aircraft_search_refuse(r.id, 'NOTE_REQUIRED', 'A note of at least 5 characters is required for an exception or a flagged search.'); return;
  end if;

  update public.aircraft_search_records
     set review_state = case when p_decision = 'confirm' then 'confirmed' else 'exception' end, reviewed_by = v_caller, reviewed_at = clock_timestamp(), review_note = nullif(v_note, '')
   where id = r.id;

  update public.bay_board b
     set search_state = case when p_decision = 'confirm' then 'confirmed' else 'exception' end,
         cleared_at = case when p_decision = 'confirm' and b.departed_without_confirmed_search then clock_timestamp() else b.cleared_at end,
         cleared_by_report_id = case when p_decision = 'confirm' and b.departed_without_confirmed_search then b.departure_report_id else b.cleared_by_report_id end
   where b.station = r.station and upper(b.reg_no) = upper(r.registration) and (b.cleared_at is null);

  perform public.phase8_write_audit('aircraft_search_reviewed', 'aircraft_search', r.id, jsonb_build_object('decision', p_decision, 'flagged', v_flagged));
  return query select true, 'OK', case when p_decision = 'confirm' then 'Search confirmed.' else 'Exception recorded.' end;
end;
$function$;

-- ---------------------------------------------------------------------------------------------------------------------------------------------------------
-- SEC016 departure: requirement, linking, both gaps, escalation
-- ---------------------------------------------------------------------------------------------------------------------------------------------------------

create or replace function public.aircraft_search_departure_assessment(
  p_station text, p_entity text, p_registration text, p_flight text, p_sta_std time, p_aircraft_type text, p_towed boolean, p_departure_at timestamptz, p_exclude_departure uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  b record;
  v_ground_since timestamptz;
  v_reasons text[] := '{}';
  v_req boolean;
  v_towed boolean;
  v_match uuid;
  v_dups uuid[];
  v_search_at timestamptz;
  v_std timestamptz;
  v_carrier text := public.aircraft_search_carrier(p_flight, p_entity);
  v_threshold integer := case when public.aircraft_search_carrier(p_flight, p_entity) = 'D7' then 90 else 45 end;
  v_gap_std numeric;
  v_gap_dep numeric;
  v_day date := (p_departure_at at time zone 'Asia/Kuala_Lumpur')::date;
begin
  select * into b from public.bay_board where station = p_station and upper(reg_no) = upper(btrim(p_registration)) and cleared_at is null order by on_ground_since desc limit 1;
  v_ground_since := b.on_ground_since;
  v_towed := coalesce(p_towed, false) or coalesce(b.towed_from_hangar, false);
  if v_ground_since is not null and p_departure_at - v_ground_since >= interval '4 hours' then v_reasons := v_reasons || 'ground_4h'; end if;
  if v_ground_since is not null and (p_departure_at at time zone 'Asia/Kuala_Lumpur')::date > (v_ground_since at time zone 'Asia/Kuala_Lumpur')::date then v_reasons := v_reasons || 'night_stop'; end if;
  if v_towed then v_reasons := v_reasons || 'towed_from_hangar'; end if;
  v_req := coalesce(array_length(v_reasons, 1), 0) > 0;

  select m.id, m.dups, m.submitted_at into v_match, v_dups, v_search_at from (
    select (array_agg(r.id order by s.submitted_at))[1] id, (array_agg(r.id order by s.submitted_at))[2:] dups, min(s.submitted_at) submitted_at
      from public.aircraft_search_records r join public.report_sec029 s on s.id = r.sec029_id
     where r.kind = 'search' and r.station = p_station and r.entity = p_entity and upper(r.flight) = upper(btrim(p_flight)) and upper(r.registration) = upper(btrim(p_registration))
       and (r.departure_report_id is null or r.departure_report_id = p_exclude_departure)
       and s.submitted_at <= p_departure_at and s.submitted_at >= coalesce(v_ground_since, p_departure_at - interval '24 hours')
  ) m;

  if v_match is not null and p_sta_std is not null then
    -- the STD is a time of day: take the Malaysia date that puts it nearest the departure submission
    select z.c into v_std from (
      select ((dd + p_sta_std) at time zone 'Asia/Kuala_Lumpur') as c from unnest(array[v_day - 1, v_day, v_day + 1]) dd
       order by abs(extract(epoch from (((dd + p_sta_std) at time zone 'Asia/Kuala_Lumpur') - p_departure_at))) limit 1
    ) z;
    v_gap_std := round(extract(epoch from (v_std - v_search_at)) / 60.0, 2);
  end if;
  if v_match is not null then v_gap_dep := round(extract(epoch from (p_departure_at - v_search_at)) / 60.0, 2); end if;

  return jsonb_build_object(
    'required', v_req, 'reasons', to_jsonb(v_reasons), 'towed', v_towed, 'carrier', v_carrier, 'threshold_minutes', v_threshold,
    'linked_record_id', v_match, 'duplicate_ids', coalesce(to_jsonb(v_dups), '[]'::jsonb), 'search_submitted_at', v_search_at,
    'std_gap_minutes', v_gap_std, 'departure_gap_minutes', v_gap_dep,
    'std_flag', coalesce(v_gap_std < v_threshold, false), 'departure_flag', coalesce(v_gap_dep < v_threshold, false),
    'missing', v_req and v_match is null,
    'flagged', v_req and (v_match is null or coalesce(v_gap_std < v_threshold, false) or coalesce(v_gap_dep < v_threshold, false))
  );
end;
$function$;

-- The SEC016 form shows this before submit: requirement, both gaps (with the entered STD), and whether a reason is required.
create or replace function public.preview_departure_search_secure(p_station text, p_registration text, p_flight text, p_sta_std time, p_aircraft_type text, p_towed boolean)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_entity text := public.leave_submitter_entity(auth.uid());
begin
  if auth.uid() is null then raise exception 'Must be signed in.'; end if;
  if v_entity is null then return jsonb_build_object('required', false, 'error', 'entity_unknown'); end if;
  return public.aircraft_search_departure_assessment(p_station, v_entity, p_registration, p_flight, p_sta_std, p_aircraft_type, p_towed, clock_timestamp(), null);
end;
$function$;

-- Applied by the SEC016 submit action right after the departure row exists. Writes the gaps/escalation, a 'missing' record when a required search is absent, and
-- clears the Bay Board only when no search is required or the search is confirmed. Never raises for a late or missing search.
create or replace function public.apply_departure_search_rules(p_departure_id uuid, p_towed boolean, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_caller uuid := auth.uid();
  d record;
  a jsonb;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_rec uuid;
  v_confirmed boolean := false;
  v_keep boolean;
begin
  if v_caller is null then raise exception 'Must be signed in.'; end if;
  select * into d from public.report_sec016 where id = p_departure_id;
  if d.id is null or d.profile_id <> v_caller or d.flight_type <> 'departure' then raise exception 'This departure is not available to you.'; end if;
  a := public.aircraft_search_departure_assessment(d.station, coalesce(d.operating_entity_code, public.leave_submitter_entity(v_caller), ''), d.reg_no, d.flight, d.sta_std, d.aircraft_type, p_towed, d.submitted_at, d.id);

  if (a ->> 'linked_record_id') is not null then
    v_rec := (a ->> 'linked_record_id')::uuid;
    update public.aircraft_search_records
       set departure_report_id = d.id, required_reasons = array(select jsonb_array_elements_text(a -> 'reasons')), std_entered = d.sta_std,
           std_gap_minutes = nullif(a ->> 'std_gap_minutes', '')::numeric, departure_gap_minutes = nullif(a ->> 'departure_gap_minutes', '')::numeric,
           late_flag = (a ->> 'std_flag')::boolean or (a ->> 'departure_flag')::boolean, late_reason = coalesce(v_reason, late_reason),
           duplicate_ids = array(select jsonb_array_elements_text(a -> 'duplicate_ids'))::uuid[]
     where id = v_rec;
    select (review_state = 'confirmed') into v_confirmed from public.aircraft_search_records where id = v_rec;
  elsif (a ->> 'required')::boolean then
    insert into public.aircraft_search_records (kind, station, entity, flight, registration, aircraft_type, submitter_id, departure_report_id, required_reasons, std_entered, late_flag, late_reason, review_state, presence_status)
    values ('missing', d.station, coalesce(d.operating_entity_code, ''), upper(btrim(d.flight)), upper(btrim(d.reg_no)), d.aircraft_type, v_caller, d.id,
            array(select jsonb_array_elements_text(a -> 'reasons')), d.sta_std, true, v_reason, 'exception', 'unverified')
    returning id into v_rec;
  end if;

  v_keep := (a ->> 'required')::boolean and not v_confirmed;
  update public.bay_board
     set search_reasons = array(select jsonb_array_elements_text(a -> 'reasons')),
         towed_from_hangar = towed_from_hangar or coalesce(p_towed, false),
         departure_report_id = d.id,
         departed_without_confirmed_search = v_keep,
         search_state = case when not (a ->> 'required')::boolean then 'not_required' when v_confirmed then 'confirmed' when (a ->> 'missing')::boolean then 'exception' else search_state end,
         cleared_at = case when v_keep then null else clock_timestamp() end,
         cleared_by_report_id = case when v_keep then null else d.id end
   where station = d.station and upper(reg_no) = upper(btrim(d.reg_no)) and cleared_at is null;

  perform public.phase8_write_audit('aircraft_search_departure_evaluated', 'aircraft_search', coalesce(v_rec, d.id), jsonb_build_object('departure_id', d.id, 'assessment', a));
  return a || jsonb_build_object('record_id', v_rec, 'kept_on_board', v_keep);
end;
$function$;

-- ---------------------------------------------------------------------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------------------------------------------------------------------

revoke execute on function public.aircraft_search_valid_fix(double precision, double precision, double precision) from public, anon, authenticated;
revoke execute on function public.aircraft_search_minimum_minutes(text) from public, anon, authenticated;
revoke execute on function public.aircraft_search_carrier(text, text) from public, anon, authenticated;
revoke execute on function public.aircraft_search_refuse(uuid, text, text) from public, anon, authenticated;
revoke execute on function public.aircraft_search_departure_assessment(text, text, text, text, time, text, boolean, timestamptz, uuid) from public, anon, authenticated;
grant execute on function public.aircraft_search_valid_fix(double precision, double precision, double precision) to service_role;
grant execute on function public.aircraft_search_minimum_minutes(text) to service_role;
grant execute on function public.aircraft_search_carrier(text, text) to service_role;
grant execute on function public.aircraft_search_refuse(uuid, text, text) to service_role;
grant execute on function public.aircraft_search_departure_assessment(text, text, text, text, time, text, boolean, timestamptz, uuid) to service_role;

revoke execute on function public.start_aircraft_search_secure(text, text, text, text, double precision, double precision, double precision, text) from public, anon;
revoke execute on function public.finish_aircraft_search_secure(uuid, double precision, double precision, double precision, text) from public, anon;
revoke execute on function public.attach_search_to_sec029(uuid, uuid, text, text) from public, anon;
revoke execute on function public.review_aircraft_search_secure(uuid, text, text) from public, anon;
revoke execute on function public.preview_departure_search_secure(text, text, text, time, text, boolean) from public, anon;
revoke execute on function public.apply_departure_search_rules(uuid, boolean, text) from public, anon;
grant execute on function public.start_aircraft_search_secure(text, text, text, text, double precision, double precision, double precision, text) to authenticated, service_role;
grant execute on function public.finish_aircraft_search_secure(uuid, double precision, double precision, double precision, text) to authenticated, service_role;
grant execute on function public.attach_search_to_sec029(uuid, uuid, text, text) to authenticated, service_role;
grant execute on function public.review_aircraft_search_secure(uuid, text, text) to authenticated, service_role;
grant execute on function public.preview_departure_search_secure(text, text, text, time, text, boolean) to authenticated, service_role;
grant execute on function public.apply_departure_search_rules(uuid, boolean, text) to authenticated, service_role;
