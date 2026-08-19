-- AVSEC OPS initial schema
-- Roles: OFFICER, SUPERVISOR, MANAGER, ADMIN
-- All timestamps stored as timestamptz (UTC); display converted to Asia/Kuala_Lumpur client-side.

create extension if not exists "pgcrypto";

-- ============ Reference tables ============

create table if not exists stations (
  code text primary key,
  label text not null,
  active boolean not null default true
);

insert into stations (code, label) values
  ('KUL - MAA', 'KUL - MAA'),
  ('KUL - AAX', 'KUL - AAX'),
  ('AOR', 'AOR'),
  ('BKI', 'BKI'),
  ('BTU', 'BTU'),
  ('JHB', 'JHB'),
  ('KBR', 'KBR'),
  ('KCH', 'KCH'),
  ('LBU', 'LBU'),
  ('LGK', 'LGK'),
  ('MYY', 'MYY'),
  ('PEN', 'PEN'),
  ('SBW', 'SBW'),
  ('SDK', 'SDK'),
  ('TGG', 'TGG'),
  ('TWU', 'TWU'),
  ('KUA', 'KUA'),
  ('IPH', 'IPH'),
  ('MKZ', 'MKZ'),
  ('SZB', 'SZB')
on conflict (code) do nothing;

create table if not exists teams (
  code text primary key,
  label text not null,
  active boolean not null default true
);

insert into teams (code, label) values
  ('ALPHA', 'ALPHA'),
  ('BRAVO', 'BRAVO'),
  ('CHARLIE', 'CHARLIE'),
  ('DELTA', 'DELTA')
on conflict (code) do nothing;

create table if not exists aircraft_types (
  code text primary key,
  label text not null,
  active boolean not null default true
);

insert into aircraft_types (code, label) values
  ('A320', 'A320'),
  ('A321', 'A321'),
  ('A330', 'A330')
on conflict (code) do nothing;

-- ============ Profiles ============

create type user_role as enum ('OFFICER', 'SUPERVISOR', 'MANAGER', 'ADMIN');

create table if not exists profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  name text not null default '',
  staff_no text not null default '',
  station text references stations (code),
  team text references teams (code),
  role user_role not null default 'OFFICER',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists profiles_station_idx on profiles (station);
create index if not exists profiles_role_idx on profiles (role);

-- ============ Report status ============

create type report_status as enum ('draft', 'submitted');

-- ============ SEC 016: ASO Attending Flight Report ============

create table if not exists report_sec016 (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles (id),
  status report_status not null default 'draft',
  submitted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  amendment_of uuid references report_sec016 (id),

  -- staff details
  station text not null references stations (code),
  team text not null references teams (code),
  staff_name text not null,
  staff_no text not null,
  duty_date date not null,
  duty_hour time not null,

  -- aircraft
  flight text not null,
  origin_arr_dep text not null,
  assisted_by text not null,
  aircraft_type text not null,
  aircraft_type_other text,
  reg_no text not null,
  sta_std time not null,
  ata_atd time not null,
  bay_no text not null,
  reason_for_delay text,
  do_infmd text not null check (do_infmd in ('YES', 'NO')),
  inbound_baggage text not null,
  outbound_baggage text not null,
  inbound_cargo text not null,
  outbound_cargo text not null,
  inbound_co_mail text not null,
  outbound_co_mail text not null,
  checked_items text[] not null default '{}',
  shift_leader text not null,
  ramp_staff_1 text not null,
  ramp_staff_2 text not null,
  ramp_staff_3 text not null,
  ramp_staff_4 text not null,
  ramp_staff_5 text not null,
  cargo_hold_checked text not null check (cargo_hold_checked in ('YES', 'NO')),
  staff_frisked text not null check (staff_frisked in ('YES', 'NO')),
  discrepancies text not null,

  -- offload information
  offload_flight_no text not null,
  offload_destination text not null,
  offload_baggage_tag_no text not null,
  offload_total_baggage text not null,
  offload_remark text not null
);

create index if not exists report_sec016_profile_idx on report_sec016 (profile_id);
create index if not exists report_sec016_station_idx on report_sec016 (station);
create index if not exists report_sec016_flight_idx on report_sec016 (flight);
create index if not exists report_sec016_submitted_idx on report_sec016 (submitted_at);

-- ============ SEC 014: ASO Daily Report ============

create table if not exists report_sec014 (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles (id),
  status report_status not null default 'draft',
  submitted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  amendment_of uuid references report_sec014 (id),

  station text not null references stations (code),
  team text not null references teams (code),
  staff_name text not null,
  staff_id text not null,
  date_time_in timestamptz not null,
  date_time_out timestamptz,

  remark text not null,
  acknowledgement boolean not null default false
);

create index if not exists report_sec014_profile_idx on report_sec014 (profile_id);
create index if not exists report_sec014_station_idx on report_sec014 (station);
create index if not exists report_sec014_submitted_idx on report_sec014 (submitted_at);

create table if not exists report_sec014_patrols (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references report_sec014 (id) on delete cascade,
  entry_no int not null check (entry_no between 1 and 15),
  location text check (location in ('Aircraft', 'Terminal', 'Premises')),
  time_from time,
  time_to time,
  description text not null default '',
  unique (report_id, entry_no)
);

-- ============ SEC 029: Aircraft Search Checklist ============

create table if not exists report_sec029 (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles (id),
  status report_status not null default 'draft',
  submitted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  amendment_of uuid references report_sec029 (id),

  station text not null references stations (code),
  team text not null references teams (code),
  supervising_officer_name text not null,
  supervising_officer_id text not null,
  staff_name text not null,
  staff_id text not null,
  assisted_by_name text not null,
  assisted_by_id text not null,

  aircraft_type text not null check (aircraft_type in ('A320', 'A321', 'A330')),
  flight_no text not null,
  aircraft_registration text not null,
  std time not null,
  parking_bay text not null,
  time_commence time not null,
  time_completed time not null,

  pic_informed text not null check (pic_informed in ('YES', 'NO')),
  declaration text not null check (
    declaration in (
      'I CERTIFY THAT THE ABOVE CHECKS HAVE BEEN CARRIED OUT AND NO DISCREPANCY WAS FOUND.',
      'DISCREPANCIES FOUND AND DUTY OFFICER IS NOTIFIED (PROVIDE DETAILS BELOW)'
    )
  ),
  d_remark text,
  acknowledgement boolean not null default false
);

create index if not exists report_sec029_profile_idx on report_sec029 (profile_id);
create index if not exists report_sec029_station_idx on report_sec029 (station);
create index if not exists report_sec029_reg_idx on report_sec029 (aircraft_registration);
create index if not exists report_sec029_submitted_idx on report_sec029 (submitted_at);

create table if not exists report_sec029_items (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references report_sec029 (id) on delete cascade,
  item_code text not null,
  checked text not null check (checked in ('YES', 'NO', 'NA')),
  remark_type text not null check (remark_type in ('nil', 'other', 'na')),
  remark_text text,
  unique (report_id, item_code)
);

-- ============ SEC 018: Patrolling of Aircraft at Parking Bay ============

create table if not exists report_sec018 (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles (id),
  status report_status not null default 'draft',
  submitted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  amendment_of uuid references report_sec018 (id),

  station text not null references stations (code),
  team text not null references teams (code),
  staff_name text not null,
  date_time timestamptz not null,

  acknowledgement boolean not null default false
);

create index if not exists report_sec018_profile_idx on report_sec018 (profile_id);
create index if not exists report_sec018_station_idx on report_sec018 (station);
create index if not exists report_sec018_submitted_idx on report_sec018 (submitted_at);

create table if not exists report_sec018_patrols (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references report_sec018 (id) on delete cascade,
  entry_no int not null check (entry_no between 1 and 6),
  time_from time,
  time_to time,
  parking_bay text,
  aircraft_type text,
  reg_no text,
  description text not null default '',
  unique (report_id, entry_no)
);

-- ============ Bay Board / 4-hour flag ============

create table if not exists bay_board (
  id uuid primary key default gen_random_uuid(),
  station text not null references stations (code),
  reg_no text not null,
  aircraft_type text,
  bay text not null,
  on_ground_since timestamptz not null,
  cleared_by_report_id uuid references report_sec029 (id),
  cleared_at timestamptz,
  created_by uuid not null references profiles (id),
  created_at timestamptz not null default now()
);

create index if not exists bay_board_station_idx on bay_board (station);
create index if not exists bay_board_reg_idx on bay_board (reg_no);
create index if not exists bay_board_open_idx on bay_board (station, cleared_at);

-- ============ updated_at trigger helper ============

create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger profiles_set_updated_at before update on profiles
  for each row execute function set_updated_at();
create trigger report_sec016_set_updated_at before update on report_sec016
  for each row execute function set_updated_at();
create trigger report_sec014_set_updated_at before update on report_sec014
  for each row execute function set_updated_at();
create trigger report_sec029_set_updated_at before update on report_sec029
  for each row execute function set_updated_at();
create trigger report_sec018_set_updated_at before update on report_sec018
  for each row execute function set_updated_at();

-- ============ Immutability trigger: block edits to submitted reports ============
-- Allows: any change while status = 'draft'; the single transition draft -> submitted
-- (which stamps submitted_at). Blocks all further UPDATE/DELETE once status = 'submitted'.

create or replace function block_submitted_report_mutation()
returns trigger as $$
begin
  if tg_op = 'DELETE' then
    if old.status = 'submitted' then
      raise exception 'Submitted reports are immutable and cannot be deleted. Submit an amendment instead.';
    end if;
    return old;
  end if;

  if old.status = 'submitted' then
    raise exception 'Submitted reports are immutable and cannot be edited. Submit an amendment instead.';
  end if;

  if new.status = 'submitted' and new.submitted_at is null then
    new.submitted_at = now();
  end if;

  return new;
end;
$$ language plpgsql;

create trigger report_sec016_immutable before update or delete on report_sec016
  for each row execute function block_submitted_report_mutation();
create trigger report_sec014_immutable before update or delete on report_sec014
  for each row execute function block_submitted_report_mutation();
create trigger report_sec029_immutable before update or delete on report_sec029
  for each row execute function block_submitted_report_mutation();
create trigger report_sec018_immutable before update or delete on report_sec018
  for each row execute function block_submitted_report_mutation();

-- Child rows (patrol entries / checklist items) follow the same immutability rule,
-- keyed off the parent report's status.

create or replace function block_submitted_child_mutation_sec014()
returns trigger as $$
declare
  parent_status report_status;
begin
  select status into parent_status from report_sec014 where id = coalesce(old.report_id, new.report_id);
  if parent_status = 'submitted' then
    raise exception 'Cannot modify entries of a submitted report.';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger report_sec014_patrols_immutable before update or delete on report_sec014_patrols
  for each row execute function block_submitted_child_mutation_sec014();

create or replace function block_submitted_child_mutation_sec029()
returns trigger as $$
declare
  parent_status report_status;
begin
  select status into parent_status from report_sec029 where id = coalesce(old.report_id, new.report_id);
  if parent_status = 'submitted' then
    raise exception 'Cannot modify entries of a submitted report.';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger report_sec029_items_immutable before update or delete on report_sec029_items
  for each row execute function block_submitted_child_mutation_sec029();

create or replace function block_submitted_child_mutation_sec018()
returns trigger as $$
declare
  parent_status report_status;
begin
  select status into parent_status from report_sec018 where id = coalesce(old.report_id, new.report_id);
  if parent_status = 'submitted' then
    raise exception 'Cannot modify entries of a submitted report.';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger report_sec018_patrols_immutable before update or delete on report_sec018_patrols
  for each row execute function block_submitted_child_mutation_sec018();

-- ============ Auto-create profile on signup ============

create or replace function handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();
