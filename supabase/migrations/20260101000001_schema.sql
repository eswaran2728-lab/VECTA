-- ============================================================
-- CSCS - Catering Security Control System
-- Migration 1: Core schema, constraints, indexes, triggers
-- ============================================================

-- ------------------------------------------------------------
-- users (application profile, linked 1:1 to auth.users)
-- ------------------------------------------------------------
create table public.users (
  id uuid primary key references auth.users (id) on delete cascade,
  name text not null,
  staff_id text not null unique,
  email text not null unique,
  role text not null check (role in ('warehouse_pic', 'post2_avsec', 'post6_avsec', 'receiver', 'supervisor')),
  created_at timestamptz not null default now()
);

-- ------------------------------------------------------------
-- transactions
-- ------------------------------------------------------------
create table public.transactions (
  id uuid primary key default gen_random_uuid(),
  transaction_number text unique not null default '',
  direction text not null check (direction in ('WAREHOUSE_TO_AIRCRAFT', 'AIRCRAFT_TO_WAREHOUSE')),
  vehicle_number text not null,
  driver_name text not null,
  driver_id text not null,
  seal_number text not null,
  status text not null default 'CREATED'
    check (status in ('CREATED', 'POST2_APPROVED', 'POST6_APPROVED', 'COMPLETED', 'ESCALATED')),
  created_by uuid not null references public.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create index idx_transactions_status on public.transactions (status);
create index idx_transactions_created_at on public.transactions (created_at);
create index idx_transactions_vehicle_number on public.transactions (vehicle_number);
create index idx_transactions_driver_id on public.transactions (driver_id);
create index idx_transactions_seal_number on public.transactions (seal_number);
create index idx_transactions_created_by on public.transactions (created_by);

-- Sequential transaction number: CSCS-YYYY-000001, counter resets each year.
create table public.transaction_counters (
  year int primary key,
  counter int not null default 0
);

create or replace function public.next_transaction_number()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_year int := extract(year from now())::int;
  v_counter int;
begin
  insert into transaction_counters as tc (year, counter)
  values (v_year, 1)
  on conflict (year) do update set counter = tc.counter + 1
  returning counter into v_counter;

  return format('CSCS-%s-%s', v_year, lpad(v_counter::text, 6, '0'));
end;
$$;

create or replace function public.set_transaction_number()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.transaction_number is null or new.transaction_number = '' then
    new.transaction_number := public.next_transaction_number();
  end if;
  return new;
end;
$$;

create trigger trg_set_transaction_number
  before insert on public.transactions
  for each row execute function public.set_transaction_number();

-- updated_at maintenance
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger trg_transactions_touch
  before update on public.transactions
  for each row execute function public.touch_updated_at();

-- ------------------------------------------------------------
-- part_a (Warehouse PIC)
-- ------------------------------------------------------------
create table public.part_a (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null unique references public.transactions (id) on delete cascade,
  pic_name text not null,
  pic_staff_id text not null,
  vehicle_search_completed boolean not null default false,
  signature_url text not null,
  remarks text,
  completed_by uuid not null references public.users (id),
  completed_at timestamptz not null default now()
);

create index idx_part_a_transaction on public.part_a (transaction_id);

-- ------------------------------------------------------------
-- part_b (AVSEC Post 2)
-- ------------------------------------------------------------
create table public.part_b (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null unique references public.transactions (id) on delete cascade,
  avsec_name text not null,
  avsec_staff_id text not null,
  vehicle_verified boolean not null default false,
  driver_verified boolean not null default false,
  seal_verified boolean not null default false,
  signature_url text not null,
  remarks text,
  completed_by uuid not null references public.users (id),
  completed_at timestamptz not null default now()
);

create index idx_part_b_transaction on public.part_b (transaction_id);

-- ------------------------------------------------------------
-- part_c (AVSEC Post 6)
-- ------------------------------------------------------------
create table public.part_c (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null unique references public.transactions (id) on delete cascade,
  avsec_name text not null,
  avsec_staff_id text not null,
  vehicle_verified boolean not null default false,
  driver_verified boolean not null default false,
  seal_verified boolean not null default false,
  signature_url text not null,
  remarks text,
  completed_by uuid not null references public.users (id),
  completed_at timestamptz not null default now()
);

create index idx_part_c_transaction on public.part_c (transaction_id);

-- ------------------------------------------------------------
-- part_d (SRA Warehouse / Aircraft receiver)
-- ------------------------------------------------------------
create table public.part_d (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null unique references public.transactions (id) on delete cascade,
  delivery_location text not null check (delivery_location in ('SRA_WAREHOUSE', 'AIRCRAFT')),
  receiver_name text not null,
  receiver_staff_id text not null,
  seal_intact boolean not null default false,
  signature_url text not null,
  remarks text,
  completed_by uuid not null references public.users (id),
  completed_at timestamptz not null default now()
);

create index idx_part_d_transaction on public.part_d (transaction_id);

-- ------------------------------------------------------------
-- incidents
-- ------------------------------------------------------------
create table public.incidents (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references public.transactions (id) on delete cascade,
  incident_type text not null
    check (incident_type in ('BROKEN_SEAL', 'SEAL_MISMATCH', 'UNAUTHORIZED_DRIVER', 'UNAUTHORIZED_VEHICLE', 'OTHER')),
  description text not null,
  reported_by text not null,
  reported_by_id uuid not null references public.users (id),
  photo_url text,
  created_at timestamptz not null default now()
);

create index idx_incidents_transaction on public.incidents (transaction_id);
create index idx_incidents_type on public.incidents (incident_type);
create index idx_incidents_created_at on public.incidents (created_at);

-- ------------------------------------------------------------
-- audit_logs (immutable trail: who / what / when / before / after)
-- ------------------------------------------------------------
create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid references public.transactions (id) on delete set null,
  action text not null,
  performed_by text not null,
  performed_by_id uuid,
  old_values jsonb,
  new_values jsonb,
  performed_at timestamptz not null default now()
);

create index idx_audit_logs_transaction on public.audit_logs (transaction_id);
create index idx_audit_logs_performed_at on public.audit_logs (performed_at);

-- ------------------------------------------------------------
-- Audit trigger: automatically logs every write on core tables
-- ------------------------------------------------------------
create or replace function public.log_audit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_id uuid := auth.uid();
  v_actor text;
  v_tx uuid;
begin
  select name into v_actor from users where id = v_actor_id;
  if v_actor is null then
    v_actor := 'system';
  end if;

  if tg_table_name = 'transactions' then
    v_tx := coalesce(new.id, old.id);
  else
    v_tx := coalesce(new.transaction_id, old.transaction_id);
  end if;

  insert into audit_logs (transaction_id, action, performed_by, performed_by_id, old_values, new_values)
  values (
    v_tx,
    tg_table_name || '.' || lower(tg_op),
    v_actor,
    v_actor_id,
    case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end,
    case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end
  );

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger trg_audit_transactions
  after insert or update or delete on public.transactions
  for each row execute function public.log_audit();

create trigger trg_audit_part_a
  after insert or update or delete on public.part_a
  for each row execute function public.log_audit();

create trigger trg_audit_part_b
  after insert or update or delete on public.part_b
  for each row execute function public.log_audit();

create trigger trg_audit_part_c
  after insert or update or delete on public.part_c
  for each row execute function public.log_audit();

create trigger trg_audit_part_d
  after insert or update or delete on public.part_d
  for each row execute function public.log_audit();

create trigger trg_audit_incidents
  after insert or update or delete on public.incidents
  for each row execute function public.log_audit();

-- ------------------------------------------------------------
-- Immutability: audit logs can never change, completed records
-- can never be modified, part records are write-once.
-- ------------------------------------------------------------
create or replace function public.block_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'CSCS: % records are immutable (% blocked)', tg_table_name, tg_op;
end;
$$;

create trigger trg_audit_logs_immutable
  before update or delete on public.audit_logs
  for each row execute function public.block_mutation();

create trigger trg_part_a_immutable
  before update or delete on public.part_a
  for each row execute function public.block_mutation();

create trigger trg_part_b_immutable
  before update or delete on public.part_b
  for each row execute function public.block_mutation();

create trigger trg_part_c_immutable
  before update or delete on public.part_c
  for each row execute function public.block_mutation();

create trigger trg_part_d_immutable
  before update or delete on public.part_d
  for each row execute function public.block_mutation();

-- Completed transactions cannot be modified. The only permitted change
-- to a completed record is escalation via an incident report.
create or replace function public.guard_transaction_update()
returns trigger
language plpgsql
as $$
begin
  if old.status = 'COMPLETED' and new.status <> 'ESCALATED' then
    raise exception 'CSCS: completed transactions cannot be modified';
  end if;
  if old.status = 'ESCALATED' and new.status <> old.status then
    raise exception 'CSCS: escalated transactions are frozen pending supervisor review';
  end if;
  -- Immutable identity fields after creation
  if new.transaction_number <> old.transaction_number
     or new.created_by <> old.created_by
     or new.created_at <> old.created_at then
    raise exception 'CSCS: transaction identity fields are immutable';
  end if;
  return new;
end;
$$;

create trigger trg_guard_transaction_update
  before update on public.transactions
  for each row execute function public.guard_transaction_update();

create trigger trg_transactions_no_delete
  before delete on public.transactions
  for each row execute function public.block_mutation();

-- ------------------------------------------------------------
-- Workflow enforcement: each part may only be inserted when the
-- transaction is in the correct prior state; insertion advances it.
-- ------------------------------------------------------------
create or replace function public.enforce_part_sequence()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
begin
  select status into v_status from transactions where id = new.transaction_id for update;

  if v_status is null then
    raise exception 'CSCS: transaction not found';
  end if;

  if v_status = 'ESCALATED' then
    raise exception 'CSCS: transaction is escalated; checkpoint processing is suspended';
  end if;

  if tg_table_name = 'part_b' then
    if v_status <> 'CREATED' then
      raise exception 'CSCS: Part B requires status CREATED (current: %)', v_status;
    end if;
    update transactions set status = 'POST2_APPROVED' where id = new.transaction_id;
  elsif tg_table_name = 'part_c' then
    if v_status <> 'POST2_APPROVED' then
      raise exception 'CSCS: Part C requires status POST2_APPROVED (current: %)', v_status;
    end if;
    update transactions set status = 'POST6_APPROVED' where id = new.transaction_id;
  elsif tg_table_name = 'part_d' then
    if v_status <> 'POST6_APPROVED' then
      raise exception 'CSCS: Part D requires status POST6_APPROVED (current: %)', v_status;
    end if;
    update transactions set status = 'COMPLETED', completed_at = now() where id = new.transaction_id;
  end if;

  return new;
end;
$$;

create trigger trg_part_b_sequence
  before insert on public.part_b
  for each row execute function public.enforce_part_sequence();

create trigger trg_part_c_sequence
  before insert on public.part_c
  for each row execute function public.enforce_part_sequence();

create trigger trg_part_d_sequence
  before insert on public.part_d
  for each row execute function public.enforce_part_sequence();

-- Incidents always escalate the transaction.
create or replace function public.escalate_on_incident()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update transactions set status = 'ESCALATED' where id = new.transaction_id;
  return new;
end;
$$;

create trigger trg_escalate_on_incident
  after insert on public.incidents
  for each row execute function public.escalate_on_incident();
