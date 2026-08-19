-- Upgrade 3: Offload Information (Departure Flight) — a new, standalone 7th report type.
-- Header + repeatable "Offloaded Baggage" child rows. Mirrors the report_sec033 pattern
-- exactly: same status/immutability/updated_at triggers, same rank+team-scoped RLS, same
-- report_no/drafts/acknowledgements/attachments machinery as the other 6 reports.
--
-- This is deliberately separate from SEC016's existing single-row "Offload Information
-- (Departure Flight)" section (offload_flight_no/offload_destination/offload_baggage_tag_no/
-- offload_total_baggage/offload_remark) — that section is a fixed part of the AA/SEC/F/016
-- paper form and stays as-is. This module is for logging offloaded baggage in detail
-- (multiple tags/reasons/weights) independent of whether a SEC016 was filed for the flight.
--
-- Open to ASO/SO/DSE (same population as the SEC014 daily report), with an optional
-- DSE verification block that only appears in the UI for DSE submitters.

create table offload_records (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles (id),
  status report_status not null default 'draft',
  submitted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  amendment_of uuid references offload_records (id),
  report_no text unique,

  station text not null,
  team text not null,
  staff_name text not null,
  staff_id text not null,

  flight_no text not null,
  destination text not null,
  aircraft_registration text not null,
  flight_date date not null,
  std time,
  total_bags int not null default 0,
  remark text,

  verified_by_dse_name text,
  verified_by_dse_id text
);

create index offload_records_profile_idx on offload_records (profile_id);
create index offload_records_station_idx on offload_records (station);
create index offload_records_submitted_idx on offload_records (submitted_at);
create index offload_records_flight_idx on offload_records (flight_no);

create table offload_items (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references offload_records (id) on delete cascade,
  entry_no int not null check (entry_no >= 1),
  baggage_tag_no text not null,
  reason text,
  weight_kg numeric,
  unique (report_id, entry_no)
);

create trigger offload_records_set_updated_at before update on offload_records
  for each row execute function set_updated_at();

create trigger offload_records_immutable before update or delete on offload_records
  for each row execute function block_submitted_report_mutation();

create or replace function block_submitted_child_mutation_offload()
returns trigger as $$
declare
  parent_status report_status;
begin
  select status into parent_status from offload_records where id = coalesce(old.report_id, new.report_id);
  if parent_status = 'submitted' then
    raise exception 'Cannot modify entries of a submitted report.';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger offload_items_immutable before update or delete on offload_items
  for each row execute function block_submitted_child_mutation_offload();

-- report_no assignment — prefix 'OFFLOAD' -> 'AASECOFL' was already reserved in
-- next_report_no() by migration 0019.
create or replace function set_report_no_offload()
returns trigger as $$
begin
  if new.report_no is null or new.report_no = '' then
    new.report_no := next_report_no('OFFLOAD', coalesce(new.flight_date, (now() at time zone 'Asia/Kuala_Lumpur')::date));
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger trg_set_report_no_offload before insert on offload_records
  for each row execute function set_report_no_offload();

alter table offload_records enable row level security;
alter table offload_items enable row level security;

create policy "offload rank select" on offload_records for select
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

create policy "offload own insert" on offload_records for insert
  with check (
    profile_id = auth.uid()
    and current_role_name() in ('ASO', 'SO', 'DSE')
    and current_status() = 'approved'
  );

create policy "offload own update" on offload_records for update using (profile_id = auth.uid());

create policy "offload_items via parent select" on offload_items for select
  using (exists (
    select 1 from offload_records r where r.id = report_id
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

create policy "offload_items via parent write" on offload_items for all
  using (exists (select 1 from offload_records r where r.id = report_id and r.profile_id = auth.uid()))
  with check (exists (select 1 from offload_records r where r.id = report_id and r.profile_id = auth.uid()));

-- Let Offload participate in the same drafts + acknowledgement + attachment machinery as
-- the other 6 reports.
alter table report_drafts drop constraint report_drafts_report_type_check;
alter table report_drafts add constraint report_drafts_report_type_check
  check (report_type = any (array['sec016', 'sec014', 'sec029', 'sec018', 'sec033', 'sec013', 'offload']));

alter table report_acknowledgements drop constraint report_acknowledgements_report_type_check;
alter table report_acknowledgements add constraint report_acknowledgements_report_type_check
  check (report_type = any (array['sec016', 'sec014', 'sec029', 'sec018', 'sec033', 'sec013', 'offload']));

alter table report_attachments drop constraint report_attachments_report_type_check;
alter table report_attachments add constraint report_attachments_report_type_check
  check (report_type = any (array['sec016', 'sec014', 'sec029', 'sec018', 'sec033', 'sec013', 'offload']));

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
  elsif p_report_type = 'offload' then
    return query select r.profile_id, r.station, r.team from offload_records r where r.id = p_report_id;
  end if;
end;
$$ language plpgsql stable security definer set search_path = public;
