-- Duty Check-In & Overtime module — Phase 1: core tables + RLS.
--
-- Additive only: no existing table, policy, or function is modified. Reuses the rank
-- helpers already powering the report_sec* policies (role_rank / current_role_rank /
-- submitter_role_rank / current_station / current_team / current_status), so the
-- visibility rule here is the same one reviewers already know from report_sec014.
--
-- Team matching uses coalesce(team, '') on both sides, matching migration 0012 — org-wide
-- roles (ENFORCEMENT/MANAGEMENT/ADMIN) carry a null/blank team and are exempted by the
-- rank branch anyway.

-- ============ Duty zones (geofence areas per station) ============

create table if not exists duty_zones (
  id uuid primary key default gen_random_uuid(),
  station text not null references stations (code),
  code text not null,
  name text not null,
  polygon jsonb not null,
  center_lat double precision not null,
  center_lng double precision not null,
  radius_m integer not null default 150,
  active boolean not null default true,
  created_by uuid references profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (station, code)
);

create index if not exists duty_zones_station_idx on duty_zones (station, active);

create trigger duty_zones_set_updated_at before update on duty_zones
  for each row execute function set_updated_at();

-- ============ Duty records (check-in / check-out core) ============
-- Mirrors the report_sec* row shape: profile_id + station + team on every row for RLS.

create table if not exists duty_records (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles (id),
  station text not null references stations (code),
  team text,
  duty_date date not null,
  shift_code text not null,
  zone_id uuid references duty_zones (id),

  check_in_at timestamptz,
  check_in_lat double precision,
  check_in_lng double precision,
  check_in_accuracy_m double precision,
  check_in_inside_fence boolean,
  check_in_offline boolean not null default false,
  check_in_hmac text,

  check_out_at timestamptz,
  check_out_lat double precision,
  check_out_lng double precision,
  check_out_inside_fence boolean,

  status text not null default 'pending'
    check (status in ('pending', 'present', 'late', 'absent', 'early_out')),
  late_minutes integer not null default 0,
  late_remark text,
  early_out_minutes integer not null default 0,
  early_out_remark text,

  -- Optional: most staff patrol/move rather than hold one post, so this stays null
  -- unless a fixed post was actually assigned for that shift.
  post_assignment text,
  handover_notes text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (profile_id, duty_date, shift_code),

  -- A flagged record must carry its explanation; enforced in the DB so an offline
  -- client replaying a queued check-in can't bypass the UI's mandatory remark.
  constraint duty_late_needs_remark
    check (late_minutes = 0 or coalesce(btrim(late_remark), '') <> ''),
  constraint duty_early_out_needs_remark
    check (early_out_minutes = 0 or coalesce(btrim(early_out_remark), '') <> '')
);

create index if not exists duty_records_profile_idx on duty_records (profile_id, duty_date);
create index if not exists duty_records_station_date_idx on duty_records (station, duty_date);
create index if not exists duty_records_zone_idx on duty_records (zone_id);
-- Live heat map reads "checked in, not yet checked out" for a station.
create index if not exists duty_records_open_idx on duty_records (station, check_out_at)
  where check_in_at is not null;

create trigger duty_records_set_updated_at before update on duty_records
  for each row execute function set_updated_at();

-- ============ Overtime requests ============

create table if not exists overtime_requests (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles (id),
  station text not null references stations (code),
  team text,
  work_date date not null,
  shift_code text,
  start_at timestamptz not null,
  end_at timestamptz not null,

  -- Exact duration, kept for the record.
  hours numeric generated always as (extract(epoch from (end_at - start_at)) / 3600) stored,
  -- Claimable figure: whole completed hours only, never rounded up (40min -> 0, 75min -> 1).
  -- Mirrors calcOtHours() in lib/overtime.ts — keep the two in sync.
  payable_hours integer generated always as (
    greatest(floor(extract(epoch from (end_at - start_at)) / 3600)::integer, 0)
  ) stored,

  category text not null
    check (category in ('flight_delay', 'manpower_shortage', 'event', 'off_day_work', 'adhoc')),
  reason text not null,
  status text not null default 'pending'
    check (status in ('pending', 'endorsed', 'approved', 'rejected', 'cancelled')),

  endorsed_by uuid references profiles (id),
  endorsed_at timestamptz,
  approved_by uuid references profiles (id),
  approved_at timestamptz,
  rejection_reason text,
  linked_duty_id uuid references duty_records (id),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint overtime_end_after_start check (end_at > start_at)
);

create index if not exists overtime_profile_idx on overtime_requests (profile_id, work_date);
create index if not exists overtime_station_status_idx on overtime_requests (station, status);

create trigger overtime_requests_set_updated_at before update on overtime_requests
  for each row execute function set_updated_at();

-- ============ Audit log (append-only, same spirit as the report Record Trail) ============

create table if not exists duty_audit_log (
  id bigint generated always as identity primary key,
  actor_id uuid references profiles (id),
  action text not null,
  entity text not null,
  entity_id uuid,
  payload jsonb,
  created_at timestamptz not null default now()
);

create index if not exists duty_audit_entity_idx on duty_audit_log (entity, entity_id);

-- ============ Immutability ============
-- Duty records stay editable through the shift (check-out has to land on the same row),
-- but the two accountability fields are write-once: an explanation can't be softened
-- after a supervisor has seen it, matching the "no edit, only amendment" rule on reports.

create or replace function block_duty_remark_rewrite()
returns trigger as $$
begin
  if old.late_remark is not null and new.late_remark is distinct from old.late_remark then
    raise exception 'Late remark is recorded once and cannot be edited.';
  end if;
  if old.early_out_remark is not null and new.early_out_remark is distinct from old.early_out_remark then
    raise exception 'Early-out remark is recorded once and cannot be edited.';
  end if;
  if old.check_in_at is not null and new.check_in_at is distinct from old.check_in_at then
    raise exception 'Check-in time cannot be altered after check-in.';
  end if;
  if old.check_out_at is not null and new.check_out_at is distinct from old.check_out_at then
    raise exception 'Check-out time cannot be altered after check-out.';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger duty_records_remark_immutable before update on duty_records
  for each row execute function block_duty_remark_rewrite();

-- Approved/rejected OT is closed: corrections are filed as a new linked request.

create or replace function block_settled_overtime_mutation()
returns trigger as $$
begin
  if tg_op = 'DELETE' then
    if old.status in ('approved', 'rejected') then
      raise exception 'Settled overtime requests cannot be deleted. File a new request instead.';
    end if;
    return old;
  end if;

  if old.status in ('approved', 'rejected') then
    raise exception 'Settled overtime requests are immutable. File a new request instead.';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger overtime_requests_immutable before update or delete on overtime_requests
  for each row execute function block_settled_overtime_mutation();

-- ============ RLS ============

alter table duty_zones enable row level security;
alter table duty_records enable row level security;
alter table overtime_requests enable row level security;
alter table duty_audit_log enable row level security;

-- Zones are reference data: readable by every approved user (the check-in screen needs
-- them), writable only by Admin via /admin/zones — same tier as /admin/users.
create policy "duty_zones readable" on duty_zones for select
  using (current_status() = 'approved');
create policy "duty_zones admin write" on duty_zones for all
  using (current_role_name() = 'ADMIN')
  with check (current_role_name() = 'ADMIN');

-- Duty records: own rows always; otherwise the report_sec014 visibility rule verbatim.
create policy "duty own select" on duty_records for select
  using (profile_id = auth.uid());

create policy "duty monitor select" on duty_records for select
  using (
    current_role_rank() > submitter_role_rank(profile_id)
    and (
      current_role_rank() >= role_rank('ENFORCEMENT')
      or (station = current_station() and coalesce(team, '') = coalesce(current_team(), ''))
    )
  );

create policy "duty own insert" on duty_records for insert
  with check (profile_id = auth.uid() and current_status() = 'approved');

create policy "duty own update" on duty_records for update
  using (profile_id = auth.uid())
  with check (profile_id = auth.uid());

-- Overtime: same visibility rule; submitted by the claimant, settled by higher ranks.
create policy "overtime own select" on overtime_requests for select
  using (profile_id = auth.uid());

create policy "overtime monitor select" on overtime_requests for select
  using (
    current_role_rank() > submitter_role_rank(profile_id)
    and (
      current_role_rank() >= role_rank('ENFORCEMENT')
      or (station = current_station() and coalesce(team, '') = coalesce(current_team(), ''))
    )
  );

create policy "overtime own insert" on overtime_requests for insert
  with check (profile_id = auth.uid() and current_status() = 'approved');

-- The claimant may still withdraw/correct their own request while it is untouched;
-- the immutability trigger closes it once approved or rejected.
create policy "overtime own update" on overtime_requests for update
  using (profile_id = auth.uid() and status = 'pending')
  with check (profile_id = auth.uid());

-- Endorse (SO/DSE over their own station+team) and approve (MANAGEMENT/ADMIN, org-wide).
create policy "overtime settle update" on overtime_requests for update
  using (
    current_role_rank() > submitter_role_rank(profile_id)
    and (
      current_role_rank() >= role_rank('MANAGEMENT')
      or (station = current_station() and coalesce(team, '') = coalesce(current_team(), ''))
    )
  )
  with check (
    current_role_rank() > submitter_role_rank(profile_id)
    and (
      current_role_rank() >= role_rank('MANAGEMENT')
      or (station = current_station() and coalesce(team, '') = coalesce(current_team(), ''))
    )
  );

-- Audit log: anyone approved can append their own actions; monitors can read.
create policy "duty_audit insert" on duty_audit_log for insert
  with check (actor_id = auth.uid() and current_status() = 'approved');
create policy "duty_audit monitor select" on duty_audit_log for select
  using (is_monitor_or_above());
