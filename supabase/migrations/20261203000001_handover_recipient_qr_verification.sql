-- Optional, named, recipient-bound shift handover with a single-use QR challenge and an atomic completion record (product owner approval 2026-11-03).
--
-- Intent: handover is optional and never required to check out. The outgoing officer's identity comes from the session; the recipient is named by staff ID,
-- resolved to a unique, approved, active, shift-based officer at the SAME station (any team) who is not the sender. Only that recipient can acknowledge.
-- Completion needs both officers checked in, a server-issued 60-second single-use QR challenge scanned by the recipient, and two FRESH browser locations (captured
-- within 30 s, accuracy <= 50 m, each inside an active duty zone of the station, and within 50 m of each other). One transaction consumes the challenge and records the
-- evidence. A failed or expired check leaves the handover pending. If the outgoing officer checks out first, or the duty date ends, it is shown as Uncompleted and never
-- transfers responsibility. Historical handovers keep their data and are marked historical; they are not retroactively treated as verified in person.
--
-- Honesty note: browser location plus a QR makes remote acknowledgment hard. It cannot prove a face-to-face meeting against collusion or location spoofing, and the
-- stored evidence says exactly that.
--
-- Clients can no longer INSERT or freely UPDATE shift_handovers: every change goes through the security-definer functions below.

alter table public.shift_handovers add column if not exists recipient_profile_id uuid references public.profiles(id);
alter table public.shift_handovers add column if not exists recipient_staff_id text;
alter table public.shift_handovers add column if not exists recipient_name text;
alter table public.shift_handovers add column if not exists handover_status text not null default 'historical';
alter table public.shift_handovers add column if not exists outgoing_duty_record_id uuid references public.duty_records(id) on delete set null;
alter table public.shift_handovers add column if not exists challenge_hash text;
alter table public.shift_handovers add column if not exists challenge_issued_at timestamptz;
alter table public.shift_handovers add column if not exists challenge_expires_at timestamptz;
alter table public.shift_handovers add column if not exists challenge_consumed_at timestamptz;
alter table public.shift_handovers add column if not exists sender_lat double precision;
alter table public.shift_handovers add column if not exists sender_lng double precision;
alter table public.shift_handovers add column if not exists sender_accuracy_m double precision;
alter table public.shift_handovers add column if not exists sender_location_at timestamptz;
alter table public.shift_handovers add column if not exists completed_at timestamptz;
alter table public.shift_handovers add column if not exists verification jsonb;

alter table public.shift_handovers add constraint shift_handovers_status_check check (handover_status in ('historical', 'pending', 'completed'));
alter table public.shift_handovers add constraint shift_handovers_completed_check check (
  handover_status <> 'completed' or (recipient_profile_id is not null and acknowledged_by = recipient_profile_id and completed_at is not null and challenge_consumed_at is not null)
);
create index if not exists shift_handovers_recipient_idx on public.shift_handovers (recipient_profile_id) where recipient_profile_id is not null;

-- ---------------------------------------------------------------------------------------------------------------------------------------------------------
-- Internal helpers (executable by no client role)
-- ---------------------------------------------------------------------------------------------------------------------------------------------------------

-- The distinct (station, team) pairs of a person's ACTIVE shift-based, station-scoped canonical assignments in the Malaysia AOC.
create or replace function public.handover_profile_scopes(p_profile uuid)
returns table (station_code text, team_name text)
language sql
stable
security definer
set search_path to 'public'
as $function$
  select distinct s.code::text, t.name::text
  from public.user_role_assignments ura
  join public.role_definitions rd on rd.id = ura.role_definition_id and rd.is_active
  join public.profiles p on p.id = ura.profile_id and p.status = 'approved'
  join public.aocs a on a.id = ura.aoc_id and a.code = 'MY'
  join public.org_stations s on s.id = ura.station_id
  left join public.org_teams t on t.id = ura.team_id
  where ura.profile_id = p_profile
    and rd.code in ('aso', 'so', 'sso', 'dse', 'sat_aso', 'profiling_so', 'profiling_aso')
    and ura.revoked_at is null
    and ura.starts_at <= now()
    and (ura.ends_at is null or ura.ends_at > now());
$function$;

-- The open duty record (checked in, not checked out) of a person at a station, or null.
create or replace function public.handover_open_duty(p_profile uuid, p_station text)
returns uuid
language sql
stable
security definer
set search_path to 'public'
as $function$
  select d.id
  from public.duty_records d
  where d.profile_id = p_profile
    and d.station = p_station
    and d.check_in_at is not null
    and d.check_out_at is null
    and d.duty_date >= (now() at time zone 'Asia/Kuala_Lumpur')::date - 1
  order by d.check_in_at desc
  limit 1;
$function$;

-- The code of the first ACTIVE duty zone of the station that contains the point (GeoJSON polygon, [lng, lat] ring), or null.
create or replace function public.handover_point_zone(p_station text, p_lat double precision, p_lng double precision)
returns text
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  z record;
  ring jsonb;
  n integer;
  i integer;
  j integer;
  xi double precision; yi double precision; xj double precision; yj double precision;
  inside boolean;
begin
  for z in select code, polygon from public.duty_zones where station = p_station and active loop
    ring := z.polygon -> 'coordinates' -> 0;
    if ring is null or jsonb_typeof(ring) <> 'array' then continue; end if;
    n := jsonb_array_length(ring);
    if n < 3 then continue; end if;
    inside := false;
    j := n - 1;
    for i in 0 .. n - 1 loop
      xi := (ring -> i ->> 0)::double precision; yi := (ring -> i ->> 1)::double precision;
      xj := (ring -> j ->> 0)::double precision; yj := (ring -> j ->> 1)::double precision;
      if (yi > p_lat) <> (yj > p_lat) and p_lng < (xj - xi) * (p_lat - yi) / (yj - yi) + xi then
        inside := not inside;
      end if;
      j := i;
    end loop;
    if inside then return z.code; end if;
  end loop;
  return null;
end;
$function$;

create or replace function public.handover_distance_m(p_lat1 double precision, p_lng1 double precision, p_lat2 double precision, p_lng2 double precision)
returns double precision
language sql
immutable
set search_path to 'public'
as $function$
  select 2 * 6371000 * asin(sqrt(
    power(sin(radians(p_lat2 - p_lat1) / 2), 2)
    + cos(radians(p_lat1)) * cos(radians(p_lat2)) * power(sin(radians(p_lng2 - p_lng1) / 2), 2)
  ));
$function$;

-- Records the failed check (audit) and returns the user-facing refusal. The record stays pending and the challenge stays valid until it expires.
create or replace function public.handover_refuse(p_id uuid, p_code text, p_message text, p_distance double precision default null)
returns table (ok boolean, code text, message text, distance_m numeric)
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  perform public.phase8_write_audit('handover_verification_failed', 'shift_handover', p_id, jsonb_build_object('code', p_code));
  return query select false, p_code, p_message, round(p_distance::numeric, 1);
end;
$function$;

-- Derived status: pending becomes Uncompleted once the sender has checked out, or when the Malaysia date is more than one day after the sender's duty date.
create or replace function public.handover_effective_status(p_id uuid)
returns text
language sql
stable
security definer
set search_path to 'public'
as $function$
  select case
    when h.handover_status <> 'pending' then h.handover_status
    when d.check_out_at is not null then 'uncompleted'
    when ((now() at time zone 'Asia/Kuala_Lumpur')::date - coalesce(d.duty_date, (h.created_at at time zone 'Asia/Kuala_Lumpur')::date)) > 1 then 'uncompleted'
    else 'pending'
  end
  from public.shift_handovers h
  left join public.duty_records d on d.id = h.outgoing_duty_record_id
  where h.id = p_id;
$function$;

-- ---------------------------------------------------------------------------------------------------------------------------------------------------------
-- Client-callable functions
-- ---------------------------------------------------------------------------------------------------------------------------------------------------------

-- Resolves a staff ID to ONE eligible receiving officer. Every non-self failure gives the same answer so nothing about other officers leaks.
create or replace function public.resolve_handover_recipient_secure(p_staff_no text)
returns table (recipient_profile_id uuid, display_name text)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_caller uuid := auth.uid();
  v_station text;
  v_n integer;
  v_staff text := upper(btrim(coalesce(p_staff_no, '')));
  v_match uuid;
  v_name text;
  v_matches integer;
begin
  if v_caller is null then raise exception 'Must be signed in.'; end if;
  if v_staff = '' then raise exception 'Enter the receiving officer''s staff ID.'; end if;
  select count(*)::integer, min(station_code) into v_n, v_station from public.handover_profile_scopes(v_caller);
  if v_n = 0 then raise exception 'Handover is available to shift-based officers with a station assignment.'; end if;
  if v_n > 1 then raise exception 'Your station and team assignment is ambiguous, so a handover cannot be filed. Ask an administrator to correct it.'; end if;
  if public.handover_open_duty(v_caller, v_station) is null then raise exception 'You must be checked in for duty to file a handover.'; end if;

  select count(*)::integer into v_matches from public.profiles pr where pr.status = 'approved' and upper(btrim(coalesce(pr.staff_no, ''))) = v_staff;
  if v_matches = 1 then
    select pr.id, pr.name into v_match, v_name from public.profiles pr where pr.status = 'approved' and upper(btrim(coalesce(pr.staff_no, ''))) = v_staff;
    if v_match = v_caller then raise exception 'You cannot hand over to yourself.'; end if;
    if exists (select 1 from public.handover_profile_scopes(v_match) sc where sc.station_code = v_station)
       and (select count(*) from public.handover_profile_scopes(v_match)) = 1 then
      return query select v_match, v_name;
      return;
    end if;
  end if;
  raise exception 'No unique active officer with that staff ID at your station.';
end;
$function$;

create or replace function public.file_handover_secure(
  p_recipient_staff_no text,
  p_place_category text,
  p_place_detail text,
  p_flight_number text,
  p_handover_notes text,
  p_unfinished jsonb
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_caller uuid := auth.uid();
  v_station text;
  v_team text;
  v_n integer;
  v_duty uuid;
  v_rec uuid;
  v_rec_name text;
  v_me record;
  v_id uuid;
begin
  if v_caller is null then raise exception 'Must be signed in.'; end if;
  if p_place_category is null or p_place_category not in ('Bay', 'Premises', 'Terminal') then raise exception 'Select a place category.'; end if;
  if btrim(coalesce(p_place_detail, '')) = '' or btrim(coalesce(p_handover_notes, '')) = '' then raise exception 'Place and handover notes are required.'; end if;
  if length(p_handover_notes) > 4000 or length(p_place_detail) > 200 then raise exception 'Handover text is too long.'; end if;

  select count(*)::integer, min(station_code), min(team_name) into v_n, v_station, v_team from public.handover_profile_scopes(v_caller);
  if v_n <> 1 then raise exception 'Your station and team assignment is missing or ambiguous, so a handover cannot be filed.'; end if;
  v_duty := public.handover_open_duty(v_caller, v_station);
  if v_duty is null then raise exception 'You must be checked in for duty to file a handover.'; end if;

  select r.recipient_profile_id, r.display_name into v_rec, v_rec_name from public.resolve_handover_recipient_secure(p_recipient_staff_no) r;
  if v_rec is null then raise exception 'No unique active officer with that staff ID at your station.'; end if;

  select pr.name, pr.staff_no into v_me from public.profiles pr where pr.id = v_caller;

  insert into public.shift_handovers (
    outgoing_profile_id, station, team, staff_name, staff_id, place_category, place_detail, flight_number, handover_notes, unfinished_work_summary,
    recipient_profile_id, recipient_staff_id, recipient_name, handover_status, outgoing_duty_record_id
  ) values (
    v_caller, v_station, v_team, v_me.name, coalesce(nullif(btrim(v_me.staff_no), ''), '—'), p_place_category, btrim(p_place_detail), nullif(btrim(coalesce(p_flight_number, '')), ''), btrim(p_handover_notes),
    coalesce(p_unfinished, '[]'::jsonb), v_rec, upper(btrim(p_recipient_staff_no)), v_rec_name, 'pending', v_duty
  ) returning id into v_id;

  perform public.notify(v_rec, 'handover_received', 'handover_' || v_id, null, null, null,
    jsonb_build_object('handover_id', v_id, 'from_name', v_me.name, 'station', v_station));
  perform public.phase8_write_audit('handover_filed', 'shift_handover', v_id, jsonb_build_object('station', v_station, 'recipient_profile_id', v_rec));
  return v_id;
end;
$function$;

-- The outgoing officer's phone shows this. Each call replaces the previous challenge. The token is returned once and only its hash is stored.
create or replace function public.issue_handover_challenge_secure(p_handover_id uuid)
returns table (token text, expires_at timestamptz, ttl_seconds integer)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_caller uuid := auth.uid();
  h record;
  v_token text;
  v_exp timestamptz;
begin
  if v_caller is null then raise exception 'Must be signed in.'; end if;
  select * into h from public.shift_handovers where id = p_handover_id for update;
  if h.id is null or h.outgoing_profile_id <> v_caller then raise exception 'This handover is not available to you.'; end if;
  if h.handover_status <> 'pending' or public.handover_effective_status(h.id) <> 'pending' then raise exception 'This handover can no longer be completed.'; end if;
  if public.handover_open_duty(v_caller, h.station) is null then raise exception 'You must be checked in for duty to hand over.'; end if;

  v_token := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  v_exp := clock_timestamp() + interval '60 seconds';
  update public.shift_handovers
     set challenge_hash = encode(sha256(convert_to(v_token, 'UTF8')), 'hex'),
         challenge_issued_at = clock_timestamp(),
         challenge_expires_at = v_exp,
         challenge_consumed_at = null,
         sender_lat = null, sender_lng = null, sender_accuracy_m = null, sender_location_at = null
   where id = h.id;
  perform public.phase8_write_audit('handover_challenge_issued', 'shift_handover', h.id, jsonb_build_object('ttl_seconds', 60));
  return query select v_token, v_exp, 60;
end;
$function$;

-- The outgoing phone keeps pushing its fresh position while the QR is on screen. Freshness is judged by the SERVER receive time.
create or replace function public.submit_handover_sender_location_secure(p_handover_id uuid, p_lat double precision, p_lng double precision, p_accuracy_m double precision)
returns timestamptz
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_caller uuid := auth.uid();
  h record;
  v_at timestamptz := clock_timestamp();
begin
  if v_caller is null then raise exception 'Must be signed in.'; end if;
  if p_lat is null or p_lng is null or p_accuracy_m is null or p_lat not between -90 and 90 or p_lng not between -180 and 180 or p_accuracy_m < 0 or p_accuracy_m > 100000 then
    raise exception 'The location is not valid.';
  end if;
  select * into h from public.shift_handovers where id = p_handover_id for update;
  if h.id is null or h.outgoing_profile_id <> v_caller then raise exception 'This handover is not available to you.'; end if;
  if h.handover_status <> 'pending' or h.challenge_hash is null or h.challenge_consumed_at is not null then raise exception 'There is no active QR code for this handover.'; end if;
  if public.handover_open_duty(v_caller, h.station) is null then raise exception 'You must be checked in for duty to hand over.'; end if;
  update public.shift_handovers set sender_lat = p_lat, sender_lng = p_lng, sender_accuracy_m = p_accuracy_m, sender_location_at = v_at where id = h.id;
  return v_at;
end;
$function$;

-- The recipient's phone calls this after scanning the QR. One transaction: lock the row, check everything, consume the challenge, record the evidence.
-- Expected failures RETURN a refusal (audited) and change nothing else; the handover stays pending.
create or replace function public.complete_handover_secure(
  p_handover_id uuid,
  p_token text,
  p_lat double precision,
  p_lng double precision,
  p_accuracy_m double precision,
  p_captured_at timestamptz,
  p_notes text default null
)
returns table (ok boolean, code text, message text, distance_m numeric)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_caller uuid := auth.uid();
  v_now timestamptz := clock_timestamp();
  h record;
  v_n integer;
  v_station text;
  v_dist double precision;
  v_sz text;
  v_rz text;
begin
  if v_caller is null then raise exception 'Must be signed in.'; end if;
  select * into h from public.shift_handovers where id = p_handover_id for update;
  if h.id is null or h.recipient_profile_id is distinct from v_caller then
    return query select false, 'NOT_AVAILABLE', 'This handover is not available to you.', null::numeric;
    return;
  end if;
  if h.handover_status <> 'pending' then return query select * from public.handover_refuse(h.id, 'NOT_PENDING', 'This handover is already completed.'); return; end if;
  if public.handover_effective_status(h.id) <> 'pending' then return query select * from public.handover_refuse(h.id, 'UNCOMPLETED', 'The outgoing officer has checked out or the duty date has ended. This handover can no longer be completed.'); return; end if;
  if h.challenge_hash is null then return query select * from public.handover_refuse(h.id, 'NO_CHALLENGE', 'There is no QR code to scan yet. Ask the outgoing officer to show one.'); return; end if;
  if h.challenge_consumed_at is not null then return query select * from public.handover_refuse(h.id, 'CONSUMED', 'This QR code was already used.'); return; end if;
  if v_now > h.challenge_expires_at then return query select * from public.handover_refuse(h.id, 'CHALLENGE_EXPIRED', 'The QR code has expired. Ask the outgoing officer to show a new one.'); return; end if;
  if encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex') <> h.challenge_hash then return query select * from public.handover_refuse(h.id, 'BAD_TOKEN', 'This is not the current QR code.'); return; end if;

  if public.handover_open_duty(h.outgoing_profile_id, h.station) is null then return query select * from public.handover_refuse(h.id, 'SENDER_OFF_DUTY', 'The outgoing officer is not checked in for duty.'); return; end if;
  select count(*)::integer, min(station_code) into v_n, v_station from public.handover_profile_scopes(v_caller);
  if v_n <> 1 or v_station is distinct from h.station then return query select * from public.handover_refuse(h.id, 'RECIPIENT_NOT_AT_STATION', 'You are not assigned to this station for handover.'); return; end if;
  if public.handover_open_duty(v_caller, h.station) is null then return query select * from public.handover_refuse(h.id, 'RECIPIENT_OFF_DUTY', 'You must be checked in for duty to receive a handover.'); return; end if;

  if h.sender_location_at is null or h.sender_lat is null or h.sender_lng is null or h.sender_accuracy_m is null or v_now - h.sender_location_at > interval '30 seconds' then
    return query select * from public.handover_refuse(h.id, 'SENDER_LOCATION_STALE', 'The outgoing officer''s location is not fresh. Ask them to keep the QR screen open with location on.'); return;
  end if;
  if p_lat is null or p_lng is null or p_accuracy_m is null or p_captured_at is null or p_lat not between -90 and 90 or p_lng not between -180 and 180
     or v_now - p_captured_at > interval '30 seconds' or p_captured_at > v_now + interval '5 seconds' then
    return query select * from public.handover_refuse(h.id, 'RECIPIENT_LOCATION_STALE', 'Your location is not fresh. Keep location on and scan again.'); return;
  end if;
  if h.sender_accuracy_m < 0 or h.sender_accuracy_m > 50 or p_accuracy_m < 0 or p_accuracy_m > 50 then
    return query select * from public.handover_refuse(h.id, 'ACCURACY', 'A phone''s location is not accurate enough (needs 50 metres or better). Move to open sky and try again.'); return;
  end if;
  v_sz := public.handover_point_zone(h.station, h.sender_lat, h.sender_lng);
  if v_sz is null then return query select * from public.handover_refuse(h.id, 'SENDER_OUTSIDE_ZONE', 'The outgoing officer is not inside a duty zone of this station.'); return; end if;
  v_rz := public.handover_point_zone(h.station, p_lat, p_lng);
  if v_rz is null then return query select * from public.handover_refuse(h.id, 'RECIPIENT_OUTSIDE_ZONE', 'You are not inside a duty zone of this station.'); return; end if;
  v_dist := public.handover_distance_m(h.sender_lat, h.sender_lng, p_lat, p_lng);
  if not (v_dist <= 50) then return query select * from public.handover_refuse(h.id, 'TOO_FAR_APART', 'The two phones are more than 50 metres apart. Both officers must be together.', v_dist); return; end if;

  update public.shift_handovers
     set challenge_consumed_at = v_now,
         handover_status = 'completed',
         acknowledged_by = v_caller,
         acknowledged_at = v_now,
         completed_at = v_now,
         acknowledgment_notes = nullif(btrim(coalesce(p_notes, '')), ''),
         verification = jsonb_build_object(
           'method', 'qr_challenge_with_browser_locations',
           'disclaimer', 'Browser location and a QR code reduce casual remote acknowledgment. They do not prove a face-to-face meeting against collusion or location spoofing.',
           'verified_at', v_now,
           'distance_m', round(v_dist::numeric, 1),
           'sender', jsonb_build_object('lat', h.sender_lat, 'lng', h.sender_lng, 'accuracy_m', h.sender_accuracy_m, 'received_at', h.sender_location_at, 'zone', v_sz),
           'recipient', jsonb_build_object('lat', p_lat, 'lng', p_lng, 'accuracy_m', p_accuracy_m, 'captured_at', p_captured_at, 'zone', v_rz)
         )
   where id = h.id;
  perform public.phase8_write_audit('handover_completed', 'shift_handover', h.id, jsonb_build_object('distance_m', round(v_dist::numeric, 1)));
  return query select true, 'OK', 'Handover completed.', round(v_dist::numeric, 1);
end;
$function$;

-- Status-aware read model (RLS of shift_handovers applies to the caller).
create or replace view public.shift_handovers_with_status with (security_invoker = true) as
  select h.*, public.handover_effective_status(h.id) as effective_status
  from public.shift_handovers h;

-- ---------------------------------------------------------------------------------------------------------------------------------------------------------
-- Privileges, policies, notification event type
-- ---------------------------------------------------------------------------------------------------------------------------------------------------------

revoke execute on function public.handover_profile_scopes(uuid) from public, anon, authenticated;
revoke execute on function public.handover_open_duty(uuid, text) from public, anon, authenticated;
revoke execute on function public.handover_point_zone(text, double precision, double precision) from public, anon, authenticated;
revoke execute on function public.handover_distance_m(double precision, double precision, double precision, double precision) from public, anon, authenticated;
revoke execute on function public.handover_refuse(uuid, text, text, double precision) from public, anon, authenticated;
grant execute on function public.handover_profile_scopes(uuid) to service_role;
grant execute on function public.handover_open_duty(uuid, text) to service_role;
grant execute on function public.handover_point_zone(text, double precision, double precision) to service_role;
grant execute on function public.handover_distance_m(double precision, double precision, double precision, double precision) to service_role;
grant execute on function public.handover_refuse(uuid, text, text, double precision) to service_role;

revoke execute on function public.handover_effective_status(uuid) from public, anon;
grant execute on function public.handover_effective_status(uuid) to authenticated, service_role;
revoke execute on function public.resolve_handover_recipient_secure(text) from public, anon;
grant execute on function public.resolve_handover_recipient_secure(text) to authenticated, service_role;
revoke execute on function public.file_handover_secure(text, text, text, text, text, jsonb) from public, anon;
grant execute on function public.file_handover_secure(text, text, text, text, text, jsonb) to authenticated, service_role;
revoke execute on function public.issue_handover_challenge_secure(uuid) from public, anon;
grant execute on function public.issue_handover_challenge_secure(uuid) to authenticated, service_role;
revoke execute on function public.submit_handover_sender_location_secure(uuid, double precision, double precision, double precision) from public, anon;
grant execute on function public.submit_handover_sender_location_secure(uuid, double precision, double precision, double precision) to authenticated, service_role;
revoke execute on function public.complete_handover_secure(uuid, text, double precision, double precision, double precision, timestamptz, text) from public, anon;
grant execute on function public.complete_handover_secure(uuid, text, double precision, double precision, double precision, timestamptz, text) to authenticated, service_role;

revoke all on public.shift_handovers_with_status from public, anon;
grant select on public.shift_handovers_with_status to authenticated, service_role;

-- No client INSERT any more; the only client UPDATE left is the legacy acknowledgement of HISTORICAL rows, on three columns.
drop policy "shift_handovers own insert" on public.shift_handovers;
revoke insert on public.shift_handovers from authenticated;
drop policy "shift_handovers team acknowledge" on public.shift_handovers;
revoke update on public.shift_handovers from authenticated;
grant update (acknowledged_by, acknowledged_at, acknowledgment_notes) on public.shift_handovers to authenticated;
create policy "shift_handovers legacy acknowledge" on public.shift_handovers for update to authenticated
  using (handover_status = 'historical' and acknowledged_at is null and (((station = current_station()) and (coalesce(team, '') = coalesce(current_team(), ''))) or canon_oversees(outgoing_profile_id, station, team) or canon_has_role(array['operation_manager', 'main_enforcement'])))
  with check (acknowledged_by = auth.uid() and handover_status = 'historical');

drop policy "shift_handovers team select" on public.shift_handovers;
create policy "shift_handovers team select" on public.shift_handovers for select to authenticated
  using ((outgoing_profile_id = auth.uid()) or (recipient_profile_id = auth.uid()) or ((station = current_station()) and (coalesce(team, '') = coalesce(current_team(), ''))) or canon_oversees(outgoing_profile_id, station, team) or canon_has_role(array['operation_manager', 'main_enforcement']));

do $do$
declare
  v_def text;
begin
  select pg_get_constraintdef(c.oid) into v_def from pg_constraint c where c.conname = 'user_notifications_event_type_check' and c.conrelid = 'public.user_notifications'::regclass;
  if v_def is not null and v_def not like '%handover_received%' then
    v_def := regexp_replace(v_def, '\]\)\)\)\s*$', ',''handover_received''::text]))) ');
    alter table public.user_notifications drop constraint user_notifications_event_type_check;
    execute 'alter table public.user_notifications add constraint user_notifications_event_type_check ' || v_def;
  end if;
end
$do$;
