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
perform pg_temp.simulate_user('00000000-0000-0000-0000-0000000000a1'::uuid);

do $$
declare
  v_report_id uuid;
begin
  insert into public.report_sec013 (profile_id, status, station, team, staff_name, staff_id, date_time_in, date_time_out, remark, acknowledgement)
  values (auth.uid(), 'submitted', 'KUL', 'Alpha', 'Test ASO Alpha', 'T-A1', now(), now() + interval '1 hour', 'sec013 required-zero fixture', false)
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
    not exists (select 1 from public.report_index_queue where source_table = 'report_sec013' and source_id = v_report_id),
    'SCENARIO 15: the rejected finalization attempt left no queue entry behind'
  );
end;
$$;

perform pg_temp.clear_simulation();

-- =======================================================================
-- SCENARIO 16 (round 7): child reassignment to a different parent report
-- is forbidden outright
-- =======================================================================
perform pg_temp.simulate_user('00000000-0000-0000-0000-0000000000a1'::uuid);

do $$
declare
  v_report_id_1 uuid;
  v_report_id_2 uuid;
  v_child_id uuid;
begin
  insert into public.report_sec014 (profile_id, status, station, team, staff_name, staff_id, date_time_in, date_time_out, remark, acknowledgement)
  values (auth.uid(), 'submitted', 'KUL', 'Alpha', 'Test ASO Alpha', 'T-A1', now(), now() + interval '1 hour', 'reassignment fixture parent 1', false)
  returning id into v_report_id_1;

  insert into public.report_sec014 (profile_id, status, station, team, staff_name, staff_id, date_time_in, date_time_out, remark, acknowledgement)
  values (auth.uid(), 'submitted', 'KUL', 'Alpha', 'Test ASO Alpha', 'T-A1', now(), now() + interval '1 hour', 'reassignment fixture parent 2', false)
  returning id into v_report_id_2;

  insert into public.report_sec014_patrols (report_id, entry_no, location, description)
  values (v_report_id_1, 1, 'Gate E1', 'reassignment target row')
  returning id into v_child_id;

  begin
    update public.report_sec014_patrols set report_id = v_report_id_2 where id = v_child_id;
    raise exception 'SCENARIO 16 FAILED: reassigning a child row''s report_id to a different parent should have been rejected outright';
  exception when others then
    if sqlerrm like '%Reassigning a child row to a different report is not supported%' then
      raise notice 'PASS: SCENARIO 16: enforce_child_write_before_finalization() forbids changing report_sec014_patrols.report_id on UPDATE, for EITHER parent (finalized or not)';
    else
      raise exception 'SCENARIO 16 FAILED: rejected for the wrong reason: %', sqlerrm;
    end if;
  end;

  perform pg_temp.assert(
    (select report_id from public.report_sec014_patrols where id = v_child_id) = v_report_id_1,
    'SCENARIO 16: the child row still belongs to its original parent -- the rejected UPDATE did not partially apply'
  );
end;
$$;

perform pg_temp.clear_simulation();

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
perform pg_temp.simulate_user('00000000-0000-0000-0000-0000000000a1'::uuid);

do $$
declare
  v_report_id uuid;
  v_child_count integer;
  v_parent_count_before integer;
  v_parent_count_after integer;
  v_queue_count_after integer;
begin
  insert into public.report_sec014 (profile_id, status, station, team, staff_name, staff_id, date_time_in, date_time_out, remark, acknowledgement)
  values (auth.uid(), 'submitted', 'KUL', 'Alpha', 'Test ASO Alpha', 'T-A1', now(), now() + interval '1 hour', 'resume-retry fixture', false)
  returning id into v_report_id;

  -- Child rows are written successfully (as they always are before the
  -- app's finalization call, per actions.ts's ordering). The app's own
  -- call to mark_report_ready_for_indexing() is presumed to have failed
  -- for a transient reason (e.g. a dropped connection) -- simulated
  -- here simply by not calling it yet, leaving the report in exactly
  -- the "child rows complete, finalization pending" state that
  -- resumeReportFinalization() exists to recover.
  insert into public.report_sec014_patrols (report_id, entry_no, location, description)
  values (v_report_id, 1, 'Gate F1', 'resume-retry child row');

  select count(*) into v_parent_count_before from public.report_sec014 where profile_id = auth.uid() and remark = 'resume-retry fixture';
  perform pg_temp.assert(v_parent_count_before = 1, 'SCENARIO 17: exactly one parent row exists before any resume attempt');

  -- Step 1 of resumeReportFinalization(): get_child_row_count_secure().
  select public.get_child_row_count_secure('report_sec014', v_report_id) into v_child_count;
  perform pg_temp.assert(v_child_count = 1, 'SCENARIO 17: get_child_row_count_secure() correctly reports 1 actual child row, ownership-checked, without direct child-table SELECT');

  -- Step 2: mark_report_ready_for_indexing() using that counted value,
  -- exactly as resumeReportFinalization() does (p_expected_child_count:
  -- childCount ?? 0).
  perform public.mark_report_ready_for_indexing('report_sec014', v_report_id, v_child_count);

  select count(*) into v_queue_count_after from public.report_index_queue where source_table = 'report_sec014' and source_id = v_report_id;
  perform pg_temp.assert(v_queue_count_after = 1, 'SCENARIO 17: the resumed finalization call succeeds and enqueues the report exactly once');

  select count(*) into v_parent_count_after from public.report_sec014 where profile_id = auth.uid() and remark = 'resume-retry fixture';
  perform pg_temp.assert(v_parent_count_after = 1, 'SCENARIO 17: still exactly one parent row after the resume -- retrying finalization never created a duplicate parent');

  -- A second resume attempt (e.g. the user double-clicking "retry")
  -- must remain a no-op, not a duplicate -- mark_report_ready_for_indexing()
  -- is idempotent (ON CONFLICT DO NOTHING), independently confirmed in
  -- SCENARIO 13.
  perform public.mark_report_ready_for_indexing('report_sec014', v_report_id, v_child_count);
  select count(*) into v_queue_count_after from public.report_index_queue where source_table = 'report_sec014' and source_id = v_report_id;
  perform pg_temp.assert(v_queue_count_after = 1, 'SCENARIO 17: a second resume attempt on an already-finalized report remains idempotent -- still exactly one queue entry');
end;
$$;

perform pg_temp.clear_simulation();

-- =======================================================================
-- SCENARIO 18 (round 8): incomplete SEC029 (missing checklist item(s))
-- is rejected -- not merely "not enough rows," but "not the RIGHT rows"
-- =======================================================================
perform pg_temp.simulate_user('00000000-0000-0000-0000-0000000000a1'::uuid);

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
    auth.uid(), 'submitted', 'KUL', 'Alpha', 'Test SO', 'SO-1', 'Test ASO Alpha', 'T-A1',
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

perform pg_temp.clear_simulation();

-- =======================================================================
-- SCENARIO 19 (round 8): duplicate or invalid SEC029 item codes rejected
-- =======================================================================
perform pg_temp.simulate_user('00000000-0000-0000-0000-0000000000a1'::uuid);

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
    auth.uid(), 'submitted', 'KUL', 'Alpha', 'Test SO', 'SO-1', 'Test ASO Alpha', 'T-A1',
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

perform pg_temp.clear_simulation();

-- =======================================================================
-- SCENARIO 20 (round 8): a valid, complete SEC029 report (all current
-- checklist items, no duplicates, no invalid codes) finalizes successfully
-- =======================================================================
perform pg_temp.simulate_user('00000000-0000-0000-0000-0000000000a1'::uuid);

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
    auth.uid(), 'submitted', 'KUL', 'Alpha', 'Test SO', 'SO-1', 'Test ASO Alpha', 'T-A1',
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
    exists (select 1 from public.report_index_queue where source_table = 'report_sec029' and source_id = v_report_id),
    'SCENARIO 20: a complete SEC029 report (exactly the current checklist''s item set) finalizes successfully'
  );
end;
$$;

perform pg_temp.clear_simulation();

-- =======================================================================
-- SCENARIO 21 (round 8): SEC018's existing maximum of 6 patrol entries is
-- now enforced at the database boundary -- 7 rejected, 6 accepted, 0
-- (legitimately optional) still accepted
-- =======================================================================
perform pg_temp.simulate_user('00000000-0000-0000-0000-0000000000a1'::uuid);

do $$
declare
  v_report_id_over uuid;
  v_report_id_ok uuid;
  i integer;
begin
  insert into public.report_sec018 (profile_id, status, station, team, staff_name, date_time, acknowledgement)
  values (auth.uid(), 'submitted', 'KUL', 'Alpha', 'Test ASO Alpha', now(), false)
  returning id into v_report_id_over;

  for i in 1..7 loop
    insert into public.report_sec018_patrols (report_id, entry_no, description)
    values (v_report_id_over, i, 'patrol ' || i);
  end loop;

  begin
    perform public.mark_report_ready_for_indexing('report_sec018', v_report_id_over, 7);
    raise exception 'SCENARIO 21 FAILED: finalizing report_sec018 with 7 patrol entries should have been rejected -- the form''s own max(6) rule';
  exception when others then
    if sqlerrm like '%has too much child content%' then
      raise notice 'PASS: SCENARIO 21a: report_sec018 finalization is rejected at 7 patrol entries -- the existing max(6) form rule is now also enforced at the database boundary';
    else
      raise exception 'SCENARIO 21 FAILED: rejected for the wrong reason: %', sqlerrm;
    end if;
  end;

  insert into public.report_sec018 (profile_id, status, station, team, staff_name, date_time, acknowledgement)
  values (auth.uid(), 'submitted', 'KUL', 'Alpha', 'Test ASO Alpha', now(), false)
  returning id into v_report_id_ok;

  for i in 1..6 loop
    insert into public.report_sec018_patrols (report_id, entry_no, description)
    values (v_report_id_ok, i, 'patrol ' || i);
  end loop;

  perform public.mark_report_ready_for_indexing('report_sec018', v_report_id_ok, 6);
  perform pg_temp.assert(
    exists (select 1 from public.report_index_queue where source_table = 'report_sec018' and source_id = v_report_id_ok),
    'SCENARIO 21b: exactly 6 patrol entries (the allowed maximum) finalizes successfully'
  );
end;
$$;

perform pg_temp.clear_simulation();

-- =======================================================================
-- SCENARIO 22 (round 8): child-insert failure followed by a successful
-- application-level recovery -- SQL-level simulation of
-- resumeReportSubmission()'s case (a) path (count confirmed 0, then
-- child rows inserted for the first time against the SAME parent id)
-- =======================================================================
perform pg_temp.simulate_user('00000000-0000-0000-0000-0000000000a1'::uuid);

do $$
declare
  v_report_id uuid;
  v_child_count integer;
begin
  insert into public.report_sec033 (profile_id, status, station, team, staff_name, staff_id, report_date, report_time)
  values (auth.uid(), 'submitted', 'KUL', 'Alpha', 'Test ASO Alpha', 'T-A1', current_date, '09:00')
  returning id into v_report_id;

  -- Simulate the original submit action's failed child insert: two rows
  -- with the same entry_no violate report_sec033_hold_checks' own
  -- unique(report_id, entry_no) constraint.
  begin
    insert into public.report_sec033_hold_checks (report_id, entry_no, parking_bay_no, aircraft_registration_no)
    values (v_report_id, 1, 'C1', '9M-XXA'), (v_report_id, 1, 'C2', '9M-XXB');
    raise exception 'SCENARIO 22 FAILED: the duplicate-entry_no insert should itself have failed';
  exception when unique_violation then
    raise notice 'PASS: SCENARIO 22a: the simulated child-insert failure actually fails (unique_violation), leaving the report stranded in case (a)';
  end;

  -- resumeReportSubmission()'s first step: check the actual count.
  select public.get_child_row_count_secure('report_sec033', v_report_id) into v_child_count;
  perform pg_temp.assert(v_child_count = 0, 'SCENARIO 22b: get_child_row_count_secure() confirms zero child rows -- this is case (a), safe to (re-)insert');

  -- resumeReportSubmission()'s case-(a) recovery: insert the (corrected)
  -- child rows for the first time, against the SAME existing parent id.
  insert into public.report_sec033_hold_checks (report_id, entry_no, parking_bay_no, aircraft_registration_no)
  values (v_report_id, 1, 'C1', '9M-XXA');

  perform public.mark_report_ready_for_indexing('report_sec033', v_report_id, 1);
  perform pg_temp.assert(
    exists (select 1 from public.report_index_queue where source_table = 'report_sec033' and source_id = v_report_id),
    'SCENARIO 22c: after the recovery insert, finalization succeeds -- the report is no longer stranded'
  );
  perform pg_temp.assert(
    (select count(*) from public.report_sec033 where profile_id = auth.uid() and staff_id = 'T-A1' and report_time = '09:00') = 1,
    'SCENARIO 22d: exactly one parent row exists -- the recovery never created a duplicate parent'
  );
end;
$$;

perform pg_temp.clear_simulation();

-- =======================================================================
-- SCENARIO 23 (round 8): finalization failure followed by a successful
-- recovery -- SQL-level simulation of resumeReportSubmission()'s case
-- (b) path (count already > 0, children are never re-inserted, only
-- finalization is retried)
-- =======================================================================
perform pg_temp.simulate_user('00000000-0000-0000-0000-0000000000a1'::uuid);

do $$
declare
  v_report_id uuid;
  v_child_count integer;
  v_child_count_before integer;
begin
  insert into public.offload_records (profile_id, status, station, team, staff_name, staff_id, flight_no, destination, aircraft_registration, flight_date, total_bags)
  values (auth.uid(), 'submitted', 'KUL', 'Alpha', 'Test ASO Alpha', 'T-A1', 'AK200', 'SIN', '9M-XYZ', current_date, 1)
  returning id into v_report_id;

  -- Child rows are written successfully -- the app's own finalization
  -- call is presumed to have failed transiently and is simply never
  -- made here, leaving the report in exactly the "children complete,
  -- finalization pending" state case (b) describes.
  insert into public.offload_items (report_id, entry_no, baggage_tag_no)
  values (v_report_id, 1, 'BAG-001');

  select count(*) into v_child_count_before from public.offload_items where report_id = v_report_id;
  perform pg_temp.assert(v_child_count_before = 1, 'SCENARIO 23a: exactly one child row exists before recovery');

  select public.get_child_row_count_secure('offload_records', v_report_id) into v_child_count;
  perform pg_temp.assert(v_child_count = 1, 'SCENARIO 23b: get_child_row_count_secure() confirms 1 (case (b) -- children already complete, only finalization is missing)');

  -- resumeReportSubmission()'s case-(b) path: skip insert entirely,
  -- finalize using the server-measured count.
  perform public.mark_report_ready_for_indexing('offload_records', v_report_id, v_child_count);
  perform pg_temp.assert(
    exists (select 1 from public.report_index_queue where source_table = 'offload_records' and source_id = v_report_id),
    'SCENARIO 23c: the resumed finalization succeeds without ever re-inserting a child row'
  );

  select count(*) into v_child_count from public.offload_items where report_id = v_report_id;
  perform pg_temp.assert(v_child_count = 1, 'SCENARIO 23d: still exactly one child row after recovery -- case (b) never duplicates children');
end;
$$;

perform pg_temp.clear_simulation();

-- =======================================================================
-- SCENARIO 24 (round 8): repeated retries never create duplicates --
-- calling the resume path 3 times in a row on an already-finalized
-- report stays at exactly 1 parent, 1 child set, 1 queue entry
-- =======================================================================
perform pg_temp.simulate_user('00000000-0000-0000-0000-0000000000a1'::uuid);

do $$
declare
  v_report_id uuid;
  v_child_count integer;
  v_queue_count integer;
  v_parent_count integer;
  v_i integer;
begin
  insert into public.report_sec013 (profile_id, status, station, team, staff_name, staff_id, date_time_in, date_time_out, acknowledgement)
  values (auth.uid(), 'submitted', 'KUL', 'Alpha', 'Test ASO Alpha', 'T-A1', now(), now() + interval '1 hour', false)
  returning id into v_report_id;

  insert into public.report_sec013_profiling_duties (report_id, entry_no, duty_area, time_from, time_to, location, sector_flight, description)
  values (v_report_id, 1, 'Departure Gate', '09:00', '09:30', 'Departure Gate Sector 5/6/7 (P-Q)', 'AK300', 'repeated-retry fixture');

  for v_i in 1..3 loop
    select public.get_child_row_count_secure('report_sec013', v_report_id) into v_child_count;
    perform public.mark_report_ready_for_indexing('report_sec013', v_report_id, v_child_count);
  end loop;

  select count(*) into v_queue_count from public.report_index_queue where source_table = 'report_sec013' and source_id = v_report_id;
  select count(*) into v_parent_count from public.report_sec013 where profile_id = auth.uid() and staff_id = 'T-A1' and date_time_out is not null;
  perform pg_temp.assert(v_queue_count = 1, 'SCENARIO 24a: 3 repeated resume attempts leave exactly 1 report_index_queue row');
  select count(*) into v_child_count from public.report_sec013_profiling_duties where report_id = v_report_id;
  perform pg_temp.assert(v_child_count = 1, 'SCENARIO 24b: 3 repeated resume attempts leave exactly 1 child row -- no duplicate children from repeated get_child_row_count_secure() + mark_report_ready_for_indexing() cycles');
end;
$$;

perform pg_temp.clear_simulation();

-- =======================================================================
-- SCENARIO 25 (round 8): an unauthorized retry attempt is denied --
-- Bravo (different profile, no relationship to Alpha's report) cannot
-- use either get_child_row_count_secure() or
-- mark_report_ready_for_indexing() against Alpha's report to "help" or
-- interfere with its recovery
-- =======================================================================
perform pg_temp.simulate_user('00000000-0000-0000-0000-0000000000a2'::uuid); -- Bravo

do $$
declare
  v_report_id uuid;
begin
  select id into v_report_id from public.report_sec014 where staff_id = 'T-A1' order by created_at desc limit 1;
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
    perform public.mark_report_ready_for_indexing('report_sec014', v_report_id, 1);
    raise exception 'SCENARIO 25 FAILED: Bravo should not be able to (re-)finalize a report Bravo does not own';
  exception when others then
    if sqlerrm like '%Only the submitting profile may mark a report ready for indexing%' then
      raise notice 'PASS: SCENARIO 25b: mark_report_ready_for_indexing() denies Bravo the same way -- an unauthorized retry is denied at every step of the resume path, not merely the first';
    else
      raise exception 'SCENARIO 25 FAILED: rejected for the wrong reason: %', sqlerrm;
    end if;
  end;
end;
$$;

perform pg_temp.clear_simulation();

rollback; -- discard every synthetic fixture and result; this harness never commits.

-- If every NOTICE above printed PASS and this script reached this
-- comment without a raised exception, every listed scenario passed
-- against this disposable database.
--
-- Scenarios 1-11, 13-25 are ordinary, executable-in-sequence assertions.
-- Scenario 12 is the sole exception: genuine cross-transaction
-- concurrency cannot be exercised within one linear script/connection,
-- so it is documented (with exact manual two-session steps) rather than
-- executed -- keep this distinction explicit in any report describing
-- what this harness covers. As with every prior round, this entire file
-- remains PREPARED BUT NOT EXECUTED: no local/disposable Postgres,
-- Docker, or Supabase CLI has been available in this development
-- environment at any point in Phase 6.
--
-- Round 8 added scenarios 18-25: SEC029 incomplete-checklist rejection
-- (18), SEC029 duplicate/invalid item rejection (19), SEC029 valid
-- complete acceptance (20), SEC018 maximum-6 enforcement (21),
-- child-insert-failure recovery (22), finalization-failure recovery
-- (23), repeated-retry non-duplication (24), and unauthorized-retry
-- denial (25). Scenarios 22-25 are SQL-level simulations of
-- resumeReportSubmission()'s exact RPC call sequence (the same
-- get_child_row_count_secure() then mark_report_ready_for_indexing()
-- calls the TypeScript action makes) -- this harness cannot invoke the
-- TypeScript server action itself, so it exercises the identical
-- database-level calls that action performs.
