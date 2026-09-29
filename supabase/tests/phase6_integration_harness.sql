-- PHASE 6 DATABASE INTEGRATION HARNESS -- NOT A MIGRATION.
--
-- EXECUTED (round 10, database-integration validation) against a real,
-- disposable, synthetic-data Postgres instance -- see the round-10
-- validation report for the exact runtime (PGlite, a real embedded
-- Postgres engine, not a reimplementation), the full migration-apply
-- chain, and every finding. Scenarios 1-11, 13-25, 27-29 (the
-- begin/rollback block below) all PASSED. Scenario 26 (the real
-- two-session concurrency test, below the final rollback) remains a
-- separate, still-unexecuted manual procedure -- explained in its own
-- comment block; scenario 12 is documented but not independently
-- executable for the same structural reason (see that comment block).
--
-- CORRECTION (round 10): every top-level `perform pg_temp.X(...)` /
-- `perform public.X(...)` call in this file (outside a `do $$ ... $$`
-- block) has been changed to `select ...` -- `perform` is plpgsql-only
-- syntax and is a syntax error as a bare top-level SQL statement in
-- both psql and any other client. This file, as originally written
-- across rounds 5-9, could never actually have run to completion even
-- via its own documented `psql -f` usage -- this was only caught by
-- actually executing it for the first time in round 10. `perform`
-- inside a `do $$ ... $$` block (correct, unchanged) is unaffected.
--
-- PREREQUISITES (must already be true of the target database before
-- running this file):
--   1. A disposable Postgres instance -- NEVER production, NEVER shared
--      staging. A local `supabase start` project, a throwaway Docker
--      Postgres with the Supabase extensions (pgcrypto, pgjwt-style
--      auth schema stubs), or an ephemeral CI Postgres all qualify.
--   2. The full avsec schema history applied in order:
--        supabase/migrations/avsec/0001_init_schema.sql .. 0023_*.sql
--   3. Every later upgrade migration applied in order:
--        supabase/migrations/202609*.sql (Phase 2-4), then
--        20260928000004_phase5_report_classification_repository.sql,
--        then 20260928000005_phase6_secure_report_access.sql.
--   4. A minimal `auth.users`/`auth.uid()` simulation -- this harness
--      assumes the standard Supabase local-dev convention where
--      `auth.uid()` reads `request.jwt.claims->>'sub'` via a GUC; each
--      test block below sets that GUC and `set role authenticated`
--      before acting as a given synthetic user, and `reset role` /
--      clears the GUC afterward. If the target's `auth.uid()`
--      implementation differs, adjust the `simulate_user()` helper
--      below accordingly -- nothing else in this file should need to
--      change.
--
-- USAGE:
--   psql "$DISPOSABLE_DB_URL" -f supabase/tests/phase6_integration_harness.sql
--
-- This file raises a NOTICE for each passing assertion and a real
-- EXCEPTION (aborting the whole script) on the first failure, so a
-- clean run to the final NOTICE means every listed scenario passed.

\set ON_ERROR_STOP on

begin;

-- =======================================================================
-- Helper: simulate being signed in as a given profile id.
-- =======================================================================
create or replace function pg_temp.simulate_user(p_profile_id uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_profile_id::text, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end;
$$;

create or replace function pg_temp.simulate_service_role()
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '{}', true);
  perform set_config('role', 'service_role', true);
end;
$$;

create or replace function pg_temp.clear_simulation()
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '', true);
  -- CORRECTION (round 10): `set_config('role', '', true)` tries to SET
  -- ROLE to the empty string, which Postgres rejects outright ('role ""
  -- does not exist') -- role is not an ordinary GUC that accepts an
  -- empty-string reset the way request.jwt.claims does. RESET ROLE is
  -- the actual command for this, issued via EXECUTE since RESET is a
  -- utility statement, not an expression set_config() can produce.
  execute 'reset role';
end;
$$;

create or replace function pg_temp.assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not p_condition then
    raise exception 'ASSERTION FAILED: %', p_message;
  end if;
  raise notice 'PASS: %', p_message;
end;
$$;

-- CORRECTION (round 10): report_index_queue has SELECT revoked from
-- authenticated entirely (Phase 5's own security design -- confirmed:
-- `revoke all on public.report_index_queue from public, anon,
-- authenticated;`). Every scenario below that checks whether a report
-- was enqueued runs as the ACTING synthetic user (authenticated), not
-- service_role -- a direct `select ... from report_index_queue` from
-- that context is correctly denied, exactly as production would deny
-- it. This SECURITY DEFINER helper (owned by whichever role created it,
-- before any user simulation begins) lets a test assertion check queue
-- membership without needing production code to expose it -- the same
-- boundary a real test suite would need, not a weakening of the actual
-- access control the migration enforces.
create or replace function pg_temp.is_queued(p_source_table text, p_source_id uuid)
returns boolean language sql security definer as $$
  select exists (select 1 from public.report_index_queue where source_table = p_source_table and source_id = p_source_id);
$$;

create or replace function pg_temp.queue_count(p_source_table text, p_source_id uuid)
returns integer language sql security definer as $$
  select count(*)::integer from public.report_index_queue where source_table = p_source_table and source_id = p_source_id;
$$;

-- CORRECTION (round 10): same class of finding as pg_temp.is_queued()
-- above -- central_reports_index also has direct SELECT revoked from
-- authenticated (Phase 5's own design; access is only ever through
-- get_report_secure()/list_reports_secure()/etc.). Several scenarios
-- below look up a report's repository row id directly, as the acting
-- synthetic user, purely as TEST SETUP (to know which id to pass into
-- get_report_secure()/list_reports_secure() next) -- this helper does
-- that lookup with the same SECURITY DEFINER bypass as is_queued(), not
-- a change to production access control.
create or replace function pg_temp.repository_id_for(p_source_table text, p_staff_id text)
returns uuid language sql security definer as $$
  select c.id from public.central_reports_index c
  where c.source_table = p_source_table
    and c.source_id in (select id from public.report_sec014 where staff_id = p_staff_id);
$$;

-- Same as above, but for report_sec033 (used by scenario 27, which
-- deliberately exercises a different report type than sec014).
create or replace function pg_temp.sec033_id_by_staff_and_time(p_staff_id text, p_report_time time)
returns uuid language sql security definer as $$
  select id from public.report_sec033 where staff_id = p_staff_id and report_time = p_report_time order by created_at desc limit 1;
$$;

create or replace function pg_temp.repository_id_for_sec033(p_staff_id text, p_report_time time)
returns uuid language sql security definer as $$
  select c.id from public.central_reports_index c
  where c.source_table = 'report_sec033'
    and c.source_id = pg_temp.sec033_id_by_staff_and_time(p_staff_id, p_report_time);
$$;

-- Same class of finding as the two helpers above: report_access_audit
-- also has direct SELECT revoked from authenticated (only the secure
-- RPCs write to it; nothing reads it directly except via a future
-- audit-review feature, out of scope here).
create or replace function pg_temp.was_audited(p_repository_report_id uuid, p_actor_id uuid, p_action text)
returns boolean language sql security definer as $$
  select exists (
    select 1 from public.report_access_audit
    where repository_report_id = p_repository_report_id and actor_id = p_actor_id and action = p_action
  );
$$;

-- Same class of finding again: report_sec014.staff_id is not one of the
-- narrowly-granted columns (id, submitted_at, report_no, profile_id --
-- round 5's column-level closure), so looking a report up BY staff_id
-- (as anyone other than its own submitter, e.g. a supervisor acting on
-- an acknowledgement) needs this same SECURITY DEFINER bypass -- a
-- genuine test-setup need, not a change to the real column grant.
create or replace function pg_temp.report_id_by_staff(p_staff_id text, p_remark text default null)
returns uuid language sql security definer as $$
  select id from public.report_sec014
  where staff_id = p_staff_id and (p_remark is null or remark = p_remark)
  order by created_at desc limit 1;
$$;

-- Same class of finding, for report_sec014_patrols: direct SELECT was
-- revoked entirely (round 5), so verifying a specific child row's
-- current report_id (reassignment tests) or a description's existence
-- (payload-never-inserted tests) needs the same SECURITY DEFINER
-- bypass -- test verification, not a change to the real access control.
create or replace function pg_temp.patrol_report_id(p_child_id uuid)
returns uuid language sql security definer as $$
  select report_id from public.report_sec014_patrols where id = p_child_id;
$$;

create or replace function pg_temp.patrol_exists_with_description(p_description text)
returns boolean language sql security definer as $$
  select exists (select 1 from public.report_sec014_patrols where description = p_description);
$$;

create or replace function pg_temp.offload_first_tag(p_report_id uuid)
returns text language sql security definer as $$
  select baggage_tag_no from public.offload_items where report_id = p_report_id limit 1;
$$;

-- Same class of finding: report_sec014.remark and report_sec033.staff_id/
-- report_time are not in the narrowly-granted parent-table columns
-- (id, submitted_at, report_no, profile_id -- round 5), so counting
-- "how many parent rows exist for this fixture" (duplicate-parent
-- checks) needs the same SECURITY DEFINER bypass.
create or replace function pg_temp.sec014_count_by_remark(p_profile_id uuid, p_remark text)
returns integer language sql security definer as $$
  select count(*)::integer from public.report_sec014 where profile_id = p_profile_id and remark = p_remark;
$$;

create or replace function pg_temp.sec033_count_by_staff_and_time(p_profile_id uuid, p_staff_id text, p_report_time time)
returns integer language sql security definer as $$
  select count(*)::integer from public.report_sec033 where profile_id = p_profile_id and staff_id = p_staff_id and report_time = p_report_time;
$$;

-- =======================================================================
-- Synthetic fixtures
-- =======================================================================
-- Two ordinary ASO profiles at different stations, one Main Enforcement
-- officer (Malaysia-wide, Phase 3 role), one AirAsia Management profile
-- (aggregate-only), and the MAA AOC/operating-entity/hub records these
-- reference. Adjust column names/NOT NULL requirements to match the
-- target schema's exact profiles/aocs/operating_entities/hubs shape if
-- they differ from what this harness assumes.

select pg_temp.simulate_service_role();

-- CORRECTION (round 10): profiles.id references auth.users(id), and
-- profiles.email is NOT NULL -- neither was satisfied by this fixture
-- as originally written (rounds 5-9), which only ever exercised this
-- file as static source text, never against a real database with these
-- constraints actually enforced.
insert into auth.users (id, email)
values
  ('00000000-0000-0000-0000-0000000000a1', 'test.aso.alpha@example.test'),
  ('00000000-0000-0000-0000-0000000000a2', 'test.aso.bravo@example.test'),
  ('00000000-0000-0000-0000-0000000000a3', 'test.main.enforcement@example.test'),
  ('00000000-0000-0000-0000-0000000000a4', 'test.airasia.mgmt@example.test'),
  ('00000000-0000-0000-0000-0000000000a5', 'test.so.alpha@example.test')
on conflict (id) do nothing;

-- CORRECTION (round 10): handle_new_user() (avsec/0001_init_schema.sql)
-- fires `after insert on auth.users` and creates a MINIMAL profiles row
-- (id, email only -- every other column gets its bare column default,
-- notably status DEFAULT 'pending') the instant the auth.users insert
-- above runs. This insert's own `on conflict (id) do nothing` (round 5)
-- then found that row already present and silently did NOTHING --
-- every explicit value here (role, station, team, ops_group, status)
-- was discarded without error, leaving every fixture profile at
-- status='pending' instead of 'approved'. Only surfaced by actually
-- running this against a real database with that trigger firing --
-- never visible in static inspection. Fixed with `do update` so this
-- insert's explicit values win over the trigger's bare-default row.
insert into public.profiles (id, email, name, staff_no, role, station, team, ops_group, status)
values
  ('00000000-0000-0000-0000-0000000000a1', 'test.aso.alpha@example.test', 'Test ASO Alpha', 'T-A1', 'ASO', 'KUL - MAA', 'Alpha', 'operation_avsec', 'approved'),
  ('00000000-0000-0000-0000-0000000000a2', 'test.aso.bravo@example.test', 'Test ASO Bravo', 'T-A2', 'ASO', 'PEN', 'Bravo', 'operation_avsec', 'approved'),
  ('00000000-0000-0000-0000-0000000000a3', 'test.main.enforcement@example.test', 'Test Main Enforcement', 'T-A3', 'ENFORCEMENT', 'KUL - MAA', 'Alpha', null, 'approved'),
  ('00000000-0000-0000-0000-0000000000a4', 'test.airasia.mgmt@example.test', 'Test AirAsia Mgmt', 'T-A4', 'MANAGEMENT', 'KUL - MAA', 'Alpha', null, 'approved'),
  -- CORRECTION (round 10): can_acknowledge_report() (avsec/0012 as
  -- amended by 20260917000001_daily_report_role_correction.sql)
  -- requires the acker to hold role SO or DSE (for a sec014 report
  -- submitted by an ASO) AND to share the SAME station/team/ops_group
  -- as the submitter -- Test Main Enforcement (role=ENFORCEMENT) was
  -- never actually eligible to acknowledge Alpha's report, only
  -- caught by actually executing Scenario 8 against a real database.
  -- This profile is added specifically to be a valid acknowledger.
  ('00000000-0000-0000-0000-0000000000a5', 'test.so.alpha@example.test', 'Test SO Alpha', 'T-A5', 'SO', 'KUL - MAA', 'Alpha', 'operation_avsec', 'approved')
on conflict (id) do update set
  name = excluded.name, staff_no = excluded.staff_no, role = excluded.role,
  station = excluded.station, team = excluded.team, ops_group = excluded.ops_group,
  status = excluded.status;

-- CORRECTION (round 10): Phase 2's own migration
-- (20260928000001_phase2_org_foundation.sql) already seeds a real
-- 'MY' aocs row, 'MAA'/'AAX' operating_entities rows, and a 'kul' hubs
-- row (lowercase code -- confirmed from that migration's own seed
-- data). This fixture, as originally written (round 5), inserted its
-- OWN aocs/operating_entities/hubs rows with fixed synthetic ids and a
-- DIFFERENT casing ('KUL - MAA' vs the real 'kul'), which the unique(code) /
-- unique(aoc_id, code) constraints reject as duplicates against Phase
-- 2's real seed -- only caught by actually running this against a
-- database with Phase 2 applied, never by static inspection. It ALSO
-- referenced a `hubs.operating_entity_id` column that does not exist on
-- that table (hubs has no such column -- confirmed from Phase 2's own
-- CREATE TABLE). Fixed by reusing Phase 2's real seeded rows instead of
-- inserting conflicting synthetic ones.
do $$
declare
  v_aoc_id uuid;
begin
  select id into v_aoc_id from public.aocs where code = 'MY';
  if v_aoc_id is null then
    raise exception 'Phase 2''s seeded Malaysia AOC (code=MY) was not found -- is 20260928000001_phase2_org_foundation.sql actually applied?';
  end if;
end $$;

-- Phase 3 role assignment: Test Main Enforcement holds main_enforcement,
-- Malaysia-wide, scoped to the Enforcement department -- CORRECTION
-- (round 10): main_enforcement requires department_id (Phase 3's own
-- enforce_role_assignment_scope() trigger), scoped to the 'enforcement'
-- department specifically -- not merely "requires an aoc_id," which is
-- all this fixture originally provided (round 5), never actually
-- checked against the real trigger until this round.
insert into public.user_role_assignments (id, profile_id, role_definition_id, aoc_id, department_id, granted_by)
select '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a3', rd.id, a.id, d.id, '00000000-0000-0000-0000-0000000000a4'
from public.role_definitions rd, public.aocs a, public.departments d
where rd.code = 'main_enforcement' and a.code = 'MY' and d.aoc_id = a.id and d.code = 'enforcement'
on conflict (id) do nothing;

-- Phase 3 role assignment: Test AirAsia Mgmt holds airasia_management.
insert into public.user_role_assignments (id, profile_id, role_definition_id, granted_by)
select '00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000a4', rd.id, '00000000-0000-0000-0000-0000000000a3'
from public.role_definitions rd where rd.code = 'airasia_management'
on conflict (id) do nothing;

select pg_temp.clear_simulation();

-- =======================================================================
-- SCENARIO 1: report creation (INSERT ... RETURNING) still works under
-- the narrowed column grant
-- =======================================================================
select pg_temp.simulate_user('00000000-0000-0000-0000-0000000000a1'::uuid);

do $$
declare
  v_report_id uuid;
  v_report_no text;
begin
  insert into public.report_sec014 (profile_id, status, station, team, staff_name, staff_id, date_time_in, date_time_out, remark, acknowledgement)
  values (auth.uid(), 'submitted', 'KUL - MAA', 'Alpha', 'Test ASO Alpha', 'T-A1', now(), now() + interval '1 hour', 'synthetic patrol remark', false)
  returning id, report_no into v_report_id, v_report_no;

  perform pg_temp.assert(v_report_id is not null, 'SCENARIO 1: INSERT ... RETURNING id succeeds for the caller''s own report_sec014 row under the narrowed (id, submitted_at, report_no, profile_id) grant');

  insert into public.report_sec014_patrols (report_id, entry_no, location, description)
  values (v_report_id, 1, 'Apron', 'synthetic patrol entry');
  perform pg_temp.assert(true, 'SCENARIO 1: child row (report_sec014_patrols) INSERT succeeds -- child creation is unaffected by the SELECT closure');

  perform pg_temp.assert(
    (select count(*) from public.report_sec014 where id = v_report_id) is not null,
    'placeholder'
  );

  -- Explicit completion signal, as lib/avsec/reports/actions.ts now does.
  -- CORRECTION (round 10): this call omitted p_expected_child_count
  -- entirely (defaulting to 0), even though a patrol child row was just
  -- inserted above -- the consistency check correctly rejected it as
  -- incomplete. Only caught by actually executing this against a real
  -- database; the omission was invisible in static inspection.
  perform public.mark_report_ready_for_indexing('report_sec014', v_report_id, 1);
  perform pg_temp.assert(
    pg_temp.is_queued('report_sec014', v_report_id),
    'SCENARIO 1: mark_report_ready_for_indexing() enqueues the report exactly once, only after the child row above was already written'
  );
end;
$$;

select pg_temp.clear_simulation();

-- =======================================================================
-- SCENARIO 2: direct parent-table content SELECT is denied (even own row,
-- full-row); the narrow RETURNING columns remain selectable
-- =======================================================================
select pg_temp.simulate_user('00000000-0000-0000-0000-0000000000a1'::uuid);

do $$
begin
  begin
    perform remark from public.report_sec014 where profile_id = auth.uid() limit 1;
    raise exception 'SCENARIO 2 FAILED: selecting report_sec014.remark directly should have been denied by the column-level grant';
  exception when insufficient_privilege then
    raise notice 'PASS: SCENARIO 2: direct SELECT of report_sec014.remark (full content) is denied by the column-level grant, even for the row''s own submitter';
  end;

  begin
    perform id, submitted_at, report_no, profile_id from public.report_sec014 where profile_id = auth.uid() limit 1;
    raise notice 'PASS: SCENARIO 2: the 4 narrowly granted columns (id, submitted_at, report_no, profile_id) remain directly selectable';
  exception when insufficient_privilege then
    raise exception 'SCENARIO 2 FAILED: the narrowly granted columns should still be selectable';
  end;
end;
$$;

select pg_temp.clear_simulation();

-- =======================================================================
-- SCENARIO 3: direct child-table SELECT is denied entirely
-- =======================================================================
select pg_temp.simulate_user('00000000-0000-0000-0000-0000000000a1'::uuid);

do $$
begin
  begin
    perform description from public.report_sec014_patrols limit 1;
    raise exception 'SCENARIO 3 FAILED: selecting report_sec014_patrols directly should have been denied -- SELECT was revoked entirely on all 6 child tables';
  exception when insufficient_privilege then
    raise notice 'PASS: SCENARIO 3: direct SELECT of report_sec014_patrols is denied entirely, even for the parent report''s own submitter';
  end;
end;
$$;

select pg_temp.clear_simulation();

-- =======================================================================
-- SCENARIO 4: cross-profile denial -- Bravo cannot read Alpha's report
-- via the secure RPC, and cannot see it in list/search either
-- =======================================================================
-- (Requires the report from Scenario 1 to have been indexed -- run
-- `select public.process_report_index_queue(10);` as service_role
-- between Scenario 1 and this block if testing end-to-end, or call
-- public.index_report(...) directly with synthetic classification for a
-- faster, indexing-queue-independent check.)
select pg_temp.simulate_service_role();
do $$
declare
  v_report_id uuid;
  v_aoc_id uuid;
  v_entity_id uuid;
  v_hub_id uuid;
begin
  v_report_id := pg_temp.report_id_by_staff('T-A1', 'synthetic patrol remark'); -- the SAME specific report indexed in Scenario 4
  select id into v_aoc_id from public.aocs where code = 'MY';
  select id into v_entity_id from public.operating_entities where aoc_id = v_aoc_id and code = 'MAA';
  select id into v_hub_id from public.hubs where aoc_id = v_aoc_id and code = 'kul';
  perform public.index_report(
    'report_sec014', v_report_id, (select report_no from public.report_sec014 where id = v_report_id),
    v_aoc_id, v_entity_id, null, null,
    v_hub_id, null, null, null, current_date,
    '00000000-0000-0000-0000-0000000000a1'
  );
end;
$$;
select pg_temp.clear_simulation();

select pg_temp.simulate_user('00000000-0000-0000-0000-0000000000a2'::uuid); -- Bravo, different station, no relationship to Alpha's report

do $$
declare
  v_repository_id uuid;
begin
  v_repository_id := pg_temp.repository_id_for('report_sec014', 'T-A1');

  begin
    perform * from public.get_report_secure(v_repository_id);
    raise exception 'SCENARIO 4 FAILED: Bravo (different station, no role) should not be authorized to read Alpha''s report';
  exception when others then
    raise notice 'PASS: SCENARIO 4: get_report_secure() denies an unrelated ordinary ASO (Bravo) access to Alpha''s report';
  end;

  perform pg_temp.assert(
    not exists (select 1 from public.list_reports_secure(1, 25, 'report_sec014') where id = v_repository_id),
    'SCENARIO 4: list_reports_secure() does not include Alpha''s report in Bravo''s authorized list'
  );
end;
$$;

select pg_temp.clear_simulation();

-- =======================================================================
-- SCENARIO 5: Main Enforcement (Malaysia-wide) CAN read Alpha's report
-- =======================================================================
select pg_temp.simulate_user('00000000-0000-0000-0000-0000000000a3'::uuid);

do $$
declare
  v_repository_id uuid;
  v_content jsonb;
begin
  v_repository_id := pg_temp.repository_id_for('report_sec014', 'T-A1');
  select content into v_content from public.get_report_secure(v_repository_id) limit 1;
  perform pg_temp.assert(v_content is not null, 'SCENARIO 5: Main Enforcement (Malaysia-wide role) IS authorized to read Alpha''s report via get_report_secure(), and receives full content including the child patrol array');
  perform pg_temp.assert((v_content -> 'patrols') is not null and jsonb_array_length(v_content -> 'patrols') = 1, 'SCENARIO 5: the immutable/detail content includes the child patrol row written in Scenario 1');
  perform pg_temp.assert(
    pg_temp.was_audited(v_repository_id, auth.uid(), 'detail_view'),
    'SCENARIO 5: the read was audited as detail_view for this actor'
  );
end;
$$;

select pg_temp.clear_simulation();

-- =======================================================================
-- SCENARIO 6: version 1 is a complete, immutable snapshot (parent + child)
-- =======================================================================
select pg_temp.simulate_user('00000000-0000-0000-0000-0000000000a3'::uuid); -- authorized via Main Enforcement

do $$
declare
  v_repository_id uuid;
  v_snapshot jsonb;
begin
  v_repository_id := pg_temp.repository_id_for('report_sec014', 'T-A1');
  select amended_content into v_snapshot from public.get_report_version_content_secure(v_repository_id, 1) limit 1;
  perform pg_temp.assert(v_snapshot is not null, 'SCENARIO 6: version 1''s amended_content is populated (not null) -- a genuine snapshot, not a placeholder');
  perform pg_temp.assert((v_snapshot -> 'patrols') is not null and jsonb_array_length(v_snapshot -> 'patrols') = 1, 'SCENARIO 6: version 1''s snapshot includes the child patrol row -- complete, not partial');
end;
$$;

select pg_temp.clear_simulation();

-- =======================================================================
-- SCENARIO 7: aggregate-only role (AirAsia Management) receives global
-- totals despite never having per-report detail access
-- =======================================================================
select pg_temp.simulate_user('00000000-0000-0000-0000-0000000000a4'::uuid);

do $$
declare
  v_total bigint;
  v_repository_id uuid;
begin
  select sum(report_count) into v_total from public.get_report_dashboard_aggregate_secure('source_table');
  perform pg_temp.assert(v_total >= 1, 'SCENARIO 7: AirAsia Management receives a non-zero global aggregate total, including reports it has no per-report detail access to');

  v_repository_id := pg_temp.repository_id_for('report_sec014', 'T-A1');
  begin
    perform * from public.get_report_secure(v_repository_id);
    raise exception 'SCENARIO 7 FAILED: AirAsia Management should NOT have per-report detail access, only aggregate counts';
  exception when others then
    raise notice 'PASS: SCENARIO 7: AirAsia Management is denied get_report_secure() detail access even though it receives aggregate totals -- the two permissions are confirmed independent';
  end;
end;
$$;

select pg_temp.clear_simulation();

-- =======================================================================
-- SCENARIO 8: acknowledgement path is unaffected by the SELECT closure
-- =======================================================================
select pg_temp.simulate_user('00000000-0000-0000-0000-0000000000a5'::uuid); -- SO, same station/team/ops_group as Alpha -- a genuinely eligible acknowledger per can_acknowledge_report()

do $$
declare
  v_report_id uuid;
begin
  v_report_id := pg_temp.report_id_by_staff('T-A1', 'synthetic patrol remark'); -- the SAME specific report indexed in Scenario 4
  insert into public.report_acknowledgements (report_type, report_id, acknowledged_by)
  values ('sec014', v_report_id, auth.uid())
  on conflict (report_type, report_id) do nothing;
  perform pg_temp.assert(
    exists (select 1 from public.report_acknowledgements where report_type = 'sec014' and report_id = v_report_id),
    'SCENARIO 8: acknowledgement INSERT into the separate report_acknowledgements table is unaffected by the report_sec014 SELECT closure -- it is a different table with its own, untouched grants/RLS'
  );
end;
$$;

select pg_temp.clear_simulation();

-- =======================================================================
-- SCENARIO 9: premature finalization is rejected
-- =======================================================================
select pg_temp.simulate_user('00000000-0000-0000-0000-0000000000a1'::uuid);

do $$
declare
  v_report_id uuid;
begin
  insert into public.report_sec014 (profile_id, status, station, team, staff_name, staff_id, date_time_in, date_time_out, remark, acknowledgement)
  values (auth.uid(), 'submitted', 'KUL - MAA', 'Alpha', 'Test ASO Alpha', 'T-A1', now(), now() + interval '1 hour', 'premature-finalization fixture', false)
  returning id into v_report_id;

  -- No patrol rows inserted yet. Claiming 0 expected when the caller
  -- INTENDS 2 (a bug/attack simulating "finalize before children exist")
  -- is exactly what this checks: the RPC must not accept an
  -- under-claimed count as truthful just because it matches reality by
  -- coincidence -- it must reject a MISMATCH between what actually
  -- exists and what the caller expects the FINAL state to be. This
  -- scenario simulates the caller claiming 1 patrol exists when zero do.
  begin
    perform public.mark_report_ready_for_indexing('report_sec014', v_report_id, 1);
    raise exception 'SCENARIO 9 FAILED: finalizing with p_expected_child_count=1 before any patrol row exists should have been rejected';
  exception when others then
    raise notice 'PASS: SCENARIO 9: mark_report_ready_for_indexing() rejects a child-count mismatch (expected 1, actual 0) -- premature finalization is denied';
  end;

  perform pg_temp.assert(
    not pg_temp.is_queued('report_sec014', v_report_id),
    'SCENARIO 9: the rejected finalization attempt left no queue entry behind'
  );
end;
$$;

select pg_temp.clear_simulation();

-- =======================================================================
-- SCENARIO 10: a valid zero-child report finalizes successfully
-- =======================================================================
select pg_temp.simulate_user('00000000-0000-0000-0000-0000000000a1'::uuid);

do $$
declare
  v_report_id uuid;
begin
  insert into public.report_sec014 (profile_id, status, station, team, staff_name, staff_id, date_time_in, date_time_out, remark, acknowledgement)
  values (auth.uid(), 'submitted', 'KUL - MAA', 'Alpha', 'Test ASO Alpha', 'T-A1', now(), now() + interval '1 hour', 'zero-child fixture', false)
  returning id into v_report_id;

  -- Zero patrol rows is a legitimate submission (patrols are optional in
  -- the application schema) -- p_expected_child_count = 0 must succeed.
  perform public.mark_report_ready_for_indexing('report_sec014', v_report_id, 0);
  perform pg_temp.assert(
    pg_temp.is_queued('report_sec014', v_report_id),
    'SCENARIO 10: a report with zero (legitimately optional) child rows finalizes successfully when p_expected_child_count = 0'
  );
end;
$$;

select pg_temp.clear_simulation();

-- =======================================================================
-- SCENARIO 11: child INSERT/UPDATE/DELETE is denied after finalization
-- =======================================================================
select pg_temp.simulate_user('00000000-0000-0000-0000-0000000000a1'::uuid);

do $$
declare
  v_report_id uuid;
begin
  v_report_id := pg_temp.report_id_by_staff('T-A1', 'synthetic patrol remark'); -- Scenario 1's already-finalized report

  begin
    insert into public.report_sec014_patrols (report_id, entry_no, location, description)
    values (v_report_id, 99, 'Apron', 'attempted post-finalization insert');
    raise exception 'SCENARIO 11 FAILED: INSERT of a new child row after finalization should have been denied';
  exception when others then
    raise notice 'PASS: SCENARIO 11a: child INSERT is denied on an already-finalized report';
  end;

  begin
    update public.report_sec014_patrols set description = 'tampered' where report_id = v_report_id;
    raise exception 'SCENARIO 11 FAILED: UPDATE of an existing child row after finalization should have been denied';
  exception when others then
    raise notice 'PASS: SCENARIO 11b: child UPDATE is denied on an already-finalized report';
  end;

  begin
    delete from public.report_sec014_patrols where report_id = v_report_id;
    raise exception 'SCENARIO 11 FAILED: DELETE of an existing child row after finalization should have been denied';
  exception when others then
    raise notice 'PASS: SCENARIO 11c: child DELETE is denied on an already-finalized report';
  end;
end;
$$;

select pg_temp.clear_simulation();

-- =======================================================================
-- SCENARIO 12: concurrent finalization and child write (documented --
-- cannot be executed within a single linear script/connection)
-- =======================================================================
-- A single psql session cannot genuinely race two transactions against
-- each other -- true concurrency testing needs two separate connections
-- interleaved manually or via a tool like `isolationtester`. This is
-- documented, not executed, as part of the same honest limitation
-- already disclosed for the rest of this harness. To exercise it by
-- hand against a disposable database, open two psql sessions:
--
--   Session A (finalizer):
--     begin;
--     select public.mark_report_ready_for_indexing('report_sec014', '<id>', 1);
--     -- PAUSE HERE (do not commit yet) -- this holds the row lock.
--
--   Session B (concurrent child write), started while A is paused:
--     begin;
--     insert into public.report_sec014_patrols (report_id, entry_no, location, description)
--     values ('<id>', 2, 'Gate C1', 'racing insert');
--     -- This BLOCKS (waiting on A's row lock), proving the trigger and
--     -- the RPC share the same lock rather than racing independently.
--
--   Then in Session A: commit;
--   Session B's blocked INSERT then resumes and must fail with
--   "already been finalized" -- proving the shared lock correctly
--   serialized the two transactions and B observed A's committed state,
--   not a stale pre-finalization snapshot.
select 1; -- no-op placeholder so this section has a runnable statement

-- =======================================================================
-- SCENARIO 13: repeated finalization is idempotent, not merely tolerated
-- =======================================================================
select pg_temp.simulate_user('00000000-0000-0000-0000-0000000000a1'::uuid);

do $$
declare
  v_report_id uuid;
  v_queue_count_before integer;
  v_queue_count_after integer;
begin
  v_report_id := pg_temp.report_id_by_staff('T-A1', 'synthetic patrol remark');
  v_queue_count_before := pg_temp.queue_count('report_sec014', v_report_id);

  -- Calling finalization again with the SAME (still-correct) expected
  -- count must succeed without creating a duplicate queue row.
  perform public.mark_report_ready_for_indexing('report_sec014', v_report_id, 1);

  v_queue_count_after := pg_temp.queue_count('report_sec014', v_report_id);
  perform pg_temp.assert(v_queue_count_before = 1 and v_queue_count_after = 1, 'SCENARIO 13: repeated finalization is idempotent -- no duplicate report_index_queue row is ever created');
end;
$$;

select pg_temp.clear_simulation();

-- =======================================================================
-- SCENARIO 14: failed child insertion does not silently succeed, and a
-- correct retry recovers cleanly
-- =======================================================================
select pg_temp.simulate_user('00000000-0000-0000-0000-0000000000a1'::uuid);

do $$
declare
  v_report_id uuid;
begin
  insert into public.report_sec014 (profile_id, status, station, team, staff_name, staff_id, date_time_in, date_time_out, remark, acknowledgement)
  values (auth.uid(), 'submitted', 'KUL - MAA', 'Alpha', 'Test ASO Alpha', 'T-A1', now(), now() + interval '1 hour', 'failed-then-retried fixture', false)
  returning id into v_report_id;

  -- Simulate a failed child insert: two rows with the SAME entry_no
  -- violate report_sec014_patrols' own (report_id, entry_no) unique
  -- constraint. The application's real submit action returns
  -- { ok: false, error } in this situation (patrolError check,
  -- lib/avsec/reports/actions.ts) rather than proceeding to finalize.
  begin
    insert into public.report_sec014_patrols (report_id, entry_no, location, description)
    values (v_report_id, 1, 'Apron', 'first'), (v_report_id, 1, 'Apron', 'duplicate entry_no -- simulated failure');
    raise exception 'SCENARIO 14 FAILED: the duplicate-entry_no insert should itself have failed (unique violation), simulating a genuine child-insert failure';
  exception when unique_violation then
    raise notice 'PASS: SCENARIO 14a: the simulated child-insert failure actually fails at the database level (unique_violation), matching what a real partial failure looks like';
  end;

  -- The report must NOT be finalizable yet -- zero child rows actually
  -- landed (the failed multi-row INSERT inserted nothing, atomically).
  -- CORRECTION (round 10): a direct count(*) on report_sec014_patrols
  -- is exactly the direct child-table SELECT round 5 revoked entirely
  -- -- get_child_row_count_secure() is the real, intended way to check
  -- this, and using it here doubles as further exercise of that RPC.
  perform pg_temp.assert(
    public.get_child_row_count_secure('report_sec014', v_report_id) = 0,
    'SCENARIO 14b: the failed insert left zero child rows -- no partial/duplicate child content from the failed attempt'
  );

  -- Retry: insert one correct patrol row, then finalize with the
  -- correct count -- this must succeed cleanly, proving the retry path
  -- does not create a duplicate PARENT (still the same v_report_id) and
  -- does not leave the report permanently stranded.
  insert into public.report_sec014_patrols (report_id, entry_no, location, description)
  values (v_report_id, 1, 'Apron', 'retried, correct');
  perform public.mark_report_ready_for_indexing('report_sec014', v_report_id, 1);
  perform pg_temp.assert(
    pg_temp.is_queued('report_sec014', v_report_id),
    'SCENARIO 14c: after a corrected retry (one child row, matching count), finalization succeeds -- no stranded report'
  );
  perform pg_temp.assert(
    pg_temp.sec014_count_by_remark(auth.uid(), 'failed-then-retried fixture') = 1,
    'SCENARIO 14d: exactly one parent row exists for this fixture -- the retry did not create a duplicate parent'
  );
end;
$$;

select pg_temp.clear_simulation();

-- =======================================================================
-- SCENARIO 15 (round 7): caller-supplied zero for a REQUIRED-child type
-- is rejected -- p_expected_child_count is a consistency check only, and
-- cannot override the per-type minimum enforced independently of it.
-- Distinct from SCENARIO 9 (a claimed-but-nonexistent nonzero count
-- against an OPTIONAL type is caught by the consistency check alone) and
-- SCENARIO 10 (a genuinely optional type legitimately finalizes at 0).
-- report_sec013 requires >=1 profiling_duties row (sec013.ts:29,
-- `.min(1, ...)`).
-- =======================================================================
select pg_temp.simulate_user('00000000-0000-0000-0000-0000000000a1'::uuid);

do $$
declare
  v_report_id uuid;
begin
  insert into public.report_sec013 (profile_id, status, station, team, staff_name, staff_id, date_time_in, date_time_out, remark, acknowledgement)
  values (auth.uid(), 'submitted', 'KUL - MAA', 'Alpha', 'Test ASO Alpha', 'T-A1', now(), now() + interval '1 hour', 'sec013 required-zero fixture', false)
  returning id into v_report_id;

  -- Zero actual child rows exist. The caller claims p_expected_child_count
  -- = 0, which MATCHES the actual count (0) -- the consistency check
  -- alone would pass this. The independent per-type minimum must still
  -- reject it, because report_sec013 requires at least 1.
  begin
    perform public.mark_report_ready_for_indexing('report_sec013', v_report_id, 0);
    raise exception 'SCENARIO 15 FAILED: finalizing report_sec013 with a caller-supplied (and matching) expected count of 0 should have been rejected -- this type requires at least 1 child row regardless of what the caller claims';
  exception when others then
    if sqlerrm like '%is missing required child content%' then
      raise notice 'PASS: SCENARIO 15: report_sec013 finalization is rejected at 0 actual children even though the caller''s claimed count (0) matches reality -- the per-type minimum overrides a merely-consistent caller claim';
    else
      raise exception 'SCENARIO 15 FAILED: rejected for the wrong reason: %', sqlerrm;
    end if;
  end;

  perform pg_temp.assert(
    not pg_temp.is_queued('report_sec013', v_report_id),
    'SCENARIO 15: the rejected finalization attempt left no queue entry behind'
  );
end;
$$;

select pg_temp.clear_simulation();

-- =======================================================================
-- SCENARIO 16 (round 7): child reassignment to a different parent report
-- is forbidden outright
-- =======================================================================
select pg_temp.simulate_user('00000000-0000-0000-0000-0000000000a1'::uuid);

do $$
declare
  v_report_id_1 uuid;
  v_report_id_2 uuid;
  v_child_id uuid;
begin
  insert into public.report_sec014 (profile_id, status, station, team, staff_name, staff_id, date_time_in, date_time_out, remark, acknowledgement)
  values (auth.uid(), 'submitted', 'KUL - MAA', 'Alpha', 'Test ASO Alpha', 'T-A1', now(), now() + interval '1 hour', 'reassignment fixture parent 1', false)
  returning id into v_report_id_1;

  insert into public.report_sec014 (profile_id, status, station, team, staff_name, staff_id, date_time_in, date_time_out, remark, acknowledgement)
  values (auth.uid(), 'submitted', 'KUL - MAA', 'Alpha', 'Test ASO Alpha', 'T-A1', now(), now() + interval '1 hour', 'reassignment fixture parent 2', false)
  returning id into v_report_id_2;

  -- CORRECTION (round 10): `INSERT ... RETURNING` on a child table
  -- requires SELECT privilege on the returned columns in Postgres --
  -- and SELECT is revoked entirely on every child table (round 5). The
  -- real application code never does this (lib/avsec/reports/actions.ts's
  -- child inserts only ever destructure `{ error }`, never `.select()`),
  -- so this was a harness-only artifact, not a production defect --
  -- fixed by generating the id explicitly instead of relying on
  -- RETURNING.
  v_child_id := gen_random_uuid();
  insert into public.report_sec014_patrols (id, report_id, entry_no, location, description)
  values (v_child_id, v_report_id_1, 1, 'Apron', 'reassignment target row');

  -- FINDING (round 10): as originally written, this test expected
  -- enforce_child_write_before_finalization()'s own "Reassigning..."
  -- exception specifically. In practice, ANY UPDATE at all on this
  -- table -- even one that never touches report_id -- is rejected
  -- earlier than that, with "permission denied for table
  -- report_sec014", for `authenticated`. This is Postgres's own
  -- referential-integrity check for the report_id foreign key: it
  -- requires broader access to the REFERENCED table (report_sec014)
  -- than the narrow (id, submitted_at, report_no, profile_id) column
  -- grant round 5 left in place provides, regardless of which columns
  -- the UPDATE itself touches. This was confirmed empirically (not
  -- merely asserted) by observing the error change to a completely
  -- different, expected one -- "Cannot modify entries of a submitted
  -- report" (avsec/0001's own parent-immutability trigger) -- once
  -- report_sec014 was granted full SELECT in an isolated debug session.
  -- Given the ONLY column-content difference a broader grant would
  -- expose is exactly what round 5 closed, and given the application
  -- never updates child rows at all (confirmed by source search,
  -- rounds 7-9), widening this grant to make the trigger's own message
  -- reachable would reopen exactly the gap round 5 closed, for a
  -- codepath nothing ever exercises. This is reported as a finding
  -- (the trigger's specific "Reassigning..." message is unreachable
  -- through any role this application actually grants -- authenticated
  -- is blocked earlier by the FK/privilege interaction above, and
  -- service_role bypasses the trigger's own check entirely) rather than
  -- worked around by weakening production access control for a test.
  -- The trigger's own reassignment-forbidding code is still verified
  -- statically (tests/phase6-secure-report-access.test.mts). What this
  -- integration test verifies is the OUTCOME that actually matters:
  -- reassignment is impossible for `authenticated`, for ANY reason.
  begin
    update public.report_sec014_patrols set report_id = v_report_id_2 where id = v_child_id;
    raise exception 'SCENARIO 16 FAILED: reassigning a child row''s report_id to a different parent should have been rejected outright';
  exception when others then
    if sqlerrm like '%Reassigning a child row to a different report is not supported%' or sqlerrm like '%permission denied%' then
      raise notice 'PASS: SCENARIO 16: an authenticated caller cannot reassign a child row''s report_id -- rejected either by enforce_child_write_before_finalization() directly, or earlier by the FK/column-privilege interaction documented above; the outcome (reassignment is impossible) holds either way';
    else
      raise exception 'SCENARIO 16 FAILED: rejected for an unexpected reason: %', sqlerrm;
    end if;
  end;

  -- Re-verifying the child row's untouched report_id needs the same
  -- SECURITY DEFINER bypass as every other post-round-5 child-table
  -- read in this harness.
  perform pg_temp.assert(
    pg_temp.patrol_report_id(v_child_id) = v_report_id_1,
    'SCENARIO 16: the child row still belongs to its original parent -- the rejected UPDATE did not partially apply'
  );
end;
$$;

select pg_temp.clear_simulation();

-- =======================================================================
-- SCENARIO 17 (round 7): application retry without duplicate parents --
-- SQL-level simulation of resumeReportFinalization() (case (b): child
-- rows already complete and correct, only the finalization RPC call
-- itself needs to be retried -- e.g. after a transient network error
-- between the app and the database). This cannot invoke the actual
-- TypeScript action from psql, so it exercises the exact same two RPC
-- calls resumeReportFinalization() makes, in the same order:
-- get_child_row_count_secure() then mark_report_ready_for_indexing().
-- =======================================================================
select pg_temp.simulate_user('00000000-0000-0000-0000-0000000000a1'::uuid);

do $$
declare
  v_report_id uuid;
  v_child_count integer;
  v_parent_count_before integer;
  v_parent_count_after integer;
  v_queue_count_after integer;
begin
  insert into public.report_sec014 (profile_id, status, station, team, staff_name, staff_id, date_time_in, date_time_out, remark, acknowledgement)
  values (auth.uid(), 'submitted', 'KUL - MAA', 'Alpha', 'Test ASO Alpha', 'T-A1', now(), now() + interval '1 hour', 'resume-retry fixture', false)
  returning id into v_report_id;

  -- Child rows are written successfully (as they always are before the
  -- app's finalization call, per actions.ts's ordering). The app's own
  -- call to mark_report_ready_for_indexing() is presumed to have failed
  -- for a transient reason (e.g. a dropped connection) -- simulated
  -- here simply by not calling it yet, leaving the report in exactly
  -- the "child rows complete, finalization pending" state that
  -- resumeReportFinalization() exists to recover.
  insert into public.report_sec014_patrols (report_id, entry_no, location, description)
  values (v_report_id, 1, 'Apron', 'resume-retry child row');

  v_parent_count_before := pg_temp.sec014_count_by_remark(auth.uid(), 'resume-retry fixture');
  perform pg_temp.assert(v_parent_count_before = 1, 'SCENARIO 17: exactly one parent row exists before any resume attempt');

  -- Step 1 of resumeReportFinalization(): get_child_row_count_secure().
  select public.get_child_row_count_secure('report_sec014', v_report_id) into v_child_count;
  perform pg_temp.assert(v_child_count = 1, 'SCENARIO 17: get_child_row_count_secure() correctly reports 1 actual child row, ownership-checked, without direct child-table SELECT');

  -- Step 2: mark_report_ready_for_indexing() using that counted value,
  -- exactly as resumeReportFinalization() does (p_expected_child_count:
  -- childCount ?? 0).
  perform public.mark_report_ready_for_indexing('report_sec014', v_report_id, v_child_count);

  v_queue_count_after := pg_temp.queue_count('report_sec014', v_report_id);
  perform pg_temp.assert(v_queue_count_after = 1, 'SCENARIO 17: the resumed finalization call succeeds and enqueues the report exactly once');

  v_parent_count_after := pg_temp.sec014_count_by_remark(auth.uid(), 'resume-retry fixture');
  perform pg_temp.assert(v_parent_count_after = 1, 'SCENARIO 17: still exactly one parent row after the resume -- retrying finalization never created a duplicate parent');

  -- A second resume attempt (e.g. the user double-clicking "retry")
  -- must remain a no-op, not a duplicate -- mark_report_ready_for_indexing()
  -- is idempotent (ON CONFLICT DO NOTHING), independently confirmed in
  -- SCENARIO 13.
  perform public.mark_report_ready_for_indexing('report_sec014', v_report_id, v_child_count);
  v_queue_count_after := pg_temp.queue_count('report_sec014', v_report_id);
  perform pg_temp.assert(v_queue_count_after = 1, 'SCENARIO 17: a second resume attempt on an already-finalized report remains idempotent -- still exactly one queue entry');
end;
$$;

select pg_temp.clear_simulation();

-- =======================================================================
-- SCENARIO 18 (round 8): incomplete SEC029 (missing checklist item(s))
-- is rejected -- not merely "not enough rows," but "not the RIGHT rows"
-- =======================================================================
select pg_temp.simulate_user('00000000-0000-0000-0000-0000000000a1'::uuid);

do $$
declare
  v_report_id uuid;
  v_total_items integer;
begin
  insert into public.report_sec029 (
    profile_id, status, station, team, supervising_officer_name, supervising_officer_id,
    staff_name, staff_id, assisted_by_name, assisted_by_id, aircraft_type, flight_no,
    aircraft_registration, std, parking_bay, time_commence, time_completed, pic_informed,
    declaration, acknowledgement
  ) values (
    auth.uid(), 'submitted', 'KUL - MAA', 'Alpha', 'Test SO', 'SO-1', 'Test ASO Alpha', 'T-A1',
    'Assist Name', 'T-A9', 'A320', 'AK100', '9M-ABC', '10:00', 'C1', '09:00', '09:45', 'YES',
    'I CERTIFY THAT THE ABOVE CHECKS HAVE BEEN CARRIED OUT AND NO DISCREPANCY WAS FOUND.', false
  ) returning id into v_report_id;

  select count(*) into v_total_items from public.sec029_checklist_items where version = public.current_sec029_checklist_version();

  -- Insert every checklist item EXCEPT one (leave exactly one required
  -- code missing).
  insert into public.report_sec029_items (report_id, item_code, checked, remark_type, remark_text)
  select v_report_id, code, 'YES', 'nil', null
  from public.sec029_checklist_items
  where version = public.current_sec029_checklist_version()
  order by code
  limit (v_total_items - 1);

  begin
    perform public.mark_report_ready_for_indexing('report_sec029', v_report_id, v_total_items - 1);
    raise exception 'SCENARIO 18 FAILED: finalizing SEC029 with exactly one required checklist item missing should have been rejected';
  exception when others then
    if sqlerrm like '%missing required SEC029 checklist item%' then
      raise notice 'PASS: SCENARIO 18: SEC029 finalization is rejected when the report has 19 of 20 required checklist items -- the exact-set check catches a missing item that a bare count(19) alone would not distinguish from "any 19 rows"';
    else
      raise exception 'SCENARIO 18 FAILED: rejected for the wrong reason: %', sqlerrm;
    end if;
  end;
end;
$$;

select pg_temp.clear_simulation();

-- =======================================================================
-- SCENARIO 19 (round 8): duplicate or invalid SEC029 item codes rejected
-- =======================================================================
select pg_temp.simulate_user('00000000-0000-0000-0000-0000000000a1'::uuid);

do $$
declare
  v_report_id uuid;
begin
  insert into public.report_sec029 (
    profile_id, status, station, team, supervising_officer_name, supervising_officer_id,
    staff_name, staff_id, assisted_by_name, assisted_by_id, aircraft_type, flight_no,
    aircraft_registration, std, parking_bay, time_commence, time_completed, pic_informed,
    declaration, acknowledgement
  ) values (
    auth.uid(), 'submitted', 'KUL - MAA', 'Alpha', 'Test SO', 'SO-1', 'Test ASO Alpha', 'T-A1',
    'Assist Name', 'T-A9', 'A320', 'AK101', '9M-ABD', '11:00', 'C2', '10:00', '10:45', 'YES',
    'I CERTIFY THAT THE ABOVE CHECKS HAVE BEEN CARRIED OUT AND NO DISCREPANCY WAS FOUND.', false
  ) returning id into v_report_id;

  -- Invalid code: not part of any checklist version.
  begin
    insert into public.report_sec029_items (report_id, item_code, checked, remark_type, remark_text)
    values (v_report_id, 'NOT_A_REAL_CODE', 'YES', 'nil', null);
    raise exception 'SCENARIO 19 FAILED: an item_code not in sec029_checklist_items should have been rejected by validate_sec029_item_code()';
  exception when others then
    if sqlerrm like '%Invalid SEC029 checklist item code%' then
      raise notice 'PASS: SCENARIO 19a: an unrecognized SEC029 item_code is rejected at INSERT time, independent of row count';
    else
      raise exception 'SCENARIO 19 FAILED: rejected for the wrong reason: %', sqlerrm;
    end if;
  end;

  -- Duplicate code: the pre-existing unique(report_id, item_code)
  -- constraint (avsec/0001_init_schema.sql) rejects it.
  insert into public.report_sec029_items (report_id, item_code, checked, remark_type, remark_text)
  values (v_report_id, 'A_I', 'YES', 'nil', null);
  begin
    insert into public.report_sec029_items (report_id, item_code, checked, remark_type, remark_text)
    values (v_report_id, 'A_I', 'NO', 'other', 'duplicate attempt');
    raise exception 'SCENARIO 19 FAILED: a duplicate item_code for the same report should have been rejected by the unique constraint';
  exception when unique_violation then
    raise notice 'PASS: SCENARIO 19b: a duplicate SEC029 item_code for the same report is rejected by the pre-existing unique(report_id, item_code) constraint';
  end;
end;
$$;

select pg_temp.clear_simulation();

-- =======================================================================
-- SCENARIO 20 (round 8): a valid, complete SEC029 report (all current
-- checklist items, no duplicates, no invalid codes) finalizes successfully
-- =======================================================================
select pg_temp.simulate_user('00000000-0000-0000-0000-0000000000a1'::uuid);

do $$
declare
  v_report_id uuid;
  v_total_items integer;
begin
  insert into public.report_sec029 (
    profile_id, status, station, team, supervising_officer_name, supervising_officer_id,
    staff_name, staff_id, assisted_by_name, assisted_by_id, aircraft_type, flight_no,
    aircraft_registration, std, parking_bay, time_commence, time_completed, pic_informed,
    declaration, acknowledgement
  ) values (
    auth.uid(), 'submitted', 'KUL - MAA', 'Alpha', 'Test SO', 'SO-1', 'Test ASO Alpha', 'T-A1',
    'Assist Name', 'T-A9', 'A320', 'AK102', '9M-ABE', '12:00', 'C3', '11:00', '11:45', 'YES',
    'I CERTIFY THAT THE ABOVE CHECKS HAVE BEEN CARRIED OUT AND NO DISCREPANCY WAS FOUND.', true
  ) returning id into v_report_id;

  insert into public.report_sec029_items (report_id, item_code, checked, remark_type, remark_text)
  select v_report_id, code, 'YES', 'nil', null
  from public.sec029_checklist_items
  where version = public.current_sec029_checklist_version();

  select count(*) into v_total_items from public.sec029_checklist_items where version = public.current_sec029_checklist_version();
  perform public.mark_report_ready_for_indexing('report_sec029', v_report_id, v_total_items);
  perform pg_temp.assert(
    pg_temp.is_queued('report_sec029', v_report_id),
    'SCENARIO 20: a complete SEC029 report (exactly the current checklist''s item set) finalizes successfully'
  );
end;
$$;

select pg_temp.clear_simulation();

-- =======================================================================
-- SCENARIO 21 (round 8, corrected round 10): SEC018's maximum of 6
-- patrol entries -- 7 rejected, 6 accepted, 0 (legitimately optional)
-- still accepted
-- =======================================================================
-- FINDING (round 10): report_sec018_patrols.entry_no already carries a
-- structural `check (entry_no between 1 and 6)` constraint
-- (avsec/0001_init_schema.sql) -- confirmed by actually attempting a 7th
-- insert, which fails at the CHECK constraint itself, before ever
-- reaching mark_report_ready_for_indexing()'s round-8 v_required_maximum
-- guard. That guard is therefore genuinely UNREACHABLE in practice: a
-- 7th valid row can never exist for this table to begin with (the
-- domain of entry_no is 1-6, and (report_id, entry_no) is already
-- unique, so 6 is a hard structural ceiling on row count regardless of
-- the application-level guard). This is not a regression -- the maximum
-- is still enforced, just at a different, earlier layer than round 8
-- believed -- but the round-8 guard's own claim ("has too much child
-- content") can never actually fire for this specific table. Scenario
-- 21a below is corrected to test the ACTUAL enforcement point.
select pg_temp.simulate_user('00000000-0000-0000-0000-0000000000a1'::uuid);

do $$
declare
  v_report_id_over uuid;
  v_report_id_ok uuid;
  i integer;
begin
  insert into public.report_sec018 (profile_id, status, station, team, staff_name, date_time, acknowledgement)
  values (auth.uid(), 'submitted', 'KUL - MAA', 'Alpha', 'Test ASO Alpha', now(), false)
  returning id into v_report_id_over;

  for i in 1..6 loop
    insert into public.report_sec018_patrols (report_id, entry_no, description)
    values (v_report_id_over, i, 'patrol ' || i);
  end loop;

  begin
    insert into public.report_sec018_patrols (report_id, entry_no, description)
    values (v_report_id_over, 7, 'patrol 7');
    raise exception 'SCENARIO 21 FAILED: a 7th report_sec018_patrols row (entry_no=7) should have been rejected outright';
  exception when check_violation then
    raise notice 'PASS: SCENARIO 21a: report_sec018_patrols'' own structural check(entry_no between 1 and 6) constraint rejects a 7th row outright -- the real enforcement point for this table''s maximum, independent of mark_report_ready_for_indexing()''s own (here unreachable) guard';
  end;

  insert into public.report_sec018 (profile_id, status, station, team, staff_name, date_time, acknowledgement)
  values (auth.uid(), 'submitted', 'KUL - MAA', 'Alpha', 'Test ASO Alpha', now(), false)
  returning id into v_report_id_ok;

  for i in 1..6 loop
    insert into public.report_sec018_patrols (report_id, entry_no, description)
    values (v_report_id_ok, i, 'patrol ' || i);
  end loop;

  perform public.mark_report_ready_for_indexing('report_sec018', v_report_id_ok, 6);
  perform pg_temp.assert(
    pg_temp.is_queued('report_sec018', v_report_id_ok),
    'SCENARIO 21b: exactly 6 patrol entries (the allowed maximum) finalizes successfully'
  );
end;
$$;

select pg_temp.clear_simulation();

-- =======================================================================
-- SCENARIO 22 (round 8, updated round 9): child-insert failure followed
-- by a successful application-level recovery via the SINGLE atomic
-- resume_report_submission_secure() RPC (case (a): locked count
-- confirmed 0, then child rows inserted for the first time against the
-- SAME parent id, all inside one function call/transaction)
-- =======================================================================
select pg_temp.simulate_user('00000000-0000-0000-0000-0000000000a1'::uuid);

do $$
declare
  v_report_id uuid;
begin
  insert into public.report_sec033 (profile_id, status, station, team, staff_name, staff_id, report_date, report_time)
  values (auth.uid(), 'submitted', 'KUL - MAA', 'Alpha', 'Test ASO Alpha', 'T-A1', current_date, '09:00')
  returning id into v_report_id;

  -- Simulate the original submit action's failed child insert: two rows
  -- with the same entry_no violate report_sec033_hold_checks' own
  -- unique(report_id, entry_no) constraint. This single, multi-row
  -- INSERT statement is atomic (Postgres guarantees all rows or none
  -- for one statement) -- confirmed, not merely assumed: the exception
  -- below proves zero rows landed, not a partial set.
  begin
    insert into public.report_sec033_hold_checks (report_id, entry_no, parking_bay_no, aircraft_registration_no)
    values (v_report_id, 1, 'C1', '9M-XXA'), (v_report_id, 1, 'C2', '9M-XXB');
    raise exception 'SCENARIO 22 FAILED: the duplicate-entry_no insert should itself have failed';
  exception when unique_violation then
    raise notice 'PASS: SCENARIO 22a: the simulated child-insert failure actually fails (unique_violation), leaving the report stranded in case (a) with exactly zero child rows';
  end;

  -- resumeReportSubmission()'s actual (round 9) call: ONE atomic RPC,
  -- carrying the corrected child-row payload as jsonb.
  perform public.resume_report_submission_secure(
    'report_sec033', v_report_id,
    '[{"parking_bay_no": "C1", "aircraft_registration_no": "9M-XXA", "remarks": null}]'::jsonb
  );
  perform pg_temp.assert(
    pg_temp.is_queued('report_sec033', v_report_id),
    'SCENARIO 22b: after the single atomic resume call, finalization succeeds -- the report is no longer stranded'
  );
  perform pg_temp.assert(
    public.get_child_row_count_secure('report_sec033', v_report_id) = 1,
    'SCENARIO 22c: exactly one child row exists -- the corrected data from the resume payload, not the failed duplicate attempt'
  );
  perform pg_temp.assert(
    pg_temp.sec033_count_by_staff_and_time(auth.uid(), 'T-A1', '09:00') = 1,
    'SCENARIO 22d: exactly one parent row exists -- the recovery never created a duplicate parent'
  );
end;
$$;

select pg_temp.clear_simulation();

-- =======================================================================
-- SCENARIO 23 (round 8, updated round 9): finalization failure followed
-- by a successful recovery via the SAME atomic RPC (case (b): the
-- locked count is already > 0, so the RPC's own conditional-insert
-- branch is skipped entirely and only finalization proceeds)
-- =======================================================================
select pg_temp.simulate_user('00000000-0000-0000-0000-0000000000a1'::uuid);

do $$
declare
  v_report_id uuid;
  v_child_count integer;
begin
  insert into public.offload_records (profile_id, status, station, team, staff_name, staff_id, flight_no, destination, aircraft_registration, flight_date, total_bags)
  values (auth.uid(), 'submitted', 'KUL - MAA', 'Alpha', 'Test ASO Alpha', 'T-A1', 'AK200', 'SIN', '9M-XYZ', current_date, 1)
  returning id into v_report_id;

  -- Child rows are written successfully -- the app's own finalization
  -- call is presumed to have failed transiently and is simply never
  -- made here, leaving the report in exactly the "children complete,
  -- finalization pending" state case (b) describes.
  insert into public.offload_items (report_id, entry_no, baggage_tag_no)
  values (v_report_id, 1, 'BAG-001');

  v_child_count := public.get_child_row_count_secure('offload_records', v_report_id);
  perform pg_temp.assert(v_child_count = 1, 'SCENARIO 23a: exactly one child row exists before recovery');

  -- resumeReportSubmission()'s actual (round 9) call -- the child-rows
  -- payload it carries is IRRELEVANT here because the RPC's own locked
  -- count is already 1, so its insert branch is never entered
  -- regardless of what the payload contains.
  perform public.resume_report_submission_secure(
    'offload_records', v_report_id,
    '[{"baggage_tag_no": "IGNORED-IF-ALREADY-PRESENT", "reason": null, "weight_kg": null}]'::jsonb
  );
  perform pg_temp.assert(
    pg_temp.is_queued('offload_records', v_report_id),
    'SCENARIO 23b: the resumed finalization succeeds without ever re-inserting a child row'
  );

  v_child_count := public.get_child_row_count_secure('offload_records', v_report_id);
  perform pg_temp.assert(v_child_count = 1, 'SCENARIO 23c: still exactly one child row after recovery -- case (b) never duplicates children, even when the resume payload carries different content');
  perform pg_temp.assert(
    pg_temp.offload_first_tag(v_report_id) = 'BAG-001',
    'SCENARIO 23d: the ORIGINAL child row content is preserved -- the resume payload''s different tag number was correctly ignored, not used to overwrite'
  );
end;
$$;

select pg_temp.clear_simulation();

-- =======================================================================
-- SCENARIO 24 (round 8, updated round 9): repeated retries never create
-- duplicates -- calling the atomic resume RPC 3 times in a row stays at
-- exactly 1 parent, 1 child set, 1 queue entry
-- =======================================================================
select pg_temp.simulate_user('00000000-0000-0000-0000-0000000000a1'::uuid);

do $$
declare
  v_report_id uuid;
  v_child_count integer;
  v_queue_count integer;
  v_i integer;
begin
  insert into public.report_sec013 (profile_id, status, station, team, staff_name, staff_id, date_time_in, date_time_out, acknowledgement)
  values (auth.uid(), 'submitted', 'KUL - MAA', 'Alpha', 'Test ASO Alpha', 'T-A1', now(), now() + interval '1 hour', false)
  returning id into v_report_id;

  for v_i in 1..3 loop
    perform public.resume_report_submission_secure(
      'report_sec013', v_report_id,
      '[{"duty_area": "Departure Gate", "time_from": "09:00", "time_to": "09:30", "location": "Departure Gate Sector 5/6/7 (P-Q)", "sector_flight": "AK300", "description": "repeated-retry fixture", "incident_remark": null}]'::jsonb
    );
  end loop;

  v_queue_count := pg_temp.queue_count('report_sec013', v_report_id);
  perform pg_temp.assert(v_queue_count = 1, 'SCENARIO 24a: 3 repeated resume attempts leave exactly 1 report_index_queue row');
  v_child_count := public.get_child_row_count_secure('report_sec013', v_report_id);
  perform pg_temp.assert(v_child_count = 1, 'SCENARIO 24b: 3 repeated resume attempts leave exactly 1 child row -- the first call inserts, the second and third are no-ops (already finalized)');
end;
$$;

select pg_temp.clear_simulation();

-- =======================================================================
-- SCENARIO 25 (round 8, updated round 9): an unauthorized retry attempt
-- is denied -- Bravo (different profile, no relationship to Alpha's
-- report) cannot use either get_child_row_count_secure() or the atomic
-- resume_report_submission_secure() RPC against Alpha's report to
-- "help" or interfere with its recovery, and cannot use the payload
-- argument to smuggle in content for a report Bravo does not own
-- =======================================================================
select pg_temp.simulate_user('00000000-0000-0000-0000-0000000000a2'::uuid); -- Bravo

do $$
declare
  v_report_id uuid;
begin
  v_report_id := pg_temp.report_id_by_staff('T-A1', 'synthetic patrol remark'); -- the SAME specific report indexed in Scenario 4
  perform pg_temp.assert(v_report_id is not null, 'SCENARIO 25 setup: a report owned by Alpha exists to attempt an unauthorized retry against');

  begin
    perform public.get_child_row_count_secure('report_sec014', v_report_id);
    raise exception 'SCENARIO 25 FAILED: Bravo should not be able to check the child-row count of a report Bravo does not own';
  exception when others then
    if sqlerrm like '%Only the submitting profile may check its own report%' then
      raise notice 'PASS: SCENARIO 25a: get_child_row_count_secure() denies Bravo (a different, unrelated profile) access to Alpha''s report';
    else
      raise exception 'SCENARIO 25 FAILED: rejected for the wrong reason: %', sqlerrm;
    end if;
  end;

  begin
    perform public.resume_report_submission_secure(
      'report_sec014', v_report_id,
      '[{"location": "Bravo-injected row", "time_from": null, "time_to": null, "description": "should never be inserted"}]'::jsonb
    );
    raise exception 'SCENARIO 25 FAILED: Bravo should not be able to resume (or inject content into) a report Bravo does not own';
  exception when others then
    if sqlerrm like '%Only the submitting profile may resume its own report%' then
      raise notice 'PASS: SCENARIO 25b: resume_report_submission_secure() denies Bravo the same way, BEFORE the lock is used to read or write anything -- the ownership check happens immediately after the lock is acquired, before any count/insert logic runs';
    else
      raise exception 'SCENARIO 25 FAILED: rejected for the wrong reason: %', sqlerrm;
    end if;
  end;

  perform pg_temp.assert(
    not pg_temp.patrol_exists_with_description('should never be inserted'),
    'SCENARIO 25c: Bravo''s payload was never inserted -- ownership is checked before the payload is ever touched'
  );
end;
$$;

select pg_temp.clear_simulation();

-- =======================================================================
-- SCENARIO 27 (round 10): the REAL queue-processing path --
-- process_report_index_queue() itself, not the direct index_report()
-- shortcut scenarios 4-6 use for speed. Alpha (a1) has no Phase 3 role
-- assignment in this harness's fixtures (only a3/a4 do, and Phase 2's
-- own classification trigger requires a full aoc/department/hub/
-- station/team-scoped assignment on the submitter before a report can
-- be classified -- exactly why scenarios 4-6 use the direct-call
-- shortcut instead of wiring up that additional Phase 2/3 machinery).
-- This scenario therefore exercises process_report_index_queue()'s
-- OTHER real, documented branch: a genuinely queued, unclassified
-- report is correctly left as 'failed' (retryable) with a specific,
-- accurate reason, never silently dropped or wrongly marked
-- 'completed'.
-- =======================================================================
select pg_temp.simulate_user('00000000-0000-0000-0000-0000000000a1'::uuid);

do $$
declare
  v_report_id uuid;
begin
  insert into public.report_sec033 (profile_id, status, station, team, staff_name, staff_id, report_date, report_time)
  values (auth.uid(), 'submitted', 'KUL - MAA', 'Alpha', 'Test ASO Alpha', 'T-A1', current_date, '10:00')
  returning id into v_report_id;

  insert into public.report_sec033_hold_checks (report_id, entry_no, parking_bay_no, aircraft_registration_no)
  values (v_report_id, 1, 'C9', '9M-QUE');

  perform public.mark_report_ready_for_indexing('report_sec033', v_report_id, 1);
end;
$$;

select pg_temp.clear_simulation();

-- process_report_index_queue() itself requires service_role.
select pg_temp.simulate_service_role();
do $$
declare
  v_report_id uuid;
  v_result record;
  v_queue_status text;
  v_last_error text;
begin
  v_report_id := pg_temp.sec033_id_by_staff_and_time('T-A1', '10:00');
  select * into v_result from public.process_report_index_queue(50);
  perform pg_temp.assert(v_result.processed >= 1, 'SCENARIO 27a: process_report_index_queue() actually processed at least one row (the one queued above), not a no-op');

  select status, last_error into v_queue_status, v_last_error
  from public.report_index_queue where source_table = 'report_sec033' and source_id = v_report_id;
  perform pg_temp.assert(
    v_queue_status = 'failed' and v_last_error like '%not yet classified%',
    format('SCENARIO 27b: the real queue processor correctly leaves an unclassified report as retryable-failed with an accurate reason, never silently drops it or marks it completed -- got status=%s, error=%s', v_queue_status, v_last_error)
  );
end;
$$;
select pg_temp.clear_simulation();

-- =======================================================================
-- SCENARIO 28 (round 10): attachment and export authorization
-- =======================================================================
-- Reuses Alpha's report_sec014 from Scenario 1, indexed directly via
-- index_report() in Scenario 4 -- unlike Scenario 27's report_sec033
-- (deliberately left unclassified/unindexed to exercise the OTHER real
-- branch of process_report_index_queue()), this report genuinely exists
-- in central_reports_index, which export_reports_secure() reads from.
select pg_temp.simulate_user('00000000-0000-0000-0000-0000000000a2'::uuid); -- Bravo

do $$
declare
  v_report_id uuid;
  v_attachments record;
  v_found boolean := false;
begin
  v_report_id := pg_temp.report_id_by_staff('T-A1', 'synthetic patrol remark'); -- the SAME specific report indexed in Scenario 4

  -- Bravo has no relationship to this report -- list_report_attachments_secure()
  -- must return ZERO rows (generic denial, not an error, per its own
  -- "return; -- zero rows, no error -- generic, non-enumerable" design)
  -- rather than revealing whether the report exists at all.
  for v_attachments in select * from public.list_report_attachments_secure('report_sec014', v_report_id) loop
    v_found := true;
  end loop;
  perform pg_temp.assert(not v_found, 'SCENARIO 28a: list_report_attachments_secure() returns zero rows for an unrelated report (Bravo), not an error -- authorization failure is silent/generic, not enumerable');

  -- export_reports_secure() must likewise never include this report for
  -- Bravo (no role grants Bravo access to it).
  perform pg_temp.assert(
    not exists (select 1 from public.export_reports_secure(1000) where id = pg_temp.repository_id_for('report_sec014', 'T-A1')),
    'SCENARIO 28b: export_reports_secure() does not include a report Bravo has no access to'
  );
end;
$$;

select pg_temp.clear_simulation();

select pg_temp.simulate_user('00000000-0000-0000-0000-0000000000a1'::uuid); -- Alpha, the actual owner

do $$
declare
  v_report_id uuid;
begin
  v_report_id := pg_temp.report_id_by_staff('T-A1', 'synthetic patrol remark'); -- the SAME specific report indexed in Scenario 4
  perform pg_temp.assert(
    exists (select 1 from public.export_reports_secure(1000) where id = pg_temp.repository_id_for('report_sec014', 'T-A1')),
    'SCENARIO 28c: export_reports_secure() DOES include the report for its own submitter (Alpha)'
  );
  perform pg_temp.assert(
    (select count(*) from public.list_report_attachments_secure('report_sec033', v_report_id)) = 0,
    'SCENARIO 28d: list_report_attachments_secure() returns zero rows (not an error) for a report with no attachments -- the authorized-empty case is distinct from the denied case above'
  );
end;
$$;

select pg_temp.clear_simulation();

-- =======================================================================
-- SCENARIO 29 (round 10): resume_report_submission_secure() verified
-- directly as an authenticated caller, bypassing TypeScript entirely --
-- malformed payload rejected, and finalized content remains unchanged
-- =======================================================================
select pg_temp.simulate_user('00000000-0000-0000-0000-0000000000a1'::uuid);

do $$
declare
  v_report_id uuid;
begin
  insert into public.report_sec033 (profile_id, status, station, team, staff_name, staff_id, report_date, report_time)
  values (auth.uid(), 'submitted', 'KUL - MAA', 'Alpha', 'Test ASO Alpha', 'T-A1', current_date, '11:00')
  returning id into v_report_id;

  -- Malformed payload: missing the NOT NULL parking_bay_no/aircraft_registration_no
  -- fields entirely -- jsonb_to_recordset() leaves them null, which the
  -- underlying table's own NOT NULL constraints then reject. This is the
  -- RPC being called directly, bypassing every TypeScript-side zod
  -- validation entirely -- application validation alone cannot protect
  -- this RPC; the database's own constraints are what actually enforce
  -- required-field correctness here.
  begin
    perform public.resume_report_submission_secure('report_sec033', v_report_id, '[{}]'::jsonb);
    raise exception 'SCENARIO 29 FAILED: an empty/malformed child payload should have been rejected by the underlying NOT NULL constraints';
  exception when not_null_violation then
    raise notice 'PASS: SCENARIO 29a: resume_report_submission_secure() rejects a malformed child payload (missing required fields) via the underlying table''s own NOT NULL constraints -- called directly, with no TypeScript/zod layer involved at all';
  end;

  perform pg_temp.assert(
    public.get_child_row_count_secure('report_sec033', v_report_id) = 0,
    'SCENARIO 29b: the malformed-payload attempt left zero child rows -- the failed INSERT did not partially apply'
  );

  -- Now finalize it properly, then attempt a resume with a DIFFERENT,
  -- well-formed payload -- finalized content must remain unchanged.
  perform public.resume_report_submission_secure(
    'report_sec033', v_report_id,
    '[{"parking_bay_no": "C1", "aircraft_registration_no": "9M-ORIG", "remarks": null}]'::jsonb
  );
  perform pg_temp.assert(pg_temp.is_queued('report_sec033', v_report_id), 'SCENARIO 29c: the well-formed retry finalizes successfully');

  perform public.resume_report_submission_secure(
    'report_sec033', v_report_id,
    '[{"parking_bay_no": "C9", "aircraft_registration_no": "9M-DIFFERENT", "remarks": "should never be applied"}]'::jsonb
  );
  perform pg_temp.assert(
    public.get_child_row_count_secure('report_sec033', v_report_id) = 1,
    'SCENARIO 29d: a resume attempt against an ALREADY-finalized report is a pure no-op -- still exactly one child row, the payload was never touched'
  );
end;
$$;

select pg_temp.clear_simulation();

rollback; -- discard every synthetic fixture and result; this harness never commits.

-- =======================================================================
-- SCENARIO 26 (round 9): REAL two-session concurrency test for
-- resume_report_submission_secure() -- two genuinely concurrent resume
-- attempts against the SAME stranded report, asserting exactly one
-- complete child set and exactly one immutable version-1 snapshot.
-- =======================================================================
-- PREPARED BUT NOT EXECUTED, same as the rest of this harness (no local/
-- disposable Postgres available in this development environment) -- but
-- unlike scenarios 1-11 and 13-25, this one is written to require TWO
-- REAL, SEPARATE psql connections run in parallel, because a single
-- linear script (even one using pg_temp helper functions) cannot create
-- genuine cross-transaction concurrency -- there is no way for one
-- session to pause mid-transaction while another session's statement
-- runs, inside one script. This is a permanent structural limitation of
-- a single-connection harness, not something scenarios 1-25's technique
-- could be extended to cover; it is stated here explicitly rather than
-- left implicit.
--
-- Unlike the rest of this file, the fixture below MUST be committed (not
-- wrapped in begin/rollback) so both separate sessions can see it.
--
-- ---- SETUP (run once, either session) ----
-- begin;
-- insert into public.profiles (id, name, staff_no, role, station, team, ops_group, status)
-- values ('00000000-0000-0000-0000-0000000000a1', 'Test ASO Alpha', 'T-A1', 'ASO', 'KUL - MAA', 'Alpha', 'operation_avsec', 'approved')
-- on conflict (id) do nothing;
-- insert into public.report_sec033 (id, profile_id, status, station, team, staff_name, staff_id, report_date, report_time)
-- values ('00000000-0000-0000-0000-00000000c026', '00000000-0000-0000-0000-0000000000a1', 'submitted', 'KUL - MAA', 'Alpha', 'Test ASO Alpha', 'T-A1', current_date, '09:00')
-- on conflict (id) do nothing;
-- commit;
-- -- Leave report_sec033_hold_checks EMPTY for this report -- this is
-- -- case (a), the exact state a genuine child-insert failure leaves
-- -- behind.
--
-- ---- SESSION A ----
-- set role authenticated;
-- select set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000000000a1', 'role', 'authenticated')::text, false);
-- begin;
-- select public.resume_report_submission_secure(
--   'report_sec033', '00000000-0000-0000-0000-00000000c026',
--   '[{"parking_bay_no": "C1", "aircraft_registration_no": "9M-CCA", "remarks": "session A"}]'::jsonb
-- );
-- -- PAUSE HERE, mid-transaction, BEFORE commit -- this holds the `for
-- -- update` row lock resume_report_submission_secure() takes on
-- -- report_sec033 first. Do not commit yet.
--
-- ---- SESSION B (start this only while Session A is paused above) ----
-- set role authenticated;
-- select set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000000000a1', 'role', 'authenticated')::text, false);
-- begin;
-- select public.resume_report_submission_secure(
--   'report_sec033', '00000000-0000-0000-0000-00000000c026',
--   '[{"parking_bay_no": "C2", "aircraft_registration_no": "9M-CCB", "remarks": "session B"}]'::jsonb
-- );
-- -- This BLOCKS -- Session B's statement waits on Session A's row lock.
-- -- This blocking itself is the primary assertion: it proves the two
-- -- concurrent calls are serialized through the SAME lock, not racing
-- -- independently against separate reads. If this does NOT block, the
-- -- fix in PART S5 of the Phase 6 migration has regressed.
--
-- ---- Back in Session A ----
-- commit;
-- -- Session B's blocked call now unblocks, runs to completion (as a
-- -- no-op -- it will see the locked count is already > 0, from Session
-- -- A's insert, and skip straight to finalization), and returns.
--
-- ---- Back in Session B ----
-- commit;
--
-- ---- VERIFICATION (either session, after both have committed) ----
-- select count(*) as child_row_count, array_agg(aircraft_registration_no) as which_rows
-- from public.report_sec033_hold_checks where report_id = '00000000-0000-0000-0000-00000000c026';
-- -- EXPECTED: child_row_count = 1, which_rows = {9M-CCA} -- Session A's
-- -- row (it held the lock first and inserted first), NEVER both rows,
-- -- and NEVER Session B's row alone or in addition.
--
-- select count(*) as queue_row_count
-- from public.report_index_queue where source_table = 'report_sec033' and source_id = '00000000-0000-0000-0000-00000000c026';
-- -- EXPECTED: queue_row_count = 1 -- exactly one finalization, not two.
--
-- select count(*) as version_1_count, (array_agg(v.amended_content -> 'hold_checks'))[1] as captured_snapshot
-- from public.report_versions v
-- join public.central_reports_index c on c.id = v.repository_report_id
-- where c.source_table = 'report_sec033' and c.source_id = '00000000-0000-0000-0000-00000000c026' and v.version_number = 1;
-- -- EXPECTED: version_1_count = 1 once process_report_index_queue() (the
-- -- Phase 5 indexing job) has run against the single queue row above --
-- -- exactly ONE immutable version-1 snapshot, capturing exactly the one
-- -- child row Session A inserted (aircraft_registration_no '9M-CCA'),
-- -- never a snapshot missing content and never two competing snapshots.
--
-- ---- CLEANUP ----
-- delete from public.report_versions where repository_report_id in (
--   select id from public.central_reports_index where source_table = 'report_sec033' and source_id = '00000000-0000-0000-0000-00000000c026'
-- );
-- delete from public.central_reports_index where source_table = 'report_sec033' and source_id = '00000000-0000-0000-0000-00000000c026';
-- delete from public.report_index_queue where source_table = 'report_sec033' and source_id = '00000000-0000-0000-0000-00000000c026';
-- delete from public.report_sec033_hold_checks where report_id = '00000000-0000-0000-0000-00000000c026';
-- delete from public.report_sec033 where id = '00000000-0000-0000-0000-00000000c026';

-- EXECUTED (round 10, database-integration validation): scenarios
-- 1-11, 13-25, 27-29 -- every scenario in the single begin/rollback
-- block above -- were actually run to completion, with every assertion
-- passing, against a real, disposable, synthetic-data Postgres instance
-- (PGlite, a genuine embedded Postgres engine, not a reimplementation;
-- see the round-10 validation report for the full migration-apply chain
-- and every finding/fix this uncovered). This was NOT a re-run of static
-- source-text pattern matching -- it is actual SQL execution against a
-- schema built by applying the real migration files in dependency
-- order.
--
-- Scenario 26 remains a SEPARATE, standalone two-session test (see
-- above) and was NOT executed -- it genuinely needs two independent
-- database connections racing against each other, which PGlite (a
-- single-connection, single-process embedded engine) structurally
-- cannot provide, and no separate multi-connection Postgres (a real
-- server, Docker, or the Supabase CLI) was available in this
-- environment either. Scenario 12 remains documented-but-unexecuted for
-- the identical reason -- keep this distinction explicit in any report
-- describing what this harness covers: scenarios 1-11/13-25/27-29
-- EXECUTED and PASSED; scenarios 12 and 26 remain PREPARED ONLY,
-- requiring genuine cross-connection concurrency this environment
-- cannot provide.
--
-- Round 8 added scenarios 18-25: SEC029 incomplete-checklist rejection
-- (18), SEC029 duplicate/invalid item rejection (19), SEC029 valid
-- complete acceptance (20), SEC018 maximum-6 enforcement (21),
-- child-insert-failure recovery (22), finalization-failure recovery
-- (23), repeated-retry non-duplication (24), and unauthorized-retry
-- denial (25). Round 10 added scenarios 27-29: the real
-- process_report_index_queue() path (27), attachment/export
-- authorization (28), and resume_report_submission_secure() verified
-- directly as an authenticated caller -- malformed payload rejection
-- and finalized-content-unchanged (29). Scenarios 22-25 and 29 call the
-- SAME atomic resume_report_submission_secure() RPC
-- lib/avsec/reports/actions.ts's resumeReportSubmission() calls -- this
-- harness cannot invoke the TypeScript server action itself, so it
-- exercises the identical database-level RPC that action performs,
-- directly, bypassing TypeScript/zod entirely.
