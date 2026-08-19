-- ============================================================
-- ICMS: whitelist admin upgrade (Vehicle + Driver).
--
-- Vehicles: adds truck_type (Hi-Lift / Bonded Truck) and
-- truck_registration_number, both nullable so existing rows are
-- untouched — only newly-added/edited vehicles are expected to carry
-- them going forward.
--
-- Drivers: driver_id -> staff_id is a pure column rename. Verified
-- before writing this migration that nothing depends on the name
-- itself as a foreign key target — the only FK involving this table is
-- transactions.driver_id_ref -> drivers.id (the primary key, not this
-- column), and the column's own `unique` constraint/index renames
-- automatically with it. transactions.driver_id and
-- part_b/part_c.observed_driver_id are separate columns on separate
-- tables that happen to share the old name coincidentally — they are
-- NOT touched by this rename.
--
-- Also adds swap_to_staff_ic + staff_ic_number to drivers, for cases
-- where a driver's airport pass ID differs from their staff IC. The
-- format check only applies when the toggle is on, and is NOT VALID
-- (skips validating historical rows) even though every existing row
-- trivially satisfies it via the default — consistent with how this
-- codebase treats new optional-field constraints elsewhere (see the
-- escort vehicle pairing check).
-- ============================================================

alter table public.vehicles
  add column if not exists truck_type text check (truck_type in ('Hi-Lift', 'Bonded Truck')),
  add column if not exists truck_registration_number text;

alter table public.drivers rename column driver_id to staff_id;

alter table public.drivers
  add column if not exists swap_to_staff_ic boolean not null default false,
  add column if not exists staff_ic_number text;

alter table public.drivers
  drop constraint if exists drivers_staff_ic_format_check;
alter table public.drivers
  add constraint drivers_staff_ic_format_check
  check (
    (swap_to_staff_ic = false and staff_ic_number is null)
    or (swap_to_staff_ic = true and staff_ic_number ~ '^\d{6}-\d{2}-\d{4}$')
  ) not valid;
