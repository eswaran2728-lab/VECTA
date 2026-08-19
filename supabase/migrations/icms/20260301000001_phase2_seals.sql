-- ============================================================
-- CSCS v2 - PHASE 2: Multi-seal system + seal color validation
-- ============================================================

create table public.seals (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references public.transactions (id) on delete cascade,
  seal_number text not null,
  seal_type text not null default 'TRUCK_SEAL' check (seal_type in ('TRUCK_SEAL', 'TROLLEY', 'OTHER')),
  seal_color text not null check (seal_color in ('BLUE', 'GREEN', 'OTHER')),
  applied_at timestamptz not null default now(),
  unique (transaction_id, seal_number)
);

create index idx_seals_transaction on public.seals (transaction_id);
create index idx_seals_number on public.seals (seal_number);

create table public.seal_verifications (
  id uuid primary key default gen_random_uuid(),
  seal_id uuid not null references public.seals (id) on delete cascade,
  checkpoint text not null check (checkpoint in ('INFLIGHT_POST', 'AIRPORT_POST', 'PART_D')),
  entered_seal_number text not null,
  matched boolean not null,
  verified_by uuid references public.users (id),
  verified_at timestamptz not null default now(),
  photo_url text
);

create index idx_seal_verifications_seal on public.seal_verifications (seal_id);

-- Seal color rule: OUTBOUND truck seal must be BLUE, INBOUND must be GREEN.
create or replace function public.enforce_seal_color()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_direction text;
begin
  select direction into v_direction from transactions where id = new.transaction_id;
  if v_direction is null then
    raise exception 'CSCS: transaction not found / transaksi tidak dijumpai';
  end if;
  if new.seal_type = 'TRUCK_SEAL' then
    if v_direction = 'OUTBOUND' and new.seal_color <> 'BLUE' then
      raise exception 'CSCS: outbound truck seals must be BLUE / sil trak keluar mesti BIRU';
    end if;
    if v_direction = 'INBOUND' and new.seal_color <> 'GREEN' then
      raise exception 'CSCS: inbound truck seals must be GREEN / sil trak masuk mesti HIJAU';
    end if;
  end if;
  return new;
end;
$$;

create trigger trg_enforce_seal_color
  before insert on public.seals
  for each row execute function public.enforce_seal_color();

-- Seals are applied once at Part A and never edited; verifications are append-only.
create trigger trg_seals_immutable
  before update or delete on public.seals
  for each row execute function public.block_mutation();

create trigger trg_seal_verifications_immutable
  before update or delete on public.seal_verifications
  for each row execute function public.block_mutation();

-- Audit seal application (log_audit reads new.transaction_id, present on seals).
create trigger trg_audit_seals
  after insert on public.seals
  for each row execute function public.log_audit();

-- Migrate existing single seal numbers into the seals model.
insert into public.seals (transaction_id, seal_number, seal_type, seal_color, applied_at)
select id, seal_number, 'TRUCK_SEAL',
       case when direction = 'OUTBOUND' then 'BLUE' else 'GREEN' end,
       created_at
from public.transactions
where seal_number is not null and seal_number <> ''
on conflict (transaction_id, seal_number) do nothing;

-- Deprecate transactions.seal_number: kept for history, no longer written.
alter table public.transactions alter column seal_number drop not null;

-- RLS
alter table public.seals enable row level security;
alter table public.seal_verifications enable row level security;

create policy "seals: read follows transaction visibility"
  on public.seals for select
  using (exists (select 1 from public.transactions t where t.id = transaction_id));

create policy "seals: pic applies at part a"
  on public.seals for insert
  with check (
    public.current_user_role() in ('warehouse_pic', 'sra_warehouse_pic')
    and exists (
      select 1 from public.transactions t
      where t.id = transaction_id and t.created_by = auth.uid()
    )
  );

create policy "seal_verifications: read follows seal visibility"
  on public.seal_verifications for select
  using (exists (select 1 from public.seals s where s.id = seal_id));

create policy "seal_verifications: checkpoint roles verify"
  on public.seal_verifications for insert
  with check (
    public.current_user_role() in ('post2_avsec', 'post6_avsec', 'receiver')
    and verified_by = auth.uid()
  );
