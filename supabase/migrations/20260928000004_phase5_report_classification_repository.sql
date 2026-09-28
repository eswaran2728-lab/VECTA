-- PHASE 5 -- REPORT CLASSIFICATION, CENTRAL REPORTING REPOSITORY,
-- IMMUTABLE VERSIONING, ACCESS GRANTS AND AUDIT (2026-09-28)
--
-- Additive only, same guarantee as Phases 2-4: no existing table/column/
-- policy/function/grant is touched, renamed or dropped, and NO existing
-- legacy permission is broadened. Existing report creation,
-- acknowledgement, lookup, history, attachments, and export behavior
-- (SEC013/014/016/018/029/033 and offload) are completely untouched --
-- current RLS on every report table is not modified, and no existing
-- route/server action calls anything in this migration.
--
-- READ-ONLY PRODUCTION INVENTORY (2026-09-28, before writing any part of
-- this migration): report_sec013=0, report_sec014=4, report_sec016=4,
-- report_sec018=0, report_sec029=0, report_sec033=0, offload_records=0
-- rows. Every one of the 8 existing rows (all in report_sec014/016) has
-- station = 'KUL - MAA' -- ZERO ambiguous rows exist today. No flight-
-- number column exists on report_sec013/014/018/033; report_sec016 has
-- flight/offload_flight_no, report_sec029 has flight_no, offload_records
-- has flight_no. No severity/flag_state column exists on any report
-- table today.
--
-- Covers:
--   Part A: additive classification columns on all 7 report tables
--   Part B: validate_org_hierarchy() -- shared hierarchy-consistency
--           check, reused from the same reasoning as Phase 3's trigger
--   Part C: central_reports_index -- authoritative repository, strict
--           source-table allowlist, one identity per source row
--   Part D: report_versions -- amendment/version model
--   Part E: report_access_requests / report_access_grants
--   Part F: report_access_audit -- append-only
--   Part G: confirm_report_operating_entity() -- prefix-vs-explicit
--           confirmation workflow
--   Part H: index_report() -- idempotent indexing, classification
--           mirrored onto the source row via an explicit allowlisted
--           CASE, never dynamic SQL with a client-supplied table name
--   Part I: flag_report() / unflag_report()
--   Part J: request_report_access() / grant_report_access() /
--           revoke_report_access()
--   Part K: has_report_access() -- the single authorization decision
--           point, reused by every read path
--   Part L: get_report_secure() -- the controlled read path
--   Part M: create_report_amendment() -- race-safe versioning
--   Part N: read-only index-integrity verification views
--   Part O: RLS / grants summary
--
-- BACKFILL: this migration adds ONLY additive nullable columns and does
-- NOT backfill a single row. Given the confirmed inventory above (100%
-- of existing rows are deterministically KUL-MAA, matching exactly the
-- Phase 2 backfill precedent), a deterministic backfill statement is
-- safe to write, but is intentionally NOT included in this file --
-- backfilling is a data-changing operation and this phase is explicitly
-- schema/function-only, local, unapplied. The exact backfill SQL is
-- provided separately in this phase's report (item 14), matching the
-- same station='KUL - MAA'/'KUL - AAX' exact-match, idempotent pattern
-- already used in 20260928000001_phase2_org_foundation.sql, for you to
-- review and separately authorize.

-- =======================================================================
-- PART A: additive classification columns on all 7 report tables
-- =======================================================================
-- Every column nullable. No existing column (station, team, any flight-
-- number field, ops_group-related field, submitter field, status field)
-- is touched. NOT NULL is never applied in this phase.
alter table public.report_sec013
  add column if not exists aoc_id uuid references public.aocs(id),
  add column if not exists operating_entity_id uuid references public.operating_entities(id),
  add column if not exists operating_entity_code text,
  add column if not exists department_id uuid references public.departments(id),
  add column if not exists unit_id uuid references public.units(id),
  add column if not exists hub_id uuid references public.hubs(id),
  add column if not exists org_station_id uuid references public.org_stations(id),
  add column if not exists org_team_id uuid references public.org_teams(id),
  add column if not exists severity text check (severity in ('low', 'medium', 'high', 'critical')),
  add column if not exists flag_state text not null default 'unflagged' check (flag_state in ('unflagged', 'flagged')),
  add column if not exists flagged_by uuid references public.profiles(id),
  add column if not exists flagged_reason text,
  add column if not exists flagged_at timestamptz,
  add column if not exists unflagged_by uuid references public.profiles(id),
  add column if not exists unflagged_at timestamptz;

alter table public.report_sec014
  add column if not exists aoc_id uuid references public.aocs(id),
  add column if not exists operating_entity_id uuid references public.operating_entities(id),
  add column if not exists operating_entity_code text,
  add column if not exists department_id uuid references public.departments(id),
  add column if not exists unit_id uuid references public.units(id),
  add column if not exists hub_id uuid references public.hubs(id),
  add column if not exists org_station_id uuid references public.org_stations(id),
  add column if not exists org_team_id uuid references public.org_teams(id),
  add column if not exists severity text check (severity in ('low', 'medium', 'high', 'critical')),
  add column if not exists flag_state text not null default 'unflagged' check (flag_state in ('unflagged', 'flagged')),
  add column if not exists flagged_by uuid references public.profiles(id),
  add column if not exists flagged_reason text,
  add column if not exists flagged_at timestamptz,
  add column if not exists unflagged_by uuid references public.profiles(id),
  add column if not exists unflagged_at timestamptz;

alter table public.report_sec016
  add column if not exists aoc_id uuid references public.aocs(id),
  add column if not exists operating_entity_id uuid references public.operating_entities(id),
  add column if not exists operating_entity_code text,
  add column if not exists department_id uuid references public.departments(id),
  add column if not exists unit_id uuid references public.units(id),
  add column if not exists hub_id uuid references public.hubs(id),
  add column if not exists org_station_id uuid references public.org_stations(id),
  add column if not exists org_team_id uuid references public.org_teams(id),
  add column if not exists severity text check (severity in ('low', 'medium', 'high', 'critical')),
  add column if not exists flag_state text not null default 'unflagged' check (flag_state in ('unflagged', 'flagged')),
  add column if not exists flagged_by uuid references public.profiles(id),
  add column if not exists flagged_reason text,
  add column if not exists flagged_at timestamptz,
  add column if not exists unflagged_by uuid references public.profiles(id),
  add column if not exists unflagged_at timestamptz;

alter table public.report_sec018
  add column if not exists aoc_id uuid references public.aocs(id),
  add column if not exists operating_entity_id uuid references public.operating_entities(id),
  add column if not exists operating_entity_code text,
  add column if not exists department_id uuid references public.departments(id),
  add column if not exists unit_id uuid references public.units(id),
  add column if not exists hub_id uuid references public.hubs(id),
  add column if not exists org_station_id uuid references public.org_stations(id),
  add column if not exists org_team_id uuid references public.org_teams(id),
  add column if not exists severity text check (severity in ('low', 'medium', 'high', 'critical')),
  add column if not exists flag_state text not null default 'unflagged' check (flag_state in ('unflagged', 'flagged')),
  add column if not exists flagged_by uuid references public.profiles(id),
  add column if not exists flagged_reason text,
  add column if not exists flagged_at timestamptz,
  add column if not exists unflagged_by uuid references public.profiles(id),
  add column if not exists unflagged_at timestamptz;

alter table public.report_sec029
  add column if not exists aoc_id uuid references public.aocs(id),
  add column if not exists operating_entity_id uuid references public.operating_entities(id),
  add column if not exists operating_entity_code text,
  add column if not exists department_id uuid references public.departments(id),
  add column if not exists unit_id uuid references public.units(id),
  add column if not exists hub_id uuid references public.hubs(id),
  add column if not exists org_station_id uuid references public.org_stations(id),
  add column if not exists org_team_id uuid references public.org_teams(id),
  add column if not exists severity text check (severity in ('low', 'medium', 'high', 'critical')),
  add column if not exists flag_state text not null default 'unflagged' check (flag_state in ('unflagged', 'flagged')),
  add column if not exists flagged_by uuid references public.profiles(id),
  add column if not exists flagged_reason text,
  add column if not exists flagged_at timestamptz,
  add column if not exists unflagged_by uuid references public.profiles(id),
  add column if not exists unflagged_at timestamptz;

alter table public.report_sec033
  add column if not exists aoc_id uuid references public.aocs(id),
  add column if not exists operating_entity_id uuid references public.operating_entities(id),
  add column if not exists operating_entity_code text,
  add column if not exists department_id uuid references public.departments(id),
  add column if not exists unit_id uuid references public.units(id),
  add column if not exists hub_id uuid references public.hubs(id),
  add column if not exists org_station_id uuid references public.org_stations(id),
  add column if not exists org_team_id uuid references public.org_teams(id),
  add column if not exists severity text check (severity in ('low', 'medium', 'high', 'critical')),
  add column if not exists flag_state text not null default 'unflagged' check (flag_state in ('unflagged', 'flagged')),
  add column if not exists flagged_by uuid references public.profiles(id),
  add column if not exists flagged_reason text,
  add column if not exists flagged_at timestamptz,
  add column if not exists unflagged_by uuid references public.profiles(id),
  add column if not exists unflagged_at timestamptz;

alter table public.offload_records
  add column if not exists aoc_id uuid references public.aocs(id),
  add column if not exists operating_entity_id uuid references public.operating_entities(id),
  add column if not exists operating_entity_code text,
  add column if not exists department_id uuid references public.departments(id),
  add column if not exists unit_id uuid references public.units(id),
  add column if not exists hub_id uuid references public.hubs(id),
  add column if not exists org_station_id uuid references public.org_stations(id),
  add column if not exists org_team_id uuid references public.org_teams(id),
  add column if not exists severity text check (severity in ('low', 'medium', 'high', 'critical')),
  add column if not exists flag_state text not null default 'unflagged' check (flag_state in ('unflagged', 'flagged')),
  add column if not exists flagged_by uuid references public.profiles(id),
  add column if not exists flagged_reason text,
  add column if not exists flagged_at timestamptz,
  add column if not exists unflagged_by uuid references public.profiles(id),
  add column if not exists unflagged_at timestamptz;

-- =======================================================================
-- PART B: validate_org_hierarchy() -- shared hierarchy-consistency check
-- =======================================================================
-- Same six checks as Phase 3's validate_user_role_assignment_scope(),
-- factored out here as a reusable function since report classification
-- needs exactly the same guarantee: a collection of individually valid
-- foreign keys belonging to different branches must be rejected.
-- Compares against each referenced table's own aoc_id column, never a
-- hardcoded 'MY' -- future-AOC-safe. Every parameter is optional
-- (nullable) -- only populated pairs are checked, since report
-- classification may be partially known (e.g. unit_id/flight_number
-- genuinely not applicable to every report type).
create or replace function public.validate_org_hierarchy(
  p_aoc_id uuid,
  p_operating_entity_id uuid,
  p_department_id uuid,
  p_unit_id uuid,
  p_hub_id uuid,
  p_station_id uuid,
  p_team_id uuid
)
returns void
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_entity_aoc uuid;
  v_dept_aoc uuid;
  v_unit_dept uuid;
  v_hub_aoc uuid;
  v_station_hub uuid;
  v_team_station uuid;
begin
  if p_operating_entity_id is not null then
    select oe.aoc_id into v_entity_aoc from public.operating_entities oe where oe.id = p_operating_entity_id;
    if p_aoc_id is null or v_entity_aoc is distinct from p_aoc_id then
      raise exception 'operating_entity_id does not belong to the given aoc_id.';
    end if;
  end if;

  if p_department_id is not null then
    select d.aoc_id into v_dept_aoc from public.departments d where d.id = p_department_id;
    if p_aoc_id is null or v_dept_aoc is distinct from p_aoc_id then
      raise exception 'department_id does not belong to the given aoc_id.';
    end if;
  end if;

  if p_unit_id is not null then
    select u.department_id into v_unit_dept from public.units u where u.id = p_unit_id;
    if p_department_id is null or v_unit_dept is distinct from p_department_id then
      raise exception 'unit_id does not belong to the given department_id.';
    end if;
  end if;

  if p_hub_id is not null then
    select h.aoc_id into v_hub_aoc from public.hubs h where h.id = p_hub_id;
    if p_aoc_id is null or v_hub_aoc is distinct from p_aoc_id then
      raise exception 'hub_id does not belong to the given aoc_id.';
    end if;
  end if;

  if p_station_id is not null then
    select s.hub_id into v_station_hub from public.org_stations s where s.id = p_station_id;
    if p_hub_id is null or v_station_hub is distinct from p_hub_id then
      raise exception 'station_id does not belong to the given hub_id.';
    end if;
  end if;

  if p_team_id is not null then
    select t.station_id into v_team_station from public.org_teams t where t.id = p_team_id;
    if p_station_id is null or v_team_station is distinct from p_station_id then
      raise exception 'team_id does not belong to the given station_id.';
    end if;
  end if;
end;
$function$;

revoke execute on function public.validate_org_hierarchy(uuid, uuid, uuid, uuid, uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.validate_org_hierarchy(uuid, uuid, uuid, uuid, uuid, uuid, uuid) to service_role;

-- =======================================================================
-- PART C: central_reports_index
-- =======================================================================
-- source_table is CHECK-constrained to a fixed allowlist -- the ONLY
-- seven values every function in this migration ever accepts. No
-- function in this file builds or executes SQL against a client-
-- supplied table name; every source-table-specific write (Part H) uses
-- an explicit, hardcoded CASE over exactly these seven names.
create table if not exists public.central_reports_index (
  id uuid primary key default gen_random_uuid(),
  source_table text not null check (source_table in (
    'report_sec013', 'report_sec014', 'report_sec016', 'report_sec018',
    'report_sec029', 'report_sec033', 'offload_records'
  )),
  source_id uuid not null,
  report_type text not null,
  aoc_id uuid references public.aocs(id),
  operating_entity_id uuid references public.operating_entities(id),
  operating_entity_code text,
  department_id uuid references public.departments(id),
  unit_id uuid references public.units(id),
  hub_id uuid references public.hubs(id),
  station_id uuid references public.org_stations(id),
  team_id uuid references public.org_teams(id),
  flight_number text,
  report_date date,
  status text not null default 'submitted',
  severity text,
  flag_state text not null default 'unflagged',
  current_version integer not null default 1,
  submitter_profile_id uuid references public.profiles(id),
  indexed_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One authoritative repository identity per source row -- a retried
-- index_report() call for the same (source_table, source_id) can never
-- create a second index entry.
create unique index if not exists central_reports_index_source_unique
  on public.central_reports_index (source_table, source_id);

create index if not exists central_reports_index_entity_idx on public.central_reports_index (operating_entity_code);
create index if not exists central_reports_index_flag_idx on public.central_reports_index (flag_state) where flag_state = 'flagged';

-- =======================================================================
-- PART D: report_versions -- amendment/version model
-- =======================================================================
-- Version 1 is the immutable original (created by index_report(), Part
-- H). Amendments never delete or overwrite an earlier version row.
-- Approval-role assignment for amendments is NOT invented here -- the
-- business rule for who may approve an amendment was not specified, so
-- this model supports approved_by/effective_status as data columns a
-- future phase can wire a real approval workflow onto, without needing
-- another schema change. Until that workflow exists, amendments are
-- recorded with effective_status='pending' and never automatically
-- become the current version (see create_report_amendment(), Part M).
create table if not exists public.report_versions (
  id uuid primary key default gen_random_uuid(),
  repository_report_id uuid not null references public.central_reports_index(id),
  version_number integer not null,
  amendment_type text not null default 'correction',
  reason text not null,
  requested_by uuid not null references public.profiles(id),
  approved_by uuid references public.profiles(id),
  effective_status text not null default 'pending' check (effective_status in ('pending', 'approved', 'rejected')),
  amended_content jsonb,
  supersedes_version integer,
  created_at timestamptz not null default now(),
  decided_at timestamptz
);

-- Version numbers are unique and race-safe per report -- see
-- create_report_amendment()'s FOR UPDATE lock on the index row (Part M);
-- this constraint is the final structural backstop against two
-- concurrent amendments ever landing on the same version number.
create unique index if not exists report_versions_unique_per_report
  on public.report_versions (repository_report_id, version_number);

-- =======================================================================
-- PART E: report_access_requests / report_access_grants
-- =======================================================================
create table if not exists public.report_access_requests (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null references public.profiles(id),
  repository_report_id uuid not null references public.central_reports_index(id),
  business_reason text not null,
  requested_duration_days integer,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  reviewed_by uuid references public.profiles(id),
  reviewed_at timestamptz,
  decision_reason text,
  created_at timestamptz not null default now()
);

create table if not exists public.report_access_grants (
  id uuid primary key default gen_random_uuid(),
  repository_report_id uuid not null references public.central_reports_index(id),
  grantee_profile_id uuid not null references public.profiles(id),
  granted_by uuid not null references public.profiles(id),
  reason text not null,
  starts_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  -- A grant never provides edit/acknowledge/approve authority -- it is
  -- structurally read-only because no function in this migration ever
  -- checks report_access_grants before a write; only get_report_secure()
  -- (Part L, a read-only function) and has_report_access() (Part K)
  -- consult it at all.
  constraint report_access_grants_no_self_grant check (granted_by is distinct from grantee_profile_id)
);

-- No duplicate ACTIVE grant for the same (report, grantee).
create unique index if not exists report_access_grants_one_active
  on public.report_access_grants (repository_report_id, grantee_profile_id)
  where revoked_at is null;

-- =======================================================================
-- PART F: report_access_audit -- append-only
-- =======================================================================
create table if not exists public.report_access_audit (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references public.profiles(id),
  repository_report_id uuid references public.central_reports_index(id),
  version_number integer,
  action text not null check (action in (
    'view', 'version_view', 'download', 'export',
    'access_request', 'grant', 'revoke',
    'flag', 'unflag', 'amendment_request', 'amendment_approved', 'amendment_rejected',
    'index', 'reindex', 'entity_confirmed', 'entity_conflict'
  )),
  reason text,
  request_id uuid references public.report_access_requests(id),
  grant_id uuid references public.report_access_grants(id),
  created_at timestamptz not null default now()
);

create index if not exists report_access_audit_report_idx on public.report_access_audit (repository_report_id);

-- =======================================================================
-- PART G: confirm_report_operating_entity()
-- =======================================================================
-- Prefix-vs-explicit-entity confirmation workflow. AK/D7 are input-
-- helper suggestions ONLY -- this function never derives an entity from
-- a flight prefix by itself; it takes the CALLER's explicitly confirmed
-- p_confirmed_entity_id and, if a prefix was supplied, checks it against
-- the confirmed entity's own flight_prefix. A mismatch is REJECTED (not
-- silently overwritten) unless p_override_conflict is explicitly true,
-- in which case the conflict is still logged to the audit trail as
-- 'entity_conflict', not silently accepted.
create or replace function public.confirm_report_operating_entity(
  p_confirmed_entity_id uuid,
  p_flight_prefix text default null,
  p_override_conflict boolean default false
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_entity_code text;
  v_expected_prefix text;
begin
  if auth.uid() is null then
    raise exception 'Must be signed in to confirm a report operating entity.';
  end if;

  select code, flight_prefix into v_entity_code, v_expected_prefix
  from public.operating_entities where id = p_confirmed_entity_id;

  if v_entity_code is null then
    raise exception 'Unknown operating_entity_id.';
  end if;

  if p_flight_prefix is not null and v_expected_prefix is not null and p_flight_prefix <> v_expected_prefix then
    if not p_override_conflict then
      raise exception 'Flight prefix % does not match the confirmed operating entity % (expected prefix %). Confirm explicitly to override.', p_flight_prefix, v_entity_code, v_expected_prefix;
    end if;
    insert into public.report_access_audit (actor_id, action, reason)
    values (auth.uid(), 'entity_conflict', format('prefix=%s confirmed_entity=%s expected_prefix=%s overridden=true', p_flight_prefix, v_entity_code, v_expected_prefix));
  else
    insert into public.report_access_audit (actor_id, action, reason)
    values (auth.uid(), 'entity_confirmed', format('entity=%s prefix=%s', v_entity_code, coalesce(p_flight_prefix, 'none')));
  end if;

  return p_confirmed_entity_id;
end;
$function$;

revoke execute on function public.confirm_report_operating_entity(uuid, text, boolean) from public, anon;
grant execute on function public.confirm_report_operating_entity(uuid, text, boolean) to authenticated, service_role;

-- =======================================================================
-- PART H: index_report() -- idempotent, allowlisted indexing
-- =======================================================================
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
as $function$
declare
  v_index_id uuid;
  v_entity_code text;
begin
  if p_source_table not in (
    'report_sec013', 'report_sec014', 'report_sec016', 'report_sec018',
    'report_sec029', 'report_sec033', 'offload_records'
  ) then
    raise exception 'Unsupported report source table %; not on the indexing allowlist.', p_source_table;
  end if;

  perform public.validate_org_hierarchy(p_aoc_id, p_operating_entity_id, p_department_id, p_unit_id, p_hub_id, p_station_id, p_team_id);

  if p_operating_entity_id is not null then
    select code into v_entity_code from public.operating_entities where id = p_operating_entity_id;
  end if;

  -- Idempotent: a retried call for the same (source_table, source_id)
  -- returns the EXISTING index id and touches nothing else --
  -- classification, once indexed, never silently changes on a retry.
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
    -- Lost a race with a concurrent indexer -- fetch what the winner wrote.
    select id into v_index_id from public.central_reports_index
    where source_table = p_source_table and source_id = p_source_id;
    return v_index_id;
  end if;

  -- Version 1 = the immutable original.
  insert into public.report_versions (repository_report_id, version_number, amendment_type, reason, requested_by, effective_status, decided_at)
  values (v_index_id, 1, 'original', 'Initial submission.', p_submitter_profile_id, 'approved', now());

  -- Mirror the confirmed classification onto the source report row --
  -- explicit, hardcoded, allowlisted CASE. No dynamic SQL, no client-
  -- supplied table name ever reaches an EXECUTE/format() call.
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
  end if;

  insert into public.report_access_audit (actor_id, repository_report_id, version_number, action)
  values (p_submitter_profile_id, v_index_id, 1, 'index');

  return v_index_id;
end;
$function$;

revoke execute on function public.index_report(text, uuid, text, uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, date, uuid) from public, anon, authenticated;
grant execute on function public.index_report(text, uuid, text, uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, date, uuid) to service_role;

-- =======================================================================
-- PART I: flag_report() / unflag_report()
-- =======================================================================
-- Flagging is a controlled server/database action, never a raw column
-- write -- ordinary users have no UPDATE grant on central_reports_index
-- at all (Part O), and the report source tables' own flag_state column
-- likewise has no direct authenticated write path added here.
create or replace function public.flag_report(
  p_repository_report_id uuid,
  p_severity text,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if auth.uid() is null then
    raise exception 'Must be signed in to flag a report.';
  end if;
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'A flag reason is required.';
  end if;

  update public.central_reports_index
  set flag_state = 'flagged', severity = p_severity, updated_at = now()
  where id = p_repository_report_id;

  insert into public.report_access_audit (actor_id, repository_report_id, action, reason)
  values (auth.uid(), p_repository_report_id, 'flag', p_reason);
end;
$function$;

revoke execute on function public.flag_report(uuid, text, text) from public, anon, authenticated;
grant execute on function public.flag_report(uuid, text, text) to service_role;

create or replace function public.unflag_report(
  p_repository_report_id uuid,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if auth.uid() is null then
    raise exception 'Must be signed in to unflag a report.';
  end if;

  update public.central_reports_index
  set flag_state = 'unflagged', updated_at = now()
  where id = p_repository_report_id;

  insert into public.report_access_audit (actor_id, repository_report_id, action, reason)
  values (auth.uid(), p_repository_report_id, 'unflag', p_reason);
end;
$function$;

revoke execute on function public.unflag_report(uuid, text) from public, anon, authenticated;
grant execute on function public.unflag_report(uuid, text) to service_role;
-- Both are service_role-only in this phase -- no ordinary role is wired
-- to call them yet (Phase 5 does not activate new role access, per
-- instruction); a future phase adds the specific "which role may flag"
-- server action that calls these with its own verified caller context.

-- =======================================================================
-- PART J: request_report_access() / grant_report_access() / revoke_report_access()
-- =======================================================================
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
  if p_business_reason is null or length(trim(p_business_reason)) = 0 then
    raise exception 'A business reason is required.';
  end if;

  insert into public.report_access_requests (requester_id, repository_report_id, business_reason, requested_duration_days)
  values (auth.uid(), p_repository_report_id, p_business_reason, p_requested_duration_days)
  returning id into v_id;

  insert into public.report_access_audit (actor_id, repository_report_id, action, reason, request_id)
  values (auth.uid(), p_repository_report_id, 'access_request', p_business_reason, v_id);

  return v_id;
end;
$function$;

revoke execute on function public.request_report_access(uuid, text, integer) from public, anon;
grant execute on function public.request_report_access(uuid, text, integer) to authenticated, service_role;

-- Only the Global Reporting Controller administers grants -- checked via
-- Phase 3's own has_active_role(), never a client-supplied role claim.
-- No self-approval (grantor cannot be grantee -- also a table CHECK,
-- Part E); no duplicate active grant (partial unique index, Part E).
create or replace function public.grant_report_access(
  p_request_id uuid,
  p_grantee_profile_id uuid,
  p_reason text,
  p_expires_at timestamptz default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_request record;
  v_admin_id uuid := auth.uid();
  v_grant_id uuid;
begin
  if not public.has_active_role('global_reporting_controller') then
    raise exception 'Only the Global Reporting Controller may grant report access.';
  end if;
  if p_grantee_profile_id = v_admin_id then
    raise exception 'Cannot grant report access to yourself.';
  end if;

  select * into v_request from public.report_access_requests where id = p_request_id for update;
  if v_request is null then
    raise exception 'Access request not found.';
  end if;
  if v_request.status <> 'pending' then
    raise exception 'Access request has already been reviewed (status=%).', v_request.status;
  end if;

  update public.report_access_requests
  set status = 'approved', reviewed_by = v_admin_id, reviewed_at = now()
  where id = p_request_id;

  insert into public.report_access_grants (repository_report_id, grantee_profile_id, granted_by, reason, expires_at)
  values (v_request.repository_report_id, p_grantee_profile_id, v_admin_id, p_reason, p_expires_at)
  returning id into v_grant_id;

  insert into public.report_access_audit (actor_id, repository_report_id, action, reason, request_id, grant_id)
  values (v_admin_id, v_request.repository_report_id, 'grant', p_reason, p_request_id, v_grant_id);

  return v_grant_id;
end;
$function$;

revoke execute on function public.grant_report_access(uuid, uuid, text, timestamptz) from public, anon;
grant execute on function public.grant_report_access(uuid, uuid, text, timestamptz) to authenticated, service_role;

create or replace function public.revoke_report_access(
  p_grant_id uuid,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_admin_id uuid := auth.uid();
  v_report_id uuid;
begin
  if not public.has_active_role('global_reporting_controller') then
    raise exception 'Only the Global Reporting Controller may revoke report access.';
  end if;

  select repository_report_id into v_report_id from public.report_access_grants where id = p_grant_id and revoked_at is null;
  if v_report_id is null then
    raise exception 'Active grant not found.';
  end if;

  update public.report_access_grants set revoked_at = now() where id = p_grant_id;

  insert into public.report_access_audit (actor_id, repository_report_id, action, reason, grant_id)
  values (v_admin_id, v_report_id, 'revoke', p_reason, p_grant_id);
end;
$function$;

revoke execute on function public.revoke_report_access(uuid, text) from public, anon;
grant execute on function public.revoke_report_access(uuid, text) to authenticated, service_role;

-- =======================================================================
-- PART K: has_report_access() -- the single authorization decision point
-- =======================================================================
-- Reused by every read path (Part L) -- no other function in this
-- migration independently re-derives report access. Reads only
-- auth.uid() and the report's own indexed classification; never trusts
-- a client-supplied role claim.
--
-- GHOD: access requires the report's ACTUAL current flag_state ='flagged'
-- in the database, never a client query parameter -- a submitter cannot
-- grant themselves GHOD visibility by tampering with a request field,
-- since flag_state is only ever written by flag_report()/unflag_report()
-- (service_role-only).
-- AirAsia Management: never returns true here -- executive aggregates
-- are a separate, not-yet-built dashboard RPC (Phase 6), never a per-
-- report grant.
-- Super Admin: never returns true here -- no implicit report access.
create or replace function public.has_report_access(p_repository_report_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_report record;
begin
  select * into v_report from public.central_reports_index where id = p_repository_report_id;
  if v_report is null then
    return false;
  end if;

  -- Own submission.
  if v_report.submitter_profile_id = auth.uid() then
    return true;
  end if;

  -- Global Reporting Controller: repository-wide search authority.
  if public.has_active_role('global_reporting_controller') then
    return true;
  end if;

  -- GHOD: only while the report is actively flagged.
  if v_report.flag_state = 'flagged' and public.has_active_role('ghod') then
    return true;
  end if;

  -- MAA / AAX Boss: only their own entity's detailed reports.
  if v_report.operating_entity_code = 'MAA' and public.has_active_role('maa_boss') then
    return true;
  end if;
  if v_report.operating_entity_code = 'AAX' and public.has_active_role('aax_boss') then
    return true;
  end if;

  -- Main Enforcement / Compliance: Malaysia-wide read, scoped to the
  -- report's own aoc_id (future-AOC-safe, not hardcoded).
  if v_report.aoc_id is not null and public.has_role_in_scope('main_enforcement', v_report.aoc_id) then
    return true;
  end if;
  if v_report.aoc_id is not null and public.has_role_in_scope('compliance', v_report.aoc_id) then
    return true;
  end if;

  -- Investigation: Malaysia-wide investigative read authority (Phase 3's
  -- own matrix keeps Investigation's operational scope Malaysia-wide,
  -- not report-type-restricted) -- covers "read-only access to original
  -- Profiling and authorized Malaysia reports."
  if v_report.aoc_id is not null and (
    public.has_role_in_scope('investigation_sso', v_report.aoc_id)
    or public.has_role_in_scope('investigation_so', v_report.aoc_id)
    or public.has_role_in_scope('investigation_aso', v_report.aoc_id)
  ) then
    return true;
  end if;

  -- Active, non-revoked, non-expired grant.
  if exists (
    select 1 from public.report_access_grants g
    where g.repository_report_id = p_repository_report_id
      and g.grantee_profile_id = auth.uid()
      and g.revoked_at is null
      and g.starts_at <= now()
      and (g.expires_at is null or g.expires_at > now())
  ) then
    return true;
  end if;

  return false;
end;
$function$;

revoke execute on function public.has_report_access(uuid) from public, anon;
grant execute on function public.has_report_access(uuid) to authenticated, service_role;

-- =======================================================================
-- PART L: get_report_secure() -- the controlled read path
-- =======================================================================
-- Implements the required sequence exactly: authenticate (auth.uid()
-- check) -> confirm approved/active status (profiles.status) -> evaluate
-- scope/grant (has_report_access()) -> verify classification (the row
-- must exist in central_reports_index) -> verify requested version
-- (defaults to current_version, or a specific version if supplied and
-- it exists) -> record access audit -> return minimum necessary
-- metadata. This returns METADATA ONLY, never a storage path or file
-- reference -- signed-URL issuance for attachments/version files is
-- explicitly Phase 6+ work (no storage bucket policy exists yet for
-- these report types), documented in the report's remaining risks.
create or replace function public.get_report_secure(
  p_repository_report_id uuid,
  p_version_number integer default null
)
returns table (
  id uuid,
  source_table text,
  source_id uuid,
  report_type text,
  operating_entity_code text,
  hub_code text,
  station_code text,
  team_name text,
  flight_number text,
  report_date date,
  status text,
  severity text,
  flag_state text,
  version_number integer,
  current_version integer
)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_caller_status text;
  v_version integer;
begin
  if auth.uid() is null then
    raise exception 'Must be signed in.';
  end if;

  select status into v_caller_status from public.profiles where id = auth.uid();
  if v_caller_status is distinct from 'approved' then
    raise exception 'Only an approved account may access report content.';
  end if;

  if not public.has_report_access(p_repository_report_id) then
    raise exception 'Not authorized to access this report.';
  end if;

  v_version := coalesce(p_version_number, (select cri.current_version from public.central_reports_index cri where cri.id = p_repository_report_id));

  if not exists (select 1 from public.report_versions rv where rv.repository_report_id = p_repository_report_id and rv.version_number = v_version) then
    raise exception 'Requested version % does not exist for this report.', v_version;
  end if;

  insert into public.report_access_audit (actor_id, repository_report_id, version_number, action)
  values (auth.uid(), p_repository_report_id, v_version, case when p_version_number is null then 'view' else 'version_view' end);

  return query
  select
    cri.id, cri.source_table, cri.source_id, cri.report_type, cri.operating_entity_code,
    h.code, s.code, t.name, cri.flight_number, cri.report_date, cri.status, cri.severity, cri.flag_state,
    v_version, cri.current_version
  from public.central_reports_index cri
  left join public.hubs h on h.id = cri.hub_id
  left join public.org_stations s on s.id = cri.station_id
  left join public.org_teams t on t.id = cri.team_id
  where cri.id = p_repository_report_id;
end;
$function$;

revoke execute on function public.get_report_secure(uuid, integer) from public, anon;
grant execute on function public.get_report_secure(uuid, integer) to authenticated, service_role;

-- =======================================================================
-- PART M: create_report_amendment() -- race-safe versioning
-- =======================================================================
-- Version numbering is race-safe via FOR UPDATE on the index row --
-- two concurrent amendment requests for the same report serialize
-- through this lock, so the next version number is always computed
-- against a consistent MAX(version_number). The unique index on
-- (repository_report_id, version_number) (Part D) is the final
-- structural backstop even if that were ever bypassed. Amendments never
-- delete or overwrite an earlier version row, and a rejected amendment
-- (effective_status left 'pending' or later set 'rejected' by a not-
-- yet-designed approval step) never becomes current_version -- only an
-- explicit, separate "approve amendment" action (deliberately NOT built
-- in this phase, since the approving role was not specified) would ever
-- advance central_reports_index.current_version.
create or replace function public.create_report_amendment(
  p_repository_report_id uuid,
  p_amendment_type text,
  p_reason text,
  p_amended_content jsonb default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_next_version integer;
  v_amendment_id uuid;
  v_current_version integer;
begin
  if auth.uid() is null then
    raise exception 'Must be signed in to request a report amendment.';
  end if;
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'An amendment reason is required.';
  end if;
  if not public.has_report_access(p_repository_report_id) then
    raise exception 'Not authorized to access this report.';
  end if;

  select current_version into v_current_version
  from public.central_reports_index
  where id = p_repository_report_id
  for update;

  if v_current_version is null then
    raise exception 'Report not found.';
  end if;

  select coalesce(max(version_number), 0) + 1 into v_next_version
  from public.report_versions
  where repository_report_id = p_repository_report_id;

  insert into public.report_versions (
    repository_report_id, version_number, amendment_type, reason, requested_by, effective_status, amended_content, supersedes_version
  ) values (
    p_repository_report_id, v_next_version, p_amendment_type, p_reason, auth.uid(), 'pending', p_amended_content, v_current_version
  )
  returning id into v_amendment_id;

  insert into public.report_access_audit (actor_id, repository_report_id, version_number, action, reason)
  values (auth.uid(), p_repository_report_id, v_next_version, 'amendment_request', p_reason);

  return v_amendment_id;
end;
$function$;

revoke execute on function public.create_report_amendment(uuid, text, text, jsonb) from public, anon;
grant execute on function public.create_report_amendment(uuid, text, text, jsonb) to authenticated, service_role;

-- =======================================================================
-- PART N: read-only index-integrity verification views
-- =======================================================================
-- service_role-only (no grant to authenticated/anon) -- for the
-- migration owner's own use, until a future phase decides who else
-- should see index-health metrics.
create or replace view public.v_report_index_classification_gaps as
select source_table, source_id, id as repository_report_id
from public.central_reports_index
where aoc_id is null or operating_entity_id is null or hub_id is null;

create or replace view public.v_report_index_current_version_mismatch as
select cri.id as repository_report_id, cri.current_version, max(rv.version_number) as highest_version
from public.central_reports_index cri
join public.report_versions rv on rv.repository_report_id = cri.id
group by cri.id, cri.current_version
having cri.current_version <> max(rv.version_number) filter (where rv.effective_status = 'approved');

-- =======================================================================
-- PART O: RLS / grants summary
-- =======================================================================
alter table public.central_reports_index enable row level security;
alter table public.report_versions enable row level security;
alter table public.report_access_requests enable row level security;
alter table public.report_access_grants enable row level security;
alter table public.report_access_audit enable row level security;

-- Every new table: zero grant to anon/authenticated at the table level.
-- All read/write happens exclusively through the SECURITY DEFINER
-- functions above, which validate authorization internally -- exactly
-- the pattern established in Phases 3 and 4 (no bespoke RLS policy per
-- role; a small set of generic, reusable, narrow RPCs instead).
revoke all on public.central_reports_index from public, anon, authenticated;
grant all on public.central_reports_index to service_role;

revoke all on public.report_versions from public, anon, authenticated;
grant all on public.report_versions to service_role;

revoke all on public.report_access_requests from public, anon, authenticated;
grant all on public.report_access_requests to service_role;

revoke all on public.report_access_grants from public, anon, authenticated;
grant all on public.report_access_grants to service_role;

revoke all on public.report_access_audit from public, anon, authenticated;
grant all on public.report_access_audit to service_role;

-- =======================================================================
-- DOCUMENTED ROLLBACK (not executed by this file -- reference only, run
-- manually and only against a target where this migration was actually
-- applied).
--
-- 1. Drop the two verification views:
--      drop view if exists public.v_report_index_current_version_mismatch;
--      drop view if exists public.v_report_index_classification_gaps;
--
-- 2. Drop the RPC functions (all reference the new tables, so must go
--    before them):
--      drop function if exists public.create_report_amendment(uuid, text, text, jsonb);
--      drop function if exists public.get_report_secure(uuid, integer);
--      drop function if exists public.has_report_access(uuid);
--      drop function if exists public.revoke_report_access(uuid, text);
--      drop function if exists public.grant_report_access(uuid, uuid, text, timestamptz);
--      drop function if exists public.request_report_access(uuid, text, integer);
--      drop function if exists public.unflag_report(uuid, text);
--      drop function if exists public.flag_report(uuid, text, text);
--      drop function if exists public.index_report(text, uuid, text, uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, date, uuid);
--      drop function if exists public.confirm_report_operating_entity(uuid, text, boolean);
--      drop function if exists public.validate_org_hierarchy(uuid, uuid, uuid, uuid, uuid, uuid, uuid);
--
-- 3. Drop the five new tables (dependents first -- report_access_audit
--    and report_access_grants/report_access_requests/report_versions
--    all reference central_reports_index, so it goes last):
--      drop table if exists public.report_access_audit;
--      drop table if exists public.report_access_grants;
--      drop table if exists public.report_access_requests;
--      drop table if exists public.report_versions;
--      drop table if exists public.central_reports_index;
--
-- 4. Drop the additive classification columns from all 7 report tables
--    (each independent of the others -- order among them does not
--    matter):
--      alter table public.report_sec013 drop column if exists aoc_id, drop column if exists operating_entity_id, drop column if exists operating_entity_code, drop column if exists department_id, drop column if exists unit_id, drop column if exists hub_id, drop column if exists org_station_id, drop column if exists org_team_id, drop column if exists severity, drop column if exists flag_state, drop column if exists flagged_by, drop column if exists flagged_reason, drop column if exists flagged_at, drop column if exists unflagged_by, drop column if exists unflagged_at;
--      -- (repeat the same DROP COLUMN list for report_sec014, report_sec016, report_sec018, report_sec029, report_sec033, offload_records)
--
-- This rolls back cleanly independent of Phases 2-4 -- no Phase 2/3/4
-- table gains a new column or FK from this migration, so there is no
-- new ordering constraint against them (this migration only reads from
-- aocs/operating_entities/departments/units/hubs/org_stations/org_teams/
-- role_definitions/profiles/has_active_role()/has_role_in_scope(),
-- never writes to them).