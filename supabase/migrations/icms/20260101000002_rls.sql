-- ============================================================
-- CSCS - Migration 2: Row Level Security policies
-- ============================================================

-- Helper: current user's application role (security definer so it can
-- read public.users regardless of the caller's own policies).
create or replace function public.current_user_role()
returns text
language sql
security definer
stable
set search_path = public
as $$
  select role from users where id = auth.uid();
$$;

alter table public.users enable row level security;
alter table public.transactions enable row level security;
alter table public.part_a enable row level security;
alter table public.part_b enable row level security;
alter table public.part_c enable row level security;
alter table public.part_d enable row level security;
alter table public.incidents enable row level security;
alter table public.audit_logs enable row level security;
alter table public.transaction_counters enable row level security;

-- ------------------------------------------------------------
-- users
-- ------------------------------------------------------------
create policy "users: read own profile"
  on public.users for select
  using (id = auth.uid());

create policy "users: supervisor reads all"
  on public.users for select
  using (public.current_user_role() = 'supervisor');

-- Profile creation/updates are done with the service role from the
-- Supervisor panel; no anon/authenticated insert or update policies.

-- ------------------------------------------------------------
-- transactions
-- ------------------------------------------------------------
-- Every operational role needs to see transactions to process checkpoints.
-- Warehouse PIC sees own transactions; checkpoint roles and supervisor see all.
create policy "transactions: warehouse reads own"
  on public.transactions for select
  using (
    public.current_user_role() = 'warehouse_pic' and created_by = auth.uid()
  );

create policy "transactions: checkpoint and supervisor read all"
  on public.transactions for select
  using (
    public.current_user_role() in ('post2_avsec', 'post6_avsec', 'receiver', 'supervisor')
  );

create policy "transactions: warehouse creates"
  on public.transactions for insert
  with check (
    public.current_user_role() = 'warehouse_pic'
    and created_by = auth.uid()
    and status = 'CREATED'
  );

-- Status transitions are performed exclusively by security-definer
-- triggers (enforce_part_sequence / escalate_on_incident); no direct
-- UPDATE policy is granted to any role.

-- ------------------------------------------------------------
-- part_a: created by warehouse_pic together with the transaction
-- ------------------------------------------------------------
create policy "part_a: read follows transaction visibility"
  on public.part_a for select
  using (
    exists (select 1 from public.transactions t where t.id = transaction_id)
  );

create policy "part_a: warehouse inserts own"
  on public.part_a for insert
  with check (
    public.current_user_role() = 'warehouse_pic'
    and completed_by = auth.uid()
    and exists (
      select 1 from public.transactions t
      where t.id = transaction_id and t.created_by = auth.uid()
    )
  );

-- ------------------------------------------------------------
-- part_b: AVSEC Post 2 only
-- ------------------------------------------------------------
create policy "part_b: read follows transaction visibility"
  on public.part_b for select
  using (
    exists (select 1 from public.transactions t where t.id = transaction_id)
  );

create policy "part_b: post2 inserts"
  on public.part_b for insert
  with check (
    public.current_user_role() = 'post2_avsec'
    and completed_by = auth.uid()
  );

-- ------------------------------------------------------------
-- part_c: AVSEC Post 6 only
-- ------------------------------------------------------------
create policy "part_c: read follows transaction visibility"
  on public.part_c for select
  using (
    exists (select 1 from public.transactions t where t.id = transaction_id)
  );

create policy "part_c: post6 inserts"
  on public.part_c for insert
  with check (
    public.current_user_role() = 'post6_avsec'
    and completed_by = auth.uid()
  );

-- ------------------------------------------------------------
-- part_d: receiver only
-- ------------------------------------------------------------
create policy "part_d: read follows transaction visibility"
  on public.part_d for select
  using (
    exists (select 1 from public.transactions t where t.id = transaction_id)
  );

create policy "part_d: receiver inserts"
  on public.part_d for insert
  with check (
    public.current_user_role() = 'receiver'
    and completed_by = auth.uid()
  );

-- ------------------------------------------------------------
-- incidents: any authenticated operational user can report
-- ------------------------------------------------------------
create policy "incidents: read follows transaction visibility"
  on public.incidents for select
  using (
    exists (select 1 from public.transactions t where t.id = transaction_id)
  );

create policy "incidents: any role reports"
  on public.incidents for insert
  with check (
    public.current_user_role() is not null
    and reported_by_id = auth.uid()
  );

-- ------------------------------------------------------------
-- audit_logs: written by triggers, readable by supervisor only
-- ------------------------------------------------------------
create policy "audit_logs: supervisor reads"
  on public.audit_logs for select
  using (public.current_user_role() = 'supervisor');

-- Inserts happen inside security-definer trigger functions, so no
-- insert policy is required for end users.

-- transaction_counters: internal only (security definer function),
-- no policies -> inaccessible to clients.

-- ------------------------------------------------------------
-- Storage buckets: signatures and incident photos (private).
-- Rendered through short-lived signed URLs generated server side.
-- ------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('signatures', 'signatures', false)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('incident-photos', 'incident-photos', false)
on conflict (id) do nothing;

create policy "signatures: authenticated upload"
  on storage.objects for insert
  with check (
    bucket_id = 'signatures' and auth.role() = 'authenticated'
  );

create policy "signatures: authenticated read"
  on storage.objects for select
  using (
    bucket_id = 'signatures' and auth.role() = 'authenticated'
  );

create policy "incident photos: authenticated upload"
  on storage.objects for insert
  with check (
    bucket_id = 'incident-photos' and auth.role() = 'authenticated'
  );

create policy "incident photos: authenticated read"
  on storage.objects for select
  using (
    bucket_id = 'incident-photos' and auth.role() = 'authenticated'
  );
