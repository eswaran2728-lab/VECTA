-- ============================================================
-- ICMS: merge sra_warehouse_pic into warehouse_pic.
-- Both roles did identical work — the only difference was which
-- direction they could create, and that is now chosen explicitly in
-- the New Transaction form (Step 1) rather than implied by the role.
-- Existing sra_warehouse_pic accounts are migrated to warehouse_pic;
-- no accounts are deleted and no transaction history changes.
-- ============================================================

update public.users
set role = 'warehouse_pic'
where role = 'sra_warehouse_pic';

-- Policies that allowed either warehouse role now just check the one.
drop policy if exists "transactions: pic reads own" on public.transactions;
create policy "transactions: pic reads own"
  on public.transactions for select
  using (
    public.current_user_role() = 'warehouse_pic'
    and created_by = auth.uid()
  );

drop policy if exists "transactions: warehouse creates" on public.transactions;
create policy "transactions: warehouse creates"
  on public.transactions for insert
  with check (
    public.current_user_role() = 'warehouse_pic'
    and created_by = auth.uid()
    and status = 'CREATED'
    and direction in ('OUTBOUND', 'INBOUND')
  );

drop policy if exists "part_a: pic inserts own" on public.part_a;
create policy "part_a: pic inserts own"
  on public.part_a for insert
  with check (
    public.current_user_role() = 'warehouse_pic'
    and completed_by = auth.uid()
    and exists (
      select 1 from public.transactions t
      where t.id = transaction_id and t.created_by = auth.uid()
    )
  );

drop policy if exists "seals: pic applies at part a" on public.seals;
create policy "seals: pic applies at part a"
  on public.seals for insert
  with check (
    public.current_user_role() = 'warehouse_pic'
    and exists (
      select 1 from public.transactions t
      where t.id = transaction_id and t.created_by = auth.uid()
    )
  );

-- Retire the role from the allowed set (done last, after the update above).
alter table public.users drop constraint if exists users_role_check;
alter table public.users
  add constraint users_role_check
  check (role in ('warehouse_pic', 'post2_avsec', 'post6_avsec', 'receiver', 'supervisor'));
