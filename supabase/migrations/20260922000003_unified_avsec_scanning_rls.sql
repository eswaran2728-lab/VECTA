-- Unified AVSEC CaterLink scanning model (operator decision, 2026-09-22).
--
-- Objective: any approved ASO/SO/DSE, regardless of whether their stored
-- profiles.ops_group is 'operation_avsec' or 'ifc_avsec', may scan and
-- process any non-Hub CaterLink checkpoint. hub_avsec stays fully
-- separate and unaffected.
--
-- Deliberately NOT a data migration: profiles.ops_group / users.ops_group
-- values are untouched. Reporting, acknowledgement, leave, overtime, and
-- roster scoping all key off ops_group specifically to disambiguate
-- Operation vs IFC teams that otherwise share team NAMES (e.g. both have
-- a "Team ALPHA" at the same station) - renaming the column's values
-- would silently reopen that cross-branch leak. This migration only
-- widens the CaterLink checkpoint-insert RLS policies from a single
-- ops_group match to a union of the two AVSEC branches; hub_avsec's own
-- policy (part_hub) is untouched.

-- part_b: post2 inserts (was ops_group = 'ifc_avsec' only)
drop policy if exists "part_b: post2 inserts" on public.part_b;
create policy "part_b: post2 inserts" on public.part_b
for insert
with check (
  (
    current_user_role() = 'post2_avsec'
    or exists (
      select 1 from profiles p
      where p.id = auth.uid()
        and p.unified_role = any (array['aso', 'so', 'dse'])
        and p.ops_group = any (array['ifc_avsec', 'operation_avsec'])
    )
  )
  and completed_by = auth.uid()
);

-- part_c: post6 inserts (was ops_group = 'operation_avsec' only)
drop policy if exists "part_c: post6 inserts" on public.part_c;
create policy "part_c: post6 inserts" on public.part_c
for insert
with check (
  (
    current_user_role() = 'post6_avsec'
    or exists (
      select 1 from profiles p
      where p.id = auth.uid()
        and p.unified_role = any (array['aso', 'so', 'dse'])
        and p.ops_group = any (array['ifc_avsec', 'operation_avsec'])
    )
  )
  and completed_by = auth.uid()
);

-- part_d: receiver inserts (was ops_group = 'ifc_avsec' only)
drop policy if exists "part_d: receiver inserts" on public.part_d;
create policy "part_d: receiver inserts" on public.part_d
for insert
with check (
  (
    current_user_role() = 'receiver'
    or exists (
      select 1 from profiles p
      where p.id = auth.uid()
        and p.unified_role = any (array['aso', 'so', 'dse'])
        and p.ops_group = any (array['ifc_avsec', 'operation_avsec'])
    )
  )
  and completed_by = auth.uid()
);

-- part_redq: redq_avsec inserts (was ops_group = 'operation_avsec' only)
drop policy if exists "part_redq: redq_avsec inserts" on public.part_redq;
create policy "part_redq: redq_avsec inserts" on public.part_redq
for insert
with check (
  (
    current_user_role() = 'redq_avsec'
    or exists (
      select 1 from profiles p
      where p.id = auth.uid()
        and p.unified_role = any (array['aso', 'so', 'dse'])
        and p.ops_group = any (array['ifc_avsec', 'operation_avsec'])
    )
  )
  and completed_by = auth.uid()
);

-- seals: redq_avsec applies new seal at redq (was ops_group = 'operation_avsec' only)
drop policy if exists "seals: redq_avsec applies new seal at redq" on public.seals;
create policy "seals: redq_avsec applies new seal at redq" on public.seals
for insert
with check (
  (
    current_user_role() = 'redq_avsec'
    or exists (
      select 1 from profiles p
      where p.id = auth.uid()
        and p.unified_role = any (array['aso', 'so', 'dse'])
        and p.ops_group = any (array['ifc_avsec', 'operation_avsec'])
    )
  )
  and exists (
    select 1 from transactions t
    where t.id = seals.transaction_id
      and t.route = 'REDQ'
      and t.status = 'INFLIGHT_POST_APPROVED'
  )
);

-- seal_verifications: checkpoint roles verify (already ANY['ifc_avsec','operation_avsec']
-- - unchanged by this migration, restated here only for completeness of the audit trail)
-- vendor_part_b: post2 inserts (was ops_group = 'ifc_avsec' only) - vendor supply
-- is now unified-AVSEC-scoped too, matching the vendor scan-side change in
-- lib/icms/actions/scan.ts (resolveVendorTransaction).
drop policy if exists "vendor_part_b: post2 inserts" on public.vendor_part_b;
create policy "vendor_part_b: post2 inserts" on public.vendor_part_b
for insert
with check (
  (
    current_user_role() = 'post2_avsec'
    or exists (
      select 1 from profiles p
      where p.id = auth.uid()
        and p.unified_role = any (array['aso', 'so', 'dse'])
        and p.ops_group = any (array['ifc_avsec', 'operation_avsec'])
    )
  )
  and completed_by = auth.uid()
);
