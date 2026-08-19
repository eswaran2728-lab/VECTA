-- Upgrade 4: Enforcement Search — search staff/flight attendance by flight number + date.
-- Access is Enforcement + Management only (Admin explicitly excluded, per product decision
-- deviating from a flat "monitor" check — Admin already sees everything via rank-based RLS,
-- so the exclusion has to be enforced explicitly in the RPC, not just left to rank).
--
-- Only SEC016, SEC029, and the Offload module actually carry a flight number — SEC014/018/
-- 033/013 are patrol/duty logs with no flight linkage, so the view unions just those three
-- sources rather than all 7 report types.

create view v_flight_attendance as
  select
    'sec016'::text as report_type,
    id as report_id,
    profile_id,
    flight as flight_no,
    coalesce(duty_date, (submitted_at at time zone 'Asia/Kuala_Lumpur')::date) as flight_date,
    station,
    team,
    staff_name,
    staff_no as staff_id,
    reg_no as aircraft_registration,
    bay_no as location_detail,
    submitted_at
  from report_sec016
  where status = 'submitted'

  union all

  select
    'sec029'::text as report_type,
    id as report_id,
    profile_id,
    flight_no,
    (submitted_at at time zone 'Asia/Kuala_Lumpur')::date as flight_date,
    station,
    team,
    staff_name,
    staff_id,
    aircraft_registration,
    parking_bay as location_detail,
    submitted_at
  from report_sec029
  where status = 'submitted'

  union all

  select
    'offload'::text as report_type,
    id as report_id,
    profile_id,
    flight_no,
    flight_date,
    station,
    team,
    staff_name,
    staff_id,
    aircraft_registration,
    destination as location_detail,
    submitted_at
  from offload_records
  where status = 'submitted';

-- The view is internal plumbing only — never exposed directly (that would let Admin, or
-- anyone whose rank already grants broad visibility, bypass the Enforcement/Management-only
-- check below by querying the view straight from PostgREST). Only the RPC can read it.
revoke all on v_flight_attendance from anon, authenticated;

create table enforcement_search_log (
  id uuid primary key default gen_random_uuid(),
  searched_by uuid not null references profiles (id),
  flight_no text not null,
  search_date date,
  result_count int not null default 0,
  searched_at timestamptz not null default now()
);

alter table enforcement_search_log enable row level security;

-- Admin can review the audit trail for oversight even though Admin can't run searches.
create policy "search log select" on enforcement_search_log for select
  using (current_role_name() in ('ENFORCEMENT', 'MANAGEMENT', 'ADMIN'));

-- No insert policy — every row is written by search_flight_attendance() below, which runs
-- as the (RLS-bypassing) function owner, exactly like report_counters in migration 0019.

create or replace function search_flight_attendance(p_flight_no text, p_date date default null)
returns setof v_flight_attendance as $$
declare
  v_flight_no text := trim(coalesce(p_flight_no, ''));
  v_count int;
begin
  if current_role_name() not in ('ENFORCEMENT', 'MANAGEMENT') then
    raise exception 'Not authorized to search flight attendance.';
  end if;
  if v_flight_no = '' then
    raise exception 'Flight number is required.';
  end if;

  select count(*) into v_count
  from v_flight_attendance
  where flight_no ilike ('%' || v_flight_no || '%')
    and (p_date is null or flight_date = p_date);

  insert into enforcement_search_log (searched_by, flight_no, search_date, result_count)
  values (auth.uid(), v_flight_no, p_date, v_count);

  return query
    select * from v_flight_attendance
    where flight_no ilike ('%' || v_flight_no || '%')
      and (p_date is null or flight_date = p_date)
    order by flight_date desc nulls last, submitted_at desc nulls last;
end;
$$ language plpgsql security definer set search_path = public;

revoke all on function search_flight_attendance(text, date) from public;
grant execute on function search_flight_attendance(text, date) to authenticated;
