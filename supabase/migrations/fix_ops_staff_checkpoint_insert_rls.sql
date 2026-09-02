-- ============================================================
-- Fix: ASO/SO/DSE ('ops_staff') accounts cannot complete ANY checkpoint
-- ============================================================
-- Companion to fix_aso_so_dse_transactions_read_rls.sql, and to the app-
-- layer requireCheckpointRole() added in lib/icms/auth.ts. That earlier
-- migration fixed READ access (Scan/the transaction detail page); this
-- fixes WRITE access, which was still completely blocked at the database
-- layer even after the app-layer check was loosened.
--
-- Root cause: every ordinary ASO/SO/DSE account gets the deliberately
-- generic ICMS role 'ops_staff' (see backfill_icms_shadow_users.sql's
-- documented judgment call — "no ICMS role represents generic patrol
-- staff"), never a checkpoint-specific role like post2_avsec. The
-- part_b/part_c/part_d/part_hub/part_redq/vendor_part_b INSERT policies
-- all gate on an exact current_user_role() match to one specific
-- checkpoint role, so 'ops_staff' was rejected by every one of them
-- regardless of ops_group or what the application layer allowed through.
-- Net effect: no regular team member could ever actually complete a
-- checkpoint — only the handful of literally-named demo/checkpoint
-- accounts (post2_avsec etc.) could, contradicting the explicit
-- "every team scans and does their part" requirement team_based_ops_
-- groups.sql was built for.
--
-- Fix: OR in the same ops_group-based path already trusted for reads —
-- an AVSEC team member (aso/so/dse) whose ops_group matches the
-- checkpoint's owning ops_group (opsGroupForCheckpointRole's mapping,
-- restated here) may also insert. completed_by = auth.uid() stays
-- mandatory either way — the actual identity is always the real signed-in
-- officer, never spoofable via this change.

alter policy "part_b: post2 inserts" on public.part_b
  with check (
    (
      public.current_user_role() = 'post2_avsec'
      or exists (
        select 1 from public.profiles p
        where p.id = auth.uid() and p.unified_role in ('aso', 'so', 'dse') and p.ops_group = 'ifc_avsec'
      )
    )
    and completed_by = auth.uid()
  );

alter policy "part_c: post6 inserts" on public.part_c
  with check (
    (
      public.current_user_role() = 'post6_avsec'
      or exists (
        select 1 from public.profiles p
        where p.id = auth.uid() and p.unified_role in ('aso', 'so', 'dse') and p.ops_group = 'operation_avsec'
      )
    )
    and completed_by = auth.uid()
  );

alter policy "part_d: receiver inserts" on public.part_d
  with check (
    (
      public.current_user_role() = 'receiver'
      or exists (
        select 1 from public.profiles p
        where p.id = auth.uid() and p.unified_role in ('aso', 'so', 'dse') and p.ops_group = 'ifc_avsec'
      )
    )
    and completed_by = auth.uid()
  );

alter policy "part_hub: hub_avsec inserts" on public.part_hub
  with check (
    (
      current_user_role() = 'hub_avsec'
      or exists (
        select 1 from public.profiles p
        where p.id = auth.uid() and p.unified_role in ('aso', 'so', 'dse') and p.ops_group = 'hub_avsec'
      )
    )
    and completed_by = auth.uid()
  );

alter policy "part_redq: redq_avsec inserts" on public.part_redq
  with check (
    (
      current_user_role() = 'redq_avsec'
      or exists (
        select 1 from public.profiles p
        where p.id = auth.uid() and p.unified_role in ('aso', 'so', 'dse') and p.ops_group = 'operation_avsec'
      )
    )
    and completed_by = auth.uid()
  );

alter policy "vendor_part_b: post2 inserts" on public.vendor_part_b
  with check (
    (
      public.current_user_role() = 'post2_avsec'
      or exists (
        select 1 from public.profiles p
        where p.id = auth.uid() and p.unified_role in ('aso', 'so', 'dse') and p.ops_group = 'ifc_avsec'
      )
    )
    and completed_by = auth.uid()
  );

-- verifySealsAtCheckpoint() (lib/icms/actions/transactions.ts) writes here
-- as part of completing part_b/part_c/part_d — without this, that insert
-- would still fail for an ops_staff account even with the part_b/c/d
-- policies above fixed, since it's a separate table/policy. Coarse-
-- grained ops_group check (ifc_avsec or operation_avsec) mirroring the
-- original's equally coarse role list, which doesn't tie a role to one
-- specific `checkpoint` column value either.
alter policy "seal_verifications: checkpoint roles verify"
  on public.seal_verifications
  with check (
    (
      current_user_role() = any (array['post2_avsec', 'post6_avsec', 'receiver', 'redq_avsec'])
      or exists (
        select 1 from public.profiles p
        where p.id = auth.uid() and p.unified_role in ('aso', 'so', 'dse')
          and p.ops_group in ('ifc_avsec', 'operation_avsec')
      )
    )
    and verified_by = auth.uid()
  );

-- submitPartRedq() applies the new seal by inserting here directly (the
-- old seal's supersede happens via the security-definer trigger, no RLS
-- involved there) — same gap as the part_redq insert policy itself.
alter policy "seals: redq_avsec applies new seal at redq"
  on public.seals
  with check (
    (
      current_user_role() = 'redq_avsec'
      or exists (
        select 1 from public.profiles p
        where p.id = auth.uid() and p.unified_role in ('aso', 'so', 'dse') and p.ops_group = 'operation_avsec'
      )
    )
    and exists (
      select 1 from public.transactions t
      where t.id = seals.transaction_id
        and t.route = 'REDQ'
        and t.status = 'INFLIGHT_POST_APPROVED'
    )
  );
