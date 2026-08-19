-- SEC 033 — Aircraft Hold Checklist (Night Stop / First Departure Flight), AA/SEC/F/033 Rev.02.
-- Mirrors the report_sec018 pattern exactly: parent + repeatable child table, same status/
-- immutability/updated_at triggers, same rank+team-scoped RLS as the other 4 reports.
-- ASO-only submission (like sec016/029/018 — this is an aircraft checklist, not the SEC014
-- multi-role daily report).

create table report_sec033 (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles (id),
  status report_status not null default 'draft',
  submitted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  amendment_of uuid references report_sec033 (id),

  station text not null,
  team text not null,
  staff_name text not null,
  staff_id text not null,
  report_date date not null,
  report_time time not null
);

create index report_sec033_profile_idx on report_sec033 (profile_id);
create index report_sec033_station_idx on report_sec033 (station);
create index report_sec033_submitted_idx on report_sec033 (submitted_at);

create table report_sec033_hold_checks (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references report_sec033 (id) on delete cascade,
  entry_no int not null check (entry_no >= 1),
  parking_bay_no text not null,
  aircraft_registration_no text not null,
  remarks text,
  unique (report_id, entry_no)
);

create index report_sec033_hold_checks_reg_idx on report_sec033_hold_checks (aircraft_registration_no);

create trigger report_sec033_set_updated_at before update on report_sec033
  for each row execute function set_updated_at();

create trigger report_sec033_immutable before update or delete on report_sec033
  for each row execute function block_submitted_report_mutation();

create or replace function block_submitted_child_mutation_sec033()
returns trigger as $$
declare
  parent_status report_status;
begin
  select status into parent_status from report_sec033 where id = coalesce(old.report_id, new.report_id);
  if parent_status = 'submitted' then
    raise exception 'Cannot modify entries of a submitted report.';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger report_sec033_hold_checks_immutable before update or delete on report_sec033_hold_checks
  for each row execute function block_submitted_child_mutation_sec033();

alter table report_sec033 enable row level security;
alter table report_sec033_hold_checks enable row level security;

create policy "sec033 rank select" on report_sec033 for select
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

create policy "sec033 own insert" on report_sec033 for insert
  with check (profile_id = auth.uid() and current_role_name() = 'ASO' and current_status() = 'approved');

create policy "sec033 own update" on report_sec033 for update using (profile_id = auth.uid());

create policy "sec033_hold_checks via parent select" on report_sec033_hold_checks for select
  using (exists (
    select 1 from report_sec033 r where r.id = report_id
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

create policy "sec033_hold_checks via parent write" on report_sec033_hold_checks for all
  using (exists (select 1 from report_sec033 r where r.id = report_id and r.profile_id = auth.uid()))
  with check (exists (select 1 from report_sec033 r where r.id = report_id and r.profile_id = auth.uid()));

-- Let SEC033 participate in the same drafts + acknowledgement machinery as the other reports.
alter table report_drafts drop constraint report_drafts_report_type_check;
alter table report_drafts add constraint report_drafts_report_type_check
  check (report_type = any (array['sec016', 'sec014', 'sec029', 'sec018', 'sec033']));

alter table report_acknowledgements drop constraint report_acknowledgements_report_type_check;
alter table report_acknowledgements add constraint report_acknowledgements_report_type_check
  check (report_type = any (array['sec016', 'sec014', 'sec029', 'sec018', 'sec033']));

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
  end if;
end;
$$ language plpgsql stable security definer set search_path = public;
