-- ============================================================
-- ICMS: strict whitelist enforcement (Part A hard block + Part B/C
-- secondary check). Previously a non-whitelisted vehicle/driver could
-- still create a transaction (remarks mandatory, audit-logged). That
-- soft-warning path is removed: Part A creation is now hard-blocked
-- for any vehicle or driver that isn't an active whitelist entry. The
-- expired-pass override ("record anyway" -> EXPIRED_PASS incident) is
-- untouched — it's a deliberate escape hatch for a vehicle already at
-- the gate with a lapsed pass, not the missing-from-whitelist case.
--
-- Rollout: this only gates new INSERTs on public.transactions (i.e.
-- new Part A submissions after this migration deploys). Transactions
-- already CREATED under the old soft-warning rule are grandfathered —
-- nothing about them is touched or re-validated, and they keep moving
-- through Part B/C/D normally. See src/lib/actions/transactions.ts for
-- the matching server-side block and its bilingual WHITELIST_VIOLATION
-- error.
-- ============================================================

alter table public.incidents drop constraint incidents_incident_type_check;
alter table public.incidents
  add constraint incidents_incident_type_check
  check (incident_type in (
    'BROKEN_SEAL', 'SEAL_MISMATCH', 'UNAUTHORIZED_DRIVER', 'UNAUTHORIZED_VEHICLE',
    'EXPIRED_PASS', 'WRONG_SEAL_COLOR', 'TIMEOUT', 'OTHER', 'WHITELIST_VIOLATION'
  ));

-- ------------------------------------------------------------
-- DB-side final authority for Part A: vehicle_id / driver_id_ref must
-- both resolve to an active whitelist row. These columns are only set
-- when the server-side lookup in createTransaction() matched an active
-- vehicles/drivers row, so a null here means "not whitelisted" — the
-- same signal the server action already checked, verified again here
-- so no insert path (including any future one) can bypass the rule.
-- ------------------------------------------------------------
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
  return new;
end;
$$;

create trigger trg_enforce_whitelist_on_create
  before insert on public.transactions
  for each row execute function public.enforce_whitelist_on_create();

revoke execute on function public.enforce_whitelist_on_create() from public, anon, authenticated;

-- ------------------------------------------------------------
-- Part B / Part C secondary whitelist check (defense-in-depth for the
-- rare case a whitelist status changes mid-transit). A PASS result may
-- only be recorded when the officer's observed vehicle/driver are both
-- still active whitelist entries; ESCALATE is always allowed (that's
-- how a mismatch gets reported). Mirrors enforce_seal_color()'s shape.
-- ------------------------------------------------------------
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
      where upper(d.driver_id) = upper(coalesce(new.observed_driver_id, ''))
        and d.is_active
    ) then
      raise exception 'ICMS: WHITELIST_VIOLATION - observed vehicle/driver is not on the active whitelist; escalate instead of passing / Kenderaan/pemandu yang diperhatikan tiada dalam senarai putih aktif; eskalasi, jangan lulus';
    end if;
  end if;
  return new;
end;
$$;

create trigger trg_part_b_secondary_whitelist
  before insert on public.part_b
  for each row execute function public.enforce_secondary_whitelist();

create trigger trg_part_c_secondary_whitelist
  before insert on public.part_c
  for each row execute function public.enforce_secondary_whitelist();

revoke execute on function public.enforce_secondary_whitelist() from public, anon, authenticated;
