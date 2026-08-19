-- Duty Check-In & Overtime module — Phase 2: admin-entered team roster.
--
-- Additive only. No pattern/formula generator — admin fills the grid by hand, day by day,
-- per station, per team. Team names are per-station (station_teams), matching the existing
-- free-text profiles.team convention (the old `teams` table is flat/global and unrelated).

-- ============ Shift presets (picker list only, not a schedule generator) ============

create table if not exists shifts (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  label text not null,
  default_start time,
  default_end time,
  display_order integer not null default 0
);

insert into shifts (code, label, default_start, default_end, display_order) values
  ('D', 'Day 0700-1900', '07:00', '19:00', 1),
  ('N', 'Night 1900-0700', '19:00', '07:00', 2),
  ('OFF', 'Off day', null, null, 3)
on conflict (code) do nothing;

-- ============ Station teams (lets admin name/order teams per station) ============
-- Seeded from whichever team names already exist per station in profiles, so the roster
-- grid works immediately without a manual setup step for stations already in use.

create table if not exists station_teams (
  id uuid primary key default gen_random_uuid(),
  station text not null references stations (code),
  team text not null,
  display_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (station, team)
);

insert into station_teams (station, team, display_order)
select station, team, row_number() over (partition by station order by team)
from (select distinct station, team from profiles where team is not null and team <> '' and station is not null) t
on conflict (station, team) do nothing;

-- ============ Team roster grid ============
-- One row = one team's shift on one date at one station. Living planning table — not
-- immutable like report_sec*/duty_records; admin can edit a saved cell freely.

create table if not exists team_rosters (
  id uuid primary key default gen_random_uuid(),
  station text not null references stations (code),
  team text not null,
  roster_date date not null,
  shift_code text not null references shifts (code),
  start_time time,
  end_time time,
  zone_id uuid references duty_zones (id),
  notes text,
  set_by uuid not null references profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (station, team, roster_date)
);

create index if not exists team_rosters_station_date_idx on team_rosters (station, roster_date);

create trigger team_rosters_set_updated_at before update on team_rosters
  for each row execute function set_updated_at();

-- ============ RLS ============

alter table shifts enable row level security;
alter table station_teams enable row level security;
alter table team_rosters enable row level security;

-- Reference data: readable by every approved user, writable only by Admin.
create policy "shifts readable" on shifts for select
  using (current_status() = 'approved');
create policy "shifts admin write" on shifts for all
  using (current_role_name() = 'ADMIN')
  with check (current_role_name() = 'ADMIN');

create policy "station_teams readable" on station_teams for select
  using (current_status() = 'approved');
create policy "station_teams admin write" on station_teams for all
  using (current_role_name() = 'ADMIN')
  with check (current_role_name() = 'ADMIN');

-- Roster: Admin sees/edits every station. Org-wide monitors (Enforcement+) read every
-- station, matching how they already see every report. SO/DSE/ASO read only their own
-- station+team's line — enough for /duty check-in to look up "am I on today".
create policy "roster admin all" on team_rosters for all
  using (current_role_name() = 'ADMIN')
  with check (current_role_name() = 'ADMIN' and set_by = auth.uid());

create policy "roster org wide select" on team_rosters for select
  using (current_role_rank() >= role_rank('ENFORCEMENT'));

create policy "roster own team select" on team_rosters for select
  using (station = current_station() and coalesce(team, '') = coalesce(current_team(), ''));
