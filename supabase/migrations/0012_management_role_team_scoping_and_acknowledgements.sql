-- Rank order: ASO(1) < SO(2) < DSE(3) < ENFORCEMENT(4) < MANAGEMENT(5) < ADMIN(6).
create or replace function role_rank(r user_role)
returns int as $$
  select case r
    when 'ASO' then 1
    when 'SO' then 2
    when 'DSE' then 3
    when 'ENFORCEMENT' then 4
    when 'MANAGEMENT' then 5
    when 'ADMIN' then 6
  end;
$$ language sql immutable;

create or replace function is_monitor_or_above()
returns boolean as $$
  select current_role_name() in ('SO', 'DSE', 'ENFORCEMENT', 'MANAGEMENT', 'ADMIN');
$$ language sql stable security definer set search_path = public;

create or replace function current_team()
returns text as $$
  select team from profiles where id = auth.uid();
$$ language sql stable security definer set search_path = public;

-- Team names are free text now (differ per station) — drop the fixed-list FK constraints.
alter table profiles drop constraint if exists profiles_team_fkey;
alter table report_sec016 drop constraint if exists report_sec016_team_fkey;
alter table report_sec014 drop constraint if exists report_sec014_team_fkey;
alter table report_sec029 drop constraint if exists report_sec029_team_fkey;
alter table report_sec018 drop constraint if exists report_sec018_team_fkey;

-- Re-scope monitoring: ENFORCEMENT/MANAGEMENT/ADMIN stay org-wide; SO/DSE are limited to
-- their own station+team (e.g. DSE Alpha cannot see Bravo/Charlie/Delta's reports).
drop policy "sec016 rank select" on report_sec016;
create policy "sec016 rank select" on report_sec016 for select
  using (
    profile_id = auth.uid()
    or (
      current_role_rank() > submitter_role_rank(profile_id)
      and (
        current_role_rank() >= role_rank('ENFORCEMENT')
        or (station = current_station() and coalesce(team, '') = coalesce(current_team(), ''))
      )
    )
  );

drop policy "sec014 rank select" on report_sec014;
create policy "sec014 rank select" on report_sec014 for select
  using (
    profile_id = auth.uid()
    or (
      current_role_rank() > submitter_role_rank(profile_id)
      and (
        current_role_rank() >= role_rank('ENFORCEMENT')
        or (station = current_station() and coalesce(team, '') = coalesce(current_team(), ''))
      )
    )
  );

drop policy "sec014_patrols via parent select" on report_sec014_patrols;
create policy "sec014_patrols via parent select" on report_sec014_patrols for select
  using (exists (
    select 1 from report_sec014 r where r.id = report_id
    and (
      r.profile_id = auth.uid()
      or (
        current_role_rank() > submitter_role_rank(r.profile_id)
        and (
          current_role_rank() >= role_rank('ENFORCEMENT')
          or (r.station = current_station() and coalesce(r.team, '') = coalesce(current_team(), ''))
        )
      )
    )
  ));

drop policy "sec029 rank select" on report_sec029;
create policy "sec029 rank select" on report_sec029 for select
  using (
    profile_id = auth.uid()
    or (
      current_role_rank() > submitter_role_rank(profile_id)
      and (
        current_role_rank() >= role_rank('ENFORCEMENT')
        or (station = current_station() and coalesce(team, '') = coalesce(current_team(), ''))
      )
    )
  );

drop policy "sec029_items via parent select" on report_sec029_items;
create policy "sec029_items via parent select" on report_sec029_items for select
  using (exists (
    select 1 from report_sec029 r where r.id = report_id
    and (
      r.profile_id = auth.uid()
      or (
        current_role_rank() > submitter_role_rank(r.profile_id)
        and (
          current_role_rank() >= role_rank('ENFORCEMENT')
          or (r.station = current_station() and coalesce(r.team, '') = coalesce(current_team(), ''))
        )
      )
    )
  ));

drop policy "sec018 rank select" on report_sec018;
create policy "sec018 rank select" on report_sec018 for select
  using (
    profile_id = auth.uid()
    or (
      current_role_rank() > submitter_role_rank(profile_id)
      and (
        current_role_rank() >= role_rank('ENFORCEMENT')
        or (station = current_station() and coalesce(team, '') = coalesce(current_team(), ''))
      )
    )
  );

drop policy "sec018_patrols via parent select" on report_sec018_patrols;
create policy "sec018_patrols via parent select" on report_sec018_patrols for select
  using (exists (
    select 1 from report_sec018 r where r.id = report_id
    and (
      r.profile_id = auth.uid()
      or (
        current_role_rank() > submitter_role_rank(r.profile_id)
        and (
          current_role_rank() >= role_rank('ENFORCEMENT')
          or (r.station = current_station() and coalesce(r.team, '') = coalesce(current_team(), ''))
        )
      )
    )
  ));

-- ============ Acknowledgements ============
-- Additive audit trail, separate from the existing self-declaration "acknowledgement"
-- checkbox already on the report forms. Records that the rank directly above the
-- submitter (SO over ASO, DSE over SO) signed off on a specific report. DSE's own
-- reports are never acknowledged (they're the team head) — no row is ever created for those.

create table if not exists report_acknowledgements (
  id uuid primary key default gen_random_uuid(),
  report_type text not null check (report_type in ('sec016', 'sec014', 'sec029', 'sec018')),
  report_id uuid not null,
  acknowledged_by uuid not null references profiles (id),
  acknowledged_at timestamptz not null default now(),
  unique (report_type, report_id)
);

alter table report_acknowledgements enable row level security;

create or replace function get_report_submitter(p_report_type text, p_report_id uuid)
returns table(profile_id uuid, station text, team text) as $$
begin
  if p_report_type = 'sec016' then
    return query select r.profile_id, r.station, r.team from report_sec016 r where r.id = p_report_id;
  elsif p_report_type = 'sec014' then
    return query select r.profile_id, r.station, r.team from report_sec014 r where r.id = p_report_id;
  elsif p_report_type = 'sec029' then
    return query select r.profile_id, r.station, r.team from report_sec029 r where r.id = p_report_id;
  elsif p_report_type = 'sec018' then
    return query select r.profile_id, r.station, r.team from report_sec018 r where r.id = p_report_id;
  end if;
end;
$$ language plpgsql stable security definer set search_path = public;

create or replace function can_acknowledge_report(p_report_type text, p_report_id uuid)
returns boolean as $$
declare
  sub record;
  acker_role user_role;
  acker_station text;
  acker_team text;
begin
  select * into sub from get_report_submitter(p_report_type, p_report_id);
  if sub is null then
    return false;
  end if;

  select role, station, team into acker_role, acker_station, acker_team
  from profiles where id = auth.uid();

  return role_rank(acker_role) = submitter_role_rank(sub.profile_id) + 1
    and acker_station = sub.station
    and coalesce(acker_team, '') = coalesce(sub.team, '');
end;
$$ language plpgsql stable security definer set search_path = public;

create policy "ack select" on report_acknowledgements for select
  using (current_status() = 'approved');

create policy "ack insert" on report_acknowledgements for insert
  with check (
    acknowledged_by = auth.uid()
    and current_status() = 'approved'
    and can_acknowledge_report(report_type, report_id)
  );
