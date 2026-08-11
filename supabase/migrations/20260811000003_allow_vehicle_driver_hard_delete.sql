-- ============================================================
-- ICMS: allow hard-deleting vehicles/drivers from the admin UI when
-- (and only when) nothing references them.
--
-- transactions.vehicle_id and transactions.driver_id_ref are declared
-- ON DELETE NO ACTION, so the FK itself already rejects a delete for
-- any vehicle/driver with real transaction history. The
-- trg_vehicles_no_delete / trg_drivers_no_delete triggers were a
-- blanket "never" rule on top of that, blocking deletes even for rows
-- with zero activity (e.g. whitelist entries added in error). Dropping
-- them just lets the FK be the actual guard instead.
--
-- All other immutability triggers are untouched: transactions,
-- part_a/b/c/d, seals, seal_verifications, incidents, audit_logs and
-- catering_companies still block every delete unconditionally.
-- ============================================================

drop trigger if exists trg_vehicles_no_delete on public.vehicles;
drop trigger if exists trg_drivers_no_delete on public.drivers;
