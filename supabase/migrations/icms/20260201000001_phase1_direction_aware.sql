-- ============================================================
-- CSCS v2 - PHASE 1: Direction-aware workflow (incremental)
-- OUTBOUND (departure, blue seal):  A -> B (In-flight Post) -> C (Airport Post) -> D
-- INBOUND  (arrival,  green seal):  A -> C (Airport Post)  -> B (In-flight Post, FINAL)
-- No tables dropped; data preserved and migrated in place.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Direction values: WAREHOUSE_TO_AIRCRAFT -> OUTBOUND,
--    AIRCRAFT_TO_WAREHOUSE -> INBOUND, anything else -> OUTBOUND.
--    Guard/audit/touch triggers are disabled during the in-place
--    UPDATE because completed rows are otherwise immutable.
-- ------------------------------------------------------------
alter table public.transactions disable trigger trg_guard_transaction_update;
alter table public.transactions disable trigger trg_transactions_touch;
alter table public.transactions disable trigger trg_audit_transactions;

alter table public.transactions drop constraint transactions_direction_check;

update public.transactions
set direction = case
  when direction = 'WAREHOUSE_TO_AIRCRAFT' then 'OUTBOUND'
  when direction = 'AIRCRAFT_TO_WAREHOUSE' then 'INBOUND'
  when direction in ('OUTBOUND', 'INBOUND') then direction
  else 'OUTBOUND'
end;

alter table public.transactions
  add constraint transactions_direction_check
  check (direction in ('OUTBOUND', 'INBOUND'));

-- ------------------------------------------------------------
-- 2. Status rename:
--    POST2_APPROVED -> INFLIGHT_POST_APPROVED
--    POST6_APPROVED -> AIRPORT_POST_APPROVED
-- ------------------------------------------------------------
alter table public.transactions drop constraint transactions_status_check;

update public.transactions set status = 'INFLIGHT_POST_APPROVED' where status = 'POST2_APPROVED';
update public.transactions set status = 'AIRPORT_POST_APPROVED' where status = 'POST6_APPROVED';

alter table public.transactions
  add constraint transactions_status_check
  check (status in ('CREATED', 'INFLIGHT_POST_APPROVED', 'AIRPORT_POST_APPROVED', 'COMPLETED', 'ESCALATED'));

alter table public.transactions enable trigger trg_guard_transaction_update;
alter table public.transactions enable trigger trg_transactions_touch;
alter table public.transactions enable trigger trg_audit_transactions;

-- ------------------------------------------------------------
-- 3. New role: SRA Warehouse PIC (creates INBOUND transactions).
--    Existing warehouse_pic keeps creating OUTBOUND.
-- ------------------------------------------------------------
alter table public.users drop constraint users_role_check;
alter table public.users
  add constraint users_role_check
  check (role in ('warehouse_pic', 'sra_warehouse_pic', 'post2_avsec', 'post6_avsec', 'receiver', 'supervisor'));

-- ------------------------------------------------------------
-- 4. Direction-aware checkpoint sequence (DB-side source of truth,
--    mirrored by src/lib/workflow.ts in the app).
-- ------------------------------------------------------------
create or replace function public.enforce_part_sequence()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_direction text;
begin
  select status, direction into v_status, v_direction
  from transactions where id = new.transaction_id for update;

  if v_status is null then
    raise exception 'CSCS: transaction not found / transaksi tidak dijumpai';
  end if;

  if v_status = 'ESCALATED' then
    raise exception 'CSCS: transaction escalated, checkpoint processing suspended / transaksi dieskalasi, pemprosesan pusat pemeriksaan digantung';
  end if;

  if tg_table_name = 'part_b' then
    if v_direction = 'OUTBOUND' then
      if v_status <> 'CREATED' then
        raise exception 'CSCS: out of order - outbound Part B (In-flight Post) requires status CREATED, current % / tidak mengikut urutan - Bahagian B keluar memerlukan status CREATED, kini %', v_status, v_status;
      end if;
      update transactions set status = 'INFLIGHT_POST_APPROVED' where id = new.transaction_id;
    else
      -- INBOUND: Part B is the FINAL step and completes the transaction.
      if v_status <> 'AIRPORT_POST_APPROVED' then
        raise exception 'CSCS: out of order - inbound Part B (In-flight Post, final) requires status AIRPORT_POST_APPROVED, current % / tidak mengikut urutan - Bahagian B masuk (akhir) memerlukan status AIRPORT_POST_APPROVED, kini %', v_status, v_status;
      end if;
      update transactions set status = 'COMPLETED', completed_at = now() where id = new.transaction_id;
    end if;

  elsif tg_table_name = 'part_c' then
    if v_direction = 'OUTBOUND' then
      if v_status <> 'INFLIGHT_POST_APPROVED' then
        raise exception 'CSCS: out of order - outbound Part C (Airport Post) requires status INFLIGHT_POST_APPROVED, current % / tidak mengikut urutan - Bahagian C keluar memerlukan status INFLIGHT_POST_APPROVED, kini %', v_status, v_status;
      end if;
    else
      -- INBOUND: Part C (Airport Post) is the FIRST checkpoint after Part A.
      if v_status <> 'CREATED' then
        raise exception 'CSCS: out of order - inbound Part C (Airport Post) requires status CREATED, current % / tidak mengikut urutan - Bahagian C masuk memerlukan status CREATED, kini %', v_status, v_status;
      end if;
    end if;
    update transactions set status = 'AIRPORT_POST_APPROVED' where id = new.transaction_id;

  elsif tg_table_name = 'part_d' then
    if v_direction = 'INBOUND' then
      raise exception 'CSCS: Part D does not apply to inbound transactions / Bahagian D tidak terpakai untuk transaksi masuk';
    end if;
    if v_status <> 'AIRPORT_POST_APPROVED' then
      raise exception 'CSCS: out of order - Part D requires status AIRPORT_POST_APPROVED, current % / tidak mengikut urutan - Bahagian D memerlukan status AIRPORT_POST_APPROVED, kini %', v_status, v_status;
    end if;
    update transactions set status = 'COMPLETED', completed_at = now() where id = new.transaction_id;
  end if;

  return new;
end;
$$;

-- ------------------------------------------------------------
-- 5. RLS: direction determines which PIC role may create.
-- ------------------------------------------------------------
drop policy "transactions: warehouse creates" on public.transactions;

create policy "transactions: warehouse creates outbound"
  on public.transactions for insert
  with check (
    public.current_user_role() = 'warehouse_pic'
    and created_by = auth.uid()
    and status = 'CREATED'
    and direction = 'OUTBOUND'
  );

create policy "transactions: sra warehouse creates inbound"
  on public.transactions for insert
  with check (
    public.current_user_role() = 'sra_warehouse_pic'
    and created_by = auth.uid()
    and status = 'CREATED'
    and direction = 'INBOUND'
  );

-- Both PIC roles read their own transactions.
drop policy "transactions: warehouse reads own" on public.transactions;

create policy "transactions: pic reads own"
  on public.transactions for select
  using (
    public.current_user_role() in ('warehouse_pic', 'sra_warehouse_pic')
    and created_by = auth.uid()
  );

-- Both PIC roles insert Part A for their own transactions.
drop policy "part_a: warehouse inserts own" on public.part_a;

create policy "part_a: pic inserts own"
  on public.part_a for insert
  with check (
    public.current_user_role() in ('warehouse_pic', 'sra_warehouse_pic')
    and completed_by = auth.uid()
    and exists (
      select 1 from public.transactions t
      where t.id = transaction_id and t.created_by = auth.uid()
    )
  );
