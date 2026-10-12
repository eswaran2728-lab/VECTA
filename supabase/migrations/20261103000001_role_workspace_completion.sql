-- Role-workspace completion (additive, forward-only). Owner decisions applied:
--
--  1. Investigation staff are NON-ROSTERED: the database refuses an attendance write (duty record, leave notice, overtime request,
--     shift handover) from a caller whose every active role is non-rostered (Investigation, Compliance, executives, Global Reporting
--     Controller, MAA/AAX Boss and Admin, CaterLink Management, Super Admin). Operation Manager and Main Enforcement are OVERSIGHT roles
--     and are not blocked.
--  2. Report forms follow the ASSIGNED FUNCTION: report_form_assignments (seeded explicitly) + can_create_report_form() +
--     a BEFORE INSERT trigger on every report table. No role gets a form implicitly.
--  3. Operation Manager: read-only operational staff search (search_operation_staff_secure); user administration is not granted here.
--  5. Investigation cases: audited links to flights, staff and evidence (private Storage bucket), a status/finding timeline, closure
--     (a closed case is immutable until reopened), and the audit history.
--  6. Workflows: BKI/KCH final-receipt list, Compliance/Operation Manager read-only CaterLink movements, Hub SE hub-station selector and
--     overview, GHOD/AirAsia report-request search (metadata stubs only) and "my requests".
-- Every function is SECURITY DEFINER with a fixed search_path and PUBLIC/anon revoked; every client read goes through these RPCs.

-- =============================================================================================
-- 1. attendance writes are refused for non-rostered callers (database layer)
-- =============================================================================================
create or replace function public.caller_is_non_rostered_only()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select exists (select 1 from public.get_my_active_role_assignments())
     and not exists (
       select 1 from public.get_my_active_role_assignments() r
       where r.role_code not in (
         'airasia_management', 'ghod', 'global_reporting_controller', 'super_admin', 'maa_boss', 'maa_admin', 'aax_boss', 'aax_admin',
         'compliance', 'investigation_sso', 'investigation_so', 'investigation_aso', 'caterlink_management'
       )
     );
$function$;
revoke execute on function public.caller_is_non_rostered_only() from public, anon;
grant execute on function public.caller_is_non_rostered_only() to authenticated, service_role;

create or replace function public.enforce_rostered_actor()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if auth.role() = 'authenticated' and public.caller_is_non_rostered_only() then
    raise exception 'Your role has no roster: duty, leave, overtime and handover records cannot be created.';
  end if;
  return new;
end;
$function$;
revoke execute on function public.enforce_rostered_actor() from public, anon, authenticated;
grant execute on function public.enforce_rostered_actor() to service_role;

drop trigger if exists trg_enforce_rostered_actor on public.duty_records;
create trigger trg_enforce_rostered_actor before insert on public.duty_records for each row execute function public.enforce_rostered_actor();
drop trigger if exists trg_enforce_rostered_actor on public.absence_notices;
create trigger trg_enforce_rostered_actor before insert on public.absence_notices for each row execute function public.enforce_rostered_actor();
drop trigger if exists trg_enforce_rostered_actor on public.overtime_requests;
create trigger trg_enforce_rostered_actor before insert on public.overtime_requests for each row execute function public.enforce_rostered_actor();
drop trigger if exists trg_enforce_rostered_actor on public.shift_handovers;
create trigger trg_enforce_rostered_actor before insert on public.shift_handovers for each row execute function public.enforce_rostered_actor();

-- =============================================================================================
-- 2. report form assignments
-- =============================================================================================
create table if not exists public.report_form_assignments (
  id uuid primary key default gen_random_uuid(),
  role_code text not null,
  station_code text,
  profile_id uuid references public.profiles(id),
  form_type text not null check (form_type in ('sec013', 'sec014', 'sec016', 'sec018', 'sec029', 'sec033', 'offload')),
  note text,
  granted_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  constraint report_form_assignments_unique unique nulls not distinct (role_code, station_code, profile_id, form_type)
);
alter table public.report_form_assignments enable row level security;
revoke all on public.report_form_assignments from public, anon, authenticated;
grant all on public.report_form_assignments to service_role;

-- Explicit operational defaults (the mapping is documented in docs/dashboard-review/role-workspace-correction.md):
--   standard ASO (every station): SEC016, SEC014, SEC029, SEC018, SEC033 and Offload
--   Profiling ASO: SEC013 only
-- Nothing is seeded for SO, SSO, DSE, Hub SE, SAT, Profiling SO, leadership, enforcement or Investigation.
insert into public.report_form_assignments (role_code, station_code, profile_id, form_type, note)
select 'aso', null, null, f, 'explicit operational default (station-wide); narrow by adding station rows and revoking this one'
from unnest(array['sec016', 'sec014', 'sec029', 'sec018', 'sec033', 'offload']) as f
on conflict on constraint report_form_assignments_unique do nothing;
insert into public.report_form_assignments (role_code, station_code, profile_id, form_type, note)
values ('profiling_aso', null, null, 'sec013', 'explicit operational default: SEC013 is the only form of the Profiling ASO')
on conflict on constraint report_form_assignments_unique do nothing;

create or replace function public.can_create_report_form(p_form text)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select exists (
    select 1
    from public.report_form_assignments a
    join public.get_my_active_role_assignments() r on r.role_code = a.role_code
    where a.revoked_at is null
      and a.form_type = p_form
      and (a.profile_id is null or a.profile_id = auth.uid())
      and (a.station_code is null or a.station_code = r.station_code)
  );
$function$;
revoke execute on function public.can_create_report_form(text) from public, anon;
grant execute on function public.can_create_report_form(text) to authenticated, service_role;

create or replace function public.list_my_report_forms_secure()
returns table (form_type text)
language sql
stable
security definer
set search_path to 'public'
as $function$
  select f from unnest(array['sec016', 'sec014', 'sec029', 'sec018', 'sec033', 'sec013', 'offload']) as f
  where public.can_create_report_form(f);
$function$;
revoke execute on function public.list_my_report_forms_secure() from public, anon;
grant execute on function public.list_my_report_forms_secure() to authenticated, service_role;

create or replace function public.enforce_report_form_assignment()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_form text := case tg_table_name
    when 'report_sec013' then 'sec013' when 'report_sec014' then 'sec014' when 'report_sec016' then 'sec016'
    when 'report_sec018' then 'sec018' when 'report_sec029' then 'sec029' when 'report_sec033' then 'sec033'
    when 'offload_records' then 'offload' else null end;
begin
  if auth.role() = 'authenticated' and (v_form is null or not public.can_create_report_form(v_form)) then
    raise exception 'Your assignment does not include the % report form.', coalesce(v_form, tg_table_name);
  end if;
  return new;
end;
$function$;
revoke execute on function public.enforce_report_form_assignment() from public, anon, authenticated;
grant execute on function public.enforce_report_form_assignment() to service_role;

do $do$
declare t text;
begin
  foreach t in array array['report_sec013', 'report_sec014', 'report_sec016', 'report_sec018', 'report_sec029', 'report_sec033', 'offload_records'] loop
    execute format('drop trigger if exists trg_enforce_form_assignment on public.%I', t);
    execute format('create trigger trg_enforce_form_assignment before insert on public.%I for each row execute function public.enforce_report_form_assignment()', t);
  end loop;
end
$do$;

-- =============================================================================================
-- 3. Operation Manager: read-only operational staff search
-- =============================================================================================
create or replace function public.search_operation_staff_secure(p_search text default null, p_page integer default 1, p_page_size integer default 50)
returns table (staff_no text, staff_name text, role_code text, hub_code text, station_code text, team_name text, total_count bigint)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_aoc uuid := (select id from public.aocs where code = 'MY');
  v_page integer := greatest(coalesce(p_page, 1), 1);
  v_size integer := least(greatest(coalesce(p_page_size, 50), 1), 100);
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
begin
  if not public.has_active_role_for_aoc('operation_manager', v_aoc) then
    raise exception 'Only an approved Operation Manager may search operational staff.';
  end if;
  return query
  with s as (
    select p.staff_no as sno, p.name as sname, rd.code as rcode, h.code as hcode, st.code as scode, t.name as tname
    from public.user_role_assignments ura
    join public.role_definitions rd on rd.id = ura.role_definition_id and rd.is_active
    join public.profiles p on p.id = ura.profile_id and p.status = 'approved'
    join public.departments d on d.id = ura.department_id and d.code = 'operation' and d.aoc_id = v_aoc
    left join public.hubs h on h.id = ura.hub_id
    left join public.org_stations st on st.id = ura.station_id
    left join public.org_teams t on t.id = ura.team_id
    where ura.revoked_at is null and ura.starts_at <= now() and (ura.ends_at is null or ura.ends_at > now())
      and rd.code <> 'operation_manager'
      and (v_search is null or p.name ilike '%' || v_search || '%' or p.staff_no ilike '%' || v_search || '%')
  ), n as (select count(*) as c from s)
  select s.sno, s.sname, s.rcode, s.hcode, s.scode, s.tname, n.c
  from s cross join n
  order by s.sname, s.sno
  limit v_size offset (v_page - 1) * v_size;
end;
$function$;
revoke execute on function public.search_operation_staff_secure(text, integer, integer) from public, anon;
grant execute on function public.search_operation_staff_secure(text, integer, integer) to authenticated, service_role;

-- =============================================================================================
-- 5. Investigation cases: flight / staff / evidence links, timeline, closure, audit history
-- =============================================================================================
create table if not exists public.investigation_case_links (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.investigation_cases(id) on delete cascade,
  link_type text not null check (link_type in ('flight', 'staff')),
  flight_number text,
  flight_date date,
  staff_profile_id uuid references public.profiles(id),
  note text,
  linked_by uuid not null references public.profiles(id),
  linked_at timestamptz not null default now(),
  constraint investigation_case_links_shape check (
    (link_type = 'flight' and flight_number is not null and staff_profile_id is null)
    or (link_type = 'staff' and staff_profile_id is not null and flight_number is null)
  ),
  constraint investigation_case_links_unique unique nulls not distinct (case_id, link_type, flight_number, flight_date, staff_profile_id)
);
create table if not exists public.investigation_case_evidence (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.investigation_cases(id) on delete cascade,
  storage_path text not null unique,
  file_name text not null,
  mime_type text not null,
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 26214400),
  description text,
  uploaded_by uuid not null references public.profiles(id),
  uploaded_at timestamptz not null default now()
);
create index if not exists investigation_case_links_case_idx on public.investigation_case_links (case_id);
create index if not exists investigation_case_evidence_case_idx on public.investigation_case_evidence (case_id);
alter table public.investigation_case_links enable row level security;
alter table public.investigation_case_evidence enable row level security;
revoke all on public.investigation_case_links from public, anon, authenticated;
revoke all on public.investigation_case_evidence from public, anon, authenticated;
grant all on public.investigation_case_links to service_role;
grant all on public.investigation_case_evidence to service_role;

-- A closed case is immutable until it is reopened: no new note, report link, flight/staff link or evidence.
create or replace function public.block_closed_case_child_insert()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if exists (select 1 from public.investigation_cases c where c.id = new.case_id and c.status = 'closed') then
    raise exception 'This case is closed. Reopen it before adding to it.';
  end if;
  return new;
end;
$function$;
revoke execute on function public.block_closed_case_child_insert() from public, anon, authenticated;
grant execute on function public.block_closed_case_child_insert() to service_role;
do $do$
declare t text;
begin
  foreach t in array array['investigation_case_notes', 'investigation_case_reports', 'investigation_case_links', 'investigation_case_evidence'] loop
    execute format('drop trigger if exists trg_block_closed_case on public.%I', t);
    execute format('create trigger trg_block_closed_case before insert on public.%I for each row execute function public.block_closed_case_child_insert()', t);
  end loop;
end
$do$;

-- evidence rows are append-only
create or replace function public.block_case_evidence_mutation()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  raise exception 'Case evidence is append-only.';
end;
$function$;
revoke execute on function public.block_case_evidence_mutation() from public, anon, authenticated;
grant execute on function public.block_case_evidence_mutation() to service_role;
drop trigger if exists trg_case_evidence_append_only on public.investigation_case_evidence;
create trigger trg_case_evidence_append_only before update or delete on public.investigation_case_evidence for each row execute function public.block_case_evidence_mutation();

create or replace function public.link_flight_to_case_secure(p_case_id uuid, p_flight text, p_flight_date date default null, p_note text default null)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_flight text := public.normalize_flight_number(p_flight);
  v_class record;
begin
  if not public.is_investigation_authorized() then
    raise exception 'Only Investigation or Main Enforcement may link a flight to a case.';
  end if;
  if not exists (select 1 from public.investigation_cases where id = p_case_id) then
    raise exception 'Case not found.';
  end if;
  select * into v_class from public.classify_flight_operating_entity(p_flight);
  if v_flight is null or v_class.status in ('missing', 'malformed', 'conflict') then
    raise exception 'Enter a single valid flight number.';
  end if;
  insert into public.investigation_case_links (case_id, link_type, flight_number, flight_date, note, linked_by)
  values (p_case_id, 'flight', v_flight, p_flight_date, nullif(btrim(coalesce(p_note, '')), ''), auth.uid())
  on conflict on constraint investigation_case_links_unique do nothing;
  perform public.phase8_write_audit('investigation_case_link_flight', 'investigation_case', p_case_id,
    jsonb_build_object('flight', v_flight, 'flight_date', p_flight_date));
end;
$function$;
revoke execute on function public.link_flight_to_case_secure(uuid, text, date, text) from public, anon;
grant execute on function public.link_flight_to_case_secure(uuid, text, date, text) to authenticated, service_role;

create or replace function public.link_staff_to_case_secure(p_case_id uuid, p_staff_no text, p_note text default null)
returns table (staff_no text, staff_name text)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_profile record;
begin
  if not public.is_investigation_authorized() then
    raise exception 'Only Investigation or Main Enforcement may link staff to a case.';
  end if;
  if not exists (select 1 from public.investigation_cases where id = p_case_id) then
    raise exception 'Case not found.';
  end if;
  select p.id, p.staff_no, p.name into v_profile from public.profiles p where upper(p.staff_no) = upper(btrim(coalesce(p_staff_no, ''))) and p.status = 'approved';
  if v_profile.id is null then
    raise exception 'No approved staff member with that staff number.';
  end if;
  insert into public.investigation_case_links (case_id, link_type, staff_profile_id, note, linked_by)
  values (p_case_id, 'staff', v_profile.id, nullif(btrim(coalesce(p_note, '')), ''), auth.uid())
  on conflict on constraint investigation_case_links_unique do nothing;
  perform public.phase8_write_audit('investigation_case_link_staff', 'investigation_case', p_case_id,
    jsonb_build_object('staff_no', v_profile.staff_no));
  return query select v_profile.staff_no, v_profile.name;
end;
$function$;
revoke execute on function public.link_staff_to_case_secure(uuid, text, text) from public, anon;
grant execute on function public.link_staff_to_case_secure(uuid, text, text) to authenticated, service_role;

create or replace function public.list_investigation_case_links_secure(p_case_id uuid)
returns table (id uuid, link_type text, flight_number text, flight_date date, staff_no text, staff_name text, note text, linked_by_name text, linked_at timestamptz)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
begin
  if not public.is_investigation_authorized() then
    raise exception 'Only Investigation or Main Enforcement may view case links.';
  end if;
  return query
  select l.id, l.link_type, l.flight_number, l.flight_date, sp.staff_no, sp.name, l.note, bp.name, l.linked_at
  from public.investigation_case_links l
  left join public.profiles sp on sp.id = l.staff_profile_id
  join public.profiles bp on bp.id = l.linked_by
  where l.case_id = p_case_id
  order by l.linked_at desc;
end;
$function$;
revoke execute on function public.list_investigation_case_links_secure(uuid) from public, anon;
grant execute on function public.list_investigation_case_links_secure(uuid) to authenticated, service_role;

-- evidence: authorize -> (server uploads with the service role) -> register -> authorized download
create or replace function public.prepare_case_evidence_secure(p_case_id uuid, p_file_name text, p_mime_type text, p_size_bytes bigint)
returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_safe text := regexp_replace(coalesce(p_file_name, ''), '[^A-Za-z0-9._-]+', '_', 'g');
begin
  if not public.is_investigation_authorized() then
    raise exception 'Only Investigation or Main Enforcement may attach evidence.';
  end if;
  if not exists (select 1 from public.investigation_cases where id = p_case_id) then
    raise exception 'Case not found.';
  end if;
  if exists (select 1 from public.investigation_cases where id = p_case_id and status = 'closed') then
    raise exception 'This case is closed. Reopen it before adding evidence.';
  end if;
  if v_safe = '' or length(v_safe) > 120 then
    raise exception 'A valid file name is required.';
  end if;
  if p_size_bytes is null or p_size_bytes <= 0 or p_size_bytes > 26214400 then
    raise exception 'Evidence files must be between 1 byte and 25 MB.';
  end if;
  if p_mime_type is null or p_mime_type not in ('application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'text/plain', 'video/mp4', 'audio/mpeg') then
    raise exception 'This file type is not accepted as evidence.';
  end if;
  return p_case_id::text || '/' || gen_random_uuid()::text || '-' || v_safe;
end;
$function$;
revoke execute on function public.prepare_case_evidence_secure(uuid, text, text, bigint) from public, anon;
grant execute on function public.prepare_case_evidence_secure(uuid, text, text, bigint) to authenticated, service_role;

create or replace function public.register_case_evidence_secure(p_case_id uuid, p_storage_path text, p_file_name text, p_mime_type text, p_size_bytes bigint, p_description text default null)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_id uuid;
begin
  if not public.is_investigation_authorized() then
    raise exception 'Only Investigation or Main Enforcement may attach evidence.';
  end if;
  if p_storage_path is null or split_part(p_storage_path, '/', 1) <> p_case_id::text or split_part(p_storage_path, '/', 2) = '' then
    raise exception 'The evidence path does not belong to this case.';
  end if;
  insert into public.investigation_case_evidence (case_id, storage_path, file_name, mime_type, size_bytes, description, uploaded_by)
  values (p_case_id, p_storage_path, left(btrim(p_file_name), 200), p_mime_type, p_size_bytes, nullif(btrim(coalesce(p_description, '')), ''), auth.uid())
  returning id into v_id;
  perform public.phase8_write_audit('investigation_evidence_add', 'investigation_case', p_case_id,
    jsonb_build_object('evidence_id', v_id, 'file_name', left(btrim(p_file_name), 200)));
  return v_id;
end;
$function$;
revoke execute on function public.register_case_evidence_secure(uuid, text, text, text, bigint, text) from public, anon;
grant execute on function public.register_case_evidence_secure(uuid, text, text, text, bigint, text) to authenticated, service_role;

create or replace function public.list_investigation_case_evidence_secure(p_case_id uuid)
returns table (id uuid, file_name text, mime_type text, size_bytes bigint, description text, uploaded_by_name text, uploaded_at timestamptz)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
begin
  if not public.is_investigation_authorized() then
    raise exception 'Only Investigation or Main Enforcement may view case evidence.';
  end if;
  return query
  select e.id, e.file_name, e.mime_type, e.size_bytes, e.description, p.name, e.uploaded_at
  from public.investigation_case_evidence e join public.profiles p on p.id = e.uploaded_by
  where e.case_id = p_case_id
  order by e.uploaded_at desc;
end;
$function$;
revoke execute on function public.list_investigation_case_evidence_secure(uuid) from public, anon;
grant execute on function public.list_investigation_case_evidence_secure(uuid) to authenticated, service_role;

create or replace function public.authorize_case_evidence_download_secure(p_evidence_id uuid)
returns table (storage_path text, file_name text)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_e record;
begin
  if not public.is_investigation_authorized() then
    raise exception 'Evidence not found or not authorized.';
  end if;
  select * into v_e from public.investigation_case_evidence where id = p_evidence_id;
  if v_e.id is null then
    raise exception 'Evidence not found or not authorized.';
  end if;
  perform public.phase8_write_audit('investigation_evidence_access', 'investigation_case', v_e.case_id,
    jsonb_build_object('evidence_id', v_e.id, 'file_name', v_e.file_name));
  return query select v_e.storage_path, v_e.file_name;
end;
$function$;
revoke execute on function public.authorize_case_evidence_download_secure(uuid) from public, anon;
grant execute on function public.authorize_case_evidence_download_secure(uuid) to authenticated, service_role;

-- private bucket; no client INSERT policy (the server uploads after prepare_case_evidence_secure authorizes); SELECT follows the case rule
insert into storage.buckets (id, name, public) values ('investigation-evidence', 'investigation-evidence', false) on conflict (id) do nothing;
create or replace function public.can_read_case_evidence(p_object_name text)
returns boolean
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
begin
  if auth.uid() is null or not public.is_investigation_authorized() then
    return false;
  end if;
  return exists (select 1 from public.investigation_case_evidence e where e.storage_path = p_object_name);
end;
$function$;
revoke execute on function public.can_read_case_evidence(text) from public, anon;
grant execute on function public.can_read_case_evidence(text) to authenticated, service_role;
drop policy if exists "investigation evidence object select" on storage.objects;
create policy "investigation evidence object select" on storage.objects for select
  using (bucket_id = 'investigation-evidence' and public.can_read_case_evidence(name));

create or replace function public.close_investigation_case_secure(p_case_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_status text;
  v_aoc uuid := (select id from public.aocs where code = 'MY');
begin
  if not (public.has_active_role_for_aoc('investigation_sso', v_aoc) or public.has_active_role_for_aoc('main_enforcement', v_aoc)) then
    raise exception 'Only Investigation SSO or Main Enforcement may close a case.';
  end if;
  if p_reason is null or length(btrim(p_reason)) < 3 then
    raise exception 'A closure reason is required.';
  end if;
  select status into v_status from public.investigation_cases where id = p_case_id for update;
  if v_status is null then
    raise exception 'Case not found.';
  end if;
  if v_status <> 'resolved' then
    raise exception 'Only a resolved case can be closed (current status: %).', v_status;
  end if;
  update public.investigation_cases set status = 'closed', updated_at = now() where id = p_case_id;
  perform public.phase8_write_audit('investigation_case_close', 'investigation_case', p_case_id, jsonb_build_object('reason', btrim(p_reason)));
end;
$function$;
revoke execute on function public.close_investigation_case_secure(uuid, text) from public, anon;
grant execute on function public.close_investigation_case_secure(uuid, text) to authenticated, service_role;

create or replace function public.get_investigation_case_timeline_secure(p_case_id uuid)
returns table (event_at timestamptz, event_type text, actor_name text, summary text, ref_id uuid)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
begin
  if not public.is_investigation_authorized() then
    raise exception 'Only Investigation or Main Enforcement may view a case timeline.';
  end if;
  if not exists (select 1 from public.investigation_cases where id = p_case_id) then
    raise exception 'Case not found.';
  end if;
  return query
  select * from (
    select c.created_at as t, 'opened'::text as ty, p.name as an, ('Case ' || c.case_no || ' opened: ' || c.title)::text as su, c.id as rid
      from public.investigation_cases c join public.profiles p on p.id = c.opened_by where c.id = p_case_id
    union all
    select n.created_at, 'note', p.name, left(n.note, 500), n.id
      from public.investigation_case_notes n join public.profiles p on p.id = n.author_id where n.case_id = p_case_id
    union all
    select r.linked_at, 'report_link', p.name, ('Report linked: ' || coalesce(cri.source_table, 'report') || ' ' || coalesce(cri.flight_number, '') || ' ' || coalesce(cri.report_date::text, '')), r.id
      from public.investigation_case_reports r join public.profiles p on p.id = r.linked_by join public.central_reports_index cri on cri.id = r.repository_report_id where r.case_id = p_case_id
    union all
    select l.linked_at, case l.link_type when 'flight' then 'flight_link' else 'staff_link' end, p.name,
           case l.link_type when 'flight' then 'Flight linked: ' || l.flight_number || coalesce(' on ' || l.flight_date::text, '')
                            else 'Staff linked: ' || sp.staff_no || ' ' || sp.name end, l.id
      from public.investigation_case_links l join public.profiles p on p.id = l.linked_by left join public.profiles sp on sp.id = l.staff_profile_id where l.case_id = p_case_id
    union all
    select e.uploaded_at, 'evidence', p.name, 'Evidence added: ' || e.file_name, e.id
      from public.investigation_case_evidence e join public.profiles p on p.id = e.uploaded_by where e.case_id = p_case_id
    union all
    select a.created_at,
           case a.action when 'investigation_case_resolve' then 'resolved' when 'investigation_case_reopen' then 'reopened'
                         when 'investigation_case_close' then 'closed' else 'assigned' end,
           p.name,
           case a.action when 'investigation_case_resolve' then 'Resolved' when 'investigation_case_reopen' then 'Reopened: ' || coalesce(a.detail ->> 'reason', '')
                         when 'investigation_case_close' then 'Closed: ' || coalesce(a.detail ->> 'reason', '') else 'Assignment changed' end,
           a.id
      from public.phase8_audit_log a left join public.profiles p on p.id = a.actor_id
      where a.entity_type = 'investigation_case' and a.entity_id = p_case_id
        and a.action in ('investigation_case_resolve', 'investigation_case_reopen', 'investigation_case_close', 'investigation_case_assign')
  ) x(t, ty, an, su, rid)
  order by 1 desc;
end;
$function$;
revoke execute on function public.get_investigation_case_timeline_secure(uuid) from public, anon;
grant execute on function public.get_investigation_case_timeline_secure(uuid) to authenticated, service_role;

create or replace function public.list_investigation_case_audit_secure(p_case_id uuid)
returns table (id uuid, created_at timestamptz, action text, actor_name text, detail jsonb)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
begin
  if not public.is_investigation_authorized() then
    raise exception 'Only Investigation or Main Enforcement may view the case audit history.';
  end if;
  return query
  select a.id, a.created_at, a.action, p.name, a.detail
  from public.phase8_audit_log a left join public.profiles p on p.id = a.actor_id
  where a.entity_type = 'investigation_case' and a.entity_id = p_case_id
  order by a.created_at desc;
end;
$function$;
revoke execute on function public.list_investigation_case_audit_secure(uuid) from public, anon;
grant execute on function public.list_investigation_case_audit_secure(uuid) to authenticated, service_role;

-- =============================================================================================
-- 6a. CaterLink: BKI/KCH final-receipt list and read-only movements
-- =============================================================================================
create or replace function public.list_caterlink_pending_receipts_secure(p_station_code text)
returns table (
  id uuid, transaction_number text, direction text, route text, status text, vehicle_number text, driver_name text, seal_number text,
  flight_number text, aircraft_registration text, trolley_count integer, origin_station text, destination_station text, created_at timestamptz
)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
begin
  if not public.can_user_confirm_caterlink_receipt(p_station_code) then
    raise exception 'Not authorized to confirm CaterLink receipts at this station.';
  end if;
  return query
  select t.id, t.transaction_number, t.direction, t.route, t.status, t.vehicle_number, t.driver_name, t.seal_number, t.flight_number,
         t.aircraft_registration, t.trolley_count, os.code, ds.code, t.created_at
  from public.transactions t
  left join public.org_stations os on os.id = t.origin_station_id
  left join public.org_stations ds on ds.id = t.destination_station_id
  where coalesce(t.archived, false) = false
    and t.status not in ('COMPLETED', 'ESCALATED')
    and (ds.code = p_station_code or t.hub_destination = p_station_code)
    and public.can_user_confirm_caterlink_receipt(p_station_code, t.aoc_id)
    and (t.route <> 'HUB' or t.status = 'INFLIGHT_POST_APPROVED')
  order by t.created_at desc
  limit 100;
end;
$function$;
revoke execute on function public.list_caterlink_pending_receipts_secure(text) from public, anon;
grant execute on function public.list_caterlink_pending_receipts_secure(text) to authenticated, service_role;

create or replace function public.list_caterlink_movements_readonly_secure(p_station_code text default null, p_status text default null, p_page integer default 1, p_page_size integer default 25)
returns table (
  id uuid, transaction_number text, direction text, route text, status text, origin_station text, destination_station text, flight_number text,
  aircraft_registration text, vehicle_number text, trolley_count integer, created_at timestamptz, completed_at timestamptz, total_count bigint
)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_aoc uuid := (select a.id from public.aocs a where a.code = 'MY');
  v_page integer := greatest(coalesce(p_page, 1), 1);
  v_size integer := least(greatest(coalesce(p_page_size, 25), 1), 100);
begin
  if not (public.has_active_role_for_aoc('compliance', v_aoc) or public.has_active_role_for_aoc('operation_manager', v_aoc)) then
    raise exception 'Only Compliance or the Operation Manager may view the read-only CaterLink movements.';
  end if;
  if p_status is not null and p_status not in ('CREATED', 'INFLIGHT_POST_APPROVED', 'AIRPORT_POST_APPROVED', 'REDQ_RESEALED', 'COMPLETED', 'ESCALATED', 'POST2_APPROVED', 'POST6_APPROVED') then
    raise exception 'Unsupported status filter.';
  end if;
  return query
  with m as (
    select t.*, os.code as ocode, ds.code as dcode
    from public.transactions t
    left join public.org_stations os on os.id = t.origin_station_id
    left join public.org_stations ds on ds.id = t.destination_station_id
    where coalesce(t.archived, false) = false and t.aoc_id = v_aoc
      and (p_status is null or t.status = p_status)
      and (p_station_code is null or os.code = p_station_code or ds.code = p_station_code)
  ), n as (select count(*) as c from m)
  select m.id, m.transaction_number, m.direction, m.route, m.status, m.ocode, m.dcode, m.flight_number, m.aircraft_registration,
         m.vehicle_number, m.trolley_count, m.created_at, m.completed_at, n.c
  from m cross join n
  order by m.created_at desc
  limit v_size offset (v_page - 1) * v_size;
end;
$function$;
revoke execute on function public.list_caterlink_movements_readonly_secure(text, text, integer, integer) from public, anon;
grant execute on function public.list_caterlink_movements_readonly_secure(text, text, integer, integer) to authenticated, service_role;

-- =============================================================================================
-- 6b. Hub SE: stations of the assigned hub only
-- =============================================================================================
create or replace function public.caller_hub_se_hub()
returns uuid
language sql
stable
security definer
set search_path to 'public'
as $function$
  select ura.hub_id
  from public.user_role_assignments ura
  join public.role_definitions rd on rd.id = ura.role_definition_id and rd.is_active
  join public.profiles p on p.id = ura.profile_id and p.status = 'approved'
  where ura.profile_id = auth.uid() and rd.code = 'hub_se' and ura.hub_id is not null
    and ura.revoked_at is null and ura.starts_at <= now() and (ura.ends_at is null or ura.ends_at > now())
  order by ura.starts_at
  limit 1;
$function$;
revoke execute on function public.caller_hub_se_hub() from public, anon;
grant execute on function public.caller_hub_se_hub() to authenticated, service_role;

create or replace function public.list_hub_stations_secure()
returns table (hub_code text, hub_name text, station_code text, station_name text)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_hub uuid := public.caller_hub_se_hub();
begin
  if v_hub is null then
    raise exception 'Only an approved Hub SE may list the stations of an assigned hub.';
  end if;
  return query
  select h.code, h.name, s.code, s.name
  from public.hubs h join public.org_stations s on s.hub_id = h.id and s.is_active
  where h.id = v_hub
  order by s.code;
end;
$function$;
revoke execute on function public.list_hub_stations_secure() from public, anon;
grant execute on function public.list_hub_stations_secure() to authenticated, service_role;

create or replace function public.get_hub_station_overview_secure(p_station_code text default null, p_date date default current_date)
returns table (
  station_code text, rostered_teams bigint, checked_in bigint, pending bigint, absent bigint, total_staff bigint,
  open_bay_board bigint, reports_last_7_days bigint, can_scan boolean, can_confirm_receipt boolean
)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_hub uuid := public.caller_hub_se_hub();
begin
  if v_hub is null then
    raise exception 'Only an approved Hub SE may view a hub station overview.';
  end if;
  if p_station_code is not null and not exists (
    select 1 from public.org_stations s where s.code = p_station_code and s.hub_id = v_hub and s.is_active
  ) then
    raise exception 'That station is not in your assigned hub.';
  end if;
  return query
  select s.code,
    (select count(distinct r.team) from public.team_rosters r where r.station = s.code and r.roster_date = p_date),
    (select count(*) from public.duty_records d where d.station = s.code and d.duty_date = p_date and d.status in ('present', 'late')),
    (select count(*) from public.duty_records d where d.station = s.code and d.duty_date = p_date and d.status = 'pending'),
    (select count(*) from public.duty_records d where d.station = s.code and d.duty_date = p_date and d.status = 'absent'),
    (select count(*) from public.duty_records d where d.station = s.code and d.duty_date = p_date),
    (select count(*) from public.bay_board b where b.station = s.code and b.cleared_at is null),
    (select count(*) from public.central_reports_index c where c.station_id = s.id and c.indexed_at > now() - interval '7 days' and public.has_report_access(c.id)),
    -- what the STATION is permitted to do (station capability table); a Hub SE holds no station assignment, so no action is offered
    coalesce((select c.can_scan from public.caterlink_station_capabilities c where c.station_id = s.id and c.is_active), false),
    coalesce((select c.can_confirm_hub_receipt or c.can_confirm_station_receipt from public.caterlink_station_capabilities c where c.station_id = s.id and c.is_active), false)
  from public.org_stations s
  where s.hub_id = v_hub and s.is_active and (p_station_code is null or s.code = p_station_code)
  order by s.code;
end;
$function$;
revoke execute on function public.get_hub_station_overview_secure(text, date) from public, anon;
grant execute on function public.get_hub_station_overview_secure(text, date) to authenticated, service_role;

-- =============================================================================================
-- 6c. GHOD / AirAsia Management: request access without browsing report content
-- =============================================================================================
create or replace function public.search_report_stubs_for_request_secure(
  p_flight text default null, p_from date default null, p_to date default null, p_source_table text default null, p_page integer default 1, p_page_size integer default 25
)
returns table (id uuid, source_table text, operating_entity_code text, flight_number text, report_date date, status text, already_accessible boolean, total_count bigint)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_page integer := greatest(coalesce(p_page, 1), 1);
  v_size integer := least(greatest(coalesce(p_page_size, 25), 1), 50);
  v_flight text := public.normalize_flight_number(p_flight);
begin
  if not (public.has_active_role('ghod') or public.has_active_role('airasia_management')) then
    raise exception 'Only GHOD or AirAsia Management may search reports to request access.';
  end if;
  if p_source_table is not null and p_source_table not in ('report_sec013', 'report_sec014', 'report_sec016', 'report_sec018', 'report_sec029', 'report_sec033', 'offload_records') then
    raise exception 'Unsupported report type filter.';
  end if;
  if v_flight is null and p_from is null and p_to is null then
    raise exception 'Provide a flight number or a date range.';
  end if;
  return query
  with c as (
    select cri.id as rid, cri.source_table as st, cri.operating_entity_code as ent, cri.status as stt, cri.source_id as sid, f.flight as fl, f.report_date as rd
    from public.central_reports_index cri
    cross join lateral public.report_source_flight_date(cri.source_table, cri.source_id) f
    where (p_source_table is null or cri.source_table = p_source_table)
  ), m as (
    select * from c
    where (v_flight is null or public.normalize_flight_number(c.fl) = v_flight)
      and (p_from is null or c.rd >= p_from) and (p_to is null or c.rd <= p_to)
  ), n as (select count(*) as k from m)
  select m.rid, m.st, m.ent, m.fl, m.rd, m.stt, public.has_report_access(m.rid), n.k
  from m cross join n
  order by m.rd desc nulls last, m.rid
  limit v_size offset (v_page - 1) * v_size;
end;
$function$;
revoke execute on function public.search_report_stubs_for_request_secure(text, date, date, text, integer, integer) from public, anon;
grant execute on function public.search_report_stubs_for_request_secure(text, date, date, text, integer, integer) to authenticated, service_role;

create or replace function public.list_my_report_access_requests_secure()
returns table (
  id uuid, source_table text, operating_entity_code text, flight_number text, report_date date, business_reason text, status text,
  decision_reason text, created_at timestamptz, reviewed_at timestamptz, grant_state text, grant_expires_at timestamptz, source_id uuid
)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
begin
  if auth.uid() is null or not exists (select 1 from public.get_my_active_role_assignments()) then
    raise exception 'An active role assignment is required.';
  end if;
  return query
  select r.id, c.source_table, c.operating_entity_code, f.flight, f.report_date, r.business_reason, r.status, r.decision_reason, r.created_at, r.reviewed_at,
         g.st, g.expires_at, case when g.st = 'active' then c.source_id else null end
  from public.report_access_requests r
  join public.central_reports_index c on c.id = r.repository_report_id
  cross join lateral public.report_source_flight_date(c.source_table, c.source_id) f
  left join lateral (
    select x.expires_at,
           case when x.revoked_at is not null then 'revoked' when x.starts_at > now() then 'scheduled'
                when x.expires_at is not null and x.expires_at <= now() then 'expired' else 'active' end as st
    from public.report_access_grants x
    where x.repository_report_id = r.repository_report_id and x.grantee_profile_id = r.requester_id
    order by x.created_at desc limit 1
  ) g on true
  where r.requester_id = auth.uid()
  order by r.created_at desc
  limit 100;
end;
$function$;
revoke execute on function public.list_my_report_access_requests_secure() from public, anon;
grant execute on function public.list_my_report_access_requests_secure() to authenticated, service_role;

-- only GHOD and AirAsia Management open report-access requests; at most 20 pending at a time
create or replace function public.request_report_access(
  p_repository_report_id uuid,
  p_business_reason text,
  p_requested_duration_days integer default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Must be signed in to request report access.';
  end if;
  if not exists (select 1 from public.profiles where id = auth.uid() and status = 'approved')
     or not (public.has_active_role('ghod') or public.has_active_role('airasia_management')) then
    raise exception 'Only GHOD or AirAsia Management with an active assignment may request report access.';
  end if;
  if p_business_reason is null or length(btrim(p_business_reason)) < 10 then
    raise exception 'A specific business reason (at least 10 characters) is required.';
  end if;
  if p_requested_duration_days is not null and (p_requested_duration_days < 1 or p_requested_duration_days > 90) then
    raise exception 'The requested duration must be between 1 and 90 days.';
  end if;
  if (select count(*) from public.report_access_requests where requester_id = auth.uid() and status = 'pending') >= 20 then
    raise exception 'Too many pending requests.';
  end if;
  if not exists (select 1 from public.central_reports_index where id = p_repository_report_id) then
    raise exception 'Report not found.';
  end if;
  insert into public.report_access_requests (requester_id, repository_report_id, business_reason, requested_duration_days)
  values (auth.uid(), p_repository_report_id, btrim(p_business_reason), p_requested_duration_days)
  returning id into v_id;
  insert into public.report_access_audit (actor_id, repository_report_id, action, reason, request_id)
  values (auth.uid(), p_repository_report_id, 'access_request', btrim(p_business_reason), v_id);
  return v_id;
end;
$function$;
revoke execute on function public.request_report_access(uuid, text, integer) from public, anon;
grant execute on function public.request_report_access(uuid, text, integer) to authenticated, service_role;
