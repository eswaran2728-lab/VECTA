-- ============================================================
-- ICMS: align Part A with the amended In-flight Catering Security
-- Form (IFCSF, AA/SEC/F/010 Rev.01, Jul 2026) — Station, cargo-type
-- checklist, and the supplies breakdown (Carts/SMU/Pallets/Boxes/
-- Oven Rack + total) that the paper form now captures on both the
-- Outbound and Inbound layouts. Incremental only: no columns removed,
-- trolley_count stays intact for existing records.
-- ============================================================

alter table public.transactions
  add column if not exists station text,
  add column if not exists cargo_types text[] not null default '{}',
  add column if not exists supplies_total integer,
  add column if not exists supplies_carts integer,
  add column if not exists supplies_smu integer,
  add column if not exists supplies_pallets integer,
  add column if not exists supplies_boxes integer,
  add column if not exists supplies_oven_racks integer;

alter table public.transactions
  drop constraint if exists transactions_cargo_types_check;

alter table public.transactions
  add constraint transactions_cargo_types_check
  check (
    cargo_types <@ array[
      'FOOD_BEVERAGE', 'PERISHABLE', 'DUTY_FREE', 'MERCHANDISE', 'VEHICLE_MAINTENANCE'
    ]::text[]
  );
