-- ============================================================
-- ICMS: Multi-Route Restructure — Hub & REDQ (supersedes and
-- replaces any earlier "Hub Route Restructure" attempt; nothing
-- from that version was ever deployed, so there is nothing to
-- roll back here).
--
-- Adds two new outbound-only routes alongside today's implicit
-- AIRCRAFT route:
--   AIRCRAFT (default, unchanged): A -> B -> C -> D
--   HUB:     A -> B -> Part Hub (terminal — no C/D)
--   REDQ:    A -> B -> Part REDQ (re-seal) -> C -> D
-- INBOUND transactions always keep route = 'AIRCRAFT' — Hub/REDQ
-- are never valid inbound (enforced client + server side, not here,
-- since the column has no direction-aware DB constraint by itself).
--
-- Two new roles: hub_avsec (confirms Hub delivery), redq_avsec
-- (performs the REDQ re-seal). Both get read access to transactions
-- via the same "checkpoint role" policy post2/post6/receiver already
-- use, and cascade read access to every child table through the
-- existing "read follows transaction visibility" pattern.
-- ============================================================

-- ------------------------------------------------------------
-- Roles
-- ------------------------------------------------------------
alter table public.users drop constraint users_role_check;
alter table public.users
  add constraint users_role_check
  check (role = any (array[
    'warehouse_pic', 'post2_avsec', 'post6_avsec', 'receiver',
    'supervisor', 'enforcement', 'vendor', 'hub_avsec', 'redq_avsec'
  ]));

-- ------------------------------------------------------------
-- transactions: route + hub_destination
-- ------------------------------------------------------------
alter table public.transactions
  add column route text not null default 'AIRCRAFT' check (route in ('AIRCRAFT', 'HUB', 'REDQ'));

alter table public.transactions
  add column hub_destination text check (hub_destination in ('PEN', 'JHB', 'NILAI'));

alter table public.transactions
  add constraint transactions_hub_destination_pairing check (
    (route = 'HUB' and hub_destination is not null)
    or (route <> 'HUB' and hub_destination is null)
  );

-- REDQ_RESEALED sits between INFLIGHT_POST_APPROVED and
-- AIRPORT_POST_APPROVED for REDQ-route outbound transactions only.
alter table public.transactions drop constraint transactions_status_check;
alter table public.transactions
  add constraint transactions_status_check
  check (status in (
    'CREATED', 'INFLIGHT_POST_APPROVED', 'AIRPORT_POST_APPROVED',
    'REDQ_RESEALED', 'COMPLETED', 'ESCALATED'
  ));

-- hub_avsec/redq_avsec need to read transactions to process their
-- checkpoint, same as the existing checkpoint roles. ALTER POLICY in
-- place (not drop+recreate) to preserve policy identity, matching the
-- pattern used when the enforcement role was added.
alter policy "transactions: checkpoint and supervisor read all"
  on public.transactions
  using (
    current_user_role() = any (array[
      'post2_avsec', 'post6_avsec', 'receiver', 'supervisor', 'enforcement',
      'hub_avsec', 'redq_avsec'
    ])
  );

-- ------------------------------------------------------------
-- part_d: aircraft_identifier (self-reported, required only when
-- delivery_location = AIRCRAFT — enforced client + server side, not
-- here, since part_d rows are write-once and this is the only field
-- that's conditionally required within one otherwise-fixed row shape).
-- ------------------------------------------------------------
alter table public.part_d add column aircraft_identifier text;

-- ------------------------------------------------------------
-- seals: superseded_at/by/reason — the one and only mutation a seal
-- row is ever allowed, closing it out at a REDQ re-seal. The blanket
-- block_mutation() immutability trigger is replaced with a narrower
-- one that permits exactly this, and nothing else, ever.
-- ------------------------------------------------------------
alter table public.seals add column superseded_at timestamptz;
alter table public.seals add column superseded_by uuid references public.users (id);
alter table public.seals add column superseded_reason text;

drop trigger trg_seals_immutable on public.seals;

create or replace function public.enforce_seal_supersede_only()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'ICMS: seal records cannot be deleted';
  end if;

  if new.id <> old.id
     or new.transaction_id <> old.transaction_id
     or new.seal_number <> old.seal_number
     or new.seal_type <> old.seal_type
     or new.seal_color <> old.seal_color
     or new.applied_at <> old.applied_at then
    raise exception 'ICMS: seal records are immutable except for superseded_at/superseded_by/superseded_reason, set once at a REDQ re-seal';
  end if;

  if old.superseded_at is not null then
    raise exception 'ICMS: this seal has already been superseded and cannot be changed again';
  end if;

  if new.superseded_at is null or new.superseded_by is null or new.superseded_reason is null then
    raise exception 'ICMS: superseded_at, superseded_by and superseded_reason must all be set together';
  end if;

  return new;
end;
$$;

create trigger trg_seals_supersede_only
  before update or delete on public.seals
  for each row execute function public.enforce_seal_supersede_only();

revoke execute on function public.enforce_seal_supersede_only() from public, anon, authenticated;

-- Audit coverage widened to catch the supersede UPDATE too (previously
-- INSERT-only, since seals were fully immutable until now).
drop trigger trg_audit_seals on public.seals;
create trigger trg_audit_seals
  after insert or update on public.seals
  for each row execute function public.log_audit();

-- redq_avsec applies the new seal at a re-seal event (the old seal's
-- supersede happens inside enforce_part_redq_sequence() below, as a
-- security-definer write — no client-facing UPDATE policy is needed
-- or granted, matching how transactions.status transitions work).
create policy "seals: redq_avsec applies new seal at redq"
  on public.seals for insert
  with check (
    current_user_role() = 'redq_avsec'
    and exists (
      select 1 from public.transactions t
      where t.id = seals.transaction_id
        and t.route = 'REDQ'
        and t.status = 'INFLIGHT_POST_APPROVED'
    )
  );

-- ------------------------------------------------------------
-- seal_verifications: add the REDQ checkpoint value, widen the
-- insert policy to let redq_avsec verify the old seal there.
-- ------------------------------------------------------------
alter table public.seal_verifications drop constraint seal_verifications_checkpoint_check;
alter table public.seal_verifications
  add constraint seal_verifications_checkpoint_check
  check (checkpoint in ('INFLIGHT_POST', 'AIRPORT_POST', 'PART_D', 'REDQ'));

alter policy "seal_verifications: checkpoint roles verify"
  on public.seal_verifications
  with check (
    current_user_role() = any (array['post2_avsec', 'post6_avsec', 'receiver', 'redq_avsec'])
    and verified_by = auth.uid()
  );

-- ------------------------------------------------------------
-- part_hub (Hub AVSEC) — write-once, terminal step for HUB route.
-- ------------------------------------------------------------
create table public.part_hub (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null unique references public.transactions (id) on delete cascade,
  confirmed_destination text not null check (confirmed_destination in ('PEN', 'JHB', 'NILAI')),
  hub_avsec_name text not null,
  hub_avsec_staff_id text not null,
  remarks text,
  signature_url text not null,
  signature_hash text,
  completed_by uuid not null references public.users (id),
  completed_at timestamptz not null default now()
);

create index idx_part_hub_transaction on public.part_hub (transaction_id);

create trigger trg_audit_part_hub
  after insert or update or delete on public.part_hub
  for each row execute function public.log_audit();

create trigger trg_part_hub_immutable
  before update or delete on public.part_hub
  for each row execute function public.block_mutation();

alter table public.part_hub enable row level security;

create policy "part_hub: read follows transaction visibility"
  on public.part_hub for select
  using (
    exists (select 1 from public.transactions t where t.id = transaction_id)
  );

create policy "part_hub: hub_avsec inserts"
  on public.part_hub for insert
  with check (
    current_user_role() = 'hub_avsec'
    and completed_by = auth.uid()
  );

-- confirmed_destination must match the destination chosen at Part A —
-- checked by enforce_part_hub_sequence() below, not a static CHECK,
-- since it depends on the parent transaction's hub_destination.
create or replace function public.enforce_part_hub_sequence()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_route text;
  v_hub_destination text;
begin
  select status, route, hub_destination into v_status, v_route, v_hub_destination
  from transactions where id = new.transaction_id for update;

  if v_status is null then
    raise exception 'ICMS: transaction not found';
  end if;
  if v_status = 'ESCALATED' then
    raise exception 'ICMS: transaction is escalated; checkpoint processing is suspended';
  end if;
  if v_route <> 'HUB' then
    raise exception 'ICMS: Part Hub only applies to HUB-route transactions (this transaction is %)', v_route;
  end if;
  if v_status <> 'INFLIGHT_POST_APPROVED' then
    raise exception 'ICMS: Part Hub requires status INFLIGHT_POST_APPROVED (current: %)', v_status;
  end if;
  if new.confirmed_destination <> v_hub_destination then
    raise exception 'ICMS: confirmed destination % does not match the hub destination chosen at Part A (%)', new.confirmed_destination, v_hub_destination;
  end if;

  -- Terminal step for HUB route — no Part C/D.
  update transactions set status = 'COMPLETED', completed_at = now() where id = new.transaction_id;
  return new;
end;
$$;

create trigger trg_part_hub_sequence
  before insert on public.part_hub
  for each row execute function public.enforce_part_hub_sequence();

revoke execute on function public.enforce_part_hub_sequence() from public, anon, authenticated;

-- ------------------------------------------------------------
-- part_redq (REDQ AVSEC) — the re-seal event. old_seal_id references
-- the truck seal being closed out, new_seal_id the one just applied;
-- both must already exist (new_seal_id's FK requires the app to
-- insert the new seals row before this one).
-- ------------------------------------------------------------
create table public.part_redq (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null unique references public.transactions (id) on delete cascade,
  old_seal_id uuid not null references public.seals (id),
  new_seal_id uuid not null references public.seals (id),
  redq_avsec_name text not null,
  redq_avsec_staff_id text not null,
  remarks text,
  signature_url text not null,
  signature_hash text,
  completed_by uuid not null references public.users (id),
  completed_at timestamptz not null default now()
);

create index idx_part_redq_transaction on public.part_redq (transaction_id);

create trigger trg_audit_part_redq
  after insert or update or delete on public.part_redq
  for each row execute function public.log_audit();

create trigger trg_part_redq_immutable
  before update or delete on public.part_redq
  for each row execute function public.block_mutation();

alter table public.part_redq enable row level security;

create policy "part_redq: read follows transaction visibility"
  on public.part_redq for select
  using (
    exists (select 1 from public.transactions t where t.id = transaction_id)
  );

create policy "part_redq: redq_avsec inserts"
  on public.part_redq for insert
  with check (
    current_user_role() = 'redq_avsec'
    and completed_by = auth.uid()
  );

create or replace function public.enforce_part_redq_sequence()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_route text;
begin
  select status, route into v_status, v_route
  from transactions where id = new.transaction_id for update;

  if v_status is null then
    raise exception 'ICMS: transaction not found';
  end if;
  if v_status = 'ESCALATED' then
    raise exception 'ICMS: transaction is escalated; checkpoint processing is suspended';
  end if;
  if v_route <> 'REDQ' then
    raise exception 'ICMS: Part REDQ only applies to REDQ-route transactions (this transaction is %)', v_route;
  end if;
  if v_status <> 'INFLIGHT_POST_APPROVED' then
    raise exception 'ICMS: Part REDQ requires status INFLIGHT_POST_APPROVED (current: %)', v_status;
  end if;

  -- Close out the old seal — the one mutation enforce_seal_supersede_only()
  -- permits. This runs as the security-definer owner, same as every other
  -- status-transition write in this schema; no client-facing UPDATE policy
  -- on seals exists or is needed.
  update seals
  set superseded_at = now(), superseded_by = new.completed_by, superseded_reason = 'Re-sealed at REDQ'
  where id = new.old_seal_id;

  update transactions set status = 'REDQ_RESEALED' where id = new.transaction_id;
  return new;
end;
$$;

create trigger trg_part_redq_sequence
  before insert on public.part_redq
  for each row execute function public.enforce_part_redq_sequence();

revoke execute on function public.enforce_part_redq_sequence() from public, anon, authenticated;

-- ------------------------------------------------------------
-- enforce_part_sequence(): made route-aware. AIRCRAFT-route and all
-- INBOUND transactions behave EXACTLY as before (route defaults to
-- AIRCRAFT and INBOUND never has a different route). REDQ-route
-- outbound Part C now requires REDQ_RESEALED instead of
-- INFLIGHT_POST_APPROVED. HUB-route transactions reject Part C/D
-- entirely — Part Hub is the terminal step, handled above.
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
  v_route text;
begin
  select status, direction, route into v_status, v_direction, v_route
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
      if v_status <> 'AIRPORT_POST_APPROVED' then
        raise exception 'CSCS: out of order - inbound Part B (In-flight Post, final) requires status AIRPORT_POST_APPROVED, current % / tidak mengikut urutan - Bahagian B masuk (akhir) memerlukan status AIRPORT_POST_APPROVED, kini %', v_status, v_status;
      end if;
      update transactions set status = 'COMPLETED', completed_at = now() where id = new.transaction_id;
    end if;

  elsif tg_table_name = 'part_c' then
    if v_route = 'HUB' then
      raise exception 'ICMS: Part C does not apply to HUB-route transactions — use Part Hub instead';
    end if;
    if v_direction = 'OUTBOUND' then
      if v_route = 'REDQ' then
        if v_status <> 'REDQ_RESEALED' then
          raise exception 'ICMS: out of order - REDQ-route Part C requires status REDQ_RESEALED, current %', v_status;
        end if;
      else
        if v_status <> 'INFLIGHT_POST_APPROVED' then
          raise exception 'CSCS: out of order - outbound Part C (Airport Post) requires status INFLIGHT_POST_APPROVED, current % / tidak mengikut urutan - Bahagian C keluar memerlukan status INFLIGHT_POST_APPROVED, kini %', v_status, v_status;
        end if;
      end if;
    else
      if v_status <> 'CREATED' then
        raise exception 'CSCS: out of order - inbound Part C (Airport Post) requires status CREATED, current % / tidak mengikut urutan - Bahagian C masuk memerlukan status CREATED, kini %', v_status, v_status;
      end if;
    end if;
    update transactions set status = 'AIRPORT_POST_APPROVED' where id = new.transaction_id;

  elsif tg_table_name = 'part_d' then
    if v_route = 'HUB' then
      raise exception 'ICMS: Part D does not apply to HUB-route transactions — Part Hub is the terminal step';
    end if;
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
