-- ============================================================
-- ICMS: let the warehouse PIC choose the direction at creation.
-- Previously each warehouse role was locked to one direction by RLS
-- (warehouse_pic=OUTBOUND, sra_warehouse_pic=INBOUND). Operationally the
-- same warehouse handles both dispatch (outbound) and returns (inbound),
-- so either PIC role may now create either direction. The direction still
-- drives the downstream checkpoint sequence via enforce_part_sequence().
-- Incremental only: policies replaced, no data touched.
-- ============================================================

drop policy if exists "transactions: warehouse creates outbound" on public.transactions;
drop policy if exists "transactions: sra warehouse creates inbound" on public.transactions;
drop policy if exists "transactions: warehouse creates" on public.transactions;

create policy "transactions: warehouse creates"
  on public.transactions for insert
  with check (
    public.current_user_role() in ('warehouse_pic', 'sra_warehouse_pic')
    and created_by = auth.uid()
    and status = 'CREATED'
    and direction in ('OUTBOUND', 'INBOUND')
  );
