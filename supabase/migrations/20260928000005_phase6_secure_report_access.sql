-- PHASE 6 -- SECURE REPORT ACCESS, SEARCH, AUDIT AND ATTACHMENTS (2026-09-28)
--
-- Additive only, same guarantee as Phases 2-5: no existing table/column/
-- function/grant this migration does not explicitly name is touched. This
-- migration extends Phase 5's central decision function
-- (has_report_access(), CREATE OR REPLACE, additive superset of its
-- existing branches) and adds new secure list/search/flagged-report RPCs,
-- version/amendment/dashboard/export RPCs, an attachment authorization
-- path, and extends the existing report_access_audit action list.
--
-- CORRECTION (review round 2): round 1 delivered this schema/RPC layer
-- but deferred ALL application-code wiring, reasoning that the
-- repository is empty in every environment today. The reviewer's
-- correction is accepted: zero live rows is a ROLLOUT dependency, not an
-- implementation blocker -- application code is corrected in this round
-- to call these RPCs unconditionally (no legacy-read fallback), so it is
-- ready the moment the repository is populated. See the Phase 6 report
-- for the exact list of files changed and the few still-justified
-- exceptions.
--
-- Covers:
--   Part A: report_access_audit action list extended further, plus an
--           additive access_reason column recording which branch of
--           has_report_access() authorized the read
--   Part B: has_report_access() v2 -- unchanged from round 1
--   Part C: list_reports_secure() -- unchanged from round 1
--   Part D: search_reports_secure() -- unchanged from round 1
--   Part E: flagged_reports_secure() -- unchanged from round 1
--   Part F: get_attachment_authorization_secure() -- unchanged from
--           round 1; now actually wired into
--           lib/avsec/attachments/actions.ts this round
--   Part G: indexes -- unchanged from round 1
--   Part H: RLS / grants summary
--   Part I: resolve_report_access_reason() -- mirrors
--           has_report_access()'s branch order, returns which reason
--           matched, for audit recording
--   Part J: get_report_secure() v2 -- CREATE OR REPLACE of Phase 5's
--           version: writes 'detail_view' (not 'view'), records
--           access_reason and grant_id
--   Part K: get_report_version_content_secure(),
--           get_report_amendments_secure(),
--           get_access_request_status_secure()
--   Part L: get_report_dashboard_aggregate_secure() -- coarse,
--           role-scoped counts only, never individual-report
--           reconstruction
--   Part M: sanitize_csv_value(), export_reports_secure() -- capped,
--           audited, formula-injection-neutralized
--   Part N: authorize_report_pdf_secure()
--
-- MANDATORY DEPLOYMENT DEPENDENCY (unchanged): the Central Reporting
-- Repository has zero rows in production today. Every RPC in this
-- migration and every application-code path now wired to it will
-- correctly return "not found"/empty results for real users until the
-- Phase 2-6 migrations are applied, Phase 3/4 role assignments are
-- activated, and the backfill/indexing queue actually populates the
-- repository (see the Phase 6 report's deployment sequencing section).
-- This is intentional fail-closed behavior, not a defect.

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

-- PART C/D (list_reports_secure()/search_reports_secure()) are defined
-- once, below, as v2 (Part R) -- the atomic, content-returning version.
-- An intermediate non-atomic v1 was drafted and superseded within this
-- same round before being committed to this file, so there is exactly
-- one CREATE OR REPLACE of each in this migration, not two.
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
-- PART I: report_access_audit extended further -- access_reason column,
-- widened action list
-- =======================================================================
-- Additive column: records WHICH branch of has_report_access() (or
-- "grant:<uuid>") authorized a given read, alongside the existing
-- grant_id FK for the explicit-grant case specifically. Every existing
-- row (there are none yet in any real database) is unaffected -- the
-- column is nullable.
alter table public.report_access_audit add column if not exists access_reason text;

alter table public.report_access_audit drop constraint if exists report_access_audit_action_check;
alter table public.report_access_audit add constraint report_access_audit_action_check check (action in (
  'view', 'version_view', 'download', 'export',
  'access_request', 'grant', 'revoke',
  'flag', 'unflag', 'amendment_request', 'amendment_approved', 'amendment_rejected',
  'index', 'reindex', 'entity_confirmed', 'entity_conflict',
  'attachment_url_issued',
  'detail_view', 'amendment_view', 'pdf_generated', 'pdf_downloaded',
  'export_generated', 'explicit_grant_used', 'unauthorized_attempt'
));
-- Authenticated clients cannot INSERT/UPDATE/DELETE this table directly
-- at all -- Phase 5's Part O already revoked ALL table-level privilege
-- from anon/authenticated and granted only to service_role; every write
-- happens exclusively inside a SECURITY DEFINER function. This migration
-- does not alter that grant, so the guarantee is unchanged.

-- =======================================================================
-- PART J: resolve_report_access_reason() and get_report_secure() v2
-- =======================================================================
-- Mirrors has_report_access()'s exact branch order and returns a short
-- code identifying which branch matched, or null if none did (the
-- caller of this function has already separately confirmed
-- has_report_access() is true before ever calling this -- it is a
-- reason-lookup, not an authorization decision in its own right, and is
-- therefore NOT a second, divergent copy of the access rules: it shares
-- the same underlying has_role_in_scope()/has_active_role() calls and
-- the same column comparisons, in the same order, so the two can never
-- disagree about whether access exists -- only about WHY.
create or replace function public.resolve_report_access_reason(p_repository_report_id uuid)
returns text
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_report record;
  v_grant_id uuid;
begin
  select * into v_report from public.central_reports_index where id = p_repository_report_id;
  if v_report is null then
    return null;
  end if;

  if v_report.submitter_profile_id = auth.uid() then
    return 'submitter';
  end if;
  if public.has_active_role('global_reporting_controller') then
    return 'global_reporting_controller';
  end if;
  if v_report.flag_state = 'flagged' and public.has_active_role('ghod') then
    return 'ghod_flagged';
  end if;
  if v_report.operating_entity_code = 'MAA' and public.has_active_role('maa_boss') then
    return 'maa_boss';
  end if;
  if v_report.operating_entity_code = 'AAX' and public.has_active_role('aax_boss') then
    return 'aax_boss';
  end if;
  if v_report.aoc_id is not null and public.has_role_in_scope('main_enforcement', v_report.aoc_id) then
    return 'main_enforcement';
  end if;
  if v_report.aoc_id is not null and public.has_role_in_scope('compliance', v_report.aoc_id) then
    return 'compliance';
  end if;
  if v_report.aoc_id is not null and (
    public.has_role_in_scope('investigation_sso', v_report.aoc_id)
    or public.has_role_in_scope('investigation_so', v_report.aoc_id)
    or public.has_role_in_scope('investigation_aso', v_report.aoc_id)
  ) then
    return 'investigation';
  end if;
  if v_report.aoc_id is not null and v_report.department_id is not null
    and public.has_role_in_scope('operation_manager', v_report.aoc_id, null, v_report.department_id) then
    return 'operation_manager';
  end if;
  if v_report.aoc_id is not null and v_report.hub_id is not null
    and public.has_role_in_scope('hub_se', v_report.aoc_id, null, null, null, v_report.hub_id) then
    return 'hub_se';
  end if;
  if v_report.aoc_id is not null and v_report.team_id is not null
    and public.has_role_in_scope('dse', v_report.aoc_id, null, null, null, null, null, v_report.team_id) then
    return 'dse';
  end if;
  if v_report.aoc_id is not null and v_report.station_id is not null and v_report.team_id is not null and (
    public.has_role_in_scope('sso', v_report.aoc_id, null, null, null, null, v_report.station_id, v_report.team_id)
    or public.has_role_in_scope('so', v_report.aoc_id, null, null, null, null, v_report.station_id, v_report.team_id)
    or public.has_role_in_scope('aso', v_report.aoc_id, null, null, null, null, v_report.station_id, v_report.team_id)
  ) then
    return 'station_team_role';
  end if;
  if v_report.aoc_id is not null and v_report.unit_id is not null and v_report.hub_id is not null
    and public.has_role_in_scope('sat_aso', v_report.aoc_id, null, null, v_report.unit_id, v_report.hub_id) then
    return 'sat_aso';
  end if;
  if v_report.aoc_id is not null and v_report.unit_id is not null and (
    public.has_role_in_scope('profiling_so', v_report.aoc_id, null, null, v_report.unit_id)
    or public.has_role_in_scope('profiling_aso', v_report.aoc_id, null, null, v_report.unit_id)
  ) then
    return 'profiling';
  end if;

  select g.id into v_grant_id
  from public.report_access_grants g
  where g.repository_report_id = p_repository_report_id
    and g.grantee_profile_id = auth.uid()
    and g.revoked_at is null
    and g.starts_at <= now()
    and (g.expires_at is null or g.expires_at > now())
  limit 1;
  if v_grant_id is not null then
    return 'explicit_grant:' || v_grant_id::text;
  end if;

  return null;
end;
$function$;

revoke execute on function public.resolve_report_access_reason(uuid) from public, anon;
grant execute on function public.resolve_report_access_reason(uuid) to authenticated, service_role;

-- get_report_secure() itself is defined once, below, as v3 (Part Q) --
-- the atomic, content-returning version. An intermediate v2 (metadata-
-- only, matching Phase 5's original shape) was drafted and superseded
-- within this same round before being committed to this file, so there
-- is exactly one CREATE OR REPLACE of it in this migration, not two.

-- =======================================================================
-- PART K: version content, amendments, access-request status
-- =======================================================================
-- get_report_version_content_secure(): returns a SPECIFIC version's own
-- content (report_versions.amended_content etc.), never more than
-- get_report_secure() would already authorize for the CURRENT report --
-- authorization is the identical has_report_access() call against the
-- same repository id, so a version can never reveal content for a
-- report the caller cannot otherwise access. Audited as 'version_view'.
create or replace function public.get_report_version_content_secure(
  p_repository_report_id uuid,
  p_version_number integer
)
returns table (
  version_number integer,
  amendment_type text,
  reason text,
  requested_by uuid,
  approved_by uuid,
  effective_status text,
  amended_content jsonb,
  supersedes_version integer,
  created_at timestamptz,
  decided_at timestamptz
)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_caller_status text;
begin
  if auth.uid() is null then
    raise exception 'Must be signed in.';
  end if;
  select status into v_caller_status from public.profiles where id = auth.uid();
  if v_caller_status is distinct from 'approved' then
    raise exception 'Only an approved account may access report content.';
  end if;
  if not public.has_report_access(p_repository_report_id) then
    insert into public.report_access_audit (actor_id, repository_report_id, action, reason)
    values (auth.uid(), p_repository_report_id, 'unauthorized_attempt', 'get_report_version_content_secure');
    raise exception 'Not authorized to access this report.';
  end if;
  if not exists (select 1 from public.report_versions rv where rv.repository_report_id = p_repository_report_id and rv.version_number = p_version_number) then
    raise exception 'Requested version % does not exist for this report.', p_version_number;
  end if;

  insert into public.report_access_audit (actor_id, repository_report_id, version_number, action, access_reason)
  values (auth.uid(), p_repository_report_id, p_version_number, 'version_view', public.resolve_report_access_reason(p_repository_report_id));

  return query
  select rv.version_number, rv.amendment_type, rv.reason, rv.requested_by, rv.approved_by,
    rv.effective_status, rv.amended_content, rv.supersedes_version, rv.created_at, rv.decided_at
  from public.report_versions rv
  where rv.repository_report_id = p_repository_report_id and rv.version_number = p_version_number;
end;
$function$;

revoke execute on function public.get_report_version_content_secure(uuid, integer) from public, anon;
grant execute on function public.get_report_version_content_secure(uuid, integer) to authenticated, service_role;

-- get_report_amendments_secure(): lists every version (including
-- pending ones) for a report the caller can access -- pending status is
-- returned as data (effective_status='pending'), never treated as
-- current/effective by any consumer; no approval/rejection function is
-- added here or anywhere in this migration, matching Phase 5's explicit
-- "no approver role invented yet" decision. Audited once as
-- 'amendment_view' per call (not per row).
create or replace function public.get_report_amendments_secure(p_repository_report_id uuid)
returns table (
  version_number integer,
  amendment_type text,
  reason text,
  requested_by uuid,
  effective_status text,
  supersedes_version integer,
  created_at timestamptz
)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_caller_status text;
begin
  if auth.uid() is null then
    raise exception 'Must be signed in.';
  end if;
  select status into v_caller_status from public.profiles where id = auth.uid();
  if v_caller_status is distinct from 'approved' then
    raise exception 'Only an approved account may access report content.';
  end if;
  if not public.has_report_access(p_repository_report_id) then
    insert into public.report_access_audit (actor_id, repository_report_id, action, reason)
    values (auth.uid(), p_repository_report_id, 'unauthorized_attempt', 'get_report_amendments_secure');
    raise exception 'Not authorized to access this report.';
  end if;

  insert into public.report_access_audit (actor_id, repository_report_id, action, access_reason)
  values (auth.uid(), p_repository_report_id, 'amendment_view', public.resolve_report_access_reason(p_repository_report_id));

  return query
  select rv.version_number, rv.amendment_type, rv.reason, rv.requested_by, rv.effective_status, rv.supersedes_version, rv.created_at
  from public.report_versions rv
  where rv.repository_report_id = p_repository_report_id
  order by rv.version_number;
end;
$function$;

revoke execute on function public.get_report_amendments_secure(uuid) from public, anon;
grant execute on function public.get_report_amendments_secure(uuid) to authenticated, service_role;

-- get_access_request_status_secure(): a requester may check their own
-- request's status; the Global Reporting Controller may check any.
-- Never lists other people's requests to an ordinary caller.
create or replace function public.get_access_request_status_secure(p_request_id uuid)
returns table (
  id uuid,
  repository_report_id uuid,
  status text,
  reviewed_by uuid,
  reviewed_at timestamptz,
  decision_reason text
)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_request record;
begin
  if auth.uid() is null then
    raise exception 'Must be signed in.';
  end if;
  select * into v_request from public.report_access_requests where id = p_request_id;
  if v_request is null then
    raise exception 'Access request not found.';
  end if;
  if v_request.requester_id <> auth.uid() and not public.has_active_role('global_reporting_controller') then
    raise exception 'Not authorized to view this access request.';
  end if;

  return query
  select v_request.id, v_request.repository_report_id, v_request.status, v_request.reviewed_by, v_request.reviewed_at, v_request.decision_reason;
end;
$function$;

revoke execute on function public.get_access_request_status_secure(uuid) from public, anon;
grant execute on function public.get_access_request_status_secure(uuid) to authenticated, service_role;

-- =======================================================================
-- PART L: get_report_dashboard_aggregate_secure() -- coarse, role-scoped
-- counts only
-- =======================================================================
-- Groups the authorized set by one coarse, fixed dimension -- never by a
-- combination fine enough to reconstruct an individual report (e.g.
-- never by exact date+station+team together, which could isolate a
-- single row). Not audited per call -- this is the explicit "aggregate
-- refreshes must not flood detail-access auditing" requirement; nothing
-- about an aggregate count is a "detail" access.
--
-- CORRECTION (review round 4): aggregate visibility must be independent
-- of per-report DETAIL permission -- AirAsia Management (and GHOD/GRC,
-- who already have detail access but should see the true global total
-- regardless) must receive real dashboard totals even though
-- airasia_management never appears in has_report_access() at all (by
-- design, Phase 5 Part K -- "executive aggregates are a separate ...
-- dashboard RPC, never a per-report grant"). Filtering this function's
-- counts through has_report_access() for those roles would silently
-- return zero for airasia_management forever, which is not "aggregate-
-- only access" -- it is a different, broader, and INTENTIONAL
-- authorization path specific to counts, never to row identity/content
-- (this function returns group_value + report_count only, never an id,
-- never content). Every other caller's counts remain has_report_access()
-- -scoped exactly as before -- this only WIDENS the three named
-- aggregate-dashboard roles' count visibility, never any role's access
-- to individual report detail.
create or replace function public.get_report_dashboard_aggregate_secure(p_group_by text default 'source_table')
returns table (
  group_value text,
  report_count bigint
)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_global boolean;
begin
  if auth.uid() is null then
    raise exception 'Must be signed in.';
  end if;
  if not exists (select 1 from public.profiles where id = auth.uid() and status = 'approved') then
    raise exception 'Only an approved account may view dashboard aggregates.';
  end if;
  if p_group_by not in ('source_table', 'flag_state', 'status', 'severity', 'operating_entity_code') then
    raise exception 'Unsupported group_by dimension.';
  end if;

  v_global := public.has_active_role('airasia_management')
    or public.has_active_role('ghod')
    or public.has_active_role('global_reporting_controller');

  return query
  select
    case p_group_by
      when 'source_table' then cri.source_table
      when 'flag_state' then cri.flag_state
      when 'status' then cri.status
      when 'severity' then coalesce(cri.severity, '(none)')
      when 'operating_entity_code' then coalesce(cri.operating_entity_code, '(unclassified)')
    end as group_value,
    count(*) as report_count
  from public.central_reports_index cri
  where v_global or public.has_report_access(cri.id)
  group by 1;
end;
$function$;

revoke execute on function public.get_report_dashboard_aggregate_secure(text) from public, anon;
grant execute on function public.get_report_dashboard_aggregate_secure(text) to authenticated, service_role;

-- =======================================================================
-- PART M: sanitize_csv_value(), export_reports_secure()
-- =======================================================================
-- Neutralizes CSV/spreadsheet formula injection: a leading '=', '+',
-- '-', '@', tab, or carriage return is prefixed with a single quote,
-- which every common spreadsheet application (Excel, Google Sheets,
-- LibreOffice) treats as "force text" rather than evaluating the cell
-- as a formula. Applied to every text field this migration's export
-- path returns.
create or replace function public.sanitize_csv_value(p_value text)
returns text
language sql
immutable
security definer
set search_path to 'public'
as $function$
  select case
    when p_value is null then null
    when p_value ~ '^[=+\-@\t\r]' then '''' || p_value
    else p_value
  end;
$function$;

revoke execute on function public.sanitize_csv_value(text) from public, anon;
grant execute on function public.sanitize_csv_value(text) to authenticated, service_role;

-- export_reports_secure(): mirrors search_reports_secure()'s filter set
-- and authorization exactly (same authorized-first CTE), with a hard row
-- cap (p_max_rows, itself capped at 5000 regardless of what is
-- requested) and exactly ONE audit row per call ('export_generated'),
-- never one per exported row. Every text field is passed through
-- sanitize_csv_value(). This returns the repository's own classification/
-- identity fields (the same fields list/search already expose) -- full
-- per-report-type original content (station/team/remark/etc., which
-- differs per source table) is NOT included here; see the Phase 6 report
-- for why a unified full-content export across 7 differently-shaped
-- source tables is a separate, larger follow-on task.
create or replace function public.export_reports_secure(
  p_max_rows integer default 1000,
  p_flight_number text default null,
  p_aoc_id uuid default null,
  p_operating_entity_code text default null,
  p_department_id uuid default null,
  p_hub_id uuid default null,
  p_station_id uuid default null,
  p_team_id uuid default null,
  p_severity text default null,
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
  flag_state text
)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_max_rows integer := least(greatest(coalesce(p_max_rows, 1000), 1), 5000);
  v_row_count integer;
begin
  if auth.uid() is null then
    raise exception 'Must be signed in.';
  end if;
  if not exists (select 1 from public.profiles where id = auth.uid() and status = 'approved') then
    raise exception 'Only an approved account may export reports.';
  end if;

  create temporary table if not exists tmp_export_result on commit drop as
  select
    cri.id, cri.source_table, public.sanitize_csv_value(cri.report_type) as report_type,
    public.sanitize_csv_value(cri.operating_entity_code) as operating_entity_code,
    public.sanitize_csv_value(cri.flight_number) as flight_number,
    cri.report_date, cri.status, cri.severity, cri.flag_state
  from public.central_reports_index cri
  where public.has_report_access(cri.id)
    and (p_flight_number is null or cri.flight_number = p_flight_number)
    and (p_aoc_id is null or cri.aoc_id = p_aoc_id)
    and (p_operating_entity_code is null or cri.operating_entity_code = p_operating_entity_code)
    and (p_department_id is null or cri.department_id = p_department_id)
    and (p_hub_id is null or cri.hub_id = p_hub_id)
    and (p_station_id is null or cri.station_id = p_station_id)
    and (p_team_id is null or cri.team_id = p_team_id)
    and (p_severity is null or cri.severity = p_severity)
    and (p_flag_state is null or cri.flag_state = p_flag_state)
    and (p_status is null or cri.status = p_status)
    and (p_from_date is null or cri.report_date >= p_from_date)
    and (p_to_date is null or cri.report_date <= p_to_date)
  order by cri.indexed_at desc, cri.id
  limit v_max_rows;

  select count(*) into v_row_count from tmp_export_result;

  insert into public.report_access_audit (actor_id, action, reason)
  values (auth.uid(), 'export_generated', format('rows=%s max_rows=%s', v_row_count, v_max_rows));

  return query select * from tmp_export_result;
end;
$function$;

revoke execute on function public.export_reports_secure(integer, text, uuid, text, uuid, uuid, uuid, uuid, text, text, text, date, date) from public, anon;
grant execute on function public.export_reports_secure(integer, text, uuid, text, uuid, uuid, uuid, uuid, text, text, text, date, date) to authenticated, service_role;

-- =======================================================================
-- PART N: authorize_report_pdf_secure()
-- =======================================================================
-- A thin authorization+audit wrapper: confirms has_report_access(),
-- writes a 'pdf_generated' audit row, and returns the same minimal
-- metadata get_report_secure() returns -- application code calls this
-- immediately before rendering a PDF, using ONLY the returned metadata
-- (and, for the source content itself, the existing per-type getReportById
-- read -- unchanged -- gated by this same authorization check having
-- already passed). No arbitrary report id bypasses this: the function
-- takes a repository id and re-derives everything from
-- central_reports_index, never a client-supplied source table/id pair
-- for a different report than the one authorized. CaterLink's own
-- final-transaction PDFs are a completely separate domain (icms_*
-- tables) and are never referenced by this function.
create or replace function public.authorize_report_pdf_secure(p_repository_report_id uuid)
returns table (
  source_table text,
  source_id uuid,
  report_type text
)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_caller_status text;
begin
  if auth.uid() is null then
    raise exception 'Must be signed in.';
  end if;
  select status into v_caller_status from public.profiles where id = auth.uid();
  if v_caller_status is distinct from 'approved' then
    raise exception 'Only an approved account may generate report PDFs.';
  end if;
  if not public.has_report_access(p_repository_report_id) then
    insert into public.report_access_audit (actor_id, repository_report_id, action, reason)
    values (auth.uid(), p_repository_report_id, 'unauthorized_attempt', 'authorize_report_pdf_secure');
    raise exception 'Not authorized to generate a PDF for this report.';
  end if;

  insert into public.report_access_audit (actor_id, repository_report_id, action, access_reason)
  values (auth.uid(), p_repository_report_id, 'pdf_generated', public.resolve_report_access_reason(p_repository_report_id));

  return query
  select cri.source_table, cri.source_id, cri.report_type
  from public.central_reports_index cri
  where cri.id = p_repository_report_id;
end;
$function$;

revoke execute on function public.authorize_report_pdf_secure(uuid) from public, anon;
grant execute on function public.authorize_report_pdf_secure(uuid) to authenticated, service_role;

-- =======================================================================
-- CORRECTION (review round 3): remove the two-step pattern; close direct
-- source-table SELECT access; atomic secure content-returning RPCs
-- =======================================================================
-- ROOT CAUSE: round 2's "authorize via RPC, then .in(\"id\", ids)"
-- pattern was not a durable security boundary for two independent
-- reasons: (1) the pre-existing legacy RLS policies on these 7 tables
-- (avsec/0002_rls.sql and later files) ALREADY grant broad station/
-- rank-based SELECT to `authenticated` directly -- any caller could
-- simply skip the secure RPC and query report_sec016 etc. themselves,
-- getting the same or MORE rows than the "authorized" id set; (2) even
-- ignoring that, authorization and content retrieval happened in two
-- separate statements, so a revoked grant/ended assignment between them
-- could -- in principle -- authorize against a stale decision.
--
-- FIX, in two parts:
--   Part O: the legacy broad SELECT policies (station-wide / rank-based)
--           are dropped from all 7 report tables, leaving ONLY an
--           "own row" SELECT policy (needed for the INSERT ... RETURNING
--           pattern report submission already relies on) -- closing the
--           direct-read bypass at its actual source (RLS), not just in
--           application code.
--   Part P-U: every secure RPC is rewritten to be ATOMIC -- it
--           authorizes via has_report_access() AND retrieves the full
--           source-table content in the SAME function call/statement,
--           via report_source_content() (below), a single, fixed,
--           hardcoded per-table CASE (never dynamic SQL/EXECUTE/
--           format()) shared by every RPC that needs source content.
--           These functions are SECURITY DEFINER, owned by the
--           migration-applying role, which bypasses RLS -- exactly the
--           same mechanism this codebase already uses for
--           current_role_name()/current_station() (avsec/0002_rls.sql,
--           "security definer, bypass RLS to avoid recursive lookups")
--           -- so they can still read full content even with Part O's
--           narrowed policies in place, while an ordinary authenticated
--           client, without SECURITY DEFINER, cannot.

-- =======================================================================
-- PART O: close direct source-table SELECT access
-- =======================================================================
-- Every "station select" / "rank select" / "monitor select" policy ever
-- created on these 7 tables across avsec/0002, 0009, 0010, 0012, 0013,
-- 0014, 0021 is dropped (DROP POLICY IF EXISTS -- safe regardless of
-- which of them happen to still exist after that migration history's
-- own drop/recreate cycles). Only the "own row" SELECT policy remains,
-- which is both necessary (INSERT ... RETURNING requires the inserting
-- role to be able to SELECT the row it just inserted) and safe (it
-- exposes nothing has_report_access() wouldn't also grant via its own
-- "own submission" branch). INSERT and UPDATE policies are completely
-- untouched -- report creation and the existing draft-editing/
-- immutability trigger behavior are unaffected.
drop policy if exists "sec016 station select" on public.report_sec016;
drop policy if exists "sec016 monitor select" on public.report_sec016;
drop policy if exists "sec016 rank select" on public.report_sec016;
drop policy if exists "sec016 own select" on public.report_sec016;
create policy "sec016 own select" on public.report_sec016 for select using (profile_id = auth.uid());

drop policy if exists "sec014 station select" on public.report_sec014;
drop policy if exists "sec014 monitor select" on public.report_sec014;
drop policy if exists "sec014 rank select" on public.report_sec014;
drop policy if exists "sec014 own select" on public.report_sec014;
create policy "sec014 own select" on public.report_sec014 for select using (profile_id = auth.uid());

drop policy if exists "sec029 station select" on public.report_sec029;
drop policy if exists "sec029 monitor select" on public.report_sec029;
drop policy if exists "sec029 rank select" on public.report_sec029;
drop policy if exists "sec029 own select" on public.report_sec029;
create policy "sec029 own select" on public.report_sec029 for select using (profile_id = auth.uid());

drop policy if exists "sec018 station select" on public.report_sec018;
drop policy if exists "sec018 monitor select" on public.report_sec018;
drop policy if exists "sec018 rank select" on public.report_sec018;
drop policy if exists "sec018 own select" on public.report_sec018;
create policy "sec018 own select" on public.report_sec018 for select using (profile_id = auth.uid());

drop policy if exists "sec033 rank select" on public.report_sec033;
drop policy if exists "sec033 own select" on public.report_sec033;
create policy "sec033 own select" on public.report_sec033 for select using (profile_id = auth.uid());

drop policy if exists "sec013 rank select" on public.report_sec013;
drop policy if exists "sec013 own select" on public.report_sec013;
create policy "sec013 own select" on public.report_sec013 for select using (profile_id = auth.uid());

drop policy if exists "offload rank select" on public.offload_records;
drop policy if exists "offload own select" on public.offload_records;
create policy "offload own select" on public.offload_records for select using (profile_id = auth.uid());

-- Child/detail tables (patrols/items/hold_checks/profiling_duties) are
-- reached only through their parent report's own id, and their existing
-- "via parent select" policies already resolve through the SAME parent
-- row's own profile_id/station condition -- since the parent's own
-- broad access has been narrowed above. Child tables are NOT narrowed
-- transitively.
--
-- CORRECTION (review round 4): round 3's claim above -- that narrowing
-- the parent's own SELECT policy transitively narrows these child
-- policies -- was WRONG and is corrected here. Each child policy embeds
-- its OWN broad clause directly inside its EXISTS subquery
-- (`r.profile_id = auth.uid() or (is_supervisor_or_above() and
-- (is_manager_or_above() or r.station = current_station()))`), evaluated
-- against the joined parent ROW's data, not gated by the parent table's
-- RLS policy at all (an EXISTS subquery inside a policy definition does
-- not itself re-apply RLS from the outer query's perspective the way
-- application code querying the parent table would). Every one of these
-- 5 child-table policies is dropped and replaced with an own-row-only
-- equivalent, exactly mirroring Part O's own correction:
drop policy if exists "sec014_patrols via parent select" on public.report_sec014_patrols;
create policy "sec014_patrols own select" on public.report_sec014_patrols for select
  using (exists (select 1 from public.report_sec014 r where r.id = report_id and r.profile_id = auth.uid()));

drop policy if exists "sec018_patrols via parent select" on public.report_sec018_patrols;
create policy "sec018_patrols own select" on public.report_sec018_patrols for select
  using (exists (select 1 from public.report_sec018 r where r.id = report_id and r.profile_id = auth.uid()));

drop policy if exists "sec029_items via parent select" on public.report_sec029_items;
create policy "sec029_items own select" on public.report_sec029_items for select
  using (exists (select 1 from public.report_sec029 r where r.id = report_id and r.profile_id = auth.uid()));

drop policy if exists "sec033_hold_checks via parent select" on public.report_sec033_hold_checks;
create policy "sec033_hold_checks own select" on public.report_sec033_hold_checks for select
  using (exists (select 1 from public.report_sec033 r where r.id = report_id and r.profile_id = auth.uid()));

drop policy if exists "sec013_profiling_duties via parent select" on public.report_sec013_profiling_duties;
create policy "sec013_profiling_duties own select" on public.report_sec013_profiling_duties for select
  using (exists (select 1 from public.report_sec013 r where r.id = report_id and r.profile_id = auth.uid()));

drop policy if exists "offload_items via parent select" on public.offload_items;
create policy "offload_items own select" on public.offload_items for select
  using (exists (select 1 from public.offload_records r where r.id = report_id and r.profile_id = auth.uid()));
-- The "via parent write" policies on these 6 tables are untouched --
-- they already gate on `r.profile_id = auth.uid()` only (own-row write,
-- needed for report creation's own child-row inserts) and never had a
-- broad-visibility clause to begin with.

-- CORRECTION (review round 5): the own-row SELECT policies above are
-- not the real closure -- RLS is only reached if SELECT is grantable at
-- all. None of the 6 child tables' inserts are ever followed by a
-- `.select(...)` in lib/avsec/reports/actions.ts (confirmed by source
-- search: every child-row `.insert(rows)` call destructures only
-- `{ error }`), so SELECT is revoked from `authenticated` on all 6
-- child tables entirely -- no column-level re-grant needed, since
-- nothing in this codebase ever needs to read a child row back directly.
-- An authenticated owner can no longer retrieve child content (patrol
-- entries, profiling duties, hold checks, offload items) through
-- PostgREST at all; it is reachable only through report_source_content()
-- (audited detail/PDF/export/version paths), which is SECURITY DEFINER
-- and bypasses RLS/grants entirely, same as every other read in this
-- migration. INSERT is completely untouched, so child-row creation
-- during report submission is unaffected.
revoke select on public.report_sec014_patrols, public.report_sec018_patrols, public.report_sec029_items, public.report_sec033_hold_checks, public.report_sec013_profiling_duties, public.offload_items from authenticated;

-- CORRECTION (review round 5): the round-4 column-level grant on the 7
-- PARENT tables (id, submitted_at, report_no) was incomplete -- it broke
-- lib/avsec/admin/actions.ts's count-only deleteUserAccount() check,
-- which filters `.eq("profile_id", profileId)`: Postgres requires
-- column-level SELECT privilege on every column referenced anywhere in
-- the query, including a WHERE/eq filter, not only columns in the
-- explicit select() list. profile_id is re-added to the grant --
-- harmless to expose (a bare foreign-key id, not content), and this is
-- the exact "count-only queries are not automatically compatible with
-- restricted SELECT grants" gap the review flagged. No other column is
-- added: content columns (remark, declaration, station, team, staff_*,
-- every type-specific field) remain unselectable by `authenticated`
-- directly, on any row, including the caller's own.
do $$
declare
  v_table text;
begin
  foreach v_table in array array[
    'report_sec013', 'report_sec014', 'report_sec016', 'report_sec018',
    'report_sec029', 'report_sec033', 'offload_records'
  ] loop
    execute format('revoke select on public.%I from authenticated', v_table);
    execute format('grant select (id, submitted_at, report_no, profile_id) on public.%I to authenticated', v_table);
  end loop;
end;
$$;
-- Note: the EXECUTE format(...) calls above target only fixed,
-- hardcoded literal table names from the array declared in this same
-- block -- never a client- or caller-supplied value -- so this does not
-- violate the "no arbitrary table-name dynamic SQL" requirement, which
-- concerns runtime-supplied identifiers, not a closed, migration-authored
-- allowlist.
--
-- Verified compatible with every remaining direct query against these 7
-- tables after this grant:
--   * INSERT ... RETURNING "id, submitted_at, report_no" or "id" alone
--     (every submit action, lib/avsec/reports/actions.ts) -- all 3
--     granted columns present.
--   * deleteUserAccount()'s count-only check,
--     `.select("id", { count: "exact", head: true }).eq("profile_id", profileId)`
--     (lib/avsec/admin/actions.ts) -- both id and profile_id granted;
--     COUNT itself never requires SELECT on any column beyond what the
--     query actually references.
--   * getMySubmissions()/searchByReportNoPrefix() -- no longer query
--     these tables directly at all (Part R, round 4); unaffected.
--   * Acknowledgement writes -- report_acknowledgements is a SEPARATE
--     table (avsec/0012_*.sql) with its own, untouched grants/RLS; the
--     `acknowledgement` boolean column on the 4 tables that have it is
--     written once at INSERT time only (confirmed by source search,
--     Phase 5) and never read back directly by any caller.

-- =======================================================================
-- PART P: report_source_content() -- the one shared, hardcoded,
-- allowlisted join every atomic RPC below uses
-- =======================================================================
-- Returns the FULL source row as jsonb for exactly one of the 7 allowed
-- tables, via an explicit IF/ELSIF over literal table names -- never
-- dynamic SQL, EXECUTE, or format() with a client- or caller-supplied
-- table name (mirrors index_report()'s own established pattern, Phase
-- 5 Part H). SECURITY DEFINER + table owner privilege bypasses RLS, so
-- this reads the full row regardless of Part O's narrowed policies --
-- the CALLER of this function is responsible for having already
-- authorized the read; this function performs no authorization itself,
-- by design, so it can be safely reused inside every atomic RPC below
-- without duplicating (and risking divergence in) the access decision.
create or replace function public.report_source_content(p_source_table text, p_source_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
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
    -- CORRECTION (review round 5): offload_records has its own child
    -- table (offload_items, avsec/0021_offload_module.sql) that was
    -- missed entirely in the original version of this function --
    -- an authorized viewer's version-1 snapshot and detail read would
    -- have silently omitted every offload item. Fixed the same way as
    -- the other 5 child tables.
    select coalesce(jsonb_agg(to_jsonb(c) order by c.entry_no), '[]'::jsonb) into v_children
      from public.offload_items c where c.report_id = p_source_id;
    v_content := v_content || jsonb_build_object('items', v_children);
  else
    raise exception 'Unsupported source_table: %', p_source_table;
  end if;
  return v_content;
end;
$function$;

revoke execute on function public.report_source_content(text, uuid) from public, anon, authenticated;
grant execute on function public.report_source_content(text, uuid) to service_role;
-- Deliberately service_role-only, NOT authenticated -- this function
-- performs no authorization check of its own, so it must never be
-- callable directly by a client; every atomic RPC below is itself
-- SECURITY DEFINER and calls it internally after its OWN
-- has_report_access() check, which is the only path that reaches it.

-- =======================================================================
-- PART P2: index_report() v2 -- version 1 now captures a true immutable
-- snapshot
-- =======================================================================
-- CORRECTION (review round 4): Phase 5's index_report() (unchanged until
-- now) inserted version 1's report_versions row with amended_content
-- left NULL -- version 1 was never actually a captured snapshot, only a
-- placeholder row. Since submitted-content is already frozen by
-- block_submitted_report_mutation() the moment a report is submitted,
-- this was not actively WRONG (the current source row IS the original,
-- because it can never change) -- but get_report_version_content_secure()
-- requesting version 1 explicitly would return amended_content: null,
-- not "the requested immutable snapshot," which review round 4 asked to
-- be verified. Fixed: CREATE OR REPLACE of index_report() (Phase 5,
-- 20260928000004 -- corrected here, from within Phase 6, following the
-- same pattern already used for has_report_access()/get_report_secure())
-- populates version 1's amended_content with report_source_content()'s
-- full jsonb snapshot, captured once, at indexing time, never touched
-- again (report_versions has no UPDATE path for amended_content
-- anywhere in this codebase). Every other line of index_report() is
-- unchanged from Phase 5's original.
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

  -- Version 1 = the immutable original -- now captures a real content
  -- snapshot (review round 4 correction), taken exactly once and never
  -- updated afterward.
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
  end if;

  insert into public.report_access_audit (actor_id, repository_report_id, version_number, action)
  values (p_submitter_profile_id, v_index_id, 1, 'index');

  return v_index_id;
end;
$function$;

revoke execute on function public.index_report(text, uuid, text, uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, date, uuid) from public, anon, authenticated;
grant execute on function public.index_report(text, uuid, text, uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, date, uuid) to service_role;

-- =======================================================================
-- PART Q: get_report_secure() v3 -- atomic: authorize AND return full
-- content in one call
-- =======================================================================
-- CREATE OR REPLACE of Part J's v2 (which returned central_reports_index
-- metadata only, requiring the caller to make a SECOND request for full
-- content -- exactly the two-step gap this round closes). v3 adds a
-- single `content jsonb` column carrying the full source row, obtained
-- via report_source_content() in the SAME function invocation as the
-- has_report_access() check and the audit write. There is no longer any
-- reason for application code to touch the source table directly for a
-- detail read at all.
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
  current_version integer,
  content jsonb
)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_caller_status text;
  v_version integer;
  v_reason text;
  v_grant_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Must be signed in.';
  end if;

  select status into v_caller_status from public.profiles where id = auth.uid();
  if v_caller_status is distinct from 'approved' then
    raise exception 'Only an approved account may access report content.';
  end if;

  if not public.has_report_access(p_repository_report_id) then
    insert into public.report_access_audit (actor_id, repository_report_id, action, reason)
    values (auth.uid(), p_repository_report_id, 'unauthorized_attempt', 'get_report_secure');
    raise exception 'Not authorized to access this report.';
  end if;

  v_version := coalesce(p_version_number, (select cri.current_version from public.central_reports_index cri where cri.id = p_repository_report_id));

  if not exists (select 1 from public.report_versions rv where rv.repository_report_id = p_repository_report_id and rv.version_number = v_version) then
    raise exception 'Requested version % does not exist for this report.', v_version;
  end if;

  v_reason := public.resolve_report_access_reason(p_repository_report_id);
  if v_reason like 'explicit_grant:%' then
    v_grant_id := replace(v_reason, 'explicit_grant:', '')::uuid;
  end if;

  insert into public.report_access_audit (actor_id, repository_report_id, version_number, action, access_reason, grant_id)
  values (
    auth.uid(), p_repository_report_id, v_version,
    case when p_version_number is null then 'detail_view' else 'version_view' end,
    v_reason, v_grant_id
  );

  return query
  select
    cri.id, cri.source_table, cri.source_id, cri.report_type, cri.operating_entity_code,
    h.code, s.code, t.name, cri.flight_number, cri.report_date, cri.status, cri.severity, cri.flag_state,
    v_version, cri.current_version,
    public.report_source_content(cri.source_table, cri.source_id)
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
-- PART R: report_source_summary() and list_reports_secure() /
-- search_reports_secure() v3 -- CARD FIELDS ONLY, never a full report body
-- =======================================================================
-- CORRECTION (review round 4): v2 (this round's own earlier draft, never
-- pushed) added a full `content jsonb` column to list/search results --
-- the entire source row, including remark text, evidence-adjacent
-- fields, and (via report_source_content()) child-table arrays, exposed
-- through an UNAUDITED list/search response. That over-corrects: full
-- content belongs only behind an audited detail/PDF/export/version read
-- (get_report_secure(), authorize_report_pdf_secure(),
-- export_reports_secure(), get_report_version_content_secure() -- each
-- audited, each individually authorized). list/search results now carry
-- only card-appropriate fields via a new, narrower, separate function.
--
-- report_source_summary(): the same hardcoded-per-table, no-dynamic-SQL,
-- service_role-only pattern as report_source_content(), but returns a
-- FIXED small set of display fields only -- never remark/declaration/
-- corrective_action in any form, never a truncated excerpt of them
-- either, never child-table rows, never any other content column. This
-- is the ONLY function list_reports_secure()/search_reports_secure()
-- use to add per-row display detail. See its own header comment for the
-- exact, documented field allowlist.
-- CORRECTION (review round 5): the original version of this round's own
-- draft included a remark_excerpt field, truncated to 80 chars. An
-- 80-char truncation is still free text -- the review's instruction is
-- explicit that "free-text remarks, declarations and child content must
-- remain behind audited detail access," full stop, not merely
-- shortened. The final, documented card-field allowlist below is:
--   * staff_name -- who filed the report (needed for every list/search
--     card and for "my submissions").
--   * station, team -- where/which team (needed for dashboard/shift-
--     compliance filtering and card display).
--   * secondary_identifier -- a STRUCTURED (never free-text) label
--     built only from flight number / registration / destination
--     fields, e.g. "Flight AK123 · Reg 9M-ABC" -- never touches remark/
--     declaration/corrective_action.
--   * reg_no, bay_no, sta_std -- SEC016-specific structured routing/
--     logistics fields (needed by the flight-coverage dashboard panel),
--     never free text.
--   * submitter_profile_id -- a bare id, needed for "is this my own
--     report" filtering client-side.
-- Nothing else is returned. No function anywhere in this migration
-- reads or returns remark/declaration/corrective_action outside
-- report_source_content() (the audited-path-only full-content join).
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
as $function$
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
  else
    raise exception 'Unsupported source_table: %', p_source_table;
  end if;
end;
$function$;

revoke execute on function public.report_source_summary(text, uuid) from public, anon, authenticated;
grant execute on function public.report_source_summary(text, uuid) to service_role;

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
  staff_name text,
  station text,
  team text,
  secondary_identifier text,
  reg_no text,
  bay_no text,
  sta_std text,
  submitter_profile_id uuid,
  total_count bigint
)
language plpgsql
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
    s.staff_name, s.station, s.team, s.secondary_identifier, s.reg_no, s.bay_no, s.sta_std, s.submitter_profile_id,
    c.n
  from authorized a, counted c
  cross join lateral public.report_source_summary(a.source_table, a.source_id) s
  order by a.indexed_at desc, a.id
  limit v_page_size
  offset (v_page - 1) * v_page_size;
end;
$function$;

revoke execute on function public.list_reports_secure(integer, integer, text, text, text, date, date) from public, anon;
grant execute on function public.list_reports_secure(integer, integer, text, text, text, date, date) to authenticated, service_role;

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
  staff_name text,
  station text,
  team text,
  secondary_identifier text,
  reg_no text,
  bay_no text,
  sta_std text,
  submitter_profile_id uuid,
  total_count bigint
)
language plpgsql
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
    s.staff_name, s.station, s.team, s.secondary_identifier, s.reg_no, s.bay_no, s.sta_std, s.submitter_profile_id,
    c.n
  from authorized a, counted c
  cross join lateral public.report_source_summary(a.source_table, a.source_id) s
  order by a.indexed_at desc, a.id
  limit v_page_size
  offset (v_page - 1) * v_page_size;
end;
$function$;

revoke execute on function public.search_reports_secure(integer, integer, text, text, uuid, text, uuid, uuid, uuid, uuid, uuid, text, text, text, uuid) from public, anon;
grant execute on function public.search_reports_secure(integer, integer, text, text, uuid, text, uuid, uuid, uuid, uuid, uuid, text, text, text, uuid) to authenticated, service_role;

-- list_my_submissions_secure(): the caller's OWN reports across all 7
-- source tables, card fields only (via report_source_summary()) -- the
-- replacement for the direct full-row SELECT getMySubmissions() used to
-- perform. SECURITY DEFINER + service_role-owned, so it reads every
-- table regardless of the column-level grant closure below; it never
-- accepts a profile id parameter, so it can only ever return the
-- CALLER's own reports (auth.uid()), never anyone else's.
create or replace function public.list_my_submissions_secure(p_limit integer default 20)
returns table (
  id uuid,
  source_table text,
  report_no text,
  status text,
  submitted_at timestamptz,
  created_at timestamptz,
  staff_name text,
  station text,
  team text,
  secondary_identifier text
)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 200);
begin
  if auth.uid() is null then
    raise exception 'Must be signed in.';
  end if;

  return query
  with mine as (
    select 'report_sec013' as source_table, t.id, t.report_no, t.status::text, t.submitted_at, t.created_at from public.report_sec013 t where t.profile_id = auth.uid()
    union all
    select 'report_sec014', t.id, t.report_no, t.status::text, t.submitted_at, t.created_at from public.report_sec014 t where t.profile_id = auth.uid()
    union all
    select 'report_sec016', t.id, t.report_no, t.status::text, t.submitted_at, t.created_at from public.report_sec016 t where t.profile_id = auth.uid()
    union all
    select 'report_sec018', t.id, t.report_no, t.status::text, t.submitted_at, t.created_at from public.report_sec018 t where t.profile_id = auth.uid()
    union all
    select 'report_sec029', t.id, t.report_no, t.status::text, t.submitted_at, t.created_at from public.report_sec029 t where t.profile_id = auth.uid()
    union all
    select 'report_sec033', t.id, t.report_no, t.status::text, t.submitted_at, t.created_at from public.report_sec033 t where t.profile_id = auth.uid()
    union all
    select 'offload_records', t.id, t.report_no, t.status::text, t.submitted_at, t.created_at from public.offload_records t where t.profile_id = auth.uid()
  )
  select
    m.id, m.source_table, m.report_no, m.status, m.submitted_at, m.created_at,
    s.staff_name, s.station, s.team, s.secondary_identifier
  from mine m
  cross join lateral public.report_source_summary(m.source_table, m.id) s
  order by m.created_at desc
  limit v_limit;
end;
$function$;

revoke execute on function public.list_my_submissions_secure(integer) from public, anon;
grant execute on function public.list_my_submissions_secure(integer) to authenticated, service_role;

-- search_reports_by_number_secure(): CORRECTION (review round 4,
-- discovered while fixing getMySubmissions() -- an adjacent direct
-- full-row read, searchByReportNoPrefix() in the same source file, was
-- found reading `.from(table).select("*")` unscoped by profile_id at
-- all, relying entirely on the now-closed legacy RLS). Authorized via
-- the same has_report_access() CTE as list/search, narrow card fields
-- only via report_source_summary() -- never full content.
create or replace function public.search_reports_by_number_secure(p_prefix text, p_limit integer default 50)
returns table (
  id uuid,
  source_table text,
  report_no text,
  status text,
  report_date date,
  station text,
  team text,
  staff_name text,
  secondary_identifier text
)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_cleaned text := upper(trim(coalesce(p_prefix, '')));
begin
  if auth.uid() is null then
    raise exception 'Must be signed in.';
  end if;
  if not exists (select 1 from public.profiles where id = auth.uid() and status = 'approved') then
    raise exception 'Only an approved account may search reports.';
  end if;
  if v_cleaned = '' then
    return;
  end if;

  return query
  select
    cri.id, cri.source_table, cri.report_type, cri.status, cri.report_date,
    s.station, s.team, s.staff_name, s.secondary_identifier
  from public.central_reports_index cri
  cross join lateral public.report_source_summary(cri.source_table, cri.source_id) s
  where public.has_report_access(cri.id)
    and upper(cri.report_type) like v_cleaned || '%'
  order by cri.report_type desc
  limit v_limit;
end;
$function$;

revoke execute on function public.search_reports_by_number_secure(text, integer) from public, anon;
grant execute on function public.search_reports_by_number_secure(text, integer) to authenticated, service_role;

-- =======================================================================
-- PART S: needs_your_action_secure() -- dedicated, atomic, preserves
-- rank/station/team/ops_group rules
-- =======================================================================
-- Mirrors the exact existing eligibility rule from
-- lib/dashboard/needs-your-action.ts (itself matching
-- can_acknowledge_report()'s own logic, avsec/20260917000001_*): SO or
-- DSE role, own station, own team, own ops_group when set. Returns only
-- the display fields the card needs (staff_name, staff_id, team,
-- submitted_at), computed and authorized in one call. Does not use
-- has_report_access()/central_reports_index at all -- this is
-- acknowledgement-work-queue visibility, a distinct, narrower rule than
-- general report access, matching the existing acknowledgement
-- authority exactly rather than widening it to Phase 3/6's report-scope
-- rules.
create or replace function public.needs_your_action_secure()
returns table (
  report_id uuid,
  staff_name text,
  staff_id text,
  team text,
  submitted_at timestamptz
)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_role text;
  v_station text;
  v_team text;
  v_ops_group text;
begin
  if auth.uid() is null then
    raise exception 'Must be signed in.';
  end if;

  select p.role::text, p.station, p.team, p.ops_group
  into v_role, v_station, v_team, v_ops_group
  from public.profiles p
  where p.id = auth.uid() and p.status = 'approved';

  if v_role is null or v_role not in ('SO', 'DSE') or v_station is null or v_team is null then
    return;
  end if;

  return query
  select r.id, r.staff_name, r.staff_id, r.team, r.submitted_at
  from public.report_sec014 r
  where r.status = 'submitted'
    and r.station = v_station
    and r.team = v_team
    and (v_ops_group is null or r.ops_group = v_ops_group)
    and not exists (
      select 1 from public.report_acknowledgements a
      where a.report_type = 'sec014' and a.report_id = r.id
    );
end;
$function$;

revoke execute on function public.needs_your_action_secure() from public, anon;
grant execute on function public.needs_your_action_secure() to authenticated, service_role;

-- =======================================================================
-- PART S1B (round 8): SEC029 checklist versioning -- an explicit,
-- maintainable database representation of the checklist, so "exactly the
-- 20 required items, no duplicates, no invalid codes" can actually be
-- enforced at the database boundary, not merely at count = 20.
-- =======================================================================
-- CORRECTION (review round 8): round 7 deliberately did NOT enforce
-- report_sec029's true requirement (SEC029_ITEMS.length, currently 20
-- SPECIFIC checklist items) because the exact count had "no independently
-- stored source of truth" on the database side -- only a structural
-- minimum-1 floor was enforced, honestly documented as a gap rather than
-- overclaimed. This part closes that gap by giving the checklist an
-- explicit, maintainable, VERSIONED database representation -- the
-- database no longer merely trusts a count, it knows the actual set of
-- required item codes for the current checklist version and can check
-- against it directly.
--
-- Versioned (not a single unversioned table) because the checklist HAS
-- changed before (see lib/avsec/reference-data.ts's own Rev.03 comment:
-- items removed, renamed, and one added -- SEC029_LEGACY_ITEM_LABELS
-- exists specifically to keep historical reports, recorded against an
-- older checklist, rendering correctly). A single unversioned table would
-- force an awkward choice on the next legitimate checklist revision:
-- either break enforcement for reports already in flight against the old
-- checklist, or silently accept the new checklist's items as "invalid"
-- until the table is manually updated in lockstep with a code deploy.
-- Versioning means a new checklist revision is a new row set at a new
-- version number, with the "current" version pointed to explicitly --
-- old reports remain valid against whatever version was current when
-- they were validated, and a revision is a pure addition, never a
-- mutation of history.
--
-- current_sec029_checklist_version() below returns a literal constant
-- (1) rather than reading a mutable "current version" row -- this is a
-- deliberate, minimal design: introducing a separately-writable "current
-- version" pointer would itself need its own authorization/audit trail
-- (who may advance it, when) that is out of scope for this round and
-- unnecessary until a second checklist revision actually exists. Bumping
-- to a new version is a two-line change (a new INSERT block for the new
-- version's items, and updating this function's returned literal) done
-- as part of the same migration that changes SEC029_ITEMS in application
-- code -- never a silent, independent drift.
create table if not exists public.sec029_checklist_items (
  version integer not null,
  code text not null,
  section text not null,
  label text not null,
  allow_not_applicable boolean not null default false,
  primary key (version, code)
);

revoke all on public.sec029_checklist_items from public, anon, authenticated;
grant select on public.sec029_checklist_items to authenticated, service_role;
-- Read-only reference data for authenticated users (e.g. a future UI
-- that renders the canonical checklist from the database instead of a
-- hardcoded TS array); only service_role/migrations may write it.

create or replace function public.current_sec029_checklist_version()
returns integer
language sql
immutable
as $function$
  select 1;
$function$;

revoke execute on function public.current_sec029_checklist_version() from public, anon;
grant execute on function public.current_sec029_checklist_version() to authenticated, service_role;

-- Version 1 seed -- MUST match lib/avsec/reference-data.ts's SEC029_ITEMS
-- array exactly (same 20 codes, same order irrelevant but same set).
-- tests/phase6-secure-report-access.test.mts statically asserts this
-- agreement by parsing both this seed and that TS array and comparing
-- their code sets.
insert into public.sec029_checklist_items (version, code, section, label, allow_not_applicable) values
  (1, 'A_I', 'A. GALLEY', 'A(I) ALL STOWAGE COMPARTMENT', false),
  (1, 'A_II', 'A. GALLEY', 'A(II) WASTE BIN', false),
  (1, 'B_I', 'B. LAVATORY', 'B(I) ALL STOWAGE COMPARTMENT', false),
  (1, 'B_II', 'B. LAVATORY', 'B(II) WASTE BIN', false),
  (1, 'B_III', 'B. LAVATORY', 'B(III) DRAWER', false),
  (1, 'B_IV', 'B. LAVATORY', 'B(IV) TOILET BOWLS', false),
  (1, 'C_I', 'C. SEAT', 'C(I) ARM REST', false),
  (1, 'C_II', 'C. SEAT', 'C(II) SEAT POCKETS', false),
  (1, 'C_III', 'C. SEAT', 'C(III) LIFE JACKET POUCHES', false),
  (1, 'A1', 'OTHER ACCESSIBLE COMPARTMENTS', 'A1. OVERHEAD COMPARTMENTS', false),
  (1, 'B1', 'OTHER ACCESSIBLE COMPARTMENTS', 'B1. CREW SEATS & SEAT COMPARTMENTS', false),
  (1, 'A2', 'COCKPIT AREA', 'A2. SEATS', false),
  (1, 'B2', 'COCKPIT AREA', 'B2. FLOOR AREA', false),
  (1, 'C2', 'COCKPIT AREA', 'C2. COMPARTMENTS', false),
  (1, 'US_SEALS', '4. U.S FLIGHTS ONLY', 'LAVATORY SHROUDS SECURITY SEALS', true),
  (1, 'A_EXT_II', 'A. AIRCRAFT VISUAL INSPECTION (EXTERNAL)', 'I. LANDING GEAR BAY', false),
  (1, 'A_EXT_III', 'A. AIRCRAFT VISUAL INSPECTION (EXTERNAL)', '(A) III. WHEELS AND BODIES', false),
  (1, 'B_EXT_V', 'CARGO HOLD (EXTERNAL)', '(B) V. DOOR, FLOOR & WALL CEILING', false),
  (1, 'B_EXT_VI', 'CARGO HOLD (EXTERNAL)', '(B) VI. RESTRAINT NETS', false),
  (1, 'B_EXT_VII', 'CARGO HOLD (EXTERNAL)', '(C) Inspect any cavities, compartments inside the hold', false)
on conflict (version, code) do nothing;

-- CORRECTION (review round 8): "validate the expected distinct item
-- identifiers -- not merely a count." report_sec029_items already has a
-- unique(report_id, item_code) constraint (avsec/0001_init_schema.sql),
-- which already rejects a literal duplicate item_code at the database
-- level -- that part of "duplicate ... items rejected" was already true
-- before this round. What was NOT enforced is that item_code is one of
-- the CURRENT checklist's actual codes -- an application bug (or a
-- direct RPC caller bypassing the UI) could otherwise insert 20 rows
-- with 20 UNIQUE but entirely made-up item_codes and satisfy every
-- check that existed before this round. This trigger closes that: every
-- inserted/updated item_code must belong to the current checklist
-- version, checked against the versioned table above rather than a
-- hardcoded list, so a genuine future checklist revision (adding this
-- version's rows under a new version number and bumping
-- current_sec029_checklist_version()) does not require touching this
-- trigger function at all.
create or replace function public.validate_sec029_item_code()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if not exists (
    select 1 from public.sec029_checklist_items
    where version = public.current_sec029_checklist_version() and code = new.item_code
  ) then
    raise exception 'Invalid SEC029 checklist item code: % is not part of checklist version %.', new.item_code, public.current_sec029_checklist_version();
  end if;
  return new;
end;
$function$;

revoke execute on function public.validate_sec029_item_code() from public, anon, authenticated;
grant execute on function public.validate_sec029_item_code() to service_role;

drop trigger if exists trg_validate_sec029_item_code on public.report_sec029_items;
create trigger trg_validate_sec029_item_code before insert or update on public.report_sec029_items
  for each row execute function public.validate_sec029_item_code();

-- =======================================================================
-- PART S2: explicit indexing readiness -- closes the immutable-snapshot
-- completeness race
-- =======================================================================
-- CORRECTION (review round 5): 6 of the 7 report tables (every one
-- except report_sec016) have a separate child table (patrols/items/
-- hold-checks/profiling-duties), written by application code in a
-- SEPARATE, LATER statement after the parent row's own INSERT commits
-- (lib/avsec/reports/actions.ts -- e.g. submitSec014() inserts the
-- parent row, gets its id back via RETURNING, THEN inserts patrol rows
-- referencing that id). Phase 5's automatic AFTER INSERT enqueue
-- trigger on the PARENT table fires the instant the parent row commits
-- -- before the child insert has necessarily happened. Since Phase 5's
-- pg_cron job runs process_report_index_queue() every 1 minute, a
-- queued row could be picked up and indexed (capturing version 1's
-- immutable snapshot) in the narrow window between the parent commit
-- and the child insert completing, permanently capturing an incomplete
-- report -- version 1 is written exactly once and this codebase has no
-- (and must not have) a path that overwrites it to repair an early
-- snapshot.
--
-- Fixed with an explicit-completion model, not a timing heuristic:
--   1. The automatic AFTER INSERT enqueue triggers (Phase 5 Part Q) are
--      dropped from all 7 report tables.
--   2. mark_report_ready_for_indexing() is a new, narrow, authenticated-
--      callable RPC that ONLY inserts into report_index_queue (the same
--      idempotent ON CONFLICT DO NOTHING pattern as the old trigger) --
--      it grants no other privilege and performs no classification or
--      content read itself.
--   3. Every one of the 7 submit actions in lib/avsec/reports/actions.ts
--      now calls this RPC explicitly, as the LAST step after any child-
--      row insert has already completed (and after checking for a
--      child-insert error) -- so a report can only ever be enqueued once
--      it is genuinely complete. report_sec016 (no child table) also
--      uses this same explicit call now, for one consistent pattern
--      instead of a special-cased automatic trigger for one table only.
-- The caller identity check (profile_id = auth.uid()) prevents this RPC
-- from being used to enqueue an arbitrary other person's report early
-- (not itself a security boundary bypass -- enqueueing only queues a
-- row for the existing has_report_access()-independent indexing
-- process, it grants no read access -- but the check keeps the
-- function's authority scoped to "my own report is now complete," which
-- is the only case any legitimate caller ever has).
drop trigger if exists trg_enqueue_indexing on public.report_sec013;
drop trigger if exists trg_enqueue_indexing on public.report_sec014;
drop trigger if exists trg_enqueue_indexing on public.report_sec016;
drop trigger if exists trg_enqueue_indexing on public.report_sec018;
drop trigger if exists trg_enqueue_indexing on public.report_sec029;
drop trigger if exists trg_enqueue_indexing on public.report_sec033;
drop trigger if exists trg_enqueue_indexing on public.offload_records;

-- CORRECTION (review round 7): p_expected_child_count (round 6) is
-- CALLER-CONTROLLED -- matching it against the database's actual count
-- proves only "what the caller claims equals what exists," never "what
-- this report TYPE actually requires." A caller (buggy or malicious)
-- could claim 0 for a type whose form validation requires at least one
-- child row, and the round-6 check alone would have accepted it. Fixed
-- by treating p_expected_child_count as a consistency check ONLY, and
-- separately enforcing each type's own minimum-child requirement
-- server-side, independent of anything the caller claims.
--
-- EXACT PER-TYPE REQUIREMENT, taken directly from each type's existing
-- zod form-validation schema (lib/avsec/schemas/*.ts) -- no new business
-- rule is invented here, only what already exists is now also enforced
-- server-side:
--   report_sec013 -- profiling_duties: `.min(1, ...)` (sec013.ts:29)
--                    => REQUIRED, minimum 1.
--   report_sec014 -- patrols: `z.array(...)`, no .min(), default []
--                    (sec014.ts:22,39) => OPTIONAL, minimum 0.
--   report_sec016 -- no child table at all => always 0, not applicable.
--   report_sec018 -- patrols: `.max(6, ...)`, no .min(), default []
--                    (sec018.ts:21,35) => OPTIONAL, minimum 0, MAXIMUM 6.
--                    CORRECTION (review round 8): round 7 enforced only
--                    the (trivial, always-true) minimum of 0 for this
--                    type and left the existing max(6) form rule
--                    unenforced at the database boundary. Now checked
--                    below via v_required_maximum -- no new business
--                    rule, the app schema already had this limit.
--   report_sec029 -- items: `.length(SEC029_ITEMS.length)` (sec029.ts:50)
--                    -- an EXACT fixed set of 20 SPECIFIC checklist item
--                    codes, not merely "at least one" or "exactly 20 of
--                    anything." Round 7 left this as an honestly-
--                    documented gap: only a structural minimum-1 floor
--                    was enforced, because the exact set had no
--                    independently stored database-side source of truth.
--                    CORRECTION (review round 8): that gap is now closed
--                    with a real, maintainable, VERSIONED database
--                    representation -- see PART S1B above
--                    (sec029_checklist_items,
--                    current_sec029_checklist_version(),
--                    validate_sec029_item_code()). This function now
--                    checks that the report's DISTINCT item_codes are
--                    exactly the current checklist version's code set --
--                    no missing codes (checked below), and no extra/
--                    invalid/duplicate codes are even insertable in the
--                    first place (validate_sec029_item_code() rejects an
--                    unrecognized code at INSERT/UPDATE time; the
--                    pre-existing unique(report_id, item_code) constraint
--                    rejects a literal duplicate at INSERT time) -- so
--                    "no missing codes" is sufficient here to prove an
--                    exact set match, not merely a count.
--   report_sec033 -- hold_checks: `.min(1, ...)` (sec033.ts:22)
--                    => REQUIRED, minimum 1.
--   offload_records -- items: `.min(1, ...)` (offload.ts:45)
--                    => REQUIRED, minimum 1.
--
-- "Required children must remain required even when the caller supplies
-- zero": the minimum check below runs INDEPENDENTLY of
-- p_expected_child_count -- a caller claiming p_expected_child_count = 0
-- for report_sec013/029/033/offload_records is rejected by the minimum
-- check even though its claim would trivially match an actual count of
-- 0 (which would otherwise pass the consistency check alone). Likewise
-- the new report_sec018 maximum check is independent of whatever the
-- caller claims.
--
-- Race safety unchanged from round 6: the parent row is locked with
-- `for update` before counting children, and
-- enforce_child_write_before_finalization() (the trigger on all 6 child
-- tables, below) locks the SAME parent row before permitting any child
-- INSERT/UPDATE/DELETE, so the two paths cannot race independently.
create or replace function public.mark_report_ready_for_indexing(p_source_table text, p_source_id uuid, p_expected_child_count integer default 0)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
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
    'report_sec029', 'report_sec033', 'offload_records'
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
  end if;

  if v_actual_children <> coalesce(p_expected_child_count, 0) then
    raise exception 'Report % is not yet complete: expected % child row(s), found %: cannot mark ready for indexing until every child row has actually been committed.', p_source_id, coalesce(p_expected_child_count, 0), v_actual_children;
  end if;

  -- Per-type minimum, enforced independently of p_expected_child_count
  -- (see the header comment above for the exact source of each number).
  v_required_minimum := case p_source_table
    when 'report_sec013' then 1
    when 'report_sec029' then 1
    when 'report_sec033' then 1
    when 'offload_records' then 1
    else 0
  end;
  if v_actual_children < v_required_minimum then
    raise exception 'Report % is missing required child content: this report type requires at least % child row(s), found %: a caller-supplied expected count cannot override this requirement.', p_source_id, v_required_minimum, v_actual_children;
  end if;

  -- Per-type maximum (round 8), enforced the same way: independent of
  -- whatever the caller claims. Only report_sec018 has one currently
  -- (sec018.ts:21, `.max(6, ...)`).
  v_required_maximum := case p_source_table
    when 'report_sec018' then 6
    else null
  end;
  if v_required_maximum is not null and v_actual_children > v_required_maximum then
    raise exception 'Report % has too much child content: this report type allows at most % child row(s), found %.', p_source_id, v_required_maximum, v_actual_children;
  end if;

  -- SEC029 exact-checklist match (round 8): the report's distinct item
  -- codes must be exactly the current checklist version's code set. No
  -- extra/invalid codes can exist (validate_sec029_item_code() rejects
  -- them at INSERT/UPDATE time) and no duplicate codes can exist (the
  -- pre-existing unique(report_id, item_code) constraint rejects them at
  -- INSERT time), so checking for zero MISSING codes is sufficient to
  -- prove the set is exactly right, not merely a count of 20.
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

  -- Idempotent AND safe to call repeatedly: ON CONFLICT DO NOTHING means
  -- a retried finalization call (after a prior attempt's transient
  -- failure, or simply called twice) never creates a duplicate queue
  -- entry, and re-verifies the same completeness check every time --
  -- repeated finalization is always safe, never silently accepted
  -- without re-checking.
  insert into public.report_index_queue (source_table, source_id)
  values (p_source_table, p_source_id)
  on conflict (source_table, source_id) do nothing;
end;
$function$;

revoke execute on function public.mark_report_ready_for_indexing(text, uuid, integer) from public, anon;
grant execute on function public.mark_report_ready_for_indexing(text, uuid, integer) to authenticated, service_role;

-- =======================================================================
-- PART S3: freeze child content after finalization, race-safe
-- =======================================================================
-- CORRECTION (review round 6): block_submitted_report_mutation()
-- already freezes the PARENT row's own content completely the instant
-- status transitions to 'submitted' (avsec/0001_init_schema.sql,
-- corrected for the service_role/classification exception in Phase 6
-- Part P -- EVIDENCE: `if old.status = 'submitted' then ... raise
-- exception 'Submitted reports are immutable...'`, unconditional for
-- any non-service_role caller). That has been true since before this
-- session and needed no change here.
--
-- Child tables had NO equivalent freeze at all: their "via parent
-- write" policies (avsec/0001/0013/0014/0021_*.sql) check only
-- `r.profile_id = auth.uid()`, never the parent's status or finalization
-- state -- a submitter could INSERT/UPDATE/DELETE a patrol/item/hold-
-- check/profiling-duty/offload-item row at ANY time after submission,
-- including after the report has been finalized (marked ready for
-- indexing) or even after it has already been indexed into an immutable
-- version 1 snapshot. This trigger closes that gap, using the SAME
-- shared lock mark_report_ready_for_indexing() takes on the parent row
-- (Part S2, above) so the two paths cannot race: whichever transaction
-- reaches the parent row's lock first completes before the other
-- proceeds, so a child write either lands cleanly before finalization
-- or is correctly rejected after it, never both/neither.
-- CORRECTION (review round 7): an UPDATE that changes a child row's own
-- report_id (reassigning it to a DIFFERENT parent) was checked against
-- only ONE parent -- coalesce(new.report_id, old.report_id) always
-- resolves to NEW.report_id for an UPDATE, so the OLD parent's
-- finalization state was never checked at all, meaning a child row
-- could be silently moved OUT of an already-finalized report's child
-- set without that report's freeze being respected. No application code
-- anywhere in this codebase ever updates a child row's report_id
-- (confirmed by source search: zero `.update(...)` calls against any of
-- the 6 child tables in lib/) -- per the review's own preference,
-- reassignment is forbidden outright rather than supported with dual-
-- parent locking the application has no use for. If a future phase
-- genuinely needs reassignment, this must be revisited deliberately
-- (lock both parents in a fixed, consistent order -- e.g. by id -- to
-- avoid a deadlock between two concurrent reassignments crossing in
-- opposite directions -- and reject if EITHER parent is finalized), not
-- silently re-enabled.
create or replace function public.enforce_child_write_before_finalization()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_report_id uuid := coalesce(new.report_id, old.report_id);
  v_parent_table text;
  v_locked_id uuid;
begin
  if auth.role() = 'service_role' then
    return coalesce(new, old);
  end if;

  if tg_op = 'UPDATE' and new.report_id is distinct from old.report_id then
    raise exception 'Reassigning a child row to a different report is not supported.';
  end if;

  v_parent_table := case tg_table_name
    when 'report_sec013_profiling_duties' then 'report_sec013'
    when 'report_sec014_patrols' then 'report_sec014'
    when 'report_sec018_patrols' then 'report_sec018'
    when 'report_sec029_items' then 'report_sec029'
    when 'report_sec033_hold_checks' then 'report_sec033'
    when 'offload_items' then 'offload_records'
    else null
  end;
  if v_parent_table is null then
    raise exception 'Unrecognized child table: %', tg_table_name;
  end if;

  if v_parent_table = 'report_sec013' then
    select id into v_locked_id from public.report_sec013 where id = v_report_id for update;
  elsif v_parent_table = 'report_sec014' then
    select id into v_locked_id from public.report_sec014 where id = v_report_id for update;
  elsif v_parent_table = 'report_sec018' then
    select id into v_locked_id from public.report_sec018 where id = v_report_id for update;
  elsif v_parent_table = 'report_sec029' then
    select id into v_locked_id from public.report_sec029 where id = v_report_id for update;
  elsif v_parent_table = 'report_sec033' then
    select id into v_locked_id from public.report_sec033 where id = v_report_id for update;
  elsif v_parent_table = 'offload_records' then
    select id into v_locked_id from public.offload_records where id = v_report_id for update;
  end if;

  if v_locked_id is null then
    raise exception 'Parent report not found for child write.';
  end if;

  if exists (
    select 1 from public.report_index_queue
    where source_table = v_parent_table and source_id = v_report_id
  ) then
    raise exception 'This report has already been finalized (marked ready for indexing): child content can no longer be added, changed, or removed.';
  end if;

  return coalesce(new, old);
end;
$function$;

revoke execute on function public.enforce_child_write_before_finalization() from public, anon, authenticated;
grant execute on function public.enforce_child_write_before_finalization() to service_role;
-- No client EXECUTE grant needed -- trigger-fired only, same reasoning
-- as every other trigger function in this migration.

drop trigger if exists trg_enforce_child_finalization on public.report_sec013_profiling_duties;
create trigger trg_enforce_child_finalization before insert or update or delete on public.report_sec013_profiling_duties
  for each row execute function public.enforce_child_write_before_finalization();

drop trigger if exists trg_enforce_child_finalization on public.report_sec014_patrols;
create trigger trg_enforce_child_finalization before insert or update or delete on public.report_sec014_patrols
  for each row execute function public.enforce_child_write_before_finalization();

drop trigger if exists trg_enforce_child_finalization on public.report_sec018_patrols;
create trigger trg_enforce_child_finalization before insert or update or delete on public.report_sec018_patrols
  for each row execute function public.enforce_child_write_before_finalization();

drop trigger if exists trg_enforce_child_finalization on public.report_sec029_items;
create trigger trg_enforce_child_finalization before insert or update or delete on public.report_sec029_items
  for each row execute function public.enforce_child_write_before_finalization();

drop trigger if exists trg_enforce_child_finalization on public.report_sec033_hold_checks;
create trigger trg_enforce_child_finalization before insert or update or delete on public.report_sec033_hold_checks
  for each row execute function public.enforce_child_write_before_finalization();

drop trigger if exists trg_enforce_child_finalization on public.offload_items;
create trigger trg_enforce_child_finalization before insert or update or delete on public.offload_items
  for each row execute function public.enforce_child_write_before_finalization();
-- Legitimate child-row creation during report submission is unaffected:
-- every submit action inserts child rows BEFORE calling
-- mark_report_ready_for_indexing() (Part S2), so report_index_queue has
-- no entry yet at INSERT time and this trigger's EXISTS check passes.

-- =======================================================================
-- PART S4: application-retry support -- resume the SAME parent id
-- instead of resubmitting a duplicate
-- =======================================================================
-- CORRECTION (review round 7): "returning the report id in an error
-- message is not itself a usable retry workflow." Postgres's own INSERT
-- semantics make the two possible partial-failure states precise:
--   (a) the child-row INSERT itself fails (e.g. a unique_violation) --
--       a multi-row INSERT is atomic in Postgres, so this always leaves
--       EXACTLY ZERO child rows, never a partial set. The submit action
--       returns { ok: false, error } immediately, BEFORE finalization is
--       ever attempted -- distinguishable from a finalization failure by
--       the error message alone (it never contains "could not be
--       finalized").
--   (b) child rows insert successfully, but the finalization RPC call
--       itself fails (e.g. a transient network error) -- the report's
--       child rows are already complete and correct; only the
--       report_index_queue entry is missing. The submit action's error
--       message explicitly says "Report saved, but could not be
--       finalized," distinguishing this case from (a).
--
-- get_child_row_count_secure(): lets the application check case (a) vs.
-- (b) for a given report WITHOUT needing direct child-table SELECT
-- (which Part O/round-5 correctly revoked entirely) -- ownership-
-- checked, returns only a count, never row content.
create or replace function public.get_child_row_count_secure(p_source_table text, p_source_id uuid)
returns integer
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_owner uuid;
  v_count integer;
begin
  if auth.uid() is null then
    raise exception 'Must be signed in.';
  end if;
  if p_source_table not in (
    'report_sec013', 'report_sec014', 'report_sec016', 'report_sec018',
    'report_sec029', 'report_sec033', 'offload_records'
  ) then
    raise exception 'Unsupported source_table: %', p_source_table;
  end if;

  if p_source_table = 'report_sec013' then
    select profile_id into v_owner from public.report_sec013 where id = p_source_id;
  elsif p_source_table = 'report_sec014' then
    select profile_id into v_owner from public.report_sec014 where id = p_source_id;
  elsif p_source_table = 'report_sec016' then
    select profile_id into v_owner from public.report_sec016 where id = p_source_id;
  elsif p_source_table = 'report_sec018' then
    select profile_id into v_owner from public.report_sec018 where id = p_source_id;
  elsif p_source_table = 'report_sec029' then
    select profile_id into v_owner from public.report_sec029 where id = p_source_id;
  elsif p_source_table = 'report_sec033' then
    select profile_id into v_owner from public.report_sec033 where id = p_source_id;
  elsif p_source_table = 'offload_records' then
    select profile_id into v_owner from public.offload_records where id = p_source_id;
  end if;

  if v_owner is null then
    raise exception 'Report not found.';
  end if;
  if v_owner <> auth.uid() and auth.role() <> 'service_role' then
    raise exception 'Only the submitting profile may check its own report.';
  end if;

  if p_source_table = 'report_sec013' then
    select count(*) into v_count from public.report_sec013_profiling_duties where report_id = p_source_id;
  elsif p_source_table = 'report_sec014' then
    select count(*) into v_count from public.report_sec014_patrols where report_id = p_source_id;
  elsif p_source_table = 'report_sec016' then
    v_count := 0;
  elsif p_source_table = 'report_sec018' then
    select count(*) into v_count from public.report_sec018_patrols where report_id = p_source_id;
  elsif p_source_table = 'report_sec029' then
    select count(*) into v_count from public.report_sec029_items where report_id = p_source_id;
  elsif p_source_table = 'report_sec033' then
    select count(*) into v_count from public.report_sec033_hold_checks where report_id = p_source_id;
  elsif p_source_table = 'offload_records' then
    select count(*) into v_count from public.offload_items where report_id = p_source_id;
  end if;

  return v_count;
end;
$function$;

revoke execute on function public.get_child_row_count_secure(text, uuid) from public, anon;
grant execute on function public.get_child_row_count_secure(text, uuid) to authenticated, service_role;

-- =======================================================================
-- PART S5 (round 9): resume_report_submission_secure() -- the ONE
-- atomic, ownership-checked recovery RPC. Replaces the round-7/8
-- application-level pattern of calling get_child_row_count_secure() and
-- mark_report_ready_for_indexing() as two SEPARATE RPC calls / SEPARATE
-- transactions.
-- =======================================================================
-- CORRECTION (review round 9): "the reported sequence -- read child
-- count, then insert if zero -- does not prove duplicate prevention
-- because concurrent retries may both observe zero." Confirmed exactly
-- right on inspection: get_child_row_count_secure() is `stable` (a
-- plain read, no `for update`) and is invoked as its OWN separate
-- Postgres statement/transaction from resumeReportSubmission()'s
-- subsequent child-row INSERT. Two concurrent calls to
-- resumeReportSubmission() for the SAME stranded report could both
-- execute get_child_row_count_secure() before either had inserted
-- anything, both observe count = 0, and both then proceed to insert --
-- nothing forced the second caller to wait for or re-check the first
-- caller's result. The ONLY lock in the round-7/8 design
-- (enforce_child_write_before_finalization()'s `for update` on the
-- parent) is acquired PER CHILD ROW INSERT, not around the earlier,
-- separate count query -- exactly the gap the review identified: "A
-- lock acquired only during each individual child insert does not
-- protect an earlier, separate count query." In practice this was
-- usually masked by each child table's own unique constraint
-- (report_id, entry_no) or (report_id, item_code) rejecting the second
-- caller's colliding rows -- but "usually masked by a side-effect of an
-- unrelated constraint" is not the same as "proven safe by design," and
-- the review is right not to accept it as one.
--
-- FIXED by collapsing the count check, the conditional child insert,
-- and finalization into ONE function -- one Postgres statement, hence
-- one transaction, hence one atomic unit as far as any caller (the
-- application, or a concurrent second call to this same function) can
-- observe:
--   1. Lock the parent row FIRST, before reading anything else --
--      `select profile_id into v_owner from <table> where id = p_source_id
--      for update`, the SAME lock enforce_child_write_before_finalization()
--      and mark_report_ready_for_indexing() already take on the same row
--      (Parts S2/S3), so ALL THREE code paths (a normal submission's
--      finalization call, a child write, and now a resume) serialize
--      against each other through that one row lock -- whichever
--      transaction reaches it first completes (commits or rolls back)
--      before any other proceeds.
--   2. If the report is already finalized (report_index_queue already
--      has an entry), return immediately -- a no-op, not an error, and
--      never touches child rows again. This is what "do not overwrite
--      finalized content" means operationally: a second concurrent
--      caller, once it acquires the lock after the first has already
--      finalized, sees that immediately and stops -- it can never reach
--      the insert step at all.
--   3. Count actual child rows -- UNDER THE LOCK, so this read is now
--      protected: no concurrent child insert (from this function, from
--      a plain resubmission, or from anything else) can occur between
--      this count and the insert below, because every one of those
--      paths needs the SAME lock this transaction is already holding.
--   4. Only if that locked count is exactly zero, AND the caller
--      supplied child rows, insert them -- as ONE single INSERT
--      statement built from the caller's jsonb payload (via
--      `jsonb_to_recordset(...) with ordinality`, preserving array
--      order for entry_no assignment) -- confirmed, not merely assumed,
--      all-or-nothing: a single Postgres INSERT statement is atomic by
--      definition, so this either inserts every row or none, the same
--      guarantee every original submitXXX() action's child insert
--      already relied on (see Part S4's original analysis, still true).
--   5. Finalize by calling mark_report_ready_for_indexing() -- reusing
--      that function's OWN independent per-type minimum/maximum/exact-
--      checklist enforcement (Parts S2/S1B, rounds 7-8) verbatim, not
--      duplicated here -- so every existing completion rule applies to
--      a resumed submission exactly as it applies to a fresh one, with
--      a single source of truth for what "complete" means per type.
--      mark_report_ready_for_indexing() re-locks the same row (a
--      transaction may re-acquire a row lock it already holds without
--      self-deadlocking) and is itself idempotent (ON CONFLICT DO
--      NOTHING), so calling it here changes nothing about its own
--      contract.
--
-- Result for two genuinely concurrent resume calls on the same stranded
-- report: the first to acquire the lock inserts (if needed) and
-- finalizes, then commits, releasing the lock. The second, once
-- unblocked, finds the report either already has child rows (skips
-- insert) or is already finalized (no-ops) -- either way it returns the
-- SAME successful outcome (ok, same report id) as the first, never a
-- duplicate parent, never a duplicate/conflicting child set, and never
-- an attempt to modify content that finalization already froze.
--
-- Payload/parent-type consistency: p_source_table is looked up against
-- exactly one hardcoded table per call (the same closed CASE pattern
-- used everywhere else in this migration), so a caller cannot address
-- one report type's row through another type's table name, and each
-- child table's own foreign key (`references report_sec013 (id) on
-- delete cascade`, etc.) makes it structurally impossible for a row
-- inserted here to attach to any report other than the one actually
-- locked and counted in this same transaction.
create or replace function public.resume_report_submission_secure(p_source_table text, p_source_id uuid, p_child_rows jsonb default '[]'::jsonb)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_owner uuid;
  v_actual_children integer;
begin
  if auth.uid() is null then
    raise exception 'Must be signed in.';
  end if;
  if p_source_table not in (
    'report_sec013', 'report_sec014', 'report_sec016', 'report_sec018',
    'report_sec029', 'report_sec033', 'offload_records'
  ) then
    raise exception 'Unsupported source_table: %', p_source_table;
  end if;

  -- Lock the parent FIRST -- before reading anything else -- so this
  -- transaction's view of "is it finalized" and "how many children
  -- exist" cannot change underneath it until this transaction commits
  -- or rolls back. Every other path that touches this report's
  -- finalization state or child rows (mark_report_ready_for_indexing(),
  -- enforce_child_write_before_finalization(), and a concurrent call to
  -- THIS function) takes the same lock on the same row.
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
  end if;

  if v_owner is null then
    raise exception 'Report not found.';
  end if;
  if v_owner <> auth.uid() and auth.role() <> 'service_role' then
    raise exception 'Only the submitting profile may resume its own report.';
  end if;

  -- Already finalized: no-op, under the same lock -- never touch child
  -- content once it may have already been indexed into an immutable
  -- snapshot. A concurrent second caller lands here, not in the insert
  -- branch below, once it is unblocked after the first caller commits.
  if exists (
    select 1 from public.report_index_queue where source_table = p_source_table and source_id = p_source_id
  ) then
    return;
  end if;

  -- Count actual children UNDER THE LOCK -- this is now safe from the
  -- TOCTOU gap the review identified, because no concurrent transaction
  -- can insert/update/delete a child row for this report without first
  -- acquiring the same lock this transaction already holds.
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
  end if;

  -- Only insert when the LOCKED count is confirmed zero (case (a)) and
  -- the caller actually supplied rows to insert. A concurrent second
  -- caller that reaches this point after the first has already
  -- inserted sees v_actual_children > 0 here and skips straight to
  -- finalization -- it never attempts a second, conflicting insert.
  if v_actual_children = 0 and jsonb_array_length(p_child_rows) > 0 then
    if p_source_table = 'report_sec013' then
      insert into public.report_sec013_profiling_duties (report_id, entry_no, duty_area, time_from, time_to, location, sector_flight, description, incident_remark)
      select p_source_id, x.ord, x.duty_area, x.time_from, x.time_to, x.location, x.sector_flight, x.description, x.incident_remark
      from jsonb_to_recordset(p_child_rows) with ordinality
        as x(duty_area text, time_from text, time_to text, location text, sector_flight text, description text, incident_remark text, ord int);
    elsif p_source_table = 'report_sec014' then
      insert into public.report_sec014_patrols (report_id, entry_no, location, time_from, time_to, description)
      select p_source_id, x.ord, x.location, x.time_from, x.time_to, x.description
      from jsonb_to_recordset(p_child_rows) with ordinality
        as x(location text, time_from text, time_to text, description text, ord int);
    elsif p_source_table = 'report_sec018' then
      insert into public.report_sec018_patrols (report_id, entry_no, time_from, time_to, parking_bay, aircraft_type, reg_no, description)
      select p_source_id, x.ord, x.time_from, x.time_to, x.parking_bay, x.aircraft_type, x.reg_no, x.description
      from jsonb_to_recordset(p_child_rows) with ordinality
        as x(time_from text, time_to text, parking_bay text, aircraft_type text, reg_no text, description text, ord int);
    elsif p_source_table = 'report_sec029' then
      insert into public.report_sec029_items (report_id, item_code, checked, remark_type, remark_text)
      select p_source_id, x.item_code, x.checked, x.remark_type, x.remark_text
      from jsonb_to_recordset(p_child_rows)
        as x(item_code text, checked text, remark_type text, remark_text text);
    elsif p_source_table = 'report_sec033' then
      insert into public.report_sec033_hold_checks (report_id, entry_no, parking_bay_no, aircraft_registration_no, remarks)
      select p_source_id, x.ord, x.parking_bay_no, x.aircraft_registration_no, x.remarks
      from jsonb_to_recordset(p_child_rows) with ordinality
        as x(parking_bay_no text, aircraft_registration_no text, remarks text, ord int);
    elsif p_source_table = 'offload_records' then
      insert into public.offload_items (report_id, entry_no, baggage_tag_no, reason, weight_kg)
      select p_source_id, x.ord, x.baggage_tag_no, x.reason, x.weight_kg
      from jsonb_to_recordset(p_child_rows) with ordinality
        as x(baggage_tag_no text, reason text, weight_kg numeric, ord int);
    end if;

    -- Re-count after the insert -- the value passed to
    -- mark_report_ready_for_indexing() below must reflect what was
    -- ACTUALLY committed by the statement above, not merely
    -- jsonb_array_length(p_child_rows) (which is only what the caller
    -- claimed to send).
    if p_source_table = 'report_sec013' then
      select count(*) into v_actual_children from public.report_sec013_profiling_duties where report_id = p_source_id;
    elsif p_source_table = 'report_sec014' then
      select count(*) into v_actual_children from public.report_sec014_patrols where report_id = p_source_id;
    elsif p_source_table = 'report_sec018' then
      select count(*) into v_actual_children from public.report_sec018_patrols where report_id = p_source_id;
    elsif p_source_table = 'report_sec029' then
      select count(*) into v_actual_children from public.report_sec029_items where report_id = p_source_id;
    elsif p_source_table = 'report_sec033' then
      select count(*) into v_actual_children from public.report_sec033_hold_checks where report_id = p_source_id;
    elsif p_source_table = 'offload_records' then
      select count(*) into v_actual_children from public.offload_items where report_id = p_source_id;
    end if;
  end if;

  -- Finalize using mark_report_ready_for_indexing()'s OWN, independent,
  -- already-tested completion rules (per-type minimum, report_sec018's
  -- maximum, report_sec029's exact-checklist match) -- not duplicated
  -- here. Still inside the SAME transaction, so the parent row is never
  -- unlocked between the count/insert above and this finalization call.
  perform public.mark_report_ready_for_indexing(p_source_table, p_source_id, v_actual_children);
end;
$function$;

revoke execute on function public.resume_report_submission_secure(text, uuid, jsonb) from public, anon;
grant execute on function public.resume_report_submission_secure(text, uuid, jsonb) to authenticated, service_role;

-- =======================================================================
-- PART T: search_movements_by_registration_secure() -- dedicated,
-- atomic, bounded registration search
-- =======================================================================
-- Bounded by a mandatory p_since_date (defaults to 30 days before now,
-- never an unbounded historical scan) and a hard result cap. Authorizes
-- each candidate row via has_report_access() individually (report_
-- sec016/029 rows only reach the return set once authorized); a
-- CaterLink transaction row is included only when the caller is
-- authorized to view report content at all (approved profile), since
-- CaterLink's own transactions table has its own separate, pre-existing
-- RLS this migration does not alter or widen.
create or replace function public.search_movements_by_registration_secure(
  p_registration text,
  p_since_date date default null,
  p_max_results integer default 50
)
returns table (
  source text,
  id uuid,
  flight text,
  report_date date,
  station text,
  summary text
)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_reg text := upper(trim(p_registration));
  v_since date := coalesce(p_since_date, (now() - interval '30 days')::date);
  v_max integer := least(greatest(coalesce(p_max_results, 50), 1), 200);
begin
  if auth.uid() is null then
    raise exception 'Must be signed in.';
  end if;
  if not exists (select 1 from public.profiles where id = auth.uid() and status = 'approved') then
    raise exception 'Only an approved account may search aircraft movements.';
  end if;
  if v_reg = '' then
    raise exception 'A registration is required.';
  end if;

  return query
  with candidates as (
    select cri.id as repository_id, cri.source_table, cri.source_id, cri.report_date, cri.flight_number
    from public.central_reports_index cri
    where cri.source_table in ('report_sec016', 'report_sec029')
      and cri.report_date >= v_since
      and public.has_report_access(cri.id)
  )
  select
    c.source_table,
    c.source_id,
    c.flight_number,
    c.report_date,
    (public.report_source_content(c.source_table, c.source_id) ->> 'station'),
    format('%s movement, %s', c.source_table, coalesce(c.flight_number, 'unknown flight'))
  from candidates c
  where upper(coalesce(public.report_source_content(c.source_table, c.source_id) ->> 'reg_no', public.report_source_content(c.source_table, c.source_id) ->> 'aircraft_registration', '')) = v_reg
  order by c.report_date desc
  limit v_max;
end;
$function$;

revoke execute on function public.search_movements_by_registration_secure(text, date, integer) from public, anon;
grant execute on function public.search_movements_by_registration_secure(text, date, integer) to authenticated, service_role;

-- =======================================================================
-- PART U: list_report_attachments_secure() -- atomic authorized
-- attachment listing (closes the "list first, authorize later" gap)
-- =======================================================================
-- CORRECTION: round 2's getReportAttachments() listed EVERY attachment
-- row for a (report_type, report_id) pair unconditionally, THEN
-- authorized each one individually before signing -- meaning filenames,
-- MIME types, sizes, and counts for an UNAUTHORIZED report were already
-- visible to the caller before any authorization ever ran. This
-- function reverses that order structurally: it resolves the report's
-- repository entry and calls has_report_access() FIRST, and returns
-- ZERO rows (not an error -- consistent with the generic-empty-result,
-- non-enumerable pattern used throughout) for an unauthorized or
-- unindexed report, so no attachment metadata -- not even a count --
-- is ever visible before authorization succeeds.
create or replace function public.list_report_attachments_secure(p_report_type text, p_report_id uuid)
returns table (
  id uuid,
  file_name text,
  mime_type text,
  size_bytes integer,
  created_at timestamptz
)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_repository_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Must be signed in.';
  end if;
  if not exists (select 1 from public.profiles where id = auth.uid() and status = 'approved') then
    raise exception 'Only an approved account may list report attachments.';
  end if;

  select cri.id into v_repository_id
  from public.central_reports_index cri
  where cri.source_table = p_report_type and cri.source_id = p_report_id;

  if v_repository_id is null or not public.has_report_access(v_repository_id) then
    return; -- zero rows, no error -- generic, non-enumerable
  end if;

  return query
  select a.id, a.file_name, a.mime_type, a.size_bytes, a.created_at
  from public.report_attachments a
  where a.report_type = p_report_type and a.report_id = p_report_id
  order by a.created_at asc;
end;
$function$;

revoke execute on function public.list_report_attachments_secure(text, uuid) from public, anon;
grant execute on function public.list_report_attachments_secure(text, uuid) to authenticated, service_role;

-- =======================================================================
-- PART V: export_reports_secure() v2 -- atomic, complete authorized
-- export dataset, no follow-up source-table query
-- =======================================================================
create or replace function public.export_reports_secure(
  p_max_rows integer default 1000,
  p_flight_number text default null,
  p_aoc_id uuid default null,
  p_operating_entity_code text default null,
  p_department_id uuid default null,
  p_hub_id uuid default null,
  p_station_id uuid default null,
  p_team_id uuid default null,
  p_severity text default null,
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
  content jsonb
)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_max_rows integer := least(greatest(coalesce(p_max_rows, 1000), 1), 5000);
  v_row_count integer;
begin
  if auth.uid() is null then
    raise exception 'Must be signed in.';
  end if;
  if not exists (select 1 from public.profiles where id = auth.uid() and status = 'approved') then
    raise exception 'Only an approved account may export reports.';
  end if;

  create temporary table if not exists tmp_export_result_v2 on commit drop as
  select
    cri.id, cri.source_table, public.sanitize_csv_value(cri.report_type) as report_type,
    public.sanitize_csv_value(cri.operating_entity_code) as operating_entity_code,
    public.sanitize_csv_value(cri.flight_number) as flight_number,
    cri.report_date, cri.status, cri.severity, cri.flag_state,
    public.report_source_content(cri.source_table, cri.source_id) as content
  from public.central_reports_index cri
  where public.has_report_access(cri.id)
    and (p_flight_number is null or cri.flight_number = p_flight_number)
    and (p_aoc_id is null or cri.aoc_id = p_aoc_id)
    and (p_operating_entity_code is null or cri.operating_entity_code = p_operating_entity_code)
    and (p_department_id is null or cri.department_id = p_department_id)
    and (p_hub_id is null or cri.hub_id = p_hub_id)
    and (p_station_id is null or cri.station_id = p_station_id)
    and (p_team_id is null or cri.team_id = p_team_id)
    and (p_severity is null or cri.severity = p_severity)
    and (p_flag_state is null or cri.flag_state = p_flag_state)
    and (p_status is null or cri.status = p_status)
    and (p_from_date is null or cri.report_date >= p_from_date)
    and (p_to_date is null or cri.report_date <= p_to_date)
  order by cri.indexed_at desc, cri.id
  limit v_max_rows;

  select count(*) into v_row_count from tmp_export_result_v2;

  insert into public.report_access_audit (actor_id, action, reason)
  values (auth.uid(), 'export_generated', format('rows=%s max_rows=%s', v_row_count, v_max_rows));

  return query select * from tmp_export_result_v2;
end;
$function$;

revoke execute on function public.export_reports_secure(integer, text, uuid, text, uuid, uuid, uuid, uuid, text, text, text, date, date) from public, anon;
grant execute on function public.export_reports_secure(integer, text, uuid, text, uuid, uuid, uuid, uuid, text, text, text, date, date) to authenticated, service_role;

-- =======================================================================
-- PART W: PDF/explicit-grant audit clarifications
-- =======================================================================
-- authorize_report_pdf_secure()'s 'pdf_generated' event represents BOTH
-- generation and delivery: app/api/avsec/export/pdf/[type]/[id]/route.tsx
-- renders the PDF buffer and streams it back in the SAME HTTP response
-- that triggered generation -- there is no separate, later "download"
-- step to distinguish. 'pdf_downloaded' remains a reserved, CHECK-
-- allowed action value for a future phase where generation and delivery
-- genuinely become separate steps (e.g. a pre-rendered PDF fetched later
-- from storage) -- it is intentionally unused today, not a bug.
--
-- Explicit-grant use: get_report_secure() (Part Q) already writes
-- access_reason = 'explicit_grant:<uuid>' AND the existing grant_id
-- column, in the SAME audit row as the detail_view/version_view event,
-- whenever resolve_report_access_reason() determines a grant was the
-- reason access succeeded (i.e. no earlier branch -- submitter/GRC/
-- GHOD/boss/enforcement/compliance/investigation/operational-scope --
-- matched first). That single row unambiguously records both the fact
-- and the grant reference. A separate 'explicit_grant_used' event
-- remains CHECK-allowed for a future phase that needs to audit grant
-- use independent of a specific detail/version read (e.g. at grant
-- creation time), but is not fired by this migration -- see the
-- EXPLICIT GRANT AUDIT tests for proof the existing event is sufficient.

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
--    report_attachments / report_access_audit / report_versions /
--    report_access_requests, so must go before any table-level
--    rollback; drop in this order since some reference others):
--      drop function if exists public.authorize_report_pdf_secure(uuid);
--      drop function if exists public.export_reports_secure(integer, text, uuid, text, uuid, uuid, uuid, uuid, text, text, text, date, date);
--      drop function if exists public.sanitize_csv_value(text);
--      drop function if exists public.get_report_dashboard_aggregate_secure(text);
--      drop function if exists public.get_access_request_status_secure(uuid);
--      drop function if exists public.get_report_amendments_secure(uuid);
--      drop function if exists public.get_report_version_content_secure(uuid, integer);
--      drop function if exists public.get_attachment_authorization_secure(uuid);
--      drop function if exists public.flagged_reports_secure(integer, integer);
--      drop function if exists public.list_my_submissions_secure(integer);
--      drop function if exists public.search_reports_secure(integer, integer, text, text, uuid, text, uuid, uuid, uuid, uuid, uuid, text, text, text, uuid);
--      drop function if exists public.list_reports_secure(integer, integer, text, text, text, date, date);
--      drop function if exists public.report_source_summary(text, uuid);
--
-- 2. Revert index_report() to its exact Phase 5 form (re-run its CREATE
--    OR REPLACE from 20260928000004's Part H) -- drops the version-1
--    amended_content snapshot capture; any version-1 rows already
--    populated by the corrected form keep their snapshot (this is a
--    function-behavior revert, not a data rollback).
--
-- 3. Revert get_report_secure() to its exact Phase 5 form (re-run its
--    CREATE OR REPLACE from 20260928000004's Part L) -- it must revert
--    BEFORE resolve_report_access_reason() is dropped, since the Phase
--    6-v2 body calls it; the reverted Phase 5 body does not.
--      drop function if exists public.resolve_report_access_reason(uuid);
--
-- 4. Revert has_report_access() to its exact Phase 5 form (re-run the
--    CREATE OR REPLACE from 20260928000004_phase5_report_classification_repository.sql
--    Part K) -- do not simply DROP it, since Phase 5's own functions
--    (get_report_secure(), flag_report(), unflag_report()) still depend
--    on it existing.
--
-- 5. Restore the 7 report tables' table-level SELECT grant and the 5
--    child-table SELECT policies to their pre-Phase-6 form:
--      grant select on public.report_sec013, public.report_sec014, public.report_sec016, public.report_sec018, public.report_sec029, public.report_sec033, public.offload_records to authenticated;
--      (re-run the exact CREATE POLICY statements for the 5 child
--      "via parent select" policies from avsec/0002/0009/0010/0012_*.sql,
--      matching whichever of those was actually the live production
--      form before Phase 6 -- see this migration's Part O comment for
--      the full historical policy-name list.)
--
-- 6. Revert report_access_audit's CHECK constraint to its Phase 5 form
--    and drop the access_reason column:
--      alter table public.report_access_audit drop constraint if exists report_access_audit_action_check;
--      alter table public.report_access_audit add constraint report_access_audit_action_check check (action in (
--        'view', 'version_view', 'download', 'export',
--        'access_request', 'grant', 'revoke',
--        'flag', 'unflag', 'amendment_request', 'amendment_approved', 'amendment_rejected',
--        'index', 'reindex', 'entity_confirmed', 'entity_conflict'
--      ));
--      alter table public.report_access_audit drop column if exists access_reason;
--    (Only safe once every row using a round-2 action value or the
--    access_reason column has been reviewed/archived -- unlike round 1,
--    application code IS wired to these paths this round, so real audit
--    rows may exist by the time a rollback is considered; back up
--    report_access_audit before this step in that case.)
--
-- 7. Drop the new indexes (each independent, order does not matter):
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
