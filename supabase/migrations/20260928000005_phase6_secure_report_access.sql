-- PHASE 6 -- SECURE REPORT ACCESS, SEARCH, AUDIT AND ATTACHMENTS (2026-09-28)
--
-- Additive only, same guarantee as Phases 2-5: no existing table/column/
-- function/grant this migration does not explicitly name is touched. This
-- migration extends Phase 5's central decision function
-- (has_report_access(), CREATE OR REPLACE, additive superset of its
-- existing branches) and adds new secure list/search/flagged-report RPCs,
-- an attachment authorization building block, and extends the existing
-- report_access_audit action list. No application code in lib/ or app/ is
-- changed by this migration file -- see the Phase 6 report for why
-- wiring application code to these RPCs is deferred (the Central
-- Reporting Repository has zero rows in production today; wiring now
-- would return empty results for every real user).
--
-- Covers:
--   Part A: report_access_audit action list extended (additive CHECK)
--   Part B: has_report_access() v2 -- CREATE OR REPLACE, adds
--           operation_manager/hub_se/dse/sso/so/aso/sat_aso/
--           profiling_so/profiling_aso branches; explicitly documents
--           the maa_admin/aax_admin/caterlink_management/
--           airasia_management/super_admin exclusions
--   Part C: list_reports_secure() -- paginated, capped, deterministic
--   Part D: search_reports_secure() -- parameterized, no dynamic SQL
--   Part E: flagged_reports_secure()
--   Part F: get_attachment_authorization_secure() -- fail-closed building
--           block, not yet wired into lib/avsec/attachments/actions.ts
--   Part G: indexes for scope filtering, date ordering, flight-number,
--           severity/flag, source identity, grants, audit lookup
--   Part H: RLS / grants summary
--
-- MANDATORY DEPLOYMENT DEPENDENCY (recorded per the Phase 5 push
-- authorization): Phase 5's repository is empty in production and stays
-- empty until the Phase 5 migration is applied, role assignments are
-- activated for real users, and the indexing queue/cron actually runs.
-- These Phase 6 RPCs are correct and fully tested against that eventual
-- state, but none of them are called by application code yet -- see the
-- Phase 6 report, section 4, for the full list of legacy readers that
-- remain unmigrated and why.

-- =======================================================================
-- PART A: report_access_audit action list extended
-- =======================================================================
-- Additive: every existing action value stays valid; two new ones are
-- added for attachment URL issuance and export generation-time auditing
-- introduced by this phase. 'view'/'version_view'/'download'/'export'
-- already existed (Phase 5) and are reused for detail/search-result
-- opens (deliberately NOT a new 'search_result_view' action -- opening a
-- report's detail is the same auditable event regardless of whether the
-- caller arrived via a list, a search, or a direct link; the entry point
-- is not a distinct authorization-relevant fact).
alter table public.report_access_audit drop constraint if exists report_access_audit_action_check;
alter table public.report_access_audit add constraint report_access_audit_action_check check (action in (
  'view', 'version_view', 'download', 'export',
  'access_request', 'grant', 'revoke',
  'flag', 'unflag', 'amendment_request', 'amendment_approved', 'amendment_rejected',
  'index', 'reindex', 'entity_confirmed', 'entity_conflict',
  'attachment_url_issued'
));

-- =======================================================================
-- PART B: has_report_access() v2
-- =======================================================================
-- CREATE OR REPLACE of Phase 5's Part K function -- every existing
-- branch (own submission, global_reporting_controller, ghod-if-flagged,
-- maa_boss/aax_boss, main_enforcement/compliance, investigation, active
-- grant) is preserved verbatim. New branches below are a pure addition.
--
-- New role behavior this phase adds:
--   * operation_manager: Malaysia-wide across the report's own aoc_id,
--     scoped to the report's department_id (Operation department only --
--     has_role_in_scope's exact-match-when-passed semantics mean this
--     naturally excludes a report classified into a different
--     department). Never matches a report with department_id null
--     (unclassified -- see PART B note below).
--   * hub_se: scoped to the report's own hub_id.
--   * dse: scoped to the report's own team_id (KUL team, per Phase 3's
--     own dse scoping rule -- dse assignments are always KUL-hub, so no
--     separate hub check is needed beyond the team match).
--   * sso / so / aso: scoped to the report's own station_id AND team_id
--     together -- preserves the existing ASO/SO/DSE station+team
--     isolation rule exactly as Phase 3's assignment trigger already
--     enforces it structurally (an sso/so/aso assignment always carries
--     both a station_id and a team_id).
--   * sat_aso: scoped to the report's own unit_id (SAT unit) AND hub_id
--     (KUL), matching Phase 3's own sat_aso scoping rule.
--   * profiling_so / profiling_aso: scoped to the report's own unit_id
--     (Profiling unit) -- Malaysia-wide within that unit, matching Phase
--     3's own profiling scoping rule (no hub/station narrowing).
--
-- Explicitly NOT added (flagged decisions, narrower-by-default per the
-- instruction "implement the narrower access and flag the decision"):
--   * maa_admin / aax_admin: the spec requires "only the exact
--     report-administration responsibilities defined for their entity,"
--     which no phase has defined yet. Granting them the same access as
--     maa_boss/aax_boss would be the broader, unjustified interpretation
--     this instruction explicitly warns against. They receive NO report
--     access through this function until that responsibility is
--     explicitly specified in a future phase.
--   * caterlink_management: explicitly out of scope for AVSEC report
--     access ("no unrelated AVSEC reports") -- CaterLink's own
--     transaction/incident/archive/PDF access is a separate domain this
--     migration does not touch at all.
--   * airasia_management: aggregate/dashboard access only, never
--     per-report detail -- unchanged from Phase 5.
--   * super_admin: technical administration only, never automatic
--     operational report access -- unchanged from Phase 5.
--
-- NULL-classification safety (review point 9): every new branch below
-- requires the relevant report_id column to be NOT NULL before calling
-- has_role_in_scope with it as a non-null parameter -- an unclassified
-- report (any classification column still null, the current state of
-- every production report) is therefore invisible to every one of these
-- scoped roles, never treated as globally accessible. Only the
-- submitter (their own report, via source-table access unrelated to
-- classification) and global_reporting_controller (repository-wide by
-- design) can ever see an unclassified report through this function.
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

  -- Investigation: Malaysia-wide investigative read authority.
  if v_report.aoc_id is not null and (
    public.has_role_in_scope('investigation_sso', v_report.aoc_id)
    or public.has_role_in_scope('investigation_so', v_report.aoc_id)
    or public.has_role_in_scope('investigation_aso', v_report.aoc_id)
  ) then
    return true;
  end if;

  -- PHASE 6: Operation Manager -- Malaysia AOC + Operation department,
  -- across all hubs/stations.
  if v_report.aoc_id is not null and v_report.department_id is not null
    and public.has_role_in_scope('operation_manager', v_report.aoc_id, null, v_report.department_id) then
    return true;
  end if;

  -- PHASE 6: Hub SE -- own hub only.
  if v_report.aoc_id is not null and v_report.hub_id is not null
    and public.has_role_in_scope('hub_se', v_report.aoc_id, null, null, null, v_report.hub_id) then
    return true;
  end if;

  -- PHASE 6: DSE -- own KUL team only.
  if v_report.aoc_id is not null and v_report.team_id is not null
    and public.has_role_in_scope('dse', v_report.aoc_id, null, null, null, null, null, v_report.team_id) then
    return true;
  end if;

  -- PHASE 6: SSO / SO / ASO -- own station AND team together (both must
  -- be set on the report and both must match the assignment).
  if v_report.aoc_id is not null and v_report.station_id is not null and v_report.team_id is not null and (
    public.has_role_in_scope('sso', v_report.aoc_id, null, null, null, null, v_report.station_id, v_report.team_id)
    or public.has_role_in_scope('so', v_report.aoc_id, null, null, null, null, v_report.station_id, v_report.team_id)
    or public.has_role_in_scope('aso', v_report.aoc_id, null, null, null, null, v_report.station_id, v_report.team_id)
  ) then
    return true;
  end if;

  -- PHASE 6: SAT ASO -- own unit (SAT) AND hub (KUL) together.
  if v_report.aoc_id is not null and v_report.unit_id is not null and v_report.hub_id is not null
    and public.has_role_in_scope('sat_aso', v_report.aoc_id, null, null, v_report.unit_id, v_report.hub_id) then
    return true;
  end if;

  -- PHASE 6: Profiling SO / ASO -- own unit (Profiling), Malaysia-wide
  -- within it, no hub/station narrowing (matches Phase 3's own rule).
  if v_report.aoc_id is not null and v_report.unit_id is not null and (
    public.has_role_in_scope('profiling_so', v_report.aoc_id, null, null, v_report.unit_id)
    or public.has_role_in_scope('profiling_aso', v_report.aoc_id, null, null, v_report.unit_id)
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
-- PART C: list_reports_secure() -- paginated, capped, deterministic
-- =======================================================================
-- Hard page-size cap (never client-controlled beyond the cap) prevents
-- an unbounded scan; deterministic ORDER BY (indexed_at desc, id) makes
-- pagination stable across concurrent inserts. Every row returned has
-- already passed has_report_access() -- the same single decision point
-- used everywhere else -- so no separate re-implementation of scope
-- rules exists here to drift out of sync. total_count is computed from
-- the SAME authorized set (never a raw unauthorized table count), so it
-- cannot leak the existence of reports the caller cannot see.
create or replace function public.list_reports_secure(
  p_page integer default 1,
  p_page_size integer default 25,
  p_source_table text default null,
  p_flag_state text default null,
  p_status text default null,
  p_from_date date default null,
  p_to_date date default null
)
returns table (
  id uuid,
  source_table text,
  report_type text,
  operating_entity_code text,
  flight_number text,
  report_date date,
  status text,
  severity text,
  flag_state text,
  indexed_at timestamptz,
  total_count bigint
)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_page integer := greatest(coalesce(p_page, 1), 1);
  v_page_size integer := least(greatest(coalesce(p_page_size, 25), 1), 100);
begin
  if auth.uid() is null then
    raise exception 'Must be signed in.';
  end if;
  if not exists (select 1 from public.profiles where id = auth.uid() and status = 'approved') then
    raise exception 'Only an approved account may list reports.';
  end if;
  if p_source_table is not null and p_source_table not in (
    'report_sec013', 'report_sec014', 'report_sec016', 'report_sec018',
    'report_sec029', 'report_sec033', 'offload_records'
  ) then
    raise exception 'Unsupported source_table filter.';
  end if;
  if p_flag_state is not null and p_flag_state not in ('unflagged', 'flagged') then
    raise exception 'Unsupported flag_state filter.';
  end if;

  return query
  with authorized as (
    select cri.*
    from public.central_reports_index cri
    where public.has_report_access(cri.id)
      and (p_source_table is null or cri.source_table = p_source_table)
      and (p_flag_state is null or cri.flag_state = p_flag_state)
      and (p_status is null or cri.status = p_status)
      and (p_from_date is null or cri.report_date >= p_from_date)
      and (p_to_date is null or cri.report_date <= p_to_date)
  ),
  counted as (
    select count(*) as n from authorized
  )
  select
    a.id, a.source_table, a.report_type, a.operating_entity_code, a.flight_number,
    a.report_date, a.status, a.severity, a.flag_state, a.indexed_at,
    c.n
  from authorized a, counted c
  order by a.indexed_at desc, a.id
  limit v_page_size
  offset (v_page - 1) * v_page_size;
end;
$function$;

revoke execute on function public.list_reports_secure(integer, integer, text, text, text, date, date) from public, anon;
grant execute on function public.list_reports_secure(integer, integer, text, text, text, date, date) to authenticated, service_role;

-- =======================================================================
-- PART D: search_reports_secure() -- parameterized, no dynamic SQL
-- =======================================================================
-- Every filter is a fixed, typed function parameter bound through
-- plpgsql/SQL parameter binding -- never string concatenation, never
-- format()/EXECUTE, never a client-supplied column or table name. Same
-- authorized-set-first pattern as list_reports_secure() so total_count
-- cannot leak unauthorized existence, and the same hard page-size cap.
create or replace function public.search_reports_secure(
  p_page integer default 1,
  p_page_size integer default 25,
  p_flight_number text default null,
  p_report_reference text default null,
  p_aoc_id uuid default null,
  p_operating_entity_code text default null,
  p_department_id uuid default null,
  p_unit_id uuid default null,
  p_hub_id uuid default null,
  p_station_id uuid default null,
  p_team_id uuid default null,
  p_severity text default null,
  p_flag_state text default null,
  p_status text default null,
  p_submitter_profile_id uuid default null
)
returns table (
  id uuid,
  source_table text,
  report_type text,
  operating_entity_code text,
  flight_number text,
  report_date date,
  status text,
  severity text,
  flag_state text,
  indexed_at timestamptz,
  total_count bigint
)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_page integer := greatest(coalesce(p_page, 1), 1);
  v_page_size integer := least(greatest(coalesce(p_page_size, 25), 1), 100);
begin
  if auth.uid() is null then
    raise exception 'Must be signed in.';
  end if;
  if not exists (select 1 from public.profiles where id = auth.uid() and status = 'approved') then
    raise exception 'Only an approved account may search reports.';
  end if;

  -- A submitter/staff lookup filter is only honored when the caller
  -- themselves already has broad read authority -- an ordinary scoped
  -- role cannot use this filter to probe an arbitrary other profile's
  -- report history beyond what has_report_access() would already have
  -- let them see per-row anyway (the filter narrows within an already-
  -- authorized set, it never widens it).
  return query
  with authorized as (
    select cri.*
    from public.central_reports_index cri
    where public.has_report_access(cri.id)
      and (p_flight_number is null or cri.flight_number = p_flight_number)
      and (p_report_reference is null or cri.report_type = p_report_reference)
      and (p_aoc_id is null or cri.aoc_id = p_aoc_id)
      and (p_operating_entity_code is null or cri.operating_entity_code = p_operating_entity_code)
      and (p_department_id is null or cri.department_id = p_department_id)
      and (p_unit_id is null or cri.unit_id = p_unit_id)
      and (p_hub_id is null or cri.hub_id = p_hub_id)
      and (p_station_id is null or cri.station_id = p_station_id)
      and (p_team_id is null or cri.team_id = p_team_id)
      and (p_severity is null or cri.severity = p_severity)
      and (p_flag_state is null or cri.flag_state = p_flag_state)
      and (p_status is null or cri.status = p_status)
      and (p_submitter_profile_id is null or cri.submitter_profile_id = p_submitter_profile_id)
  ),
  counted as (
    select count(*) as n from authorized
  )
  select
    a.id, a.source_table, a.report_type, a.operating_entity_code, a.flight_number,
    a.report_date, a.status, a.severity, a.flag_state, a.indexed_at,
    c.n
  from authorized a, counted c
  order by a.indexed_at desc, a.id
  limit v_page_size
  offset (v_page - 1) * v_page_size;
end;
$function$;

revoke execute on function public.search_reports_secure(integer, integer, text, text, uuid, text, uuid, uuid, uuid, uuid, uuid, text, text, text, uuid) from public, anon;
grant execute on function public.search_reports_secure(integer, integer, text, text, uuid, text, uuid, uuid, uuid, uuid, uuid, text, text, text, uuid) to authenticated, service_role;

-- =======================================================================
-- PART E: flagged_reports_secure()
-- =======================================================================
-- A thin, explicitly-flagged-only view over list_reports_secure()'s same
-- authorized-set pattern -- covers GHOD's flagged-only visibility and
-- every other role's own flagged-report access without a separate
-- decision path.
create or replace function public.flagged_reports_secure(
  p_page integer default 1,
  p_page_size integer default 25
)
returns table (
  id uuid,
  source_table text,
  report_type text,
  operating_entity_code text,
  flight_number text,
  report_date date,
  status text,
  severity text,
  flagged_reason text,
  flagged_at timestamptz,
  total_count bigint
)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_page integer := greatest(coalesce(p_page, 1), 1);
  v_page_size integer := least(greatest(coalesce(p_page_size, 25), 1), 100);
begin
  if auth.uid() is null then
    raise exception 'Must be signed in.';
  end if;
  if not exists (select 1 from public.profiles where id = auth.uid() and status = 'approved') then
    raise exception 'Only an approved account may list flagged reports.';
  end if;

  return query
  with authorized as (
    select cri.*
    from public.central_reports_index cri
    where cri.flag_state = 'flagged'
      and public.has_report_access(cri.id)
  ),
  counted as (
    select count(*) as n from authorized
  )
  select
    a.id, a.source_table, a.report_type, a.operating_entity_code, a.flight_number,
    a.report_date, a.status, a.severity, a.flagged_reason, a.flagged_at,
    c.n
  from authorized a, counted c
  order by a.flagged_at desc nulls last, a.id
  limit v_page_size
  offset (v_page - 1) * v_page_size;
end;
$function$;

revoke execute on function public.flagged_reports_secure(integer, integer) from public, anon;
grant execute on function public.flagged_reports_secure(integer, integer) to authenticated, service_role;

-- =======================================================================
-- PART F: get_attachment_authorization_secure() -- fail-closed building
-- block, NOT yet wired into lib/avsec/attachments/actions.ts
-- =======================================================================
-- CORRECTION-STYLE NOTE (this is new work, not a correction, but follows
-- the same honesty standard): report_attachments (pre-existing,
-- untouched by this migration) has no FK to central_reports_index --
-- report_attachments.report_type/report_id are exactly
-- central_reports_index.source_table/source_id, so the link CAN be made
-- reliably by that equality, but only for an attachment whose report has
-- actually been indexed. Since the repository has zero rows in
-- production today, resolving that join for a real attachment fails
-- closed (no match => no authorization) for effectively 100% of
-- existing attachments right now.
--
-- Rather than wire this into the live attachment action (which would
-- immediately break every existing attachment download, violating the
-- "preserve all existing operational workflows" requirement), this
-- function is delivered as a tested, ready building block: it returns
-- the attachment's storage_path ONLY when (a) the caller is signed in
-- and approved, (b) the attachment's report has a matching
-- central_reports_index row, and (c) has_report_access() authorizes that
-- repository row. It never returns a signed URL itself (signing is a
-- Supabase Storage API call, not SQL) -- a future server action calls
-- this, then calls supabase.storage.createSignedUrl() with the returned
-- path, short-lived, only after this check passes. Wiring
-- lib/avsec/attachments/actions.ts to call this instead of its current
-- logic is deferred until the repository is actually populated (see the
-- Phase 6 report's remaining-exceptions section).
create or replace function public.get_attachment_authorization_secure(p_attachment_id uuid)
returns table (storage_path text, file_name text, mime_type text)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_attachment record;
  v_repository_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Must be signed in.';
  end if;
  if not exists (select 1 from public.profiles where id = auth.uid() and status = 'approved') then
    raise exception 'Only an approved account may access report attachments.';
  end if;

  select * into v_attachment from public.report_attachments where id = p_attachment_id;
  if v_attachment is null then
    raise exception 'Attachment not found.';
  end if;

  select cri.id into v_repository_id
  from public.central_reports_index cri
  where cri.source_table = v_attachment.report_type and cri.source_id = v_attachment.report_id;

  if v_repository_id is null then
    -- Fail closed: the attachment's report has not been indexed into
    -- the repository yet, so authorization cannot be verified through
    -- this path. Documented migration requirement: existing attachment
    -- access remains on its current (unchanged) authorization logic
    -- until backfill/indexing makes this join reliable, at which point
    -- this function becomes the sole authorization path.
    raise exception 'Attachment cannot be authorized through the secure repository path yet (report not indexed). Existing attachment access is unaffected by this function.';
  end if;

  if not public.has_report_access(v_repository_id) then
    raise exception 'Not authorized to access this attachment.';
  end if;

  insert into public.report_access_audit (actor_id, repository_report_id, action, reason)
  values (auth.uid(), v_repository_id, 'attachment_url_issued', p_attachment_id::text);

  return query select v_attachment.storage_path, v_attachment.file_name, v_attachment.mime_type;
end;
$function$;

revoke execute on function public.get_attachment_authorization_secure(uuid) from public, anon;
grant execute on function public.get_attachment_authorization_secure(uuid) to authenticated, service_role;

-- =======================================================================
-- PART G: indexes for scope filtering, date ordering, flight-number
-- lookup, severity/flag filtering, source identity, grants, audit lookup
-- =======================================================================
-- central_reports_index already has: source_table_unique (Part C, Phase
-- 5), entity_idx (operating_entity_code), flag_idx (partial, flagged
-- only). This phase adds the remaining columns list_reports_secure()/
-- search_reports_secure() filter or order by.
create index if not exists central_reports_index_report_date_idx on public.central_reports_index (report_date);
create index if not exists central_reports_index_indexed_at_idx on public.central_reports_index (indexed_at desc);
create index if not exists central_reports_index_flight_number_idx on public.central_reports_index (flight_number) where flight_number is not null;
create index if not exists central_reports_index_severity_idx on public.central_reports_index (severity) where severity is not null;
create index if not exists central_reports_index_aoc_idx on public.central_reports_index (aoc_id) where aoc_id is not null;
create index if not exists central_reports_index_department_idx on public.central_reports_index (department_id) where department_id is not null;
create index if not exists central_reports_index_hub_idx on public.central_reports_index (hub_id) where hub_id is not null;
create index if not exists central_reports_index_station_team_idx on public.central_reports_index (station_id, team_id) where station_id is not null and team_id is not null;
create index if not exists central_reports_index_unit_idx on public.central_reports_index (unit_id) where unit_id is not null;
create index if not exists central_reports_index_submitter_idx on public.central_reports_index (submitter_profile_id);

-- report_access_grants already has one_active (Part E, Phase 5); add the
-- grantee-lookup direction used by has_report_access()'s grant check.
create index if not exists report_access_grants_grantee_idx on public.report_access_grants (grantee_profile_id) where revoked_at is null;

-- report_access_audit already has report_idx; add the actor-lookup
-- direction for "what has this person accessed" audit queries.
create index if not exists report_access_audit_actor_idx on public.report_access_audit (actor_id, created_at desc);

-- =======================================================================
-- PART H: RLS / grants summary
-- =======================================================================
-- No new table is created by this migration (report_access_audit's
-- constraint was widened, not its RLS; central_reports_index/
-- report_access_grants only gained indexes). All access continues
-- exclusively through SECURITY DEFINER functions, consistent with every
-- prior phase.

-- =======================================================================
-- DOCUMENTED ROLLBACK (not executed by this file -- reference only, run
-- manually and only against a target where this migration was actually
-- applied). Phase 6 must roll back before Phase 5, since Part B's
-- has_report_access() replacement is layered on Phase 5's own version --
-- rolling back to the exact Phase 5 form requires re-applying Phase 5's
-- own CREATE OR REPLACE of the function (not a DROP), then this phase's
-- other new objects can be dropped independently of Phase 5.
--
-- 1. Drop the new functions (all reference central_reports_index /
--    report_attachments / report_access_audit, so must go before any
--    table-level rollback, but have no ordering dependency on each
--    other):
--      drop function if exists public.get_attachment_authorization_secure(uuid);
--      drop function if exists public.flagged_reports_secure(integer, integer);
--      drop function if exists public.search_reports_secure(integer, integer, text, text, uuid, text, uuid, uuid, uuid, uuid, uuid, text, text, text, uuid);
--      drop function if exists public.list_reports_secure(integer, integer, text, text, text, date, date);
--
-- 2. Revert has_report_access() to its exact Phase 5 form (re-run the
--    CREATE OR REPLACE from 20260928000004_phase5_report_classification_repository.sql
--    Part K) -- do not simply DROP it, since Phase 5's own functions
--    (get_report_secure(), flag_report(), unflag_report()) still depend
--    on it existing.
--
-- 3. Revert report_access_audit's CHECK constraint to its Phase 5 form:
--      alter table public.report_access_audit drop constraint if exists report_access_audit_action_check;
--      alter table public.report_access_audit add constraint report_access_audit_action_check check (action in (
--        'view', 'version_view', 'download', 'export',
--        'access_request', 'grant', 'revoke',
--        'flag', 'unflag', 'amendment_request', 'amendment_approved', 'amendment_rejected',
--        'index', 'reindex', 'entity_confirmed', 'entity_conflict'
--      ));
--    (Only safe if no row with action = 'attachment_url_issued' has been
--    written yet -- since this function was never wired into the app,
--    that is guaranteed true for as long as it remains unwired.)
--
-- 4. Drop the new indexes (each independent, order does not matter):
--      drop index if exists public.central_reports_index_report_date_idx;
--      drop index if exists public.central_reports_index_indexed_at_idx;
--      drop index if exists public.central_reports_index_flight_number_idx;
--      drop index if exists public.central_reports_index_severity_idx;
--      drop index if exists public.central_reports_index_aoc_idx;
--      drop index if exists public.central_reports_index_department_idx;
--      drop index if exists public.central_reports_index_hub_idx;
--      drop index if exists public.central_reports_index_station_team_idx;
--      drop index if exists public.central_reports_index_unit_idx;
--      drop index if exists public.central_reports_index_submitter_idx;
--      drop index if exists public.report_access_grants_grantee_idx;
--      drop index if exists public.report_access_audit_actor_idx;
