-- ============================================================
-- Fix: ASO/SO/DSE accounts cannot read transactions/vendor_transactions
-- ============================================================
-- Root cause: "transactions: checkpoint and supervisor read all" (and its
-- vendor_transactions equivalent) gate on current_user_role(), defined as
-- `select role from users where id = auth.uid()`. ASO/SO/DSE are AVSEC-
-- native roles that live only in public.profiles — they have no row in
-- public.users at all (unlike post2_avsec/post6_avsec/hub_avsec/
-- redq_avsec/receiver/supervisor/enforcement/management, which are ICMS-
-- native or were given ICMS shadow rows) — so current_user_role() returns
-- NULL for them and RLS silently blocks every read, regardless of what
-- the app-layer ops_group check in lib/icms/actions/scan.ts says. Result:
-- an ASO scanning ANY transaction gets "Transaction not found" even when
-- the row exists and is genuinely in their ops_group.
--
-- Fix mirrors the existing "checkpoint roles read all, app enforces the
-- specific scope" pattern already used for post2_avsec etc. (see
-- lib/icms/actions/scan.ts's own comment: the ops_group scope check is
-- the real enforcement point, not RLS) — grant broad SELECT to any
-- profile with a team unified_role and an assigned ops_group, and let
-- scanTransaction()'s existing ops_group comparison narrow it per call.
-- part_a/b/c/d and vendor_part_a/b/c need no changes: their own SELECT
-- policies are `exists (select 1 from transactions/vendor_transactions
-- where id = transaction_id)`, which cascades from this fix automatically
-- (same "read follows transaction visibility" pattern noted in
-- management_icms_parity.sql).

create policy "transactions: avsec team roles read all"
  on public.transactions for select
  using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and p.unified_role in ('aso', 'so', 'dse')
        and p.ops_group is not null
    )
  );

create policy "vendor_transactions: avsec team roles read all"
  on public.vendor_transactions for select
  using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and p.unified_role in ('aso', 'so', 'dse')
        and p.ops_group is not null
    )
  );
