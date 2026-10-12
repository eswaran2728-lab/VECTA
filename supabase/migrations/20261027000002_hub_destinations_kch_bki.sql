-- Hub destinations: allow KCH and BKI (additive; no data is changed).
--
-- Why: KCH and BKI have final Hub receipt enabled (20261022000001) but the CHECK constraints below only
-- allowed PEN / JHB / NILAI, so a transaction destined for KCH/BKI could not be created and a KCH/BKI receipt
-- could not record its confirmed destination.
--
-- Scope: widens two CHECK constraints only. It does not enable scanning at KCH/BKI, does not touch any
-- capability, role, RLS policy or function, and every existing row already satisfies the wider constraint.
-- Idempotent: safe to re-run.

-- 1. transactions.hub_destination
alter table if exists public.transactions
  drop constraint if exists transactions_hub_destination_check;

-- Sweep any differently-named CHECK on hub_destination that does not already allow KCH (defensive).
do $$
declare
  c record;
begin
  if to_regclass('public.transactions') is null then
    return;
  end if;
  for c in
    select conname
    from pg_constraint
    where conrelid = 'public.transactions'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%hub_destination%'
      and pg_get_constraintdef(oid) not ilike '%KCH%'
  loop
    execute format('alter table public.transactions drop constraint %I', c.conname);
  end loop;
end $$;

alter table if exists public.transactions
  add constraint transactions_hub_destination_check
  check (hub_destination in ('PEN', 'JHB', 'NILAI', 'KCH', 'BKI') or hub_destination is null)
  not valid;

alter table if exists public.transactions
  validate constraint transactions_hub_destination_check;

-- 2. part_hub.confirmed_destination (legacy table: a no-op where it does not exist)
alter table if exists public.part_hub
  drop constraint if exists part_hub_confirmed_destination_check;

alter table if exists public.part_hub
  add constraint part_hub_confirmed_destination_check
  check (confirmed_destination in ('PEN', 'JHB', 'NILAI', 'KCH', 'BKI'));
