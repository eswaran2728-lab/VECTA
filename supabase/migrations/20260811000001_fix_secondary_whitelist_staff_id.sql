-- ============================================================
-- Hotfix: enforce_secondary_whitelist() (Part B/C checkpoint trigger)
-- still referenced drivers.driver_id in its function body. Postgres
-- does not rewrite PL/pgSQL function bodies on ALTER TABLE ... RENAME
-- COLUMN (unlike views/FKs, a function body is just stored text with
-- no tracked catalog dependency on the column), so the driver_id ->
-- staff_id rename in 20260810000004_whitelist_extended_fields.sql left
-- this function broken: every Part B/Part C checkpoint save failed
-- with "column d.driver_id does not exist".
-- ============================================================

create or replace function public.enforce_secondary_whitelist()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.result = 'PASS' then
    if not exists (
      select 1 from vehicles v
      where upper(v.vehicle_number) = upper(coalesce(new.observed_vehicle_number, ''))
        and v.is_active
    ) or not exists (
      select 1 from drivers d
      where upper(d.staff_id) = upper(coalesce(new.observed_driver_id, ''))
        and d.is_active
    ) then
      raise exception 'ICMS: WHITELIST_VIOLATION - observed vehicle/driver is not on the active whitelist; escalate instead of passing / Kenderaan/pemandu yang diperhatikan tiada dalam senarai putih aktif; eskalasi, jangan lulus';
    end if;
  end if;
  return new;
end;
$$;
