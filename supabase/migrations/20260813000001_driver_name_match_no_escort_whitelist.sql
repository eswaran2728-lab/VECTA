-- ============================================================
-- ICMS: two whitelist rule changes discovered during on-site UAT
-- (2026-08-13):
--
-- 1. Driver name must match the whitelist. Previously Part A only
--    checked that the *driver ID* resolved to an active whitelist
--    entry — the free-typed Driver Name field was never compared
--    against it, so a real whitelisted driver ID could be entered
--    with a different (unlisted) person's name and still pass. Now
--    the typed name must match the name on file for that driver ID
--    (case/whitespace-insensitive), or Part A is blocked with the
--    same WHITELIST_VIOLATION severity as an unlisted vehicle/driver.
--    Mirrored client-side and in the server action.
--
-- 2. Escort vehicle no longer checked against the vehicle whitelist.
--    Unlike the primary catering vehicle/driver, escort officers and
--    their vehicles rotate and were never meant to be a registered
--    whitelist entry — requiring one was blocking legitimate escorts.
--    The escort officer name/staff ID/vehicle number all-or-nothing
--    pairing rule (transactions_escort_pairing_check) is untouched.
-- ============================================================

create or replace function public.enforce_whitelist_on_create()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_driver_name text;
begin
  if new.vehicle_id is null or new.driver_id_ref is null then
    raise exception 'ICMS: WHITELIST_VIOLATION - vehicle and driver must both be on the active whitelist to create a transaction / Kenderaan dan pemandu mesti berada dalam senarai putih aktif untuk mencipta transaksi';
  end if;

  select name into v_driver_name from drivers where id = new.driver_id_ref;
  if v_driver_name is null or upper(trim(v_driver_name)) <> upper(trim(new.driver_name)) then
    raise exception 'ICMS: WHITELIST_VIOLATION - driver name does not match the whitelisted name on file for this driver ID / Nama pemandu tidak sepadan dengan nama dalam senarai putih untuk ID pemandu ini';
  end if;

  return new;
end;
$$;
