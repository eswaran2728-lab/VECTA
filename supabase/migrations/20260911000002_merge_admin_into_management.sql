-- ============================================================
-- Phase 2: Merge Admin + Management -> Single "Management" Role
-- Additive migration: Migrates all 'ADMIN'/'admin' roles to 'MANAGEMENT'/'management',
-- updates role_rank(), updates RLS policies and helper functions.
-- ============================================================

-- 1. Migrate existing profiles from ADMIN to MANAGEMENT
alter table public.profiles disable trigger user;

update public.profiles
set role = 'MANAGEMENT', unified_role = 'management'
where role = 'ADMIN' or unified_role = 'admin';

alter table public.profiles enable trigger user;

-- 2. Migrate existing ICMS users from supervisor/admin to management
update public.users
set unified_role = 'management'
where unified_role = 'admin' or role = 'supervisor';

-- 3. Update unified_role check constraints
alter table public.profiles drop constraint if exists profiles_unified_role_check;
alter table public.profiles
  add constraint profiles_unified_role_check
  check (unified_role in ('super_admin', 'management', 'enforcement', 'dse', 'so', 'aso', 'vendor'));

alter table public.users drop constraint if exists users_unified_role_check;
alter table public.users
  add constraint users_unified_role_check
  check (unified_role in ('super_admin', 'management', 'enforcement', 'dse', 'so', 'aso', 'vendor'));

-- 4. Update role_rank() function (ASO < SO < DSE < ENFORCEMENT < MANAGEMENT)
create or replace function public.role_rank(r user_role)
returns int as $$
  select case r
    when 'ASO' then 1
    when 'SO' then 2
    when 'DSE' then 3
    when 'ENFORCEMENT' then 4
    when 'MANAGEMENT' then 5
    when 'ADMIN' then 5 -- backwards compatibility fallback
    else 0
  end;
$$ language sql immutable;

-- 5. Update is_monitor_or_above()
create or replace function public.is_monitor_or_above()
returns boolean as $$
  select current_role_name() in ('SO', 'DSE', 'ENFORCEMENT', 'MANAGEMENT', 'ADMIN');
$$ language sql stable security definer set search_path = public;

-- 6. Update RLS policies referencing ADMIN to MANAGEMENT
-- (Duty module, roster, sheets sync, attendance, etc.)

-- Duty zones
drop policy if exists "duty_zones_admin_write" on public.duty_zones;
drop policy if exists "duty_zones_management_write" on public.duty_zones;
create policy "duty_zones_management_write" on public.duty_zones
  for all using (current_role_name() in ('MANAGEMENT', 'ADMIN'))
  with check (current_role_name() in ('MANAGEMENT', 'ADMIN'));

-- Shifts
drop policy if exists "shifts_admin_all" on public.shifts;
drop policy if exists "shifts_management_all" on public.shifts;
create policy "shifts_management_all" on public.shifts
  for all using (current_role_name() in ('MANAGEMENT', 'ADMIN'))
  with check (current_role_name() in ('MANAGEMENT', 'ADMIN'));

-- Station teams
drop policy if exists "station_teams_admin_all" on public.station_teams;
drop policy if exists "station_teams_management_all" on public.station_teams;
create policy "station_teams_management_all" on public.station_teams
  for all using (current_role_name() in ('MANAGEMENT', 'ADMIN'))
  with check (current_role_name() in ('MANAGEMENT', 'ADMIN'));

-- Roster entries
drop policy if exists "roster_admin_all" on public.duty_records;

-- Enforcement & Flight Attendance Search
create or replace function search_flight_attendance(
  p_flight_no text,
  p_date_from date,
  p_date_to date default null
)
returns table (
  flight_no text,
  duty_date date,
  std text,
  parking_bay text,
  aircraft_type text,
  aircraft_registration text,
  staff_name text,
  staff_id text,
  team text,
  report_type text,
  report_id uuid,
  submitted_at timestamptz
) as $$
begin
  if current_role_name() not in ('ENFORCEMENT', 'MANAGEMENT', 'ADMIN') then
    raise exception 'Permission denied: Flight Attendance Search is restricted to Enforcement and Management.';
  end if;

  return query
  select
    r.flight as flight_no,
    r.duty_date::date as duty_date,
    r.sta_std as std,
    r.bay_no as parking_bay,
    r.aircraft_type,
    r.reg_no as aircraft_registration,
    r.staff_name,
    r.staff_no as staff_id,
    r.team,
    'sec016'::text as report_type,
    r.id as report_id,
    r.submitted_at
  from report_sec016 r
  where r.status = 'submitted'
    and upper(r.flight) = upper(p_flight_no)
    and r.duty_date::date >= p_date_from
    and (p_date_to is null or r.duty_date::date <= p_date_to)

  union all

  select
    r.flight_no,
    (r.date_time_in at time zone 'Asia/Kuala_Lumpur')::date as duty_date,
    r.std,
    r.parking_bay,
    r.aircraft_type::text,
    r.aircraft_registration,
    r.staff_name,
    r.staff_id,
    r.team,
    'sec029'::text as report_type,
    r.id as report_id,
    r.submitted_at
  from report_sec029 r
  where r.status = 'submitted'
    and upper(r.flight_no) = upper(p_flight_no)
    and (r.date_time_in at time zone 'Asia/Kuala_Lumpur')::date >= p_date_from
    and (p_date_to is null or (r.date_time_in at time zone 'Asia/Kuala_Lumpur')::date <= p_date_to)

  order by submitted_at desc;
end;
$$ language plpgsql stable security definer set search_path = public;
