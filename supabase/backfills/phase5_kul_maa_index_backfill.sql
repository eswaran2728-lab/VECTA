-- PHASE 5 BACKFILL ARTIFACT -- NOT A MIGRATION. DO NOT APPLY WITHOUT
-- SEPARATE EXPLICIT AUTHORIZATION. This file is intentionally outside
-- supabase/migrations/ so it can never be picked up by an automated
-- migration run.
--
-- EXECUTION CONTEXT (added review round 3): index_report() performs a
-- classification-mirroring UPDATE against the already-submitted source
-- row. The corrected block_submitted_report_mutation() trigger (Part P)
-- only permits that exact 15-column update when auth.role() =
-- 'service_role' -- this script must therefore be run with service-role
-- privileges (e.g. the Supabase SQL editor's service-role connection,
-- or an equivalent superuser/service context), never as an ordinary
-- authenticated user, or every index_report() call inside it will be
-- rejected by that trigger. This is unchanged from -- and does not
-- weaken -- the trigger's protection: it is the same narrow exception
-- already relied on by the automatic indexing queue (Part Q).
--
-- Purpose: index the 8 existing, deterministic, station='KUL - MAA'
-- report rows (report_sec014=4, report_sec016=4; report_sec013/018/029/
-- 033/offload_records=0 as of the 2026-09-28 production inventory in
-- 20260928000004_phase5_report_classification_repository.sql) into the
-- Central Reporting Repository via the already-idempotent index_report()
-- RPC (Part H) -- never a raw INSERT into central_reports_index.
--
-- PRECONDITIONS (all four must hold; abort if any fails):
--   1. report_sec014 has exactly 4 rows, all station = 'KUL - MAA'.
--   2. report_sec016 has exactly 4 rows, all station = 'KUL - MAA'.
--   3. report_sec013/report_sec018/report_sec029/report_sec033/
--      offload_records have exactly 0 rows each.
--   4. Zero rows already exist in central_reports_index (this backfill
--      has never been run before against this target).
-- If any precondition fails -- in particular if the row counts have
-- drifted from this snapshot, or any row's station is not exactly
-- 'KUL - MAA' -- the script raises an exception and performs no writes.
-- No prefix-matching or fuzzy station comparison is used anywhere.
--
-- IDEMPOTENCY: index_report() itself early-returns on an existing
-- (source_table, source_id) match and has an ON CONFLICT DO NOTHING
-- structural backstop (Part H), so re-running this script after a
-- partial or full success is always safe and can never duplicate or
-- reclassify an already-indexed row.
--
-- The KUL-MAA -> org hierarchy mapping below (aoc_id/operating_entity_id/
-- hub_id/etc.) must be filled in from the live Phase 2 org tables at
-- execution time -- it is intentionally left as a lookup by code, never
-- a hardcoded id, since ids are environment-specific.

do $$
declare
  v_report_sec014_count integer;
  v_report_sec016_count integer;
  v_other_count integer;
  v_existing_index_count integer;
  v_aoc_id uuid;
  v_operating_entity_id uuid;
  v_operating_entity_code text;
  v_hub_id uuid;
  v_row record;
  v_indexed_count integer := 0;
begin
  -- Precondition 1-3: exact deterministic row counts.
  select count(*) into v_report_sec014_count from public.report_sec014;
  select count(*) into v_report_sec016_count from public.report_sec016;
  select
    (select count(*) from public.report_sec013)
    + (select count(*) from public.report_sec018)
    + (select count(*) from public.report_sec029)
    + (select count(*) from public.report_sec033)
    + (select count(*) from public.offload_records)
  into v_other_count;

  if v_report_sec014_count <> 4 then
    raise exception 'ABORT: expected exactly 4 rows in report_sec014, found %. Row counts have drifted since this backfill was authored -- re-derive the backfill before running it.', v_report_sec014_count;
  end if;
  if v_report_sec016_count <> 4 then
    raise exception 'ABORT: expected exactly 4 rows in report_sec016, found %. Row counts have drifted since this backfill was authored -- re-derive the backfill before running it.', v_report_sec016_count;
  end if;
  if v_other_count <> 0 then
    raise exception 'ABORT: expected 0 rows across report_sec013/018/029/033/offload_records, found %. This backfill only covers the originally-inventoried tables.', v_other_count;
  end if;

  -- Exact-match station check -- never a prefix or LIKE match.
  if exists (select 1 from public.report_sec014 where station <> 'KUL - MAA') then
    raise exception 'ABORT: report_sec014 contains a row whose station is not exactly ''KUL - MAA''.';
  end if;
  if exists (select 1 from public.report_sec016 where station <> 'KUL - MAA') then
    raise exception 'ABORT: report_sec016 contains a row whose station is not exactly ''KUL - MAA''.';
  end if;

  -- Precondition 4: never run against a target that already has index rows.
  select count(*) into v_existing_index_count from public.central_reports_index;
  if v_existing_index_count <> 0 then
    raise exception 'ABORT: central_reports_index already has % row(s) -- this backfill is only safe to run once, against an empty repository. If this is an intentional re-run, verify manually that no row will be duplicated (index_report() is idempotent, but re-running against an already-partially-indexed target should be reviewed, not assumed safe).', v_existing_index_count;
  end if;

  -- Resolve the KUL / MAA org hierarchy ids by code, never hardcoded --
  -- must exist from Phase 2's own seed/inventory for this to proceed.
  select oe.id, oe.code, oe.aoc_id
  into v_operating_entity_id, v_operating_entity_code, v_aoc_id
  from public.operating_entities oe
  where oe.code = 'MAA';
  if v_operating_entity_id is null then
    raise exception 'ABORT: no operating_entities row with code = ''MAA'' found -- cannot resolve the classification target.';
  end if;

  select h.id into v_hub_id
  from public.hubs h
  where h.code = 'KUL' and h.operating_entity_id = v_operating_entity_id;
  if v_hub_id is null then
    raise exception 'ABORT: no hubs row with code = ''KUL'' under operating_entity MAA found -- cannot resolve the classification target.';
  end if;

  -- Index all 4 report_sec014 rows.
  for v_row in select id, report_no, profile_id from public.report_sec014 where station = 'KUL - MAA' order by created_at
  loop
    perform public.index_report(
      'report_sec014', v_row.id, v_row.report_no,
      v_aoc_id, v_operating_entity_id, null, null, v_hub_id, null, null,
      v_operating_entity_code, null, v_row.profile_id
    );
    v_indexed_count := v_indexed_count + 1;
  end loop;

  -- Index all 4 report_sec016 rows.
  for v_row in select id, report_no, profile_id from public.report_sec016 where station = 'KUL - MAA' order by created_at
  loop
    perform public.index_report(
      'report_sec016', v_row.id, v_row.report_no,
      v_aoc_id, v_operating_entity_id, null, null, v_hub_id, null, null,
      v_operating_entity_code, null, v_row.profile_id
    );
    v_indexed_count := v_indexed_count + 1;
  end loop;

  if v_indexed_count <> 8 then
    raise exception 'UNEXPECTED: indexed % rows, expected exactly 8. Investigate before trusting the result.', v_indexed_count;
  end if;

  raise notice 'Backfill complete: % rows indexed.', v_indexed_count;
end;
$$;

-- BEFORE/AFTER VERIFICATION (run manually, compare counts):
--   before: select count(*) from public.central_reports_index; -- expect 0
--   after:  select count(*) from public.central_reports_index; -- expect 8
--   after:  select count(*) from public.report_versions where version_number = 1; -- expect 8
--   after:  select * from public.v_report_index_classification_gaps; -- expect 0 rows
--   after:  select * from public.v_report_index_current_version_mismatch; -- expect 0 rows
--
-- NOT NULL is never tightened on any source column by this script -- it
-- only calls index_report(), which only ever mirrors classification
-- values onto already-nullable columns (Part A).
