-- PHASE 2 -- ORGANIZATIONAL FOUNDATION (2026-09-28)
-- Malaysia AOC upgrade. Additive only. Does not touch, rename or drop any
-- existing column, table, role value, RLS policy or function. Does not
-- change any existing authorization behavior -- every new table defaults
-- to RLS enabled with NO policies (deny-all), so nothing becomes newly
-- readable/writable by any existing role as a side effect of this
-- migration. Phase 3 adds the policies that actually grant access.
--
-- Covers:
--   Part A: aocs, operating_entities, departments, units
--   Part B: hubs, stations (normalized), teams (normalized)
--   Part C: Malaysia seed data (MY, MAA, AAX, 5 hubs, all named stations)
--   Part D: legacy/unclassified station preservation (KUA, MKZ, SZB)
--   Part E: additive nullable compatibility FKs on profiles
--   Part F: deterministic KUL backfill (profiles only, MAA/KUL rows only)
--   Part G: read-only helper views for verifying backfill coverage
--
-- NOT done in this migration (explicitly deferred to later phases):
--   - no NOT NULL constraint on any new profiles column
--   - no RLS policy granting access to any new table
--   - no role/permission model (Phase 3)
--   - no change to profiles.station, profiles.team, profiles.ops_group,
--     profiles.role, profiles.unified_role -- all preserved verbatim
--   - no change to public.users (CaterLink identity stays separate,
--     per explicit instruction not to collapse profiles and CaterLink
--     users during early phases)

-- =======================================================================
-- PART A: aocs, operating_entities, departments, units
-- =======================================================================
create table if not exists public.aocs (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,             -- 'MY'
  name text not null,
  is_active boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.operating_entities (
  id uuid primary key default gen_random_uuid(),
  aoc_id uuid not null references public.aocs(id),
  code text not null,                    -- 'MAA' | 'AAX'
  name text not null,
  flight_prefix text not null,           -- 'AK' | 'D7' -- input helper only, never the authorization source
  created_at timestamptz not null default now(),
  unique (aoc_id, code)
);

create table if not exists public.departments (
  id uuid primary key default gen_random_uuid(),
  aoc_id uuid not null references public.aocs(id),
  code text not null,                    -- 'operation' | 'enforcement' | 'compliance' | 'caterlink'
  name text not null,
  created_at timestamptz not null default now(),
  unique (aoc_id, code)
);

create table if not exists public.units (
  id uuid primary key default gen_random_uuid(),
  department_id uuid not null references public.departments(id),
  code text not null,                    -- 'investigation' | 'sat' | 'profiling'
  name text not null,
  created_at timestamptz not null default now(),
  unique (department_id, code)
);

-- =======================================================================
-- PART B: hubs, stations (normalized), teams (normalized)
-- =======================================================================
create table if not exists public.hubs (
  id uuid primary key default gen_random_uuid(),
  aoc_id uuid not null references public.aocs(id),
  code text not null,                    -- 'kul' | 'northern' | 'sarawak' | 'sabah' | 'southern_east_coast' | 'unclassified'
  name text not null,
  created_at timestamptz not null default now(),
  unique (aoc_id, code)
);

-- Normalized stations. Deliberately NOT a replacement for
-- profiles.station/reference-data.ts's STATIONS[] in this phase -- this
-- is the new authoritative table Phase 3+ code will start reading from,
-- while the legacy free-text column keeps working unchanged in parallel.
create table if not exists public.org_stations (
  id uuid primary key default gen_random_uuid(),
  hub_id uuid not null references public.hubs(id),
  code text not null unique,             -- matches lib/avsec/reference-data.ts STATIONS values, e.g. 'PEN', 'KUL - MAA'
  name text not null,
  -- Any Malaysia entity may operate at any station -- explicitly NOT an
  -- entity-scoped table (no operating_entity_id column here), per
  -- instruction: "Do not assign a station permanently to only MAA or AAX."
  classification_status text not null default 'classified'
    check (classification_status in ('classified', 'classification_pending')),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

-- Normalized teams -- station-scoped, so "ALPHA" at PEN and "ALPHA" at
-- KUL are different rows. Never join on team name alone (repo-wide rule).
create table if not exists public.org_teams (
  id uuid primary key default gen_random_uuid(),
  station_id uuid not null references public.org_stations(id),
  name text not null,
  created_at timestamptz not null default now(),
  unique (station_id, name)
);

-- =======================================================================
-- PART C: Malaysia seed data
-- =======================================================================
-- Malaysia is inserted but left INACTIVE (is_active = false) by this
-- migration -- activation is an explicit, separate, later decision (not
-- assumed here just because this is "the only AOC implemented now").
insert into public.aocs (code, name, is_active)
values ('MY', 'Malaysia', false)
on conflict (code) do nothing;

insert into public.operating_entities (aoc_id, code, name, flight_prefix)
select a.id, v.code, v.name, v.flight_prefix
from public.aocs a
cross join (values
  ('MAA', 'AirAsia Malaysia', 'AK'),
  ('AAX', 'AirAsia X Malaysia', 'D7')
) as v(code, name, flight_prefix)
where a.code = 'MY'
on conflict (aoc_id, code) do nothing;

insert into public.departments (aoc_id, code, name)
select a.id, v.code, v.name
from public.aocs a
cross join (values
  ('operation', 'Operation'),
  ('enforcement', 'Enforcement'),
  ('compliance', 'Compliance'),
  ('caterlink', 'CaterLink')
) as v(code, name)
where a.code = 'MY'
on conflict (aoc_id, code) do nothing;

insert into public.units (department_id, code, name)
select d.id, v.code, v.name
from public.departments d
join public.aocs a on a.id = d.aoc_id and a.code = 'MY'
cross join (values
  ('investigation', 'Investigation'),
  ('sat', 'Special Action Team'),
  ('profiling', 'Staff Profiling')
) as v(code, name)
where d.code = 'enforcement'
on conflict (department_id, code) do nothing;

insert into public.hubs (aoc_id, code, name)
select a.id, v.code, v.name
from public.aocs a
cross join (values
  ('kul', 'KUL Hub'),
  ('northern', 'Northern Hub'),
  ('sarawak', 'Sarawak Hub'),
  ('sabah', 'Sabah Hub'),
  ('southern_east_coast', 'Southern & East Coast Hub'),
  ('unclassified', 'Unclassified / Legacy')
) as v(code, name)
where a.code = 'MY'
on conflict (aoc_id, code) do nothing;

-- Stations, one row per hub. KUL keeps BOTH 'KUL - MAA' and 'KUL - AAX' as
-- distinct station codes (matching the existing free-text values exactly,
-- so the deterministic backfill in Part F can join on equality) --
-- explicitly preserving "KUL-MAA/KUL-AAX compatibility while introducing
-- normalized KUL station/entity relationships" per instruction, rather
-- than collapsing them into one 'KUL' row.
insert into public.org_stations (hub_id, code, name)
select h.id, v.code, v.name
from public.hubs h
join public.aocs a on a.id = h.aoc_id and a.code = 'MY'
cross join (values
  ('kul', 'KUL - MAA', 'KUL (MAA)'),
  ('kul', 'KUL - AAX', 'KUL (AAX)'),
  ('northern', 'PEN', 'Penang'),
  ('northern', 'AOR', 'Alor Setar'),
  ('northern', 'IPH', 'Ipoh'),
  ('northern', 'LGK', 'Langkawi'),
  ('sarawak', 'KCH', 'Kuching'),
  ('sarawak', 'MYY', 'Miri'),
  ('sarawak', 'SBW', 'Sibu'),
  ('sarawak', 'BTU', 'Bintulu'),
  ('sabah', 'BKI', 'Kota Kinabalu'),
  ('sabah', 'LBU', 'Labuan'),
  ('sabah', 'SDK', 'Sandakan'),
  ('sabah', 'TWU', 'Tawau'),
  ('southern_east_coast', 'JHB', 'Johor Bahru'),
  ('southern_east_coast', 'TGG', 'Kuala Terengganu'),
  ('southern_east_coast', 'KBR', 'Kota Bharu')
) as v(hub_code, code, name)
where h.code = v.hub_code
on conflict (code) do nothing;

-- Legacy/unclassified stations: preserved exactly as instructed --
-- neither deleted, deactivated, nor guessed into a hub. Attached to the
-- explicit 'unclassified' hub so the hierarchy stays structurally valid
-- without inventing a real hub assignment. No CaterLink access (Phase 9
-- will not grant them any). Flagged classification_pending so they can be
-- reclassified later without a structural migration.
insert into public.org_stations (hub_id, code, name, classification_status)
select h.id, v.code, v.name, 'classification_pending'
from public.hubs h
join public.aocs a on a.id = h.aoc_id and a.code = 'MY'
cross join (values
  ('KUA', 'Kuantan (legacy, unclassified)'),
  ('MKZ', 'Malacca (legacy, unclassified)'),
  ('SZB', 'Sultan Abdul Aziz Shah / Subang (legacy, unclassified)')
) as v(code, name)
where h.code = 'unclassified'
on conflict (code) do nothing;

-- =======================================================================
-- PART D: (folded into Part C above -- legacy stations)
-- =======================================================================

-- =======================================================================
-- PART E: additive nullable compatibility FKs on profiles
-- =======================================================================
-- Every column nullable, no default that implies a guess, no NOT NULL.
-- profiles.station (text), profiles.team (text), profiles.ops_group,
-- profiles.role, profiles.unified_role are all completely untouched.
alter table public.profiles
  add column if not exists aoc_id uuid references public.aocs(id),
  add column if not exists operating_entity_id uuid references public.operating_entities(id),
  add column if not exists department_id uuid references public.departments(id),
  add column if not exists unit_id uuid references public.units(id),
  add column if not exists hub_id uuid references public.hubs(id),
  add column if not exists org_station_id uuid references public.org_stations(id),
  add column if not exists org_team_id uuid references public.org_teams(id);

-- =======================================================================
-- PART F: deterministic KUL backfill (profiles only)
-- =======================================================================
-- CONFIRMED live (2026-09-28, read-only count against vecta-prod before
-- writing this Part): every existing profile with a non-null station is
-- 'KUL - MAA' (27 rows); 9 profiles have station = NULL (ambiguous,
-- intentionally left untouched, new columns stay NULL for them);
-- 'KUL - AAX' and every other station have ZERO existing profiles. No
-- non-KUL operating entity or hub is guessed anywhere in this Part, per
-- instruction.
--
-- Backfill logic, applied only to rows where profiles.station is exactly
-- 'KUL - MAA' or 'KUL - AAX' (the only two deterministic values):
--   station = 'KUL - MAA' -> aoc=MY, operating_entity=MAA, hub=KUL, org_station='KUL - MAA'
--   station = 'KUL - AAX' -> aoc=MY, operating_entity=AAX, hub=KUL, org_station='KUL - AAX'
-- department_id/unit_id/org_team_id are NOT backfilled here -- department
-- requires knowing Operation vs Enforcement vs Compliance vs CaterLink,
-- which profiles.ops_group only partially implies (operation_avsec /
-- ifc_avsec / hub_avsec are Operation-department signals, not unit
-- assignments) -- deferred to Phase 3's role/assignment system rather
-- than guessed here.
update public.profiles p
set
  aoc_id = my.id,
  operating_entity_id = oe.id,
  hub_id = h.id,
  org_station_id = s.id
from public.aocs my
join public.hubs h on h.aoc_id = my.id and h.code = 'kul'
join public.operating_entities oe on oe.aoc_id = my.id and oe.code = 'MAA'
join public.org_stations s on s.code = 'KUL - MAA'
where my.code = 'MY'
  and p.station = 'KUL - MAA'
  and p.aoc_id is null; -- idempotent -- never re-touches an already-backfilled row

update public.profiles p
set
  aoc_id = my.id,
  operating_entity_id = oe.id,
  hub_id = h.id,
  org_station_id = s.id
from public.aocs my
join public.hubs h on h.aoc_id = my.id and h.code = 'kul'
join public.operating_entities oe on oe.aoc_id = my.id and oe.code = 'AAX'
join public.org_stations s on s.code = 'KUL - AAX'
where my.code = 'MY'
  and p.station = 'KUL - AAX'
  and p.aoc_id is null;

-- =======================================================================
-- PART G: read-only backfill-coverage verification views
-- =======================================================================
-- Not exposed to any role (no grants below beyond the default -- see the
-- RLS note at the top of this file); for Claude Code / migration-owner
-- use only, via the Supabase SQL tool, until Phase 3 defines who (if
-- anyone) may read them directly.
create or replace view public.v_phase2_backfill_coverage as
select
  count(*) as total_profiles,
  count(*) filter (where aoc_id is not null) as backfilled_profiles,
  count(*) filter (where aoc_id is null and station is not null) as deterministic_gap_profiles,
  count(*) filter (where station is null) as ambiguous_profiles;

create or replace view public.v_phase2_unclassified_stations as
select code, name, classification_status
from public.org_stations
where classification_status = 'classification_pending';

-- =======================================================================
-- SECURITY: RLS enabled, deny-all, on every new table (Phase 3 adds
-- policies). This is the "no side-effect access change" guarantee this
-- migration makes -- confirmed by the absence of any CREATE POLICY
-- statement anywhere in this file.
-- =======================================================================
alter table public.aocs enable row level security;
alter table public.operating_entities enable row level security;
alter table public.departments enable row level security;
alter table public.units enable row level security;
alter table public.hubs enable row level security;
alter table public.org_stations enable row level security;
alter table public.org_teams enable row level security;

revoke all on public.aocs from public, anon, authenticated;
revoke all on public.operating_entities from public, anon, authenticated;
revoke all on public.departments from public, anon, authenticated;
revoke all on public.units from public, anon, authenticated;
revoke all on public.hubs from public, anon, authenticated;
revoke all on public.org_stations from public, anon, authenticated;
revoke all on public.org_teams from public, anon, authenticated;
grant all on public.aocs, public.operating_entities, public.departments,
  public.units, public.hubs, public.org_stations, public.org_teams
  to service_role;
