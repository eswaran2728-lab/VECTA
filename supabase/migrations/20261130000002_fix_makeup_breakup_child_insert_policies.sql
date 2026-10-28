-- Migration: 20261130000002_fix_makeup_breakup_child_insert_policies.sql
-- Description: Align RLS insert policies on report_makeup_baggage_entries, report_makeup_discrepancies,
--              and report_breakup_baggage_entries with standard parent-write pattern (removing draft-only restriction
--              on insert so parent rows created with status = 'submitted' can receive their child entries; immutability
--              is strictly guarded by the block_submitted_child_mutation triggers on update/delete).

-- 1. report_makeup_baggage_entries
drop policy if exists makeup_baggage_entries_insert on public.report_makeup_baggage_entries;
create policy makeup_baggage_entries_insert on public.report_makeup_baggage_entries
  for insert with check (
    exists (
      select 1 from public.report_makeup p
      where p.id = report_makeup_baggage_entries.report_id
        and p.profile_id = auth.uid()
    )
  );

-- 2. report_makeup_discrepancies
drop policy if exists makeup_discrepancies_insert on public.report_makeup_discrepancies;
create policy makeup_discrepancies_insert on public.report_makeup_discrepancies
  for insert with check (
    exists (
      select 1 from public.report_makeup p
      where p.id = report_makeup_discrepancies.report_id
        and p.profile_id = auth.uid()
    )
  );

-- 3. report_breakup_baggage_entries
drop policy if exists breakup_baggage_entries_insert on public.report_breakup_baggage_entries;
create policy breakup_baggage_entries_insert on public.report_breakup_baggage_entries
  for insert with check (
    exists (
      select 1 from public.report_breakup p
      where p.id = report_breakup_baggage_entries.report_id
        and p.profile_id = auth.uid()
    )
  );
