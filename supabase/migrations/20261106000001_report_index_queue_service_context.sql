-- Report index queue: run the worker in the service-role context (additive; replaces one function body, same signature and grants).
--
-- DEFECT (verified on staging): process_report_index_queue() is invoked every minute by pg_cron as role postgres, with no JWT, so
-- auth.role() is NULL. For a freshly submitted report, index_report() mirrors the classification into the submitted source row and the
-- immutability guard (block_submitted_report_mutation) permits that only when auth.role() = 'service_role'. The first indexing attempt
-- therefore failed with "Submitted reports are immutable ..." and the queue row became permanently_failed, so the report never reached
-- central_reports_index (invisible to search, leadership lists and PDF authorization). Reproduced in a rolled-back transaction with
-- auth.role() NULL; the same call succeeds with the service-role claim.
--
-- Fix: the worker sets the transaction-local service-role claim itself. Execution remains limited to service_role (and the cron owner).
-- Repair: queue rows that failed ONLY because of this defect are returned to 'pending' (no report row is touched).

create or replace function public.process_report_index_queue(p_batch_size integer default 50)
returns table (processed integer, indexed integer, failed integer, permanently_failed integer)
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
  v_permanently_failed integer := 0;
  v_aoc_id uuid;
  v_source_exists boolean;
begin
  -- The queue runs under pg_cron (role postgres, no JWT), where auth.role() is NULL. index_report() mirrors the trusted classification
  -- into the submitted source row, and block_submitted_report_mutation() permits that only for service_role. Run this trusted,
  -- SECURITY DEFINER, service-role-only worker in the service-role context for the current transaction (transaction-local).
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);

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
      execute format('select exists(select 1 from public.%I where id = $1)', v_row.source_table)
        into v_source_exists using v_row.source_id;

      if not v_source_exists then
        update public.report_index_queue
        set status = 'permanently_failed', last_error = 'source row no longer exists', processed_at = now()
        where id = v_row.id;
        v_permanently_failed := v_permanently_failed + 1;
        continue;
      end if;

      execute format('select aoc_id from public.%I where id = $1', v_row.source_table)
        into v_aoc_id using v_row.source_id;

      if v_aoc_id is null then
        update public.report_index_queue
        set status = 'failed', last_error = 'source row not yet classified (aoc_id is null); retryable once the submitter has exactly one active role assignment', processed_at = now()
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
      -- Any failure other than "not yet classified" or "source gone" --
      -- e.g. index_report()'s own hierarchy-validation exception --
      -- indicates a data problem that will not self-resolve by retrying
      -- the identical inputs, so this is treated as permanent.
      update public.report_index_queue
      set status = 'permanently_failed', last_error = sqlerrm, processed_at = now()
      where id = v_row.id;
      v_permanently_failed := v_permanently_failed + 1;
    end;
  end loop;

  return query select v_processed, v_indexed, v_failed, v_permanently_failed;
end;
$function$;

revoke execute on function public.process_report_index_queue(integer) from public, anon, authenticated;
grant execute on function public.process_report_index_queue(integer) to service_role;

update public.report_index_queue
set status = 'pending', attempts = 0, last_error = null, processed_at = null
where status = 'permanently_failed' and last_error like 'Submitted reports are immutable and cannot be edited%';
