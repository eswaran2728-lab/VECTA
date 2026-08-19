-- ============================================================
-- ICMS: Vendor Movement Module (AA/SEC/F/019 "Vendors Supplies
-- Security Form"). A second, independent workflow alongside the
-- catering IFCSF flow — external vendor drivers moving supplies
-- through AirAsia Security (Post 2) and the in-flight warehouse.
--
-- Part A (Vendor)              -> creates vendor_transactions + vendor_part_a
-- Part B (AirAsia Security)    -> vendor_part_b, post2_avsec only
-- Part C (Warehouse, dual sig) -> vendor_part_c, warehouse_pic + vendor driver
--
-- Status: CREATED -> SECURITY_VERIFIED -> (PART_C_PARTIAL) -> COMPLETED
--         or ESCALATED (reserved; no escalation path wired yet — this
--         module does not integrate with public.incidents).
--
-- Deliberately NOT wired into audit_logs: log_audit() branches on
-- tg_table_name = 'transactions' and otherwise assumes a
-- transaction_id column; vendor_transactions uses its own id/FK
-- shape and audit_logs.transaction_id FKs to public.transactions,
-- not vendor_transactions. Extending that safely (parallel audit
-- table, or a more generic trigger) is a follow-up if audit
-- coverage is required here, not attempted in this migration.
-- ============================================================

alter table public.users drop constraint users_role_check;
alter table public.users
  add constraint users_role_check
  check (role = any (array[
    'warehouse_pic', 'post2_avsec', 'post6_avsec', 'receiver',
    'supervisor', 'enforcement', 'vendor'
  ]));

-- ------------------------------------------------------------
-- vendor_transactions
-- ------------------------------------------------------------
create table public.vendor_transactions (
  id uuid primary key default gen_random_uuid(),
  transaction_number text unique not null default '',
  status text not null default 'CREATED'
    check (status in ('CREATED', 'SECURITY_VERIFIED', 'PART_C_PARTIAL', 'COMPLETED', 'ESCALATED')),
  qr_token text,
  completed_form_url text,
  created_by uuid not null references public.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create index idx_vendor_transactions_status on public.vendor_transactions (status);
create index idx_vendor_transactions_created_by on public.vendor_transactions (created_by);
create index idx_vendor_transactions_created_at on public.vendor_transactions (created_at);

-- Own VMS-YYYY-000001 sequence, mirroring next_transaction_number()/
-- transaction_counters exactly but kept separate so the two modules'
-- numbering never collide or share a counter.
create table public.vendor_transaction_counters (
  year int primary key,
  counter int not null default 0
);

create or replace function public.next_vendor_transaction_number()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_year int := extract(year from now())::int;
  v_counter int;
begin
  insert into vendor_transaction_counters as vtc (year, counter)
  values (v_year, 1)
  on conflict (year) do update set counter = vtc.counter + 1
  returning counter into v_counter;

  return format('VMS-%s-%s', v_year, lpad(v_counter::text, 6, '0'));
end;
$$;

create or replace function public.set_vendor_transaction_number()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.transaction_number is null or new.transaction_number = '' then
    new.transaction_number := public.next_vendor_transaction_number();
  end if;
  return new;
end;
$$;

create trigger trg_set_vendor_transaction_number
  before insert on public.vendor_transactions
  for each row execute function public.set_vendor_transaction_number();

create trigger trg_vendor_transactions_touch
  before update on public.vendor_transactions
  for each row execute function public.touch_updated_at();

-- Never deletable, matching public.transactions — history is preserved,
-- only status can move forward via the security-definer sequence triggers.
create trigger trg_vendor_transactions_no_delete
  before delete on public.vendor_transactions
  for each row execute function public.block_mutation();

-- ------------------------------------------------------------
-- vendor_part_a (Vendor) — write-once, mirrors part_a's shape.
-- ------------------------------------------------------------
create table public.vendor_part_a (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null unique references public.vendor_transactions (id) on delete cascade,
  driver_name text not null,
  nric_number text not null,
  seal_number text not null,
  signature_url text not null,
  completed_by uuid not null references public.users (id),
  completed_at timestamptz not null default now()
);

create index idx_vendor_part_a_transaction on public.vendor_part_a (transaction_id);

create trigger trg_vendor_part_a_immutable
  before update or delete on public.vendor_part_a
  for each row execute function public.block_mutation();

-- ------------------------------------------------------------
-- vendor_part_b (AirAsia Security / Post 2) — write-once.
-- avsec_name/avsec_staff_id denormalized (mirrors part_b.avsec_name/
-- avsec_staff_id) so the officer's identity renders without a users
-- join, which other roles' RLS would block anyway.
-- ------------------------------------------------------------
create table public.vendor_part_b (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null unique references public.vendor_transactions (id) on delete cascade,
  vehicle_registration_no text not null,
  driver_name text not null,
  driver_nric text not null,
  seal_number text not null,
  remarks text,
  signature_url text not null,
  avsec_name text not null,
  avsec_staff_id text not null,
  completed_by uuid not null references public.users (id),
  completed_at timestamptz not null default now()
);

create index idx_vendor_part_b_transaction on public.vendor_part_b (transaction_id);

create trigger trg_vendor_part_b_immutable
  before update or delete on public.vendor_part_b
  for each row execute function public.block_mutation();

-- ------------------------------------------------------------
-- vendor_part_c (Warehouse — In-Flight) — dual signature, single row.
-- Inserted by warehouse_pic (only side allowed to create the row);
-- both halves are captured in one submission per the app's UI design,
-- but the schema tolerates a partial row (one side only) for a retry
-- after a network failure, hence PART_C_PARTIAL as a real status.
-- ------------------------------------------------------------
create table public.vendor_part_c (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null unique references public.vendor_transactions (id) on delete cascade,
  warehouse_pic_id uuid references public.users (id),
  warehouse_pic_name text,
  warehouse_signature_url text,
  warehouse_signed_at timestamptz,
  vendor_driver_id uuid references public.users (id),
  vendor_driver_name text,
  vendor_signature_url text,
  vendor_signed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint vendor_part_c_warehouse_pairing_check check (
    (warehouse_pic_id is not null) = (warehouse_signature_url is not null)
    and (warehouse_pic_id is not null) = (warehouse_signed_at is not null)
  ),
  constraint vendor_part_c_vendor_pairing_check check (
    (vendor_driver_id is not null) = (vendor_signature_url is not null)
    and (vendor_driver_id is not null) = (vendor_signed_at is not null)
  )
);

create index idx_vendor_part_c_transaction on public.vendor_part_c (transaction_id);

create trigger trg_vendor_part_c_touch
  before update on public.vendor_part_c
  for each row execute function public.touch_updated_at();

-- ------------------------------------------------------------
-- Sequencing triggers (mirror enforce_part_sequence()'s shape,
-- separate functions since the status set and table shapes differ).
-- ------------------------------------------------------------
create or replace function public.enforce_vendor_part_sequence()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
begin
  select status into v_status from vendor_transactions where id = new.transaction_id for update;
  if v_status is null then
    raise exception 'ICMS: vendor transaction not found';
  end if;
  if v_status = 'ESCALATED' then
    raise exception 'ICMS: vendor transaction is escalated; checkpoint processing is suspended';
  end if;
  if v_status <> 'CREATED' then
    raise exception 'ICMS: Vendor Part B requires status CREATED (current: %)', v_status;
  end if;

  update vendor_transactions set status = 'SECURITY_VERIFIED' where id = new.transaction_id;
  return new;
end;
$$;

create trigger trg_vendor_part_b_sequence
  before insert on public.vendor_part_b
  for each row execute function public.enforce_vendor_part_sequence();

revoke execute on function public.enforce_vendor_part_sequence() from public, anon, authenticated;

create or replace function public.enforce_vendor_part_c_sequence()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
begin
  select status into v_status from vendor_transactions where id = new.transaction_id for update;
  if v_status is null then
    raise exception 'ICMS: vendor transaction not found';
  end if;
  if v_status = 'ESCALATED' then
    raise exception 'ICMS: vendor transaction is escalated; checkpoint processing is suspended';
  end if;
  if v_status not in ('SECURITY_VERIFIED', 'PART_C_PARTIAL') then
    raise exception 'ICMS: Vendor Part C requires status SECURITY_VERIFIED or PART_C_PARTIAL (current: %)', v_status;
  end if;

  if new.warehouse_pic_id is not null and new.vendor_driver_id is not null then
    update vendor_transactions set status = 'COMPLETED', completed_at = now() where id = new.transaction_id;
  else
    update vendor_transactions set status = 'PART_C_PARTIAL' where id = new.transaction_id;
  end if;

  return new;
end;
$$;

create trigger trg_vendor_part_c_sequence
  before insert or update on public.vendor_part_c
  for each row execute function public.enforce_vendor_part_c_sequence();

revoke execute on function public.enforce_vendor_part_c_sequence() from public, anon, authenticated;

-- ------------------------------------------------------------
-- RLS
-- ------------------------------------------------------------
alter table public.vendor_transactions enable row level security;
alter table public.vendor_part_a enable row level security;
alter table public.vendor_part_b enable row level security;
alter table public.vendor_part_c enable row level security;
alter table public.vendor_transaction_counters enable row level security;

create policy "vendor_transactions: vendor reads own"
  on public.vendor_transactions for select
  using (
    public.current_user_role() = 'vendor' and created_by = auth.uid()
  );

create policy "vendor_transactions: checkpoint roles read all"
  on public.vendor_transactions for select
  using (
    public.current_user_role() = any (array['post2_avsec', 'warehouse_pic', 'supervisor', 'enforcement'])
  );

create policy "vendor_transactions: vendor creates"
  on public.vendor_transactions for insert
  with check (
    public.current_user_role() = 'vendor'
    and created_by = auth.uid()
    and status = 'CREATED'
  );

-- No UPDATE policy for any client role — status transitions happen only
-- via the security-definer sequence triggers above, same as transactions.

create policy "vendor_part_a: read follows transaction visibility"
  on public.vendor_part_a for select
  using (
    exists (select 1 from public.vendor_transactions vt where vt.id = transaction_id)
  );

create policy "vendor_part_a: vendor inserts own"
  on public.vendor_part_a for insert
  with check (
    public.current_user_role() = 'vendor'
    and completed_by = auth.uid()
    and exists (
      select 1 from public.vendor_transactions vt
      where vt.id = transaction_id and vt.created_by = auth.uid()
    )
  );

create policy "vendor_part_b: read follows transaction visibility"
  on public.vendor_part_b for select
  using (
    exists (select 1 from public.vendor_transactions vt where vt.id = transaction_id)
  );

create policy "vendor_part_b: post2 inserts"
  on public.vendor_part_b for insert
  with check (
    public.current_user_role() = 'post2_avsec'
    and completed_by = auth.uid()
  );

create policy "vendor_part_c: read follows transaction visibility"
  on public.vendor_part_c for select
  using (
    exists (select 1 from public.vendor_transactions vt where vt.id = transaction_id)
  );

-- Only warehouse_pic may create the row (the first — and per the current
-- UI, only — side to insert); a defensive update path lets either party
-- fill in their own half, matching whichever column pair belongs to them.
create policy "vendor_part_c: warehouse inserts"
  on public.vendor_part_c for insert
  with check (
    public.current_user_role() = 'warehouse_pic'
    and warehouse_pic_id = auth.uid()
  );

-- Either party may write the row as long as their own half is theirs:
-- warehouse_pic_id = auth.uid() (or still null — the first write from
-- warehouse_pic claims it) for the warehouse side, vendor_driver_id for
-- the vendor side. In the current single-submission UI this is always
-- exercised by warehouse_pic's session writing both halves at once,
-- which the warehouse branch alone already permits (RLS checks the
-- whole new row against one matching branch, not column-by-column).
create policy "vendor_part_c: either side fills own half"
  on public.vendor_part_c for update
  using (
    (public.current_user_role() = 'warehouse_pic' and (warehouse_pic_id is null or warehouse_pic_id = auth.uid()))
    or (public.current_user_role() = 'vendor' and (vendor_driver_id is null or vendor_driver_id = auth.uid()))
  )
  with check (
    (public.current_user_role() = 'warehouse_pic' and warehouse_pic_id = auth.uid())
    or (public.current_user_role() = 'vendor' and vendor_driver_id = auth.uid())
  );

-- transaction_counters-style internal table: no policies, only reachable
-- from the security-definer next_vendor_transaction_number() function.
