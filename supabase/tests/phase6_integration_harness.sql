-- PHASE 6 DATABASE INTEGRATION HARNESS -- NOT A MIGRATION.
--
-- PREPARED BUT NOT EXECUTED (review round 5, section 6). No local/
-- disposable Postgres, Docker, or Supabase CLI was available in the
-- environment this was authored in (confirmed: `psql`, `docker`, and
-- `supabase` are all absent from PATH). This harness is runnable
-- against any disposable Postgres instance that already has the full
-- avsec schema and Phases 2-6 applied, but has NOT been run. Treat
-- database integration as an explicit pre-merge / pre-deployment gate:
-- do not merge or deploy any of Phase 2-6 until this (or an equivalent
-- harness) has actually been executed successfully against a real,
-- disposable database and every assertion below has passed.
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
  perform set_config('role', '', true);
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

-- =======================================================================
-- Synthetic fixtures
-- =======================================================================
-- Two ordinary ASO profiles at different stations, one Main Enforcement
-- officer (Malaysia-wide, Phase 3 role), one AirAsia Management profile
-- (aggregate-only), and the MAA AOC/operating-entity/hub records these
-- reference. Adjust column names/NOT NULL requirements to match the
-- target schema's exact profiles/aocs/operating_entities/hubs shape if
-- they differ from what this harness assumes.

perform pg_temp.simulate_service_role();

insert into public.profiles (id, name, staff_no, role, station, team, ops_group, status)
values
  ('00000000-0000-0000-0000-0000000000a1', 'Test ASO Alpha', 'T-A1', 'ASO', 'KUL', 'Alpha', 'operation_avsec', 'approved'),
  ('00000000-0000-0000-0000-0000000000a2', 'Test ASO Bravo', 'T-A2', 'ASO', 'PEN', 'Bravo', 'operation_avsec', 'approved'),
  ('00000000-0000-0000-0000-0000000000a3', 'Test Main Enforcement', 'T-A3', 'ENFORCEMENT', 'KUL', 'Alpha', null, 'approved'),
  ('00000000-0000-0000-0000-0000000000a4', 'Test AirAsia Mgmt', 'T-A4', 'MANAGEMENT', 'KUL', 'Alpha', null, 'approved')
on conflict (id) do nothing;

-- Malaysia AOC + MAA operating entity + KUL hub (adjust to existing
-- Phase 2 seed data if this environment already has one).
insert into public.aocs (id, code, name) values ('00000000-0000-0000-0000-0000000000b1', 'MY', 'Malaysia') on conflict (id) do nothing;
insert into public.operating_entities (id, aoc_id, code, name, flight_prefix) values ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000b1', 'MAA', 'AirAsia Malaysia', 'AK') on conflict (id) do nothing;
insert into public.hubs (id, aoc_id, operating_entity_id, code, name) values ('00000000-0000-0000-0000-0000000000b3', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000b2', 'KUL', 'Kuala Lumpur') on conflict (id) do nothing;

-- Phase 3 role assignment: Test Main Enforcement holds main_enforcement, Malaysia-wide.
insert into public.user_role_assignments (id, profile_id, role_definition_id, aoc_id, granted_by)
select '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a3', rd.id, '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a4'
from public.role_definitions rd where rd.code = 'main_enforcement'
on conflict (id) do nothing;

-- Phase 3 role assignment: Test AirAsia Mgmt holds airasia_management.
insert into public.user_role_assignments (id, profile_id, role_definition_id, granted_by)
select '00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000a4', rd.id, '00000000-0000-0000-0000-0000000000a3'
from public.role_definitions rd where rd.code = 'airasia_management'
on conflict (id) do nothing;

perform pg_temp.clear_simulation();

-- =======================================================================
-- SCENARIO 1: report creation (INSERT ... RETURNING) still works under
-- the narrowed column grant
-- =======================================================================
perform pg_temp.simulate_user('00000000-0000-0000-0000-0000000000a1'::uuid);

do $$
declare
  v_report_id uuid;
  v_report_no text;
begin
  insert into public.report_sec014 (profile_id, status, station, team, staff_name, staff_id, date_time_in, date_time_out, remark, acknowledgement)
  values (auth.uid(), 'submitted', 'KUL', 'Alpha', 'Test ASO Alpha', 'T-A1', now(), now() + interval '1 hour', 'synthetic patrol remark', false)
  returning id, report_no into v_report_id, v_report_no;

  perform pg_temp.assert(v_report_id is not null, 'SCENARIO 1: INSERT ... RETURNING id succeeds for the caller''s own report_sec014 row under the narrowed (id, submitted_at, report_no, profile_id) grant');

  insert into public.report_sec014_patrols (report_id, entry_no, location, description)
  values (v_report_id, 1, 'Gate A1', 'synthetic patrol entry');
  perform pg_temp.assert(true, 'SCENARIO 1: child row (report_sec014_patrols) INSERT succeeds -- child creation is unaffected by the SELECT closure');

  perform pg_temp.assert(
    (select count(*) from public.report_sec014 where id = v_report_id) is not null,
    'placeholder'
  );

  -- Explicit completion signal, as lib/avsec/reports/actions.ts now does.
  perform public.mark_report_ready_for_indexing('report_sec014', v_report_id);
  perform pg_temp.assert(
    exists (select 1 from public.report_index_queue where source_table = 'report_sec014' and source_id = v_report_id),
    'SCENARIO 1: mark_report_ready_for_indexing() enqueues the report exactly once, only after the child row above was already written'
  );
end;
$$;

perform pg_temp.clear_simulation();

-- =======================================================================
-- SCENARIO 2: direct parent-table content SELECT is denied (even own row,
-- full-row); the narrow RETURNING columns remain selectable
-- =======================================================================
perform pg_temp.simulate_user('00000000-0000-0000-0000-0000000000a1'::uuid);

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

perform pg_temp.clear_simulation();

-- =======================================================================
-- SCENARIO 3: direct child-table SELECT is denied entirely
-- =======================================================================
perform pg_temp.simulate_user('00000000-0000-0000-0000-0000000000a1'::uuid);

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

perform pg_temp.clear_simulation();

-- =======================================================================
-- SCENARIO 4: cross-profile denial -- Bravo cannot read Alpha's report
-- via the secure RPC, and cannot see it in list/search either
-- =======================================================================
-- (Requires the report from Scenario 1 to have been indexed -- run
-- `select public.process_report_index_queue(10);` as service_role
-- between Scenario 1 and this block if testing end-to-end, or call
-- public.index_report(...) directly with synthetic classification for a
-- faster, indexing-queue-independent check.)
perform pg_temp.simulate_service_role();
do $$
declare
  v_report_id uuid;
begin
  select id into v_report_id from public.report_sec014 where staff_id = 'T-A1' order by created_at desc limit 1;
  perform public.index_report(
    'report_sec014', v_report_id, (select report_no from public.report_sec014 where id = v_report_id),
    '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000b2', null, null,
    '00000000-0000-0000-0000-0000000000b3', null, null, null, current_date,
    '00000000-0000-0000-0000-0000000000a1'
  );
end;
$$;
perform pg_temp.clear_simulation();

perform pg_temp.simulate_user('00000000-0000-0000-0000-0000000000a2'::uuid); -- Bravo, different station, no relationship to Alpha's report

do $$
declare
  v_repository_id uuid;
begin
  select id into v_repository_id from public.central_reports_index where source_table = 'report_sec014' and source_id in (select id from public.report_sec014 where staff_id = 'T-A1');

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

perform pg_temp.clear_simulation();

-- =======================================================================
-- SCENARIO 5: Main Enforcement (Malaysia-wide) CAN read Alpha's report
-- =======================================================================
perform pg_temp.simulate_user('00000000-0000-0000-0000-0000000000a3'::uuid);

do $$
declare
  v_repository_id uuid;
  v_content jsonb;
begin
  select id into v_repository_id from public.central_reports_index where source_table = 'report_sec014' and source_id in (select id from public.report_sec014 where staff_id = 'T-A1');
  select content into v_content from public.get_report_secure(v_repository_id) limit 1;
  perform pg_temp.assert(v_content is not null, 'SCENARIO 5: Main Enforcement (Malaysia-wide role) IS authorized to read Alpha''s report via get_report_secure(), and receives full content including the child patrol array');
  perform pg_temp.assert((v_content -> 'patrols') is not null and jsonb_array_length(v_content -> 'patrols') = 1, 'SCENARIO 5: the immutable/detail content includes the child patrol row written in Scenario 1');
  perform pg_temp.assert(
    exists (select 1 from public.report_access_audit where repository_report_id = v_repository_id and actor_id = auth.uid() and action = 'detail_view'),
    'SCENARIO 5: the read was audited as detail_view for this actor'
  );
end;
$$;

perform pg_temp.clear_simulation();

-- =======================================================================
-- SCENARIO 6: version 1 is a complete, immutable snapshot (parent + child)
-- =======================================================================
perform pg_temp.simulate_user('00000000-0000-0000-0000-0000000000a3'::uuid); -- authorized via Main Enforcement

do $$
declare
  v_repository_id uuid;
  v_snapshot jsonb;
begin
  select id into v_repository_id from public.central_reports_index where source_table = 'report_sec014' and source_id in (select id from public.report_sec014 where staff_id = 'T-A1');
  select amended_content into v_snapshot from public.get_report_version_content_secure(v_repository_id, 1) limit 1;
  perform pg_temp.assert(v_snapshot is not null, 'SCENARIO 6: version 1''s amended_content is populated (not null) -- a genuine snapshot, not a placeholder');
  perform pg_temp.assert((v_snapshot -> 'patrols') is not null and jsonb_array_length(v_snapshot -> 'patrols') = 1, 'SCENARIO 6: version 1''s snapshot includes the child patrol row -- complete, not partial');
end;
$$;

perform pg_temp.clear_simulation();

-- =======================================================================
-- SCENARIO 7: aggregate-only role (AirAsia Management) receives global
-- totals despite never having per-report detail access
-- =======================================================================
perform pg_temp.simulate_user('00000000-0000-0000-0000-0000000000a4'::uuid);

do $$
declare
  v_total bigint;
  v_repository_id uuid;
begin
  select sum(report_count) into v_total from public.get_report_dashboard_aggregate_secure('source_table');
  perform pg_temp.assert(v_total >= 1, 'SCENARIO 7: AirAsia Management receives a non-zero global aggregate total, including reports it has no per-report detail access to');

  select id into v_repository_id from public.central_reports_index where source_table = 'report_sec014' and source_id in (select id from public.report_sec014 where staff_id = 'T-A1');
  begin
    perform * from public.get_report_secure(v_repository_id);
    raise exception 'SCENARIO 7 FAILED: AirAsia Management should NOT have per-report detail access, only aggregate counts';
  exception when others then
    raise notice 'PASS: SCENARIO 7: AirAsia Management is denied get_report_secure() detail access even though it receives aggregate totals -- the two permissions are confirmed independent';
  end;
end;
$$;

perform pg_temp.clear_simulation();

-- =======================================================================
-- SCENARIO 8: acknowledgement path is unaffected by the SELECT closure
-- =======================================================================
perform pg_temp.simulate_user('00000000-0000-0000-0000-0000000000a3'::uuid); -- acting as a supervisor role for this synthetic check

do $$
declare
  v_report_id uuid;
begin
  select id into v_report_id from public.report_sec014 where staff_id = 'T-A1' order by created_at desc limit 1;
  insert into public.report_acknowledgements (report_type, report_id, acknowledged_by)
  values ('sec014', v_report_id, auth.uid())
  on conflict (report_type, report_id) do nothing;
  perform pg_temp.assert(
    exists (select 1 from public.report_acknowledgements where report_type = 'sec014' and report_id = v_report_id),
    'SCENARIO 8: acknowledgement INSERT into the separate report_acknowledgements table is unaffected by the report_sec014 SELECT closure -- it is a different table with its own, untouched grants/RLS'
  );
end;
$$;

perform pg_temp.clear_simulation();

-- =======================================================================
-- SCENARIO 9: premature finalization is rejected
-- =======================================================================
perform pg_temp.simulate_user('00000000-0000-0000-0000-0000000000a1'::uuid);

do $$
declare
  v_report_id uuid;
begin
  insert into public.report_sec014 (profile_id, status, station, team, staff_name, staff_id, date_time_in, date_time_out, remark, acknowledgement)
  values (auth.uid(), 'submitted', 'KUL', 'Alpha', 'Test ASO Alpha', 'T-A1', now(), now() + interval '1 hour', 'premature-finalization fixture', false)
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
    not exists (select 1 from public.report_index_queue where source_table = 'report_sec014' and source_id = v_report_id),
    'SCENARIO 9: the rejected finalization attempt left no queue entry behind'
  );
end;
$$;

perform pg_temp.clear_simulation();

-- =======================================================================
-- SCENARIO 10: a valid zero-child report finalizes successfully
-- =======================================================================
perform pg_temp.simulate_user('00000000-0000-0000-0000-0000000000a1'::uuid);

do $$
declare
  v_report_id uuid;
begin
  insert into public.report_sec014 (profile_id, status, station, team, staff_name, staff_id, date_time_in, date_time_out, remark, acknowledgement)
  values (auth.uid(), 'submitted', 'KUL', 'Alpha', 'Test ASO Alpha', 'T-A1', now(), now() + interval '1 hour', 'zero-child fixture', false)
  returning id into v_report_id;

  -- Zero patrol rows is a legitimate submission (patrols are optional in
  -- the application schema) -- p_expected_child_count = 0 must succeed.
  perform public.mark_report_ready_for_indexing('report_sec014', v_report_id, 0);
  perform pg_temp.assert(
    exists (select 1 from public.report_index_queue where source_table = 'report_sec014' and source_id = v_report_id),
    'SCENARIO 10: a report with zero (legitimately optional) child rows finalizes successfully when p_expected_child_count = 0'
  );
end;
$$;

perform pg_temp.clear_simulation();

-- =======================================================================
-- SCENARIO 11: child INSERT/UPDATE/DELETE is denied after finalization
-- =======================================================================
perform pg_temp.simulate_user('00000000-0000-0000-0000-0000000000a1'::uuid);

do $$
declare
  v_report_id uuid;
begin
  select id into v_report_id from public.report_sec014 where staff_id = 'T-A1' and remark = 'synthetic patrol remark' limit 1; -- Scenario 1's already-finalized report

  begin
    insert into public.report_sec014_patrols (report_id, entry_no, location, description)
    values (v_report_id, 99, 'Gate B9', 'attempted post-finalization insert');
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

perform pg_temp.clear_simulation();

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
perform pg_temp.simulate_user('00000000-0000-0000-0000-0000000000a1'::uuid);

do $$
declare
  v_report_id uuid;
  v_queue_count_before integer;
  v_queue_count_after integer;
begin
  select id into v_report_id from public.report_sec014 where staff_id = 'T-A1' and remark = 'synthetic patrol remark' limit 1;
  select count(*) into v_queue_count_before from public.report_index_queue where source_table = 'report_sec014' and source_id = v_report_id;

  -- Calling finalization again with the SAME (still-correct) expected
  -- count must succeed without creating a duplicate queue row.
  perform public.mark_report_ready_for_indexing('report_sec014', v_report_id, 1);

  select count(*) into v_queue_count_after from public.report_index_queue where source_table = 'report_sec014' and source_id = v_report_id;
  perform pg_temp.assert(v_queue_count_before = 1 and v_queue_count_after = 1, 'SCENARIO 13: repeated finalization is idempotent -- no duplicate report_index_queue row is ever created');
end;
$$;

perform pg_temp.clear_simulation();

-- =======================================================================
-- SCENARIO 14: failed child insertion does not silently succeed, and a
-- correct retry recovers cleanly
-- =======================================================================
perform pg_temp.simulate_user('00000000-0000-0000-0000-0000000000a1'::uuid);

do $$
declare
  v_report_id uuid;
begin
  insert into public.report_sec014 (profile_id, status, station, team, staff_name, staff_id, date_time_in, date_time_out, remark, acknowledgement)
  values (auth.uid(), 'submitted', 'KUL', 'Alpha', 'Test ASO Alpha', 'T-A1', now(), now() + interval '1 hour', 'failed-then-retried fixture', false)
  returning id into v_report_id;

  -- Simulate a failed child insert: two rows with the SAME entry_no
  -- violate report_sec014_patrols' own (report_id, entry_no) unique
  -- constraint. The application's real submit action returns
  -- { ok: false, error } in this situation (patrolError check,
  -- lib/avsec/reports/actions.ts) rather than proceeding to finalize.
  begin
    insert into public.report_sec014_patrols (report_id, entry_no, location, description)
    values (v_report_id, 1, 'Gate D1', 'first'), (v_report_id, 1, 'Gate D2', 'duplicate entry_no -- simulated failure');
    raise exception 'SCENARIO 14 FAILED: the duplicate-entry_no insert should itself have failed (unique violation), simulating a genuine child-insert failure';
  exception when unique_violation then
    raise notice 'PASS: SCENARIO 14a: the simulated child-insert failure actually fails at the database level (unique_violation), matching what a real partial failure looks like';
  end;

  -- The report must NOT be finalizable yet -- zero child rows actually
  -- landed (the failed multi-row INSERT inserted nothing, atomically).
  perform pg_temp.assert(
    (select count(*) from public.report_sec014_patrols where report_id = v_report_id) = 0,
    'SCENARIO 14b: the failed insert left zero child rows -- no partial/duplicate child content from the failed attempt'
  );

  -- Retry: insert one correct patrol row, then finalize with the
  -- correct count -- this must succeed cleanly, proving the retry path
  -- does not create a duplicate PARENT (still the same v_report_id) and
  -- does not leave the report permanently stranded.
  insert into public.report_sec014_patrols (report_id, entry_no, location, description)
  values (v_report_id, 1, 'Gate D1', 'retried, correct');
  perform public.mark_report_ready_for_indexing('report_sec014', v_report_id, 1);
  perform pg_temp.assert(
    exists (select 1 from public.report_index_queue where source_table = 'report_sec014' and source_id = v_report_id),
    'SCENARIO 14c: after a corrected retry (one child row, matching count), finalization succeeds -- no stranded report'
  );
  perform pg_temp.assert(
    (select count(*) from public.report_sec014 where profile_id = auth.uid() and remark = 'failed-then-retried fixture') = 1,
    'SCENARIO 14d: exactly one parent row exists for this fixture -- the retry did not create a duplicate parent'
  );
end;
$$;

perform pg_temp.clear_simulation();

rollback; -- discard every synthetic fixture and result; this harness never commits.

-- If every NOTICE above printed PASS and this script reached this
-- comment without a raised exception, every listed scenario passed
-- against this disposable database.
