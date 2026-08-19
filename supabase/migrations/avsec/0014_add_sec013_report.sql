-- SEC 013 — Daily Report Profiling (AVSEC), AA/SEC/F/013 Rev.03.
-- Mirrors the report_sec014 pattern (staff details + date_time_in/out + repeatable child
-- table + acknowledgement checkbox), plus two extra Section-3-only columns (remark,
-- corrective_action) that appear once, after all profiling-duty blocks, not repeatable.
-- ASO-only submission, same rank+team-scoped RLS as the other 5 reports.

create table report_sec013 (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles (id),
  status report_status not null default 'draft',
  submitted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  amendment_of uuid references report_sec013 (id),

  station text not null,
  team text not null,
  staff_name text not null,
  staff_id text not null,
  date_time_in timestamptz not null,
  date_time_out timestamptz not null,

  remark text,
  corrective_action text,
  acknowledgement boolean not null default false
);

create index report_sec013_profile_idx on report_sec013 (profile_id);
create index report_sec013_station_idx on report_sec013 (station);
create index report_sec013_submitted_idx on report_sec013 (submitted_at);

create table report_sec013_profiling_duties (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references report_sec013 (id) on delete cascade,
  entry_no int not null check (entry_no >= 1),
  duty_area text not null check (duty_area in ('Departure Gate', 'Terminal Area', 'Apron')),
  time_from text not null,
  time_to text not null,
  location text not null check (
    location in (
      'Departure Gate Sector 5/6/7 (P-Q)',
      'Departure Gate Sector 1 & 3 (J & L/K)',
      'Terminal Area (Sector 2)'
    )
  ),
  sector_flight text not null,
  description text not null,
  incident_remark text,
  unique (report_id, entry_no)
);

create trigger report_sec013_set_updated_at before update on report_sec013
  for each row execute function set_updated_at();

create trigger report_sec013_immutable before update or delete on report_sec013
  for each row execute function block_submitted_report_mutation();

create or replace function block_submitted_child_mutation_sec013()
returns trigger as $$
declare
  parent_status report_status;
begin
  select status into parent_status from report_sec013 where id = coalesce(old.report_id, new.report_id);
  if parent_status = 'submitted' then
    raise exception 'Cannot modify entries of a submitted report.';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger report_sec013_profiling_duties_immutable before update or delete on report_sec013_profiling_duties
  for each row execute function block_submitted_child_mutation_sec013();

alter table report_sec013 enable row level security;
alter table report_sec013_profiling_duties enable row level security;

create policy "sec013 rank select" on report_sec013 for select
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

create policy "sec013 own insert" on report_sec013 for insert
  with check (profile_id = auth.uid() and current_role_name() = 'ASO' and current_status() = 'approved');

create policy "sec013 own update" on report_sec013 for update using (profile_id = auth.uid());

create policy "sec013_profiling_duties via parent select" on report_sec013_profiling_duties for select
  using (exists (
    select 1 from report_sec013 r where r.id = report_id
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

create policy "sec013_profiling_duties via parent write" on report_sec013_profiling_duties for all
  using (exists (select 1 from report_sec013 r where r.id = report_id and r.profile_id = auth.uid()))
  with check (exists (select 1 from report_sec013 r where r.id = report_id and r.profile_id = auth.uid()));

-- Let SEC013 participate in the same drafts + acknowledgement machinery as the other reports.
alter table report_drafts drop constraint report_drafts_report_type_check;
alter table report_drafts add constraint report_drafts_report_type_check
  check (report_type = any (array['sec016', 'sec014', 'sec029', 'sec018', 'sec033', 'sec013']));

alter table report_acknowledgements drop constraint report_acknowledgements_report_type_check;
alter table report_acknowledgements add constraint report_acknowledgements_report_type_check
  check (report_type = any (array['sec016', 'sec014', 'sec029', 'sec018', 'sec033', 'sec013']));

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
  elsif p_report_type = 'sec033' then
    return query select r.profile_id, r.station, r.team from report_sec033 r where r.id = p_report_id;
  elsif p_report_type = 'sec013' then
    return query select r.profile_id, r.station, r.team from report_sec013 r where r.id = p_report_id;
  end if;
end;
$$ language plpgsql stable security definer set search_path = public;
