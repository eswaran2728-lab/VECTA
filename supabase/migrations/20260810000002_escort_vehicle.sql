-- ============================================================
-- ICMS: escort vehicle number. Part A already captures an escort
-- officer name + staff ID (added in phase4_whitelists, columns live on
-- public.transactions, not part_a — Part A's own table only ever held
-- the PIC's own fields). The escort vehicle number joins those two
-- columns in the same place for the same reason: it describes the
-- transaction's escort, not the PIC's checkpoint record.
--
-- Pairing rule: escort officer name, staff ID and escort vehicle number
-- are all-or-nothing. Enforced in the UI and the server action; the
-- constraint below is NOT VALID so it applies to every new/updated row
-- going forward without requiring a backfill of historical data (none
-- of which had escort_vehicle_number to begin with).
--
-- Whitelist: per the same strict-whitelist rule as the primary vehicle
-- (Upgrade 2/3), a filled-in escort vehicle number must also resolve to
-- an active whitelist entry — otherwise Part A is blocked with
-- WHITELIST_VIOLATION, closing the side-door an unlisted "escort"
-- vehicle would otherwise be.
-- ============================================================

alter table public.transactions
  add column if not exists escort_vehicle_number text;

alter table public.transactions
  drop constraint if exists transactions_escort_pairing_check;
alter table public.transactions
  add constraint transactions_escort_pairing_check
  check (
    (escort_officer_name is not null) = (escort_officer_staff_id is not null)
    and (escort_officer_name is not null) = (escort_vehicle_number is not null)
  ) not valid;

create or replace function public.enforce_whitelist_on_create()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.vehicle_id is null or new.driver_id_ref is null then
    raise exception 'ICMS: WHITELIST_VIOLATION - vehicle and driver must both be on the active whitelist to create a transaction / Kenderaan dan pemandu mesti berada dalam senarai putih aktif untuk mencipta transaksi';
  end if;
  if new.escort_vehicle_number is not null and not exists (
    select 1 from vehicles v
    where upper(v.vehicle_number) = upper(new.escort_vehicle_number) and v.is_active
  ) then
    raise exception 'ICMS: WHITELIST_VIOLATION - escort vehicle must also be on the active whitelist / Kenderaan pengiring mesti juga berada dalam senarai putih aktif';
  end if;
  return new;
end;
$$;
