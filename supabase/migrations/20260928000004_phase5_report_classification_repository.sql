-- PHASE 5 -- REPORT CLASSIFICATION, CENTRAL REPORTING REPOSITORY,
-- IMMUTABLE VERSIONING, ACCESS GRANTS AND AUDIT (2026-09-28)
--
-- Additive only, same guarantee as Phases 2-4: no existing table/column/
-- policy/function/grant is touched, renamed or dropped, and NO existing
-- legacy permission is broadened. Existing report creation,
-- acknowledgement, lookup, history, attachments, and export behavior
-- (SEC013/014/016/018/029/033 and offload) are completely untouched --
-- current RLS policies on every report table are not modified, and no
-- existing route/server action calls anything in this migration.
--
-- CORRECTION (review round 2): two BEFORE/AFTER triggers are now added
-- to all 7 report tables (Parts P and Q) -- direct-write protection and
-- automatic indexing. Existing RLS policies, columns, and application
-- code are still untouched; the triggers only ever narrow what a direct
-- PostgREST write can change (Part P) or run a side-effecting INSERT
-- into the new, isolated report_index_queue table (Part Q). Legitimate
-- existing writes (draft creation, submission, acknowledgement) are
-- unaffected -- see Part P's allowlist for the exact columns each table
-- keeps mutable.
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
--   Part P: enforce_report_row_immutability() -- BEFORE UPDATE trigger,
--           per-table allowlist, closes the direct-write and content-
--           immutability gaps found in review round 2
--   Part Q: report_index_queue -- durable, automatic, AFTER INSERT
--           indexing queue plus process_report_index_queue(), closing
--           the "client must remember to index" gap
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
-- CORRECTION (review round 2, point 5): possession of a service-role
-- client is not business authorization. The original version of these
-- functions checked only "auth.uid() is not null" -- any signed-in user
-- calling through any future service-role server action would have been
-- able to flag or unflag any report. Authorization is now verified
-- *inside* the function from auth.uid() itself, independent of which
-- Postgres role executes the call:
--   * caller must hold main_enforcement or compliance, scoped to the
--     report's own aoc_id, OR global_reporting_controller (repo-wide);
--   * the submitter can never flag/unflag their own report;
--   * GHOD is explicitly denied -- GHOD's access is a *consequence* of
--     an existing flag (has_report_access, Part K), so allowing GHOD to
--     flag would let it grant itself access, which is exactly the
--     self-dealing path the instruction called out;
--   * MAA/AAX Boss are explicitly denied -- the instruction reserves
--     entity-Boss/Compliance/Investigation flagging authority for a
--     later explicit business decision, so only Enforcement/Compliance/
--     the Global Reporting Controller may flag in this phase.
-- Grant is widened to `authenticated` because the internal auth.uid()
-- check is now the real security boundary, not the Postgres grant.
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
declare
  v_report record;
begin
  if auth.uid() is null then
    raise exception 'Must be signed in to flag a report.';
  end if;
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'A flag reason is required.';
  end if;
  if p_severity is null or length(trim(p_severity)) = 0 then
    raise exception 'A severity value is required.';
  end if;

  select * into v_report from public.central_reports_index where id = p_repository_report_id;
  if v_report is null then
    raise exception 'Report not found.';
  end if;

  if v_report.submitter_profile_id = auth.uid() then
    raise exception 'Cannot flag your own submitted report.';
  end if;

  if public.has_active_role('ghod') then
    raise exception 'GHOD is not authorized to flag reports.';
  end if;

  if not (
    public.has_active_role('global_reporting_controller')
    or (v_report.aoc_id is not null and public.has_role_in_scope('main_enforcement', v_report.aoc_id))
    or (v_report.aoc_id is not null and public.has_role_in_scope('compliance', v_report.aoc_id))
  ) then
    raise exception 'Not authorized to flag this report.';
  end if;

  update public.central_reports_index
  set flag_state = 'flagged', severity = p_severity,
      flagged_by = auth.uid(), flagged_reason = p_reason, flagged_at = now(),
      unflagged_by = null, unflagged_at = null, updated_at = now()
  where id = p_repository_report_id;

  insert into public.report_access_audit (actor_id, repository_report_id, action, reason)
  values (auth.uid(), p_repository_report_id, 'flag', p_reason);
end;
$function$;

revoke execute on function public.flag_report(uuid, text, text) from public, anon;
grant execute on function public.flag_report(uuid, text, text) to authenticated, service_role;

create or replace function public.unflag_report(
  p_repository_report_id uuid,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_report record;
begin
  if auth.uid() is null then
    raise exception 'Must be signed in to unflag a report.';
  end if;

  select * into v_report from public.central_reports_index where id = p_repository_report_id;
  if v_report is null then
    raise exception 'Report not found.';
  end if;

  if v_report.submitter_profile_id = auth.uid() then
    raise exception 'Cannot unflag your own submitted report.';
  end if;

  if public.has_active_role('ghod') then
    raise exception 'GHOD is not authorized to unflag reports.';
  end if;

  if not (
    public.has_active_role('global_reporting_controller')
    or (v_report.aoc_id is not null and public.has_role_in_scope('main_enforcement', v_report.aoc_id))
    or (v_report.aoc_id is not null and public.has_role_in_scope('compliance', v_report.aoc_id))
  ) then
    raise exception 'Not authorized to unflag this report.';
  end if;

  update public.central_reports_index
  set flag_state = 'unflagged', unflagged_by = auth.uid(), unflagged_at = now(), updated_at = now()
  where id = p_repository_report_id;

  insert into public.report_access_audit (actor_id, repository_report_id, action, reason)
  values (auth.uid(), p_repository_report_id, 'unflag', p_reason);
end;
$function$;

revoke execute on function public.unflag_report(uuid, text) from public, anon;
grant execute on function public.unflag_report(uuid, text) to authenticated, service_role;
-- Flag history is preserved: flag_state transitions are recorded in
-- report_access_audit (append-only, Part F) on every flag/unflag call,
-- and flagged_by/flagged_reason/flagged_at/unflagged_by/unflagged_at on
-- central_reports_index itself retain the most recent transition's
-- detail. No row is ever deleted from either.

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
  -- CORRECTION (review round 2, point 6): grantee identity is validated
  -- beyond the bare FK -- the grantee must be a real, currently-approved
  -- profile, not merely an id that happens to exist (e.g. a deactivated
  -- or never-approved account).
  if not exists (select 1 from public.profiles where id = p_grantee_profile_id and status = 'approved') then
    raise exception 'Grantee is not an approved profile.';
  end if;

  select * into v_request from public.report_access_requests where id = p_request_id for update;
  if v_request is null then
    raise exception 'Access request not found.';
  end if;
  if v_request.status <> 'pending' then
    raise exception 'Access request has already been reviewed (status=%).', v_request.status;
  end if;
  -- Report-scope validation: the request's target report must still
  -- exist in the repository (defense-in-depth beyond the FK -- makes
  -- the failure explicit rather than a generic constraint violation).
  if not exists (select 1 from public.central_reports_index where id = v_request.repository_report_id) then
    raise exception 'The requested report no longer exists in the repository.';
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
-- PART P: report content and classification immutability enforcement
-- =======================================================================
-- CORRECTION (review round 2, points 2 and 3). The original migration
-- assumed service-role-only RPCs were sufficient to keep the 15 new
-- classification/flag columns safe, and never addressed direct writes
-- to the 7 report tables' own pre-existing content columns at all. Both
-- assumptions were wrong: per a live production grant check this round,
-- `authenticated` holds broad table-level UPDATE on these tables today
-- (RLS, not table grants, is this project's real access gate), and
-- Phase 5 never added or touched RLS/policies on any of these 7 tables.
-- So, unconstrained, an ordinary signed-in user with any row-level
-- access at all could already rewrite station/team/remark/acknowledgement
-- -- or now, the new classification/flag columns -- directly through
-- PostgREST, with no trigger in the way.
--
-- One generic trigger function closes both gaps at once with a genuine
-- per-table ALLOWLIST (never a denylist a future column could bypass):
-- for each table it names every column an ordinary authenticated user
-- may still change after row creation; every other column -- including
-- every new classification/flag column, which appears in no table's
-- allowlist -- is frozen for any caller that is not service_role.
--
-- Allowlist basis (from this round's production column audit and a
-- code search of lib/avsec/reports/actions.ts and lib/avsec/admin/
-- actions.ts for any post-creation UPDATE of these tables):
--   * status, updated_at -- every table's own existing workflow columns.
--   * acknowledgement -- exists only on report_sec013/014/018/029 and is
--     written post-submission by the existing acknowledgement feature;
--     report_sec016/033/offload_records have no acknowledgement column
--     at all, so it is omitted from their allowlists.
--   * report_sec016's aircraft_search_completed/search_overdue_flag/
--     search_remark are NOT allowlisted: a code search found these are
--     only ever set once, at INSERT time, in lib/avsec/reports/
--     actions.ts (the >=4-hour-on-ground search-overdue computation
--     happens before the row is written, never as a later UPDATE) --
--     no legitimate workflow needs them mutable after creation, so they
--     are frozen along with every other content column.
-- If a future phase needs a workflow that legitimately updates a column
-- not on this list, it must extend this allowlist explicitly and
-- through service_role/a dedicated RPC -- never left to fall through.
--
-- This trigger governs UPDATE only (INSERT -- draft creation and
-- submission -- is completely unaffected), and is bypassed for
-- service_role so that index_report() (Part H, itself already
-- allowlist-validated and idempotent) can still mirror classification
-- onto the source row, and so existing service-role server actions keep
-- working unchanged.
create or replace function public.enforce_report_row_immutability()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_allowed text[];
  v_old jsonb;
  v_new jsonb;
  v_key text;
begin
  if auth.role() = 'service_role' then
    return new;
  end if;

  v_allowed := case tg_table_name
    when 'report_sec013' then array['status', 'updated_at', 'acknowledgement']
    when 'report_sec014' then array['status', 'updated_at', 'acknowledgement']
    when 'report_sec016' then array['status', 'updated_at']
    when 'report_sec018' then array['status', 'updated_at', 'acknowledgement']
    when 'report_sec029' then array['status', 'updated_at', 'acknowledgement']
    when 'report_sec033' then array['status', 'updated_at']
    when 'offload_records' then array['status', 'updated_at']
    else array[]::text[]
  end;

  v_old := to_jsonb(old);
  v_new := to_jsonb(new);

  for v_key in select jsonb_object_keys(v_new) loop
    if v_key = any(v_allowed) then
      continue;
    end if;
    if (v_new -> v_key) is distinct from (v_old -> v_key) then
      raise exception 'Column % on % cannot be changed directly after creation; only % may change.',
        v_key, tg_table_name, array_to_string(v_allowed, ', ');
    end if;
  end loop;

  return new;
end;
$function$;

revoke execute on function public.enforce_report_row_immutability() from public, anon, authenticated;
grant execute on function public.enforce_report_row_immutability() to service_role;

drop trigger if exists trg_enforce_immutability on public.report_sec013;
create trigger trg_enforce_immutability before update on public.report_sec013
  for each row execute function public.enforce_report_row_immutability();

drop trigger if exists trg_enforce_immutability on public.report_sec014;
create trigger trg_enforce_immutability before update on public.report_sec014
  for each row execute function public.enforce_report_row_immutability();

drop trigger if exists trg_enforce_immutability on public.report_sec016;
create trigger trg_enforce_immutability before update on public.report_sec016
  for each row execute function public.enforce_report_row_immutability();

drop trigger if exists trg_enforce_immutability on public.report_sec018;
create trigger trg_enforce_immutability before update on public.report_sec018
  for each row execute function public.enforce_report_row_immutability();

drop trigger if exists trg_enforce_immutability on public.report_sec029;
create trigger trg_enforce_immutability before update on public.report_sec029
  for each row execute function public.enforce_report_row_immutability();

drop trigger if exists trg_enforce_immutability on public.report_sec033;
create trigger trg_enforce_immutability before update on public.report_sec033
  for each row execute function public.enforce_report_row_immutability();

drop trigger if exists trg_enforce_immutability on public.offload_records;
create trigger trg_enforce_immutability before update on public.offload_records
  for each row execute function public.enforce_report_row_immutability();
-- No client EXECUTE grant is needed on this function at all -- Postgres
-- does not check EXECUTE privilege for trigger-fired invocation, only
-- for an explicit call/RPC (same reasoning already applied to Phase 4's
-- trigger functions). The revoke/grant above is defense-in-depth only.

-- =======================================================================
-- PART Q: durable, automatic indexing queue
-- =======================================================================
-- CORRECTION (review round 2, point 4). index_report() (Part H) was a
-- pure RPC that nothing in the application called -- the repository
-- would silently never fill unless a client remembered to invoke it.
-- This part makes indexing an automatic, durable, server-side
-- consequence of a report row being created, transparent to existing
-- application code (no route or action in lib/avsec/reports/actions.ts
-- changes), with a detectable, non-blocking failure/recovery path.
create table if not exists public.report_index_queue (
  id uuid primary key default gen_random_uuid(),
  source_table text not null check (source_table in (
    'report_sec013', 'report_sec014', 'report_sec016', 'report_sec018',
    'report_sec029', 'report_sec033', 'offload_records'
  )),
  source_id uuid not null,
  status text not null default 'pending' check (status in ('pending', 'processing', 'completed', 'failed')),
  attempts integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  processed_at timestamptz
);

-- Structural idempotency backstop: a source row can enqueue at most one
-- queue record, ever (mirrors index_report()'s own idempotency, Part H).
create unique index if not exists report_index_queue_source_unique
  on public.report_index_queue (source_table, source_id);

create index if not exists report_index_queue_pending_idx
  on public.report_index_queue (status) where status in ('pending', 'failed');

alter table public.report_index_queue enable row level security;
revoke all on public.report_index_queue from public, anon, authenticated;
grant all on public.report_index_queue to service_role;

-- AFTER INSERT trigger: fires in the SAME transaction as the report
-- INSERT, so the queue record is committed atomically with the report
-- itself -- there is no window where a submitted report exists without
-- a corresponding queue entry. ON CONFLICT DO NOTHING makes this safe
-- against any retry or re-fire. Because it only ever INSERTs into
-- report_index_queue (a table no trigger on the 7 report tables reads
-- or writes), it cannot recurse. Because it is AFTER INSERT only (never
-- AFTER UPDATE), a later content edit can never re-enqueue or duplicate
-- an entry.
create or replace function public.enqueue_report_for_indexing()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  insert into public.report_index_queue (source_table, source_id)
  values (tg_table_name, new.id)
  on conflict (source_table, source_id) do nothing;
  return new;
end;
$function$;

revoke execute on function public.enqueue_report_for_indexing() from public, anon, authenticated;
grant execute on function public.enqueue_report_for_indexing() to service_role;

drop trigger if exists trg_enqueue_indexing on public.report_sec013;
create trigger trg_enqueue_indexing after insert on public.report_sec013
  for each row execute function public.enqueue_report_for_indexing();

drop trigger if exists trg_enqueue_indexing on public.report_sec014;
create trigger trg_enqueue_indexing after insert on public.report_sec014
  for each row execute function public.enqueue_report_for_indexing();

drop trigger if exists trg_enqueue_indexing on public.report_sec016;
create trigger trg_enqueue_indexing after insert on public.report_sec016
  for each row execute function public.enqueue_report_for_indexing();

drop trigger if exists trg_enqueue_indexing on public.report_sec018;
create trigger trg_enqueue_indexing after insert on public.report_sec018
  for each row execute function public.enqueue_report_for_indexing();

drop trigger if exists trg_enqueue_indexing on public.report_sec029;
create trigger trg_enqueue_indexing after insert on public.report_sec029
  for each row execute function public.enqueue_report_for_indexing();

drop trigger if exists trg_enqueue_indexing on public.report_sec033;
create trigger trg_enqueue_indexing after insert on public.report_sec033
  for each row execute function public.enqueue_report_for_indexing();

drop trigger if exists trg_enqueue_indexing on public.offload_records;
create trigger trg_enqueue_indexing after insert on public.offload_records
  for each row execute function public.enqueue_report_for_indexing();

-- process_report_index_queue(): service_role-only, called by a future
-- scheduled job (no cron infrastructure is authorized or wired in this
-- phase -- this is the processing function that job will call). It never
-- guesses a classification: a queued row with no aoc_id yet on the
-- source table (true for every row today, since no classification UI
-- exists yet) is marked 'failed' with a explicit, detectable reason
-- rather than being indexed with fabricated values. It is safe to call
-- repeatedly -- 'completed' rows are never revisited, and index_report()
-- itself is idempotent if a row is retried after being classified.
create or replace function public.process_report_index_queue(p_batch_size integer default 50)
returns table (processed integer, indexed integer, failed integer)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_row record;
  v_source record;
  v_processed integer := 0;
  v_indexed integer := 0;
  v_failed integer := 0;
  v_aoc_id uuid;
begin
  for v_row in
    select * from public.report_index_queue
    where status in ('pending', 'failed')
    order by created_at
    limit p_batch_size
    for update skip locked
  loop
    v_processed := v_processed + 1;

    update public.report_index_queue set status = 'processing', attempts = attempts + 1 where id = v_row.id;

    begin
      execute format('select aoc_id from public.%I where id = $1', v_row.source_table)
        into v_aoc_id using v_row.source_id;

      if v_aoc_id is null then
        update public.report_index_queue
        set status = 'failed', last_error = 'source row not yet classified (aoc_id is null)', processed_at = now()
        where id = v_row.id;
        v_failed := v_failed + 1;
      else
        -- Re-select the full classification set now that we know it is
        -- populated; index_report() re-validates everything itself.
        execute format(
          'select aoc_id, operating_entity_id, department_id, unit_id, hub_id, org_station_id, org_team_id, report_no, profile_id from public.%I where id = $1',
          v_row.source_table
        ) into v_source using v_row.source_id;

        perform public.index_report(
          v_row.source_table, v_row.source_id, v_source.report_no,
          v_source.aoc_id, v_source.operating_entity_id, v_source.department_id,
          v_source.unit_id, v_source.hub_id, v_source.org_station_id, v_source.org_team_id,
          null, null, v_source.profile_id
        );

        update public.report_index_queue
        set status = 'completed', last_error = null, processed_at = now()
        where id = v_row.id;
        v_indexed := v_indexed + 1;
      end if;
    exception when others then
      update public.report_index_queue
      set status = 'failed', last_error = sqlerrm, processed_at = now()
      where id = v_row.id;
      v_failed := v_failed + 1;
    end;
  end loop;

  return query select v_processed, v_indexed, v_failed;
end;
$function$;

revoke execute on function public.process_report_index_queue(integer) from public, anon, authenticated;
grant execute on function public.process_report_index_queue(integer) to service_role;

-- Verification view: every queue entry that is not cleanly 'completed',
-- for whoever (a future ops dashboard, or manual inspection) needs to
-- see missing/failed indexing at a glance.
create or replace view public.v_report_index_queue_health as
select source_table, source_id, status, attempts, last_error, created_at, processed_at
from public.report_index_queue
where status <> 'completed';

-- =======================================================================
-- DOCUMENTED ROLLBACK (not executed by this file -- reference only, run
-- manually and only against a target where this migration was actually
-- applied). CORRECTION (review round 2, point 9): Phase 5 must be rolled
-- back in full, in the order below, BEFORE any Phase 2 organizational
-- table is rolled back -- Parts B, G, H and Q read aocs/operating_
-- entities/departments/units/hubs/org_stations/org_teams (Phase 2), and
-- Part K/flag_report/unflag_report read role_definitions/user_role_
-- assignments via has_active_role()/has_role_in_scope() (Phase 3) and
-- profiles.status (Phase 2/4). None of those Phase 2/3/4 objects may be
-- dropped while any Phase 5 object referencing them still exists.
--
-- 1. Drop the two triggers per report table (Parts P and Q -- triggers
--    must go before the functions they call), then the queue's
--    verification view and the queue-processing/enqueue functions:
--      drop trigger if exists trg_enforce_immutability on public.report_sec013;
--      drop trigger if exists trg_enforce_immutability on public.report_sec014;
--      drop trigger if exists trg_enforce_immutability on public.report_sec016;
--      drop trigger if exists trg_enforce_immutability on public.report_sec018;
--      drop trigger if exists trg_enforce_immutability on public.report_sec029;
--      drop trigger if exists trg_enforce_immutability on public.report_sec033;
--      drop trigger if exists trg_enforce_immutability on public.offload_records;
--      drop trigger if exists trg_enqueue_indexing on public.report_sec013;
--      drop trigger if exists trg_enqueue_indexing on public.report_sec014;
--      drop trigger if exists trg_enqueue_indexing on public.report_sec016;
--      drop trigger if exists trg_enqueue_indexing on public.report_sec018;
--      drop trigger if exists trg_enqueue_indexing on public.report_sec029;
--      drop trigger if exists trg_enqueue_indexing on public.report_sec033;
--      drop trigger if exists trg_enqueue_indexing on public.offload_records;
--      drop view if exists public.v_report_index_queue_health;
--      drop function if exists public.process_report_index_queue(integer);
--      drop function if exists public.enqueue_report_for_indexing();
--      drop function if exists public.enforce_report_row_immutability();
--
-- 2. Drop the report_index_queue table:
--      drop table if exists public.report_index_queue;
--
-- 3. Drop the two verification views:
--      drop view if exists public.v_report_index_current_version_mismatch;
--      drop view if exists public.v_report_index_classification_gaps;
--
-- 4. Drop the RPC functions (all reference the new tables, so must go
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
-- 5. Drop the five original new tables (dependents first -- report_
--    access_audit and report_access_grants/report_access_requests/
--    report_versions all reference central_reports_index, so it goes
--    last; these also transitively reference Phase 3/4 objects via
--    grantee_profile_id/granted_by -> profiles and via role checks in
--    the functions already dropped in step 4, so this step must also
--    precede any Phase 4 profiles/role-assignment rollback):
--      drop table if exists public.report_access_audit;
--      drop table if exists public.report_access_grants;
--      drop table if exists public.report_access_requests;
--      drop table if exists public.report_versions;
--      drop table if exists public.central_reports_index;
--
-- 6. Drop the additive classification columns from all 7 report tables
--    (each independent of the others -- order among them does not
--    matter -- but this step must come after step 1, since the Part P
--    trigger inspects these columns):
--      alter table public.report_sec013 drop column if exists aoc_id, drop column if exists operating_entity_id, drop column if exists operating_entity_code, drop column if exists department_id, drop column if exists unit_id, drop column if exists hub_id, drop column if exists org_station_id, drop column if exists org_team_id, drop column if exists severity, drop column if exists flag_state, drop column if exists flagged_by, drop column if exists flagged_reason, drop column if exists flagged_at, drop column if exists unflagged_by, drop column if exists unflagged_at;
--      -- (repeat the same DROP COLUMN list for report_sec014, report_sec016, report_sec018, report_sec029, report_sec033, offload_records)
--
-- Only after all 6 steps above are complete may Phase 2's organizational
-- tables (aocs/operating_entities/.../org_teams), Phase 3's role_
-- definitions/user_role_assignments, or Phase 4's profiles.status/
-- approval_state columns be rolled back -- no Phase 5 object references
-- them anymore at that point.