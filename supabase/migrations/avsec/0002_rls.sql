-- Row Level Security for AVSEC OPS

alter table profiles enable row level security;
alter table stations enable row level security;
alter table teams enable row level security;
alter table aircraft_types enable row level security;
alter table report_sec016 enable row level security;
alter table report_sec014 enable row level security;
alter table report_sec014_patrols enable row level security;
alter table report_sec029 enable row level security;
alter table report_sec029_items enable row level security;
alter table report_sec018 enable row level security;
alter table report_sec018_patrols enable row level security;
alter table bay_board enable row level security;

-- Helper functions (security definer, bypass RLS to avoid recursive lookups on profiles)

create or replace function current_role_name()
returns user_role as $$
  select role from profiles where id = auth.uid();
$$ language sql stable security definer set search_path = public;

create or replace function current_station()
returns text as $$
  select station from profiles where id = auth.uid();
$$ language sql stable security definer set search_path = public;

create or replace function is_supervisor_or_above()
returns boolean as $$
  select current_role_name() in ('SUPERVISOR', 'MANAGER', 'ADMIN');
$$ language sql stable security definer set search_path = public;

create or replace function is_manager_or_above()
returns boolean as $$
  select current_role_name() in ('MANAGER', 'ADMIN');
$$ language sql stable security definer set search_path = public;

-- ============ Reference data: readable by all authenticated users, writable by admin ============

create policy "reference stations readable" on stations for select using (auth.role() = 'authenticated');
create policy "reference stations admin write" on stations for all
  using (current_role_name() = 'ADMIN') with check (current_role_name() = 'ADMIN');

create policy "reference teams readable" on teams for select using (auth.role() = 'authenticated');
create policy "reference teams admin write" on teams for all
  using (current_role_name() = 'ADMIN') with check (current_role_name() = 'ADMIN');

create policy "reference aircraft_types readable" on aircraft_types for select using (auth.role() = 'authenticated');
create policy "reference aircraft_types admin write" on aircraft_types for all
  using (current_role_name() = 'ADMIN') with check (current_role_name() = 'ADMIN');

-- ============ Profiles ============

create policy "profiles self select" on profiles for select
  using (id = auth.uid() or is_supervisor_or_above());

create policy "profiles self update" on profiles for update
  using (id = auth.uid())
  with check (id = auth.uid() and (role = (select role from profiles p where p.id = auth.uid())));

create policy "profiles admin manage" on profiles for all
  using (current_role_name() = 'ADMIN') with check (current_role_name() = 'ADMIN');

create policy "profiles self insert" on profiles for insert
  with check (id = auth.uid());

-- ============ Generic report policy pattern ============
-- OFFICER: select/insert/update own rows (update blocked once submitted by trigger)
-- SUPERVISOR/MANAGER/ADMIN: select rows in their station (managers/admins see all)

-- report_sec016
create policy "sec016 own select" on report_sec016 for select using (profile_id = auth.uid());
create policy "sec016 station select" on report_sec016 for select
  using (is_supervisor_or_above() and (is_manager_or_above() or station = current_station()));
create policy "sec016 own insert" on report_sec016 for insert with check (profile_id = auth.uid());
create policy "sec016 own update" on report_sec016 for update using (profile_id = auth.uid());

-- report_sec014
create policy "sec014 own select" on report_sec014 for select using (profile_id = auth.uid());
create policy "sec014 station select" on report_sec014 for select
  using (is_supervisor_or_above() and (is_manager_or_above() or station = current_station()));
create policy "sec014 own insert" on report_sec014 for insert with check (profile_id = auth.uid());
create policy "sec014 own update" on report_sec014 for update using (profile_id = auth.uid());

create policy "sec014_patrols via parent select" on report_sec014_patrols for select
  using (exists (
    select 1 from report_sec014 r where r.id = report_id
    and (r.profile_id = auth.uid() or (is_supervisor_or_above() and (is_manager_or_above() or r.station = current_station())))
  ));
create policy "sec014_patrols via parent write" on report_sec014_patrols for all
  using (exists (select 1 from report_sec014 r where r.id = report_id and r.profile_id = auth.uid()))
  with check (exists (select 1 from report_sec014 r where r.id = report_id and r.profile_id = auth.uid()));

-- report_sec029
create policy "sec029 own select" on report_sec029 for select using (profile_id = auth.uid());
create policy "sec029 station select" on report_sec029 for select
  using (is_supervisor_or_above() and (is_manager_or_above() or station = current_station()));
create policy "sec029 own insert" on report_sec029 for insert with check (profile_id = auth.uid());
create policy "sec029 own update" on report_sec029 for update using (profile_id = auth.uid());

create policy "sec029_items via parent select" on report_sec029_items for select
  using (exists (
    select 1 from report_sec029 r where r.id = report_id
    and (r.profile_id = auth.uid() or (is_supervisor_or_above() and (is_manager_or_above() or r.station = current_station())))
  ));
create policy "sec029_items via parent write" on report_sec029_items for all
  using (exists (select 1 from report_sec029 r where r.id = report_id and r.profile_id = auth.uid()))
  with check (exists (select 1 from report_sec029 r where r.id = report_id and r.profile_id = auth.uid()));

-- report_sec018
create policy "sec018 own select" on report_sec018 for select using (profile_id = auth.uid());
create policy "sec018 station select" on report_sec018 for select
  using (is_supervisor_or_above() and (is_manager_or_above() or station = current_station()));
create policy "sec018 own insert" on report_sec018 for insert with check (profile_id = auth.uid());
create policy "sec018 own update" on report_sec018 for update using (profile_id = auth.uid());

create policy "sec018_patrols via parent select" on report_sec018_patrols for select
  using (exists (
    select 1 from report_sec018 r where r.id = report_id
    and (r.profile_id = auth.uid() or (is_supervisor_or_above() and (is_manager_or_above() or r.station = current_station())))
  ));
create policy "sec018_patrols via parent write" on report_sec018_patrols for all
  using (exists (select 1 from report_sec018 r where r.id = report_id and r.profile_id = auth.uid()))
  with check (exists (select 1 from report_sec018 r where r.id = report_id and r.profile_id = auth.uid()));

-- ============ Bay Board ============
-- Any authenticated officer at a station can create/read entries for their station;
-- supervisors/managers/admins can read across stations (managers/admins: all).

create policy "bay_board station select" on bay_board for select
  using (station = current_station() or is_manager_or_above());
create policy "bay_board station insert" on bay_board for insert
  with check (station = current_station() or is_manager_or_above());
create policy "bay_board station update" on bay_board for update
  using (station = current_station() or is_manager_or_above());
