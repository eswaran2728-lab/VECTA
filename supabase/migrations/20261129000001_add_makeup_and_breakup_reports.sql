-- 20261129000001_add_makeup_and_breakup_reports.sql
-- Forward migration to implement approved Makeup Report (departure baggage operations)
-- and Breakup Report (arrival baggage operations).

-- =============================================================================================
-- 1. Tables: report_makeup and child tables
-- =============================================================================================

create table if not exists public.report_makeup (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id),
  status public.report_status not null default 'draft',
  submitted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  report_no text unique,

  -- Header fields
  station text not null,
  team text not null,
  staff_name text not null,
  staff_id text not null,
  flight_number text not null,
  duty_date date not null,
  destination text not null,

  -- Timing
  first_baggage_time text not null,
  last_baggage_tag_time text not null,

  -- Additional sections
  ground_handling_personnel text,
  remarks text,
  officer_confirmation boolean not null default false,

  -- Organizational hierarchy & entity classification
  aoc_id uuid references public.aocs(id),
  operating_entity_id uuid references public.operating_entities(id),
  operating_entity_code text,
  department_id uuid references public.departments(id),
  unit_id uuid references public.units(id),
  hub_id uuid references public.hubs(id),
  org_station_id uuid references public.org_stations(id),
  org_team_id uuid references public.org_teams(id),
  ops_group text
);

create table if not exists public.report_makeup_baggage_entries (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.report_makeup(id) on delete cascade,
  entry_no integer not null,
  container_pallet_trolley_no text not null,
  seal_no text not null,
  bay text not null,
  destination text not null,
  created_at timestamptz not null default now(),
  constraint report_makeup_baggage_entries_unique unique (report_id, entry_no)
);

create table if not exists public.report_makeup_discrepancies (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.report_makeup(id) on delete cascade,
  entry_no integer not null,
  baggage_tag_no text,
  details text,
  created_at timestamptz not null default now(),
  constraint report_makeup_discrepancies_unique unique (report_id, entry_no)
);

create index if not exists idx_report_makeup_profile_id on public.report_makeup(profile_id);
create index if not exists idx_report_makeup_station_team on public.report_makeup(station, team);
create index if not exists idx_report_makeup_report_no on public.report_makeup(report_no);
create index if not exists idx_report_makeup_duty_date on public.report_makeup(duty_date);
create index if not exists idx_report_makeup_baggage_entries_report_id on public.report_makeup_baggage_entries(report_id);
create index if not exists idx_report_makeup_discrepancies_report_id on public.report_makeup_discrepancies(report_id);

-- =============================================================================================
-- 2. Tables: report_breakup and child tables
-- =============================================================================================

create table if not exists public.report_breakup (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id),
  status public.report_status not null default 'draft',
  submitted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  report_no text unique,

  -- Header fields
  station text not null,
  team text not null,
  staff_name text not null,
  staff_id text not null,
  flight_number text not null,
  duty_date date not null,
  origin text not null,

  -- Timing
  first_container_time text not null,
  last_container_time text not null,

  -- Additional sections
  ground_handling_personnel text,
  pir_dpr_details text,
  containers_inspected_clean boolean not null default false,

  -- Organizational hierarchy & entity classification
  aoc_id uuid references public.aocs(id),
  operating_entity_id uuid references public.operating_entities(id),
  operating_entity_code text,
  department_id uuid references public.departments(id),
  unit_id uuid references public.units(id),
  hub_id uuid references public.hubs(id),
  org_station_id uuid references public.org_stations(id),
  org_team_id uuid references public.org_teams(id),
  ops_group text
);

create table if not exists public.report_breakup_baggage_entries (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.report_breakup(id) on delete cascade,
  entry_no integer not null,
  container_pallet_trolley_no text not null,
  baggage_tag_no text,
  discrepancy_details text,
  created_at timestamptz not null default now(),
  constraint report_breakup_baggage_entries_unique unique (report_id, entry_no)
);

create index if not exists idx_report_breakup_profile_id on public.report_breakup(profile_id);
create index if not exists idx_report_breakup_station_team on public.report_breakup(station, team);
create index if not exists idx_report_breakup_report_no on public.report_breakup(report_no);
create index if not exists idx_report_breakup_duty_date on public.report_breakup(duty_date);
create index if not exists idx_report_breakup_baggage_entries_report_id on public.report_breakup_baggage_entries(report_id);

-- =============================================================================================
-- 3. Immutability triggers
-- =============================================================================================

create trigger report_makeup_set_updated_at before update on public.report_makeup
  for each row execute function public.set_updated_at();

create trigger report_makeup_immutable before update or delete on public.report_makeup
  for each row execute function public.block_submitted_report_mutation();

create or replace function public.block_submitted_child_mutation_makeup()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  parent_status public.report_status;
begin
  select status into parent_status from public.report_makeup where id = coalesce(old.report_id, new.report_id);
  if parent_status = 'submitted' then
    raise exception 'Cannot modify entries of a submitted report.';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;
revoke execute on function public.block_submitted_child_mutation_makeup() from public, anon, authenticated;
grant execute on function public.block_submitted_child_mutation_makeup() to service_role;

create trigger report_makeup_baggage_entries_immutable before update or delete on public.report_makeup_baggage_entries
  for each row execute function public.block_submitted_child_mutation_makeup();

create trigger report_makeup_discrepancies_immutable before update or delete on public.report_makeup_discrepancies
  for each row execute function public.block_submitted_child_mutation_makeup();

create trigger report_breakup_set_updated_at before update on public.report_breakup
  for each row execute function public.set_updated_at();

create trigger report_breakup_immutable before update or delete on public.report_breakup
  for each row execute function public.block_submitted_report_mutation();

create or replace function public.block_submitted_child_mutation_breakup()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  parent_status public.report_status;
begin
  select status into parent_status from public.report_breakup where id = coalesce(old.report_id, new.report_id);
  if parent_status = 'submitted' then
    raise exception 'Cannot modify entries of a submitted report.';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;
revoke execute on function public.block_submitted_child_mutation_breakup() from public, anon, authenticated;
grant execute on function public.block_submitted_child_mutation_breakup() to service_role;

create trigger report_breakup_baggage_entries_immutable before update or delete on public.report_breakup_baggage_entries
  for each row execute function public.block_submitted_child_mutation_breakup();

-- =============================================================================================
-- 4. Report numbering
-- =============================================================================================

create or replace function public.next_report_no(p_form_code text, p_report_date date)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_seq integer;
  v_prefix text;
begin
  v_prefix := case upper(p_form_code)
    when 'SEC016' then 'AASEC16'
    when 'SEC014' then 'AASEC14'
    when 'SEC029' then 'AASEC29'
    when 'SEC018' then 'AASEC18'
    when 'SEC033' then 'AASEC33'
    when 'SEC013' then 'AASEC13'
    when 'OFFLOAD' then 'AASECOFL'
    when 'MAKEUP' then 'AAMKP'
    when 'BREAKUP' then 'AABKP'
    else null
  end;
  if v_prefix is null then
    raise exception 'Unknown form code: %', p_form_code;
  end if;

  insert into public.report_counters (form_code, report_date, last_seq)
  values (upper(p_form_code), p_report_date, 1)
  on conflict (form_code, report_date)
  do update set last_seq = report_counters.last_seq + 1
  returning last_seq into v_seq;

  return v_prefix || '-' || to_char(p_report_date, 'YYYYMMDD') || '-' || lpad(v_seq::text, 3, '0');
end;
$$;

create or replace function public.set_report_no_makeup() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'submitted' and (new.report_no is null or new.report_no = '') then
    new.report_no := public.next_report_no('MAKEUP', coalesce(new.duty_date, (now() at time zone 'Asia/Kuala_Lumpur')::date));
  end if;
  return new;
end;
$$;

drop trigger if exists trg_set_report_no_makeup on public.report_makeup;
create trigger trg_set_report_no_makeup before insert or update on public.report_makeup
  for each row execute function public.set_report_no_makeup();

create or replace function public.set_report_no_breakup() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'submitted' and (new.report_no is null or new.report_no = '') then
    new.report_no := public.next_report_no('BREAKUP', coalesce(new.duty_date, (now() at time zone 'Asia/Kuala_Lumpur')::date));
  end if;
  return new;
end;
$$;

drop trigger if exists trg_set_report_no_breakup on public.report_breakup;
create trigger trg_set_report_no_breakup before insert or update on public.report_breakup
  for each row execute function public.set_report_no_breakup();

-- =============================================================================================
-- 5. Form assignments & creation trigger
-- =============================================================================================

alter table public.report_form_assignments drop constraint if exists report_form_assignments_form_type_check;
alter table public.report_form_assignments add constraint report_form_assignments_form_type_check
  check (form_type in ('sec013', 'sec014', 'sec016', 'sec018', 'sec029', 'sec033', 'offload', 'makeup', 'breakup'));

insert into public.report_form_assignments (role_code, station_code, profile_id, form_type, note)
select 'aso', s.code, null, f, 'explicit operational default for this station'
from public.org_stations s
cross join unnest(array['makeup', 'breakup']) as f
where s.is_active
on conflict on constraint report_form_assignments_unique do nothing;

create or replace function public.list_my_report_forms_secure()
returns table (form_type text)
language sql
stable
security definer
set search_path to 'public'
as $$
  select f from unnest(array['sec016', 'sec014', 'sec029', 'sec018', 'sec033', 'sec013', 'makeup', 'breakup']) as f
  where public.can_create_report_form(f);
$$;

create or replace function public.enforce_report_form_assignment()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_form text := case tg_table_name
    when 'report_sec013' then 'sec013' when 'report_sec014' then 'sec014' when 'report_sec016' then 'sec016'
    when 'report_sec018' then 'sec018' when 'report_sec029' then 'sec029' when 'report_sec033' then 'sec033'
    when 'offload_records' then 'offload' when 'report_makeup' then 'makeup' when 'report_breakup' then 'breakup'
    else null end;
begin
  if auth.role() = 'authenticated' and (v_form is null or not public.can_create_report_form(v_form)) then
    raise exception 'Your assignment does not include the % report form.', coalesce(v_form, tg_table_name);
  end if;
  return new;
end;
$$;

drop trigger if exists trg_enforce_form_assignment on public.report_makeup;
create trigger trg_enforce_form_assignment before insert on public.report_makeup
  for each row execute function public.enforce_report_form_assignment();

drop trigger if exists trg_enforce_form_assignment on public.report_breakup;
create trigger trg_enforce_form_assignment before insert on public.report_breakup
  for each row execute function public.enforce_report_form_assignment();

-- =============================================================================================
-- 6. Classification & Review Queue
-- =============================================================================================

create or replace function public.set_report_classification_fields()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_explicit_entity_id uuid := null;
  v_explicit_entity_code text := null;
  v_assignment_aoc uuid := null;
  v_flight text;
  v_flight_class record;
  v_entity record;
begin
  if new.operating_entity_id is not null then
    select oe.id, oe.code, oe.aoc_id into v_explicit_entity_id, v_explicit_entity_code, v_assignment_aoc
    from public.operating_entities oe
    where oe.id = new.operating_entity_id;
  elsif new.operating_entity_code is not null then
    select oe.id, oe.code, oe.aoc_id into v_explicit_entity_id, v_explicit_entity_code, v_assignment_aoc
    from public.operating_entities oe
    where oe.code = upper(trim(new.operating_entity_code));
  end if;

  if v_explicit_entity_id is null and new.profile_id is not null then
    select ura.aoc_id, coalesce(oe.id, oem.id), coalesce(oe.code, oem.code)
    into v_assignment_aoc, new.operating_entity_id, new.operating_entity_code
    from public.user_role_assignments ura
    left join public.operating_entities oe on oe.id = ura.operating_entity_id
    left join public.user_entity_memberships uem on uem.id = ura.entity_membership_id and uem.status = 'active'
      and uem.starts_at <= now() and (uem.ends_at is null or uem.ends_at > now())
    left join public.operating_entities oem on oem.id = uem.operating_entity_id
    where ura.profile_id = new.profile_id
      and ura.role_definition_id in (select id from public.role_definitions where is_active)
      and ura.revoked_at is null
      and ura.starts_at <= now()
      and (ura.ends_at is null or ura.ends_at > now())
      and ura.aoc_id is not null
    limit 1;

    v_flight := case tg_table_name
      when 'report_sec016' then to_jsonb(new) ->> 'flight'
      when 'report_sec029' then to_jsonb(new) ->> 'flight_no'
      when 'offload_records' then to_jsonb(new) ->> 'flight_no'
      when 'report_makeup' then to_jsonb(new) ->> 'flight_number'
      when 'report_breakup' then to_jsonb(new) ->> 'flight_number'
      else null
    end;
    if tg_table_name in ('report_sec016', 'report_sec029', 'offload_records', 'report_makeup', 'report_breakup') and v_explicit_entity_id is null then
      v_assignment_aoc := new.aoc_id;
      select * into v_flight_class from public.classify_flight_operating_entity(v_flight);
      new.operating_entity_id := null;
      new.operating_entity_code := null;
      if v_flight_class.status = 'classified' then
        select oe.id, oe.code, oe.aoc_id into v_entity from public.operating_entities oe where oe.code = v_flight_class.entity_code limit 1;
        if v_entity.id is not null and v_entity.aoc_id is not distinct from v_assignment_aoc then
          new.operating_entity_id := v_entity.id;
          new.operating_entity_code := v_entity.code;
        end if;
      end if;
    end if;
  end if;

  if v_explicit_entity_id is not null then
    new.operating_entity_id := v_explicit_entity_id;
    new.operating_entity_code := v_explicit_entity_code;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_set_classification on public.report_makeup;
create trigger trg_set_classification before insert or update on public.report_makeup
  for each row execute function public.set_report_classification_fields();

drop trigger if exists trg_set_classification on public.report_breakup;
create trigger trg_set_classification before insert or update on public.report_breakup
  for each row execute function public.set_report_classification_fields();

create or replace function public.enqueue_unclassified_flight_report()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_flight text;
  v_class record;
  v_reason text;
begin
  if new.operating_entity_code is not null then
    return new;
  end if;
  v_flight := case tg_table_name
    when 'report_sec016' then to_jsonb(new) ->> 'flight'
    when 'report_sec029' then to_jsonb(new) ->> 'flight_no'
    when 'offload_records' then to_jsonb(new) ->> 'flight_no'
    when 'report_makeup' then to_jsonb(new) ->> 'flight_number'
    when 'report_breakup' then to_jsonb(new) ->> 'flight_number'
    else null
  end;
  select * into v_class from public.classify_flight_operating_entity(v_flight);
  v_reason := case when v_class.status = 'classified' then 'cross_aoc_conflict' else v_class.status end;
  insert into public.report_classification_review_queue (source_table, source_id, reason, flight_input)
  values (tg_table_name, new.id, v_reason, left(v_flight, 40))
  on conflict (source_table, source_id) do nothing;
  return new;
end;
$$;

drop trigger if exists trg_unclassified_flight_report on public.report_makeup;
create trigger trg_unclassified_flight_report after insert on public.report_makeup
  for each row execute function public.enqueue_unclassified_flight_report();

drop trigger if exists trg_unclassified_flight_report on public.report_breakup;
create trigger trg_unclassified_flight_report after insert on public.report_breakup
  for each row execute function public.enqueue_unclassified_flight_report();

-- =============================================================================================
-- 7. Central reports indexing & source content
-- =============================================================================================

alter table public.central_reports_index drop constraint if exists central_reports_index_source_table_check;
alter table public.central_reports_index add constraint central_reports_index_source_table_check check (
  source_table in (
    'report_sec013', 'report_sec014', 'report_sec016', 'report_sec018',
    'report_sec029', 'report_sec033', 'offload_records', 'report_makeup', 'report_breakup'
  )
);

create or replace function public.index_report(
  p_source_table text,
  p_source_id uuid,
  p_report_type text,
  p_aoc_id uuid,
  p_operating_entity_id uuid,
  p_department_id uuid,
  p_unit_id uuid,
  p_hub_id uuid,
  p_station_id uuid,
  p_team_id uuid,
  p_flight_number text,
  p_report_date date,
  p_submitter_profile_id uuid
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_index_id uuid;
  v_entity_code text;
begin
  if p_operating_entity_id is not null then
    select code into v_entity_code from public.operating_entities where id = p_operating_entity_id;
  end if;

  select id into v_index_id from public.central_reports_index
  where source_table = p_source_table and source_id = p_source_id;

  if v_index_id is not null then
    return v_index_id;
  end if;

  insert into public.central_reports_index (
    source_table, source_id, report_type, aoc_id, operating_entity_id, operating_entity_code,
    department_id, unit_id, hub_id, station_id, team_id, flight_number, report_date,
    status, current_version, submitter_profile_id
  ) values (
    p_source_table, p_source_id, p_report_type, p_aoc_id, p_operating_entity_id, v_entity_code,
    p_department_id, p_unit_id, p_hub_id, p_station_id, p_team_id, p_flight_number, p_report_date,
    'submitted', 1, p_submitter_profile_id
  )
  on conflict (source_table, source_id) do nothing
  returning id into v_index_id;

  if v_index_id is null then
    select id into v_index_id from public.central_reports_index
    where source_table = p_source_table and source_id = p_source_id;
    return v_index_id;
  end if;

  insert into public.report_versions (repository_report_id, version_number, amendment_type, reason, requested_by, effective_status, decided_at, amended_content)
  values (v_index_id, 1, 'original', 'Initial submission.', p_submitter_profile_id, 'approved', now(), public.report_source_content(p_source_table, p_source_id));

  if p_source_table = 'report_sec013' then
    update public.report_sec013 set aoc_id = p_aoc_id, operating_entity_id = p_operating_entity_id, operating_entity_code = v_entity_code, department_id = p_department_id, unit_id = p_unit_id, hub_id = p_hub_id, org_station_id = p_station_id, org_team_id = p_team_id where id = p_source_id;
  elsif p_source_table = 'report_sec014' then
    update public.report_sec014 set aoc_id = p_aoc_id, operating_entity_id = p_operating_entity_id, operating_entity_code = v_entity_code, department_id = p_department_id, unit_id = p_unit_id, hub_id = p_hub_id, org_station_id = p_station_id, org_team_id = p_team_id where id = p_source_id;
  elsif p_source_table = 'report_sec016' then
    update public.report_sec016 set aoc_id = p_aoc_id, operating_entity_id = p_operating_entity_id, operating_entity_code = v_entity_code, department_id = p_department_id, unit_id = p_unit_id, hub_id = p_hub_id, org_station_id = p_station_id, org_team_id = p_team_id where id = p_source_id;
  elsif p_source_table = 'report_sec018' then
    update public.report_sec018 set aoc_id = p_aoc_id, operating_entity_id = p_operating_entity_id, operating_entity_code = v_entity_code, department_id = p_department_id, unit_id = p_unit_id, hub_id = p_hub_id, org_station_id = p_station_id, org_team_id = p_team_id where id = p_source_id;
  elsif p_source_table = 'report_sec029' then
    update public.report_sec029 set aoc_id = p_aoc_id, operating_entity_id = p_operating_entity_id, operating_entity_code = v_entity_code, department_id = p_department_id, unit_id = p_unit_id, hub_id = p_hub_id, org_station_id = p_station_id, org_team_id = p_team_id where id = p_source_id;
  elsif p_source_table = 'report_sec033' then
    update public.report_sec033 set aoc_id = p_aoc_id, operating_entity_id = p_operating_entity_id, operating_entity_code = v_entity_code, department_id = p_department_id, unit_id = p_unit_id, hub_id = p_hub_id, org_station_id = p_station_id, org_team_id = p_team_id where id = p_source_id;
  elsif p_source_table = 'offload_records' then
    update public.offload_records set aoc_id = p_aoc_id, operating_entity_id = p_operating_entity_id, operating_entity_code = v_entity_code, department_id = p_department_id, unit_id = p_unit_id, hub_id = p_hub_id, org_station_id = p_station_id, org_team_id = p_team_id where id = p_source_id;
  elsif p_source_table = 'report_makeup' then
    update public.report_makeup set aoc_id = p_aoc_id, operating_entity_id = p_operating_entity_id, operating_entity_code = v_entity_code, department_id = p_department_id, unit_id = p_unit_id, hub_id = p_hub_id, org_station_id = p_station_id, org_team_id = p_team_id where id = p_source_id;
  elsif p_source_table = 'report_breakup' then
    update public.report_breakup set aoc_id = p_aoc_id, operating_entity_id = p_operating_entity_id, operating_entity_code = v_entity_code, department_id = p_department_id, unit_id = p_unit_id, hub_id = p_hub_id, org_station_id = p_station_id, org_team_id = p_team_id where id = p_source_id;
  end if;

  insert into public.report_access_audit (actor_id, repository_report_id, version_number, action)
  values (p_submitter_profile_id, v_index_id, 1, 'index');

  return v_index_id;
end;
$$;

create or replace function public.report_source_content(p_source_table text, p_source_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_content jsonb;
  v_children jsonb;
begin
  if p_source_table = 'report_sec013' then
    select to_jsonb(t) into v_content from public.report_sec013 t where t.id = p_source_id;
    select coalesce(jsonb_agg(to_jsonb(c) order by c.entry_no), '[]'::jsonb) into v_children
      from public.report_sec013_profiling_duties c where c.report_id = p_source_id;
    v_content := v_content || jsonb_build_object('profiling_duties', v_children);
  elsif p_source_table = 'report_sec014' then
    select to_jsonb(t) into v_content from public.report_sec014 t where t.id = p_source_id;
    select coalesce(jsonb_agg(to_jsonb(c) order by c.entry_no), '[]'::jsonb) into v_children
      from public.report_sec014_patrols c where c.report_id = p_source_id;
    v_content := v_content || jsonb_build_object('patrols', v_children);
  elsif p_source_table = 'report_sec016' then
    select to_jsonb(t) into v_content from public.report_sec016 t where t.id = p_source_id;
  elsif p_source_table = 'report_sec018' then
    select to_jsonb(t) into v_content from public.report_sec018 t where t.id = p_source_id;
    select coalesce(jsonb_agg(to_jsonb(c) order by c.entry_no), '[]'::jsonb) into v_children
      from public.report_sec018_patrols c where c.report_id = p_source_id;
    v_content := v_content || jsonb_build_object('patrols', v_children);
  elsif p_source_table = 'report_sec029' then
    select to_jsonb(t) into v_content from public.report_sec029 t where t.id = p_source_id;
    select coalesce(jsonb_agg(to_jsonb(c)), '[]'::jsonb) into v_children
      from public.report_sec029_items c where c.report_id = p_source_id;
    v_content := v_content || jsonb_build_object('items', v_children);
  elsif p_source_table = 'report_sec033' then
    select to_jsonb(t) into v_content from public.report_sec033 t where t.id = p_source_id;
    select coalesce(jsonb_agg(to_jsonb(c) order by c.entry_no), '[]'::jsonb) into v_children
      from public.report_sec033_hold_checks c where c.report_id = p_source_id;
    v_content := v_content || jsonb_build_object('hold_checks', v_children);
  elsif p_source_table = 'offload_records' then
    select to_jsonb(t) into v_content from public.offload_records t where t.id = p_source_id;
    select coalesce(jsonb_agg(to_jsonb(c) order by c.entry_no), '[]'::jsonb) into v_children
      from public.offload_items c where c.report_id = p_source_id;
    v_content := v_content || jsonb_build_object('items', v_children);
  elsif p_source_table = 'report_makeup' then
    select to_jsonb(t) into v_content from public.report_makeup t where t.id = p_source_id;
    select coalesce(jsonb_agg(to_jsonb(c) order by c.entry_no), '[]'::jsonb) into v_children
      from public.report_makeup_baggage_entries c where c.report_id = p_source_id;
    v_content := v_content || jsonb_build_object('baggage_entries', v_children);
    select coalesce(jsonb_agg(to_jsonb(c) order by c.entry_no), '[]'::jsonb) into v_children
      from public.report_makeup_discrepancies c where c.report_id = p_source_id;
    v_content := v_content || jsonb_build_object('discrepancies', v_children);
  elsif p_source_table = 'report_breakup' then
    select to_jsonb(t) into v_content from public.report_breakup t where t.id = p_source_id;
    select coalesce(jsonb_agg(to_jsonb(c) order by c.entry_no), '[]'::jsonb) into v_children
      from public.report_breakup_baggage_entries c where c.report_id = p_source_id;
    v_content := v_content || jsonb_build_object('baggage_entries', v_children);
  else
    raise exception 'Unsupported source_table: %', p_source_table;
  end if;
  return v_content;
end;
$$;

create or replace function public.report_source_summary(p_source_table text, p_source_id uuid)
returns table (
  staff_name text,
  station text,
  team text,
  secondary_identifier text,
  reg_no text,
  bay_no text,
  sta_std text,
  submitter_profile_id uuid
)
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  if p_source_table = 'report_sec013' then
    return query select t.staff_name, t.station, t.team, null::text, null::text, null::text, null::text, t.profile_id from public.report_sec013 t where t.id = p_source_id;
  elsif p_source_table = 'report_sec014' then
    return query select t.staff_name, t.station, t.team, null::text, null::text, null::text, null::text, t.profile_id from public.report_sec014 t where t.id = p_source_id;
  elsif p_source_table = 'report_sec016' then
    return query select t.staff_name, t.station, t.team, ('Flight ' || coalesce(t.flight, '?') || ' · Reg ' || coalesce(t.reg_no, '?')), t.reg_no, t.bay_no, t.sta_std, t.profile_id from public.report_sec016 t where t.id = p_source_id;
  elsif p_source_table = 'report_sec018' then
    return query select t.staff_name, t.station, t.team, null::text, null::text, null::text, null::text, t.profile_id from public.report_sec018 t where t.id = p_source_id;
  elsif p_source_table = 'report_sec029' then
    return query select t.staff_name, t.station, t.team, ('Flight ' || coalesce(t.flight_no, '?') || ' · Reg ' || coalesce(t.aircraft_registration, '?')), t.aircraft_registration, null::text, null::text, t.profile_id from public.report_sec029 t where t.id = p_source_id;
  elsif p_source_table = 'report_sec033' then
    return query select t.staff_name, t.station, t.team, null::text, null::text, null::text, null::text, t.profile_id from public.report_sec033 t where t.id = p_source_id;
  elsif p_source_table = 'offload_records' then
    return query select t.staff_name, t.station, t.team, ('Flight ' || coalesce(t.flight_no, '?') || ' · ' || coalesce(t.destination, '?')), null::text, null::text, null::text, t.profile_id from public.offload_records t where t.id = p_source_id;
  elsif p_source_table = 'report_makeup' then
    return query select t.staff_name, t.station, t.team, ('Flight ' || coalesce(t.flight_number, '?') || ' · ' || coalesce(t.destination, '?')), null::text, null::text, null::text, t.profile_id from public.report_makeup t where t.id = p_source_id;
  elsif p_source_table = 'report_breakup' then
    return query select t.staff_name, t.station, t.team, ('Flight ' || coalesce(t.flight_number, '?') || ' · ' || coalesce(t.origin, '?')), null::text, null::text, null::text, t.profile_id from public.report_breakup t where t.id = p_source_id;
  else
    raise exception 'Unsupported source_table: %', p_source_table;
  end if;
end;
$$;

create or replace function public.mark_report_ready_for_indexing(p_source_table text, p_source_id uuid, p_expected_child_count integer default 0)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_owner uuid;
  v_actual_children integer;
  v_required_minimum integer;
  v_required_maximum integer;
  v_missing_checklist_codes text[];
begin
  if auth.uid() is null then
    raise exception 'Must be signed in.';
  end if;
  if p_source_table not in (
    'report_sec013', 'report_sec014', 'report_sec016', 'report_sec018',
    'report_sec029', 'report_sec033', 'offload_records', 'report_makeup', 'report_breakup'
  ) then
    raise exception 'Unsupported source_table: %', p_source_table;
  end if;

  if p_source_table = 'report_sec013' then
    select profile_id into v_owner from public.report_sec013 where id = p_source_id for update;
  elsif p_source_table = 'report_sec014' then
    select profile_id into v_owner from public.report_sec014 where id = p_source_id for update;
  elsif p_source_table = 'report_sec016' then
    select profile_id into v_owner from public.report_sec016 where id = p_source_id for update;
  elsif p_source_table = 'report_sec018' then
    select profile_id into v_owner from public.report_sec018 where id = p_source_id for update;
  elsif p_source_table = 'report_sec029' then
    select profile_id into v_owner from public.report_sec029 where id = p_source_id for update;
  elsif p_source_table = 'report_sec033' then
    select profile_id into v_owner from public.report_sec033 where id = p_source_id for update;
  elsif p_source_table = 'offload_records' then
    select profile_id into v_owner from public.offload_records where id = p_source_id for update;
  elsif p_source_table = 'report_makeup' then
    select profile_id into v_owner from public.report_makeup where id = p_source_id for update;
  elsif p_source_table = 'report_breakup' then
    select profile_id into v_owner from public.report_breakup where id = p_source_id for update;
  end if;

  if v_owner is null then
    raise exception 'Report not found.';
  end if;
  if v_owner <> auth.uid() and auth.role() <> 'service_role' then
    raise exception 'Only the submitting profile may mark a report ready for indexing.';
  end if;

  if p_source_table = 'report_sec013' then
    select count(*) into v_actual_children from public.report_sec013_profiling_duties where report_id = p_source_id;
  elsif p_source_table = 'report_sec014' then
    select count(*) into v_actual_children from public.report_sec014_patrols where report_id = p_source_id;
  elsif p_source_table = 'report_sec016' then
    v_actual_children := 0;
  elsif p_source_table = 'report_sec018' then
    select count(*) into v_actual_children from public.report_sec018_patrols where report_id = p_source_id;
  elsif p_source_table = 'report_sec029' then
    select count(*) into v_actual_children from public.report_sec029_items where report_id = p_source_id;
  elsif p_source_table = 'report_sec033' then
    select count(*) into v_actual_children from public.report_sec033_hold_checks where report_id = p_source_id;
  elsif p_source_table = 'offload_records' then
    select count(*) into v_actual_children from public.offload_items where report_id = p_source_id;
  elsif p_source_table = 'report_makeup' then
    select count(*) into v_actual_children from public.report_makeup_baggage_entries where report_id = p_source_id;
  elsif p_source_table = 'report_breakup' then
    select count(*) into v_actual_children from public.report_breakup_baggage_entries where report_id = p_source_id;
  end if;

  if v_actual_children <> coalesce(p_expected_child_count, 0) then
    raise exception 'Report % is not yet complete: expected % child row(s), found %: cannot mark ready for indexing until every child row has actually been committed.', p_source_id, coalesce(p_expected_child_count, 0), v_actual_children;
  end if;

  v_required_minimum := case p_source_table
    when 'report_sec013' then 1
    when 'report_sec029' then 1
    when 'report_sec033' then 1
    when 'offload_records' then 1
    when 'report_makeup' then 1
    when 'report_breakup' then 1
    else 0
  end;
  if v_actual_children < v_required_minimum then
    raise exception 'Report % is missing required child content: this report type requires at least % child row(s), found %: a caller-supplied expected count cannot override this requirement.', p_source_id, v_required_minimum, v_actual_children;
  end if;

  v_required_maximum := case p_source_table
    when 'report_sec018' then 6
    else null
  end;
  if v_required_maximum is not null and v_actual_children > v_required_maximum then
    raise exception 'Report % has too much child content: this report type allows at most % child row(s), found %.', p_source_id, v_required_maximum, v_actual_children;
  end if;

  if p_source_table = 'report_sec029' then
    select array_agg(c.code order by c.code) into v_missing_checklist_codes
    from public.sec029_checklist_items c
    where c.version = public.current_sec029_checklist_version()
      and not exists (
        select 1 from public.report_sec029_items i
        where i.report_id = p_source_id and i.item_code = c.code
      );
    if v_missing_checklist_codes is not null and array_length(v_missing_checklist_codes, 1) > 0 then
      raise exception 'Report % is missing required SEC029 checklist item(s): %.', p_source_id, array_to_string(v_missing_checklist_codes, ', ');
    end if;
  end if;

  insert into public.report_index_queue (source_table, source_id)
  values (p_source_table, p_source_id)
  on conflict (source_table, source_id) do nothing;
end;
$$;

-- =============================================================================================
-- 8. Acknowledgement, Drafts & Attachments
-- =============================================================================================

alter table public.report_drafts drop constraint if exists report_drafts_report_type_check;
alter table public.report_drafts add constraint report_drafts_report_type_check
  check (report_type in ('sec016', 'sec014', 'sec029', 'sec018', 'sec033', 'sec013', 'offload', 'makeup', 'breakup'));

alter table public.report_acknowledgements drop constraint if exists report_acknowledgements_report_type_check;
alter table public.report_acknowledgements add constraint report_acknowledgements_report_type_check
  check (report_type in ('sec016', 'sec014', 'sec029', 'sec018', 'sec033', 'sec013', 'offload', 'makeup', 'breakup'));

alter table public.report_attachments drop constraint if exists report_attachments_report_type_check;
alter table public.report_attachments add constraint report_attachments_report_type_check
  check (report_type in ('sec016', 'sec014', 'sec029', 'sec018', 'sec033', 'sec013', 'offload', 'makeup', 'breakup'));

create or replace function public.get_report_submitter(p_report_type text, p_report_id uuid)
returns table(profile_id uuid, station text, team text)
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  if p_report_type = 'sec016' then
    return query select r.profile_id, r.station, r.team from public.report_sec016 r where r.id = p_report_id;
  elsif p_report_type = 'sec014' then
    return query select r.profile_id, r.station, r.team from public.report_sec014 r where r.id = p_report_id;
  elsif p_report_type = 'sec029' then
    return query select r.profile_id, r.station, r.team from public.report_sec029 r where r.id = p_report_id;
  elsif p_report_type = 'sec018' then
    return query select r.profile_id, r.station, r.team from public.report_sec018 r where r.id = p_report_id;
  elsif p_report_type = 'sec033' then
    return query select r.profile_id, r.station, r.team from public.report_sec033 r where r.id = p_report_id;
  elsif p_report_type = 'sec013' then
    return query select r.profile_id, r.station, r.team from public.report_sec013 r where r.id = p_report_id;
  elsif p_report_type = 'offload' then
    return query select r.profile_id, r.station, r.team from public.offload_records r where r.id = p_report_id;
  elsif p_report_type = 'makeup' then
    return query select r.profile_id, r.station, r.team from public.report_makeup r where r.id = p_report_id;
  elsif p_report_type = 'breakup' then
    return query select r.profile_id, r.station, r.team from public.report_breakup r where r.id = p_report_id;
  end if;
end;
$$;

create or replace function public.can_acknowledge_report(p_report_type text, p_report_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  sub record;
  v_caller integer;
  v_sub integer;
begin
  if auth.uid() is null then
    return false;
  end if;
  select * into sub from public.get_report_submitter(p_report_type, p_report_id);
  if sub is null then
    return false;
  end if;
  v_caller := public.canon_my_level();
  v_sub := public.canon_profile_level(sub.profile_id);

  return coalesce(
    (
      v_caller = v_sub + 1
      or (p_report_type in ('makeup', 'breakup') and v_sub = 1 and public.canon_has_role(array['so', 'sso']))
      or (p_report_type = 'sec014' and v_sub = 1 and public.canon_has_role(array['so', 'sso', 'dse']))
    )
    and public.canon_same_team(sub.station, sub.team),
    false
  );
end;
$$;

-- =============================================================================================
-- 9. Row-Level Security Policies & Grants
-- =============================================================================================

alter table public.report_makeup enable row level security;
alter table public.report_makeup_baggage_entries enable row level security;
alter table public.report_makeup_discrepancies enable row level security;
alter table public.report_breakup enable row level security;
alter table public.report_breakup_baggage_entries enable row level security;

-- report_makeup
create policy makeup_own_select on public.report_makeup
  for select to authenticated
  using (profile_id = auth.uid() or public.can_view_report('makeup', id));

create policy makeup_own_insert on public.report_makeup
  for insert to authenticated
  with check (profile_id = auth.uid() and public.canon_has_role(array['aso']));

create policy makeup_own_update on public.report_makeup
  for update to authenticated
  using (profile_id = auth.uid() and status = 'draft')
  with check (profile_id = auth.uid());

create policy makeup_own_delete on public.report_makeup
  for delete to authenticated
  using (profile_id = auth.uid() and status = 'draft');

-- report_makeup_baggage_entries
create policy makeup_baggage_entries_select on public.report_makeup_baggage_entries
  for select to authenticated
  using (exists (
    select 1 from public.report_makeup p
    where p.id = report_makeup_baggage_entries.report_id
      and (p.profile_id = auth.uid() or public.can_view_report('makeup', p.id))
  ));

create policy makeup_baggage_entries_insert on public.report_makeup_baggage_entries
  for insert to authenticated
  with check (exists (
    select 1 from public.report_makeup p
    where p.id = report_makeup_baggage_entries.report_id
      and p.profile_id = auth.uid()
      and p.status = 'draft'
  ));

create policy makeup_baggage_entries_update on public.report_makeup_baggage_entries
  for update to authenticated
  using (exists (
    select 1 from public.report_makeup p
    where p.id = report_makeup_baggage_entries.report_id
      and p.profile_id = auth.uid()
      and p.status = 'draft'
  ))
  with check (exists (
    select 1 from public.report_makeup p
    where p.id = report_makeup_baggage_entries.report_id
      and p.profile_id = auth.uid()
  ));

create policy makeup_baggage_entries_delete on public.report_makeup_baggage_entries
  for delete to authenticated
  using (exists (
    select 1 from public.report_makeup p
    where p.id = report_makeup_baggage_entries.report_id
      and p.profile_id = auth.uid()
      and p.status = 'draft'
  ));

-- report_makeup_discrepancies
create policy makeup_discrepancies_select on public.report_makeup_discrepancies
  for select to authenticated
  using (exists (
    select 1 from public.report_makeup p
    where p.id = report_makeup_discrepancies.report_id
      and (p.profile_id = auth.uid() or public.can_view_report('makeup', p.id))
  ));

create policy makeup_discrepancies_insert on public.report_makeup_discrepancies
  for insert to authenticated
  with check (exists (
    select 1 from public.report_makeup p
    where p.id = report_makeup_discrepancies.report_id
      and p.profile_id = auth.uid()
      and p.status = 'draft'
  ));

create policy makeup_discrepancies_update on public.report_makeup_discrepancies
  for update to authenticated
  using (exists (
    select 1 from public.report_makeup p
    where p.id = report_makeup_discrepancies.report_id
      and p.profile_id = auth.uid()
      and p.status = 'draft'
  ))
  with check (exists (
    select 1 from public.report_makeup p
    where p.id = report_makeup_discrepancies.report_id
      and p.profile_id = auth.uid()
  ));

create policy makeup_discrepancies_delete on public.report_makeup_discrepancies
  for delete to authenticated
  using (exists (
    select 1 from public.report_makeup p
    where p.id = report_makeup_discrepancies.report_id
      and p.profile_id = auth.uid()
      and p.status = 'draft'
  ));

-- report_breakup
create policy breakup_own_select on public.report_breakup
  for select to authenticated
  using (profile_id = auth.uid() or public.can_view_report('breakup', id));

create policy breakup_own_insert on public.report_breakup
  for insert to authenticated
  with check (profile_id = auth.uid() and public.canon_has_role(array['aso']));

create policy breakup_own_update on public.report_breakup
  for update to authenticated
  using (profile_id = auth.uid() and status = 'draft')
  with check (profile_id = auth.uid());

create policy breakup_own_delete on public.report_breakup
  for delete to authenticated
  using (profile_id = auth.uid() and status = 'draft');

-- report_breakup_baggage_entries
create policy breakup_baggage_entries_select on public.report_breakup_baggage_entries
  for select to authenticated
  using (exists (
    select 1 from public.report_breakup p
    where p.id = report_breakup_baggage_entries.report_id
      and (p.profile_id = auth.uid() or public.can_view_report('breakup', p.id))
  ));

create policy breakup_baggage_entries_insert on public.report_breakup_baggage_entries
  for insert to authenticated
  with check (exists (
    select 1 from public.report_breakup p
    where p.id = report_breakup_baggage_entries.report_id
      and p.profile_id = auth.uid()
      and p.status = 'draft'
  ));

create policy breakup_baggage_entries_update on public.report_breakup_baggage_entries
  for update to authenticated
  using (exists (
    select 1 from public.report_breakup p
    where p.id = report_breakup_baggage_entries.report_id
      and p.profile_id = auth.uid()
      and p.status = 'draft'
  ))
  with check (exists (
    select 1 from public.report_breakup p
    where p.id = report_breakup_baggage_entries.report_id
      and p.profile_id = auth.uid()
  ));

create policy breakup_baggage_entries_delete on public.report_breakup_baggage_entries
  for delete to authenticated
  using (exists (
    select 1 from public.report_breakup p
    where p.id = report_breakup_baggage_entries.report_id
      and p.profile_id = auth.uid()
      and p.status = 'draft'
  ));

-- Grants
revoke all on public.report_makeup from public, anon;
grant select, insert, update, delete on public.report_makeup to authenticated;
grant all on public.report_makeup to service_role;

revoke all on public.report_makeup_baggage_entries from public, anon;
grant select, insert, update, delete on public.report_makeup_baggage_entries to authenticated;
grant all on public.report_makeup_baggage_entries to service_role;

revoke all on public.report_makeup_discrepancies from public, anon;
grant select, insert, update, delete on public.report_makeup_discrepancies to authenticated;
grant all on public.report_makeup_discrepancies to service_role;

revoke all on public.report_breakup from public, anon;
grant select, insert, update, delete on public.report_breakup to authenticated;
grant all on public.report_breakup to service_role;

revoke all on public.report_breakup_baggage_entries from public, anon;
grant select, insert, update, delete on public.report_breakup_baggage_entries to authenticated;
grant all on public.report_breakup_baggage_entries to service_role;
