-- CaterLink external-actor workflows on the canonical Phase 9 model (option B).
--
-- Additive only. Does NOT recreate the legacy ICMS tables (incidents, part_a..part_d, part_hub,
-- part_redq, vendor_*, audit_logs, segment_timeouts, incident_photos) and does NOT alter any existing
-- column, constraint, policy, account, assignment or capability row. Scan stays PEN/JHB only and
-- receipt stays KCH/BKI; this file never changes either.
--
-- 1. Hardening: remove TRUNCATE/REFERENCES/TRIGGER from anon/authenticated on the CaterLink tables
--    (these are not governed by RLS; staging showed them granted through default privileges).
-- 2. Read access to the canonical checkpoint, seal and seal-verification tables, scoped by the caller's
--    visibility of the parent transaction (the existing transactions RLS decides).
-- 3. caterlink_external_role(): the caller's role from the trusted public.users row (never email).
-- 4. create_caterlink_driver_transaction_secure(): the CaterLink Driver (warehouse_pic) creates a
--    movement + Part A. The canonical create RPC requires a role assignment, which external accounts
--    do not hold.
-- 5. Third-Party Vendor delivery workflow: caterlink_vendor_deliveries + caterlink_vendor_checkpoints
--    and three secure RPCs (create, security check by a scan-authorised officer, vendor completion).

-- ---------------------------------------------------------------------------------------------
-- 1. Hardening
-- ---------------------------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'transactions', 'seals', 'seal_verifications', 'catering_companies', 'vehicles', 'drivers',
    'caterlink_checkpoint_part_a', 'part_b_c', 'caterlink_checkpoint_part_d',
    'caterlink_checkpoint_hub', 'caterlink_checkpoint_redq', 'caterlink_incidents',
    'caterlink_incident_notes', 'caterlink_archives', 'caterlink_transaction_pdfs',
    'caterlink_station_capabilities', 'users'
  ] loop
    if to_regclass('public.' || t) is not null then
      execute format('revoke truncate, references, trigger on public.%I from public, anon, authenticated', t);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------
-- 2. Checkpoint reads follow the parent transaction's visibility
-- ---------------------------------------------------------------------------------------------
grant select on public.caterlink_checkpoint_part_a, public.part_b_c, public.caterlink_checkpoint_part_d,
  public.caterlink_checkpoint_hub, public.caterlink_checkpoint_redq to authenticated;

drop policy if exists caterlink_checkpoint_part_a_read on public.caterlink_checkpoint_part_a;
create policy caterlink_checkpoint_part_a_read on public.caterlink_checkpoint_part_a for select to authenticated
  using (exists (select 1 from public.transactions t where t.id = transaction_id));
drop policy if exists part_b_c_read on public.part_b_c;
create policy part_b_c_read on public.part_b_c for select to authenticated
  using (exists (select 1 from public.transactions t where t.id = transaction_id));
drop policy if exists caterlink_checkpoint_part_d_read on public.caterlink_checkpoint_part_d;
create policy caterlink_checkpoint_part_d_read on public.caterlink_checkpoint_part_d for select to authenticated
  using (exists (select 1 from public.transactions t where t.id = transaction_id));
drop policy if exists caterlink_checkpoint_hub_read on public.caterlink_checkpoint_hub;
create policy caterlink_checkpoint_hub_read on public.caterlink_checkpoint_hub for select to authenticated
  using (exists (select 1 from public.transactions t where t.id = transaction_id));
drop policy if exists caterlink_checkpoint_redq_read on public.caterlink_checkpoint_redq;
create policy caterlink_checkpoint_redq_read on public.caterlink_checkpoint_redq for select to authenticated
  using (exists (select 1 from public.transactions t where t.id = transaction_id));

grant select on public.seals, public.seal_verifications to authenticated;
drop policy if exists seals_read on public.seals;
create policy seals_read on public.seals for select to authenticated
  using (exists (select 1 from public.transactions t where t.id = transaction_id));
drop policy if exists seal_verifications_read on public.seal_verifications;
create policy seal_verifications_read on public.seal_verifications for select to authenticated
  using (exists (select 1 from public.seals s where s.id = seal_id));

-- ---------------------------------------------------------------------------------------------
-- 3. External role from the trusted account row
-- ---------------------------------------------------------------------------------------------
create or replace function public.caterlink_external_role()
returns text
language sql
stable
security definer
set search_path to 'public'
as $function$
  select u.role
  from public.users u
  where u.id = auth.uid()
    and u.status = 'active'
    and u.role in ('warehouse_pic', 'vendor')
    -- a mixed identity (any active canonical assignment) is never an external actor
    and not exists (
      select 1 from public.user_role_assignments ura
      where ura.profile_id = u.id
        and ura.revoked_at is null
        and (ura.starts_at is null or ura.starts_at <= now())
        and (ura.ends_at is null or ura.ends_at > now())
    );
$function$;
revoke execute on function public.caterlink_external_role() from public, anon;
grant execute on function public.caterlink_external_role() to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 4. CaterLink Driver: create a movement and its Part A
-- ---------------------------------------------------------------------------------------------
create or replace function public.create_caterlink_driver_transaction_secure(
  p_origin_station text,
  p_direction text,
  p_route text,
  p_vehicle_number text,
  p_driver_name text,
  p_driver_id text,
  p_seal_number text,
  p_signature_url text,
  p_signature_hash text default null,
  p_vehicle_search_completed boolean default true,
  p_remarks text default null,
  p_hub_destination text default null,
  p_flight_number text default null,
  p_aircraft_reg text default null,
  p_trolley_count integer default 0,
  p_cargo_types text[] default '{}'
)
returns table (transaction_id uuid, transaction_number text)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_caller uuid := auth.uid();
  v_user record;
  v_station_id uuid;
  v_aoc_id uuid;
  v_hub_dest_id uuid;
  v_vehicle_id uuid;
  v_driver_id uuid;
  v_tx_id uuid;
  v_tx_number text;
  v_seq integer;
  v_year integer := extract(year from now())::integer;
begin
  if v_caller is null then
    raise exception 'Must be signed in.';
  end if;
  if public.caterlink_external_role() is distinct from 'warehouse_pic' then
    raise exception 'Only an active CaterLink Driver account may create a movement.';
  end if;
  select u.name, u.staff_id into v_user from public.users u where u.id = v_caller;

  if p_origin_station is null or p_direction is null or p_route is null
     or nullif(btrim(p_vehicle_number), '') is null or nullif(btrim(p_driver_name), '') is null
     or nullif(btrim(p_driver_id), '') is null or nullif(btrim(p_seal_number), '') is null
     or nullif(btrim(p_signature_url), '') is null then
    raise exception 'Missing required fields.';
  end if;
  if p_direction not in ('OUTBOUND', 'INBOUND', 'WAREHOUSE_TO_AIRCRAFT', 'AIRCRAFT_TO_WAREHOUSE') then
    raise exception 'Invalid direction.';
  end if;

  select s.id, cap.aoc_id into v_station_id, v_aoc_id
  from public.org_stations s
  join public.caterlink_station_capabilities cap on cap.station_id = s.id and cap.is_active
  where s.code = p_origin_station and s.is_active and cap.can_create
  limit 1;
  if v_station_id is null then
    raise exception 'Station % is not configured to initiate CaterLink transactions.', p_origin_station;
  end if;

  v_vehicle_id := public.resolve_usable_caterlink_vehicle(p_vehicle_number, v_aoc_id);
  v_driver_id := public.resolve_usable_caterlink_driver(p_driver_id, v_aoc_id);
  if v_vehicle_id is null or v_driver_id is null then
    raise exception 'Vehicle or driver is not an active, approved, currently-effective whitelist entry for this AOC.';
  end if;
  -- a whitelisted driver id must not wave through a different person: the name must match the entry
  if not exists (
    select 1 from public.drivers d
    where d.id = v_driver_id and upper(btrim(d.name)) = upper(btrim(p_driver_name))
  ) then
    raise exception 'The driver name does not match the whitelisted name on file for this driver ID.';
  end if;

  if p_route = 'HUB' then
    if p_hub_destination is null then
      raise exception 'Hub destination is required for HUB route.';
    end if;
    select id into v_hub_dest_id from public.org_stations where code = p_hub_destination;
  end if;

  if to_regclass('public.cl_txn_seq_' || v_year) is null then
    begin
      execute format('create sequence public.cl_txn_seq_%s start with 1', v_year);
    exception when duplicate_table or unique_violation then
      null;
    end;
  end if;
  execute format('select nextval(''public.cl_txn_seq_%s'')', v_year) into v_seq;
  v_tx_number := 'CL-' || v_year || '-' || lpad(v_seq::text, 6, '0');

  insert into public.transactions (
    transaction_number, aoc_id, direction, route, vehicle_number, driver_name, driver_id,
    vehicle_id, driver_id_ref, seal_number, hub_destination, station, origin_station_id,
    destination_station_id, flight_number, aircraft_registration, trolley_count, cargo_types,
    status, created_by
  ) values (
    v_tx_number, v_aoc_id, p_direction, p_route, p_vehicle_number, p_driver_name, p_driver_id,
    v_vehicle_id, v_driver_id, p_seal_number, p_hub_destination, p_origin_station, v_station_id,
    v_hub_dest_id, p_flight_number, p_aircraft_reg, coalesce(p_trolley_count, 0),
    coalesce(p_cargo_types, '{}'), 'CREATED', v_caller
  ) returning id into v_tx_id;

  insert into public.seals (transaction_id, seal_number, seal_type, seal_color)
  values (v_tx_id, p_seal_number, 'TRUCK_SEAL', case when p_direction in ('INBOUND', 'AIRCRAFT_TO_WAREHOUSE') then 'GREEN' else 'BLUE' end);

  insert into public.caterlink_checkpoint_part_a (
    transaction_id, pic_name, pic_staff_id, vehicle_search_completed, signature_url, signature_hash,
    remarks, completed_by
  ) values (
    v_tx_id, v_user.name, v_user.staff_id, coalesce(p_vehicle_search_completed, true), p_signature_url,
    p_signature_hash, p_remarks, v_caller
  );

  perform public.phase8_write_audit('caterlink_driver_transaction_create', 'transaction', v_tx_id,
    jsonb_build_object('transaction_number', v_tx_number, 'station', p_origin_station, 'route', p_route));

  return query select v_tx_id, v_tx_number;
end;
$function$;
revoke execute on function public.create_caterlink_driver_transaction_secure(text, text, text, text, text, text, text, text, text, boolean, text, text, text, text, integer, text[]) from public, anon;
grant execute on function public.create_caterlink_driver_transaction_secure(text, text, text, text, text, text, text, text, text, boolean, text, text, text, text, integer, text[]) to authenticated, service_role;

-- The Driver cannot read the whitelist tables (their RLS is role-based), so the creation form is fed
-- by this narrow RPC: only currently usable entries in the creating station's AOC, minimal fields.
create or replace function public.list_caterlink_driver_options_secure()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_aocs uuid[];
begin
  if public.caterlink_external_role() is distinct from 'warehouse_pic' then
    raise exception 'Only an active CaterLink Driver account may list creation options.';
  end if;
  select coalesce(array_agg(distinct cap.aoc_id), '{}') into v_aocs
  from public.caterlink_station_capabilities cap
  where cap.is_active and cap.can_create;

  return jsonb_build_object(
    'stations', (
      select coalesce(jsonb_agg(s.code order by s.code), '[]'::jsonb)
      from public.caterlink_station_capabilities cap
      join public.org_stations s on s.id = cap.station_id and s.is_active
      where cap.is_active and cap.can_create
    ),
    'companies', (
      select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'code', c.code) order by c.name), '[]'::jsonb)
      from public.catering_companies c
      where c.aoc_id = any(v_aocs) and c.status = 'active'
    ),
    'vehicles', (
      select coalesce(jsonb_agg(jsonb_build_object('vehicle_number', v.vehicle_number, 'pass_expiry_date', v.pass_expiry_date) order by v.vehicle_number), '[]'::jsonb)
      from public.vehicles v
      where v.aoc_id = any(v_aocs)
        and public.caterlink_identity_is_usable(v.is_active, v.revoked_at, v.deactivated_at, v.created_by, v.approved_at, v.effective_from, v.pass_expiry_date)
    ),
    'drivers', (
      select coalesce(jsonb_agg(jsonb_build_object('name', d.name, 'staff_id', d.staff_id, 'pass_expiry_date', d.pass_expiry_date, 'catering_company_id', d.catering_company_id) order by d.name), '[]'::jsonb)
      from public.drivers d
      where d.aoc_id = any(v_aocs)
        and public.caterlink_identity_is_usable(d.is_active, d.revoked_at, d.deactivated_at, d.created_by, d.approved_at, d.effective_from, d.pass_expiry_date)
    )
  );
end;
$function$;
revoke execute on function public.list_caterlink_driver_options_secure() from public, anon;
grant execute on function public.list_caterlink_driver_options_secure() to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 5. Third-Party Vendor delivery workflow
-- ---------------------------------------------------------------------------------------------
create table if not exists public.caterlink_vendor_deliveries (
  id uuid primary key default gen_random_uuid(),
  delivery_number text not null unique default '',
  aoc_id uuid not null references public.aocs(id),
  station_id uuid not null references public.org_stations(id),
  vendor_user_id uuid not null references public.users(id),
  status text not null default 'CREATED'
    check (status in ('CREATED', 'SECURITY_VERIFIED', 'COMPLETED', 'ESCALATED')),
  driver_name text not null,
  driver_nric text not null,
  vehicle_registration_no text not null,
  seal_number text not null,
  supplies_description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists idx_cl_vendor_deliveries_vendor on public.caterlink_vendor_deliveries (vendor_user_id);
create index if not exists idx_cl_vendor_deliveries_aoc_status on public.caterlink_vendor_deliveries (aoc_id, status);
create index if not exists idx_cl_vendor_deliveries_station on public.caterlink_vendor_deliveries (station_id);

create table if not exists public.caterlink_vendor_checkpoints (
  id uuid primary key default gen_random_uuid(),
  delivery_id uuid not null references public.caterlink_vendor_deliveries(id) on delete restrict,
  stage text not null check (stage in ('A', 'B', 'C')),
  actor_id uuid not null references public.profiles(id),
  actor_name text not null,
  actor_staff_id text not null,
  signature_url text not null,
  signature_hash text,
  result text not null default 'PASS' check (result in ('PASS', 'ESCALATE')),
  remarks text,
  escalation_reason text,
  observed jsonb,
  completed_at timestamptz not null default now(),
  unique (delivery_id, stage),
  check (result <> 'ESCALATE' or nullif(btrim(escalation_reason), '') is not null)
);

create or replace function public.caterlink_vendor_guard()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
begin
  if tg_op = 'DELETE' then
    raise exception 'CaterLink vendor records are never deleted.';
  end if;
  if tg_table_name = 'caterlink_vendor_checkpoints' then
    raise exception 'CaterLink vendor checkpoints are write-once.';
  end if;
  new.updated_at := now();
  return new;
end;
$function$;

drop trigger if exists trg_cl_vendor_deliveries_guard on public.caterlink_vendor_deliveries;
create trigger trg_cl_vendor_deliveries_guard before update or delete on public.caterlink_vendor_deliveries
  for each row execute function public.caterlink_vendor_guard();
drop trigger if exists trg_cl_vendor_checkpoints_guard on public.caterlink_vendor_checkpoints;
create trigger trg_cl_vendor_checkpoints_guard before update or delete on public.caterlink_vendor_checkpoints
  for each row execute function public.caterlink_vendor_guard();

alter table public.caterlink_vendor_deliveries enable row level security;
alter table public.caterlink_vendor_checkpoints enable row level security;
revoke all on public.caterlink_vendor_deliveries, public.caterlink_vendor_checkpoints from public, anon, authenticated;
grant all on public.caterlink_vendor_deliveries, public.caterlink_vendor_checkpoints to service_role;
grant select on public.caterlink_vendor_deliveries, public.caterlink_vendor_checkpoints to authenticated;

create or replace function public.caterlink_can_scan_vendor_station(p_station_id uuid, p_aoc_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select exists (
    select 1 from public.org_stations s
    where s.id = p_station_id and public.can_user_scan_caterlink(s.code, p_aoc_id)
  );
$function$;
revoke execute on function public.caterlink_can_scan_vendor_station(uuid, uuid) from public, anon;
grant execute on function public.caterlink_can_scan_vendor_station(uuid, uuid) to authenticated, service_role;

drop policy if exists caterlink_vendor_deliveries_read on public.caterlink_vendor_deliveries;
create policy caterlink_vendor_deliveries_read on public.caterlink_vendor_deliveries for select to authenticated
  using (
    vendor_user_id = auth.uid()
    or public.has_active_role_for_aoc('caterlink_management', aoc_id)
    or public.caterlink_can_scan_vendor_station(station_id, aoc_id)
  );
drop policy if exists caterlink_vendor_checkpoints_read on public.caterlink_vendor_checkpoints;
create policy caterlink_vendor_checkpoints_read on public.caterlink_vendor_checkpoints for select to authenticated
  using (exists (select 1 from public.caterlink_vendor_deliveries d where d.id = delivery_id));

create or replace function public.create_caterlink_vendor_delivery_secure(
  p_station_code text,
  p_driver_name text,
  p_driver_nric text,
  p_vehicle_registration_no text,
  p_seal_number text,
  p_signature_url text,
  p_signature_hash text default null,
  p_supplies_description text default null
)
returns table (delivery_id uuid, delivery_number text)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_caller uuid := auth.uid();
  v_user record;
  v_station_id uuid;
  v_aoc_id uuid;
  v_id uuid;
  v_number text;
  v_seq integer;
  v_year integer := extract(year from now())::integer;
begin
  if v_caller is null then
    raise exception 'Must be signed in.';
  end if;
  if public.caterlink_external_role() is distinct from 'vendor' then
    raise exception 'Only an active Third-Party Vendor account may create a delivery.';
  end if;
  select u.name, u.staff_id into v_user from public.users u where u.id = v_caller;

  if nullif(btrim(p_station_code), '') is null or nullif(btrim(p_driver_name), '') is null
     or nullif(btrim(p_driver_nric), '') is null or nullif(btrim(p_vehicle_registration_no), '') is null
     or nullif(btrim(p_seal_number), '') is null or nullif(btrim(p_signature_url), '') is null then
    raise exception 'Missing required fields.';
  end if;

  -- Deliveries are security-checked by a scan-authorised officer, so they may only be raised for a
  -- station whose scan capability is enabled (the approved PEN/JHB scope; this never widens it).
  select s.id, cap.aoc_id into v_station_id, v_aoc_id
  from public.org_stations s
  join public.caterlink_station_capabilities cap on cap.station_id = s.id and cap.is_active and cap.can_scan
  where s.code = p_station_code and s.is_active and s.code in ('PEN', 'JHB')
  limit 1;
  if v_station_id is null then
    raise exception 'Station % does not accept vendor deliveries.', p_station_code;
  end if;

  if to_regclass('public.cl_vendor_seq_' || v_year) is null then
    begin
      execute format('create sequence public.cl_vendor_seq_%s start with 1', v_year);
    exception when duplicate_table or unique_violation then
      null;
    end;
  end if;
  execute format('select nextval(''public.cl_vendor_seq_%s'')', v_year) into v_seq;
  v_number := 'CLV-' || v_year || '-' || lpad(v_seq::text, 6, '0');

  insert into public.caterlink_vendor_deliveries (
    delivery_number, aoc_id, station_id, vendor_user_id, driver_name, driver_nric,
    vehicle_registration_no, seal_number, supplies_description
  ) values (
    v_number, v_aoc_id, v_station_id, v_caller, p_driver_name, p_driver_nric,
    p_vehicle_registration_no, p_seal_number, p_supplies_description
  ) returning id into v_id;

  insert into public.caterlink_vendor_checkpoints (delivery_id, stage, actor_id, actor_name, actor_staff_id, signature_url, signature_hash)
  values (v_id, 'A', v_caller, v_user.name, v_user.staff_id, p_signature_url, p_signature_hash);

  perform public.phase8_write_audit('caterlink_vendor_delivery_create', 'caterlink_vendor_delivery', v_id,
    jsonb_build_object('delivery_number', v_number, 'station', p_station_code));

  return query select v_id, v_number;
end;
$function$;
revoke execute on function public.create_caterlink_vendor_delivery_secure(text, text, text, text, text, text, text, text) from public, anon;
grant execute on function public.create_caterlink_vendor_delivery_secure(text, text, text, text, text, text, text, text) to authenticated, service_role;

create or replace function public.record_caterlink_vendor_security_check_secure(
  p_delivery_id uuid,
  p_signature_url text,
  p_signature_hash text default null,
  p_result text default 'PASS',
  p_remarks text default null,
  p_escalation_reason text default null,
  p_observed jsonb default null
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_caller uuid := auth.uid();
  v_d record;
  v_station_code text;
  v_profile record;
begin
  if v_caller is null then
    raise exception 'Must be signed in.';
  end if;
  select * into v_d from public.caterlink_vendor_deliveries where id = p_delivery_id for update;
  if v_d.id is null then
    raise exception 'Delivery not found.';
  end if;
  select s.code into v_station_code from public.org_stations s where s.id = v_d.station_id;
  if not public.can_user_scan_caterlink(v_station_code, v_d.aoc_id) then
    raise exception 'Not authorised to perform the security check at this station.';
  end if;
  if v_d.status <> 'CREATED' then
    raise exception 'The security check is only available for a newly created delivery.';
  end if;
  if p_result not in ('PASS', 'ESCALATE') then
    raise exception 'Invalid result.';
  end if;
  if nullif(btrim(p_signature_url), '') is null then
    raise exception 'A signature is required.';
  end if;
  if p_result = 'ESCALATE' and nullif(btrim(p_escalation_reason), '') is null then
    raise exception 'An escalation reason is required.';
  end if;
  select p.name, p.staff_no into v_profile from public.profiles p where p.id = v_caller;

  insert into public.caterlink_vendor_checkpoints (
    delivery_id, stage, actor_id, actor_name, actor_staff_id, signature_url, signature_hash, result, remarks, escalation_reason, observed
  ) values (
    p_delivery_id, 'B', v_caller, coalesce(v_profile.name, ''), coalesce(v_profile.staff_no, ''), p_signature_url,
    p_signature_hash, p_result, p_remarks, p_escalation_reason, p_observed
  );
  update public.caterlink_vendor_deliveries
    set status = case when p_result = 'PASS' then 'SECURITY_VERIFIED' else 'ESCALATED' end
    where id = p_delivery_id;

  perform public.phase8_write_audit('caterlink_vendor_security_check', 'caterlink_vendor_delivery', p_delivery_id,
    jsonb_build_object('result', p_result, 'station', v_station_code));
end;
$function$;
revoke execute on function public.record_caterlink_vendor_security_check_secure(uuid, text, text, text, text, text, jsonb) from public, anon;
grant execute on function public.record_caterlink_vendor_security_check_secure(uuid, text, text, text, text, text, jsonb) to authenticated, service_role;

create or replace function public.complete_caterlink_vendor_delivery_secure(
  p_delivery_id uuid,
  p_signature_url text,
  p_signature_hash text default null
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_caller uuid := auth.uid();
  v_d record;
  v_user record;
begin
  if v_caller is null then
    raise exception 'Must be signed in.';
  end if;
  if public.caterlink_external_role() is distinct from 'vendor' then
    raise exception 'Only an active Third-Party Vendor account may complete a delivery.';
  end if;
  select * into v_d from public.caterlink_vendor_deliveries where id = p_delivery_id for update;
  if v_d.id is null or v_d.vendor_user_id <> v_caller then
    raise exception 'Delivery not found.';
  end if;
  if v_d.status <> 'SECURITY_VERIFIED' then
    raise exception 'The delivery has not passed its security check.';
  end if;
  if nullif(btrim(p_signature_url), '') is null then
    raise exception 'A signature is required.';
  end if;
  select u.name, u.staff_id into v_user from public.users u where u.id = v_caller;

  insert into public.caterlink_vendor_checkpoints (delivery_id, stage, actor_id, actor_name, actor_staff_id, signature_url, signature_hash)
  values (p_delivery_id, 'C', v_caller, v_user.name, v_user.staff_id, p_signature_url, p_signature_hash);
  update public.caterlink_vendor_deliveries set status = 'COMPLETED', completed_at = now() where id = p_delivery_id;

  perform public.phase8_write_audit('caterlink_vendor_delivery_complete', 'caterlink_vendor_delivery', p_delivery_id, '{}'::jsonb);
end;
$function$;
revoke execute on function public.complete_caterlink_vendor_delivery_secure(uuid, text, text) from public, anon;
grant execute on function public.complete_caterlink_vendor_delivery_secure(uuid, text, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 6. Audit log for CaterLink Management (phase8_audit_log has no client read grant)
-- ---------------------------------------------------------------------------------------------
create or replace function public.list_caterlink_audit_secure(p_limit integer default 300)
returns table (
  id uuid, actor_id uuid, actor_name text, action text, entity_type text, entity_id uuid,
  detail jsonb, created_at timestamptz
)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_aocs uuid[];
begin
  select coalesce(array_agg(distinct ura.aoc_id), '{}') into v_aocs
  from public.user_role_assignments ura
  join public.role_definitions rd on rd.id = ura.role_definition_id
  where ura.profile_id = auth.uid()
    and rd.code = 'caterlink_management'
    and ura.aoc_id is not null
    and ura.revoked_at is null
    and (ura.starts_at is null or ura.starts_at <= now())
    and (ura.ends_at is null or ura.ends_at > now());
  if cardinality(v_aocs) = 0 then
    raise exception 'Only CaterLink Management may read the CaterLink audit log.';
  end if;

  return query
  select a.id, a.actor_id, p.name, a.action, a.entity_type, a.entity_id, a.detail, a.created_at
  from public.phase8_audit_log a
  left join public.profiles p on p.id = a.actor_id
  where a.action like 'caterlink!_%' escape '!'
    and (
      exists (select 1 from public.transactions t where t.id = a.entity_id and t.aoc_id = any(v_aocs))
      or exists (select 1 from public.caterlink_vendor_deliveries d where d.id = a.entity_id and d.aoc_id = any(v_aocs))
      or exists (select 1 from public.caterlink_incidents i where i.id = a.entity_id and i.aoc_id = any(v_aocs))
      or exists (select 1 from public.caterlink_archives r where r.id = a.entity_id and r.aoc_id = any(v_aocs))
      or exists (select 1 from public.vehicles v where v.id = a.entity_id and v.aoc_id = any(v_aocs))
      or exists (select 1 from public.drivers dr where dr.id = a.entity_id and dr.aoc_id = any(v_aocs))
      or exists (select 1 from public.catering_companies c where c.id = a.entity_id and c.aoc_id = any(v_aocs))
    )
  order by a.created_at desc
  limit least(greatest(coalesce(p_limit, 300), 1), 1000);
end;
$function$;
revoke execute on function public.list_caterlink_audit_secure(integer) from public, anon;
grant execute on function public.list_caterlink_audit_secure(integer) to authenticated, service_role;
