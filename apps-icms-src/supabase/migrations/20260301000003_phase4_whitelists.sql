-- ============================================================
-- CSCS v2 - PHASE 4: Whitelists + new transaction fields
-- ============================================================

create table public.catering_companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  code text not null unique,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.vehicles (
  id uuid primary key default gen_random_uuid(),
  vehicle_number text not null unique,
  catering_company_id uuid references public.catering_companies (id),
  airport_pass_number text,
  pass_expiry_date date,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.drivers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  driver_id text not null unique,
  catering_company_id uuid references public.catering_companies (id),
  airport_pass_number text,
  pass_expiry_date date,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create index idx_vehicles_company on public.vehicles (catering_company_id);
create index idx_drivers_company on public.drivers (catering_company_id);

-- New transaction fields (all nullable/additive; existing rows unaffected)
alter table public.transactions
  add column if not exists flight_number text,
  add column if not exists aircraft_registration text,
  add column if not exists catering_company_id uuid references public.catering_companies (id),
  add column if not exists vehicle_id uuid references public.vehicles (id),
  add column if not exists driver_id_ref uuid references public.drivers (id),
  add column if not exists trolley_count integer not null default 0,
  add column if not exists escort_officer_name text,
  add column if not exists escort_officer_staff_id text;

create index if not exists idx_transactions_flight on public.transactions (flight_number);
create index if not exists idx_transactions_company on public.transactions (catering_company_id);

-- ------------------------------------------------------------
-- Race-condition-safe transaction numbers via a Postgres SEQUENCE
-- (per year, created on demand). Replaces the counter-table upsert.
-- Existing numbers are untouched.
-- ------------------------------------------------------------
create or replace function public.next_transaction_number()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_year int := extract(year from now())::int;
  v_seq text := format('cscs_txn_seq_%s', v_year);
  v_n bigint;
begin
  if to_regclass('public.' || v_seq) is null then
    -- Seed the new year's sequence from any legacy counter value.
    execute format(
      'create sequence if not exists public.%I start with %s',
      v_seq,
      coalesce((select counter from transaction_counters where year = v_year), 0) + 1
    );
  end if;
  execute format('select nextval(''public.%I'')', v_seq) into v_n;
  return format('CSCS-%s-%s', v_year, lpad(v_n::text, 6, '0'));
end;
$$;

-- New incident types used from Part A onward (full lifecycle in Phase 5).
alter table public.incidents drop constraint incidents_incident_type_check;
alter table public.incidents
  add constraint incidents_incident_type_check
  check (incident_type in (
    'BROKEN_SEAL', 'SEAL_MISMATCH', 'UNAUTHORIZED_DRIVER', 'UNAUTHORIZED_VEHICLE',
    'EXPIRED_PASS', 'WRONG_SEAL_COLOR', 'TIMEOUT', 'OTHER'
  ));

-- ------------------------------------------------------------
-- Admin audit for whitelist changes (no transaction_id involved)
-- ------------------------------------------------------------
create or replace function public.log_audit_admin()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_id uuid := auth.uid();
  v_actor text;
begin
  select name into v_actor from users where id = v_actor_id;
  insert into audit_logs (transaction_id, action, performed_by, performed_by_id, old_values, new_values)
  values (
    null,
    tg_table_name || '.' || lower(tg_op),
    coalesce(v_actor, 'system'),
    v_actor_id,
    case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end,
    case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end
  );
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create trigger trg_audit_catering_companies
  after insert or update or delete on public.catering_companies
  for each row execute function public.log_audit_admin();

create trigger trg_audit_vehicles
  after insert or update or delete on public.vehicles
  for each row execute function public.log_audit_admin();

create trigger trg_audit_drivers
  after insert or update or delete on public.drivers
  for each row execute function public.log_audit_admin();

-- No hard deletes: whitelists are soft-deactivated only.
create trigger trg_catering_companies_no_delete
  before delete on public.catering_companies
  for each row execute function public.block_mutation();

create trigger trg_vehicles_no_delete
  before delete on public.vehicles
  for each row execute function public.block_mutation();

create trigger trg_drivers_no_delete
  before delete on public.drivers
  for each row execute function public.block_mutation();

-- ------------------------------------------------------------
-- RLS: everyone signed in can read whitelists (needed at Part A);
-- only the supervisor manages them.
-- ------------------------------------------------------------
alter table public.catering_companies enable row level security;
alter table public.vehicles enable row level security;
alter table public.drivers enable row level security;

create policy "catering_companies: authenticated read"
  on public.catering_companies for select
  using (public.current_user_role() is not null);

create policy "catering_companies: supervisor manages"
  on public.catering_companies for insert
  with check (public.current_user_role() = 'supervisor');

create policy "catering_companies: supervisor updates"
  on public.catering_companies for update
  using (public.current_user_role() = 'supervisor');

create policy "vehicles: authenticated read"
  on public.vehicles for select
  using (public.current_user_role() is not null);

create policy "vehicles: supervisor manages"
  on public.vehicles for insert
  with check (public.current_user_role() = 'supervisor');

create policy "vehicles: supervisor updates"
  on public.vehicles for update
  using (public.current_user_role() = 'supervisor');

create policy "drivers: authenticated read"
  on public.drivers for select
  using (public.current_user_role() is not null);

create policy "drivers: supervisor manages"
  on public.drivers for insert
  with check (public.current_user_role() = 'supervisor');

create policy "drivers: supervisor updates"
  on public.drivers for update
  using (public.current_user_role() = 'supervisor');
