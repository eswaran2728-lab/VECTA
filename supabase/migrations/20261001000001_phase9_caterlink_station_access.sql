-- =======================================================================
-- VECTA Phase 9: CaterLink Station Access, Transaction Control and Management Oversight
-- =======================================================================
-- Implements secure, configurable CaterLink station-access capabilities,
-- Phase 3 role-assignment-backed authorization, destination receipt confirmation,
-- incident lifecycle, whitelist management, final PDF access, and CaterLink
-- Management oversight for Malaysia AOC while preserving KUL operational workflow.
-- =======================================================================

-- Recovery-inspection finding: confirm_caterlink_destination_receipt_
-- secure() (Part G below) calls public.notify(..., 'caterlink_movement_
-- received', ...) -- reusing the established Phase 4/8 user_
-- notifications system per the approved Phase 9 rules ("reuse user_
-- notifications", "no disconnected notification table") -- but that
-- event type was never added to user_notifications' own event_type
-- CHECK constraint, so every receipt confirmation would raise a
-- constraint violation. Widened here, the same way Phase 8/Slice 7
-- widened it for its own new event types.
alter table public.user_notifications drop constraint if exists user_notifications_event_type_check;
alter table public.user_notifications add constraint user_notifications_event_type_check
  check (event_type in (
    'request_submitted', 'request_approved', 'request_rejected',
    'transfer_initiated', 'transfer_accepted', 'transfer_rejected',
    'membership_ended', 'assignment_ended', 'deactivation',
    'leave_status_changed', 'ot_status_changed', 'investigation_case_assigned',
    'caterlink_movement_received', 'caterlink_whitelist_approved', 'caterlink_whitelist_rejected'
  ));

-- =======================================================================
-- PART A: Station Capability Model
-- =======================================================================
create table if not exists public.caterlink_station_capabilities (
  id uuid primary key default gen_random_uuid(),
  aoc_id uuid not null references public.aocs(id),
  station_id uuid not null references public.org_stations(id),
  can_view boolean not null default false,
  can_create boolean not null default false,
  can_scan boolean not null default false,
  can_confirm_station_receipt boolean not null default false,
  can_confirm_hub_receipt boolean not null default false,
  can_report_incident boolean not null default false,
  can_view_history boolean not null default false,
  can_download_pdf boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (aoc_id, station_id)
);

create index if not exists idx_caterlink_station_caps_lookup
  on public.caterlink_station_capabilities (aoc_id, station_id, is_active);

alter table public.caterlink_station_capabilities enable row level security;
revoke all on public.caterlink_station_capabilities from public, anon, authenticated;
grant all on public.caterlink_station_capabilities to service_role;
grant select on public.caterlink_station_capabilities to authenticated;

-- RLS policies execute as the querying (non-privileged) role, not as a security-definer
-- function body, and `authenticated` carries zero grant on public.user_role_assignments
-- (revoked in Phase 3, same lockdown pattern as public.aocs). A raw inline subquery against
-- user_role_assignments inside a USING clause therefore fails with "permission denied for
-- table user_role_assignments" -- this small SECURITY DEFINER wrapper is the same fix
-- Phase 8 applied for public.my_aoc_id().
create or replace function public.has_any_active_assignment_in_aoc(p_aoc_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select exists (
    select 1 from public.user_role_assignments ura
    where ura.profile_id = auth.uid()
      and ura.aoc_id = p_aoc_id
      and ura.revoked_at is null
      and ura.starts_at <= now()
      and (ura.ends_at is null or ura.ends_at > now())
  );
$function$;
revoke execute on function public.has_any_active_assignment_in_aoc(uuid) from public, anon;
grant execute on function public.has_any_active_assignment_in_aoc(uuid) to authenticated, service_role;

-- public.user_entity_memberships carries the same zero-grant-for-authenticated lockdown
-- (see Phase 4's "no direct grant for anon/authenticated at all" note) -- same fix.
create or replace function public.has_active_entity_membership_in_aoc(p_aoc_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select exists (
    select 1 from public.user_entity_memberships uem
    where uem.profile_id = auth.uid()
      and uem.aoc_id = p_aoc_id
      and uem.status = 'active'
  );
$function$;
revoke execute on function public.has_active_entity_membership_in_aoc(uuid) from public, anon;
grant execute on function public.has_active_entity_membership_in_aoc(uuid) to authenticated, service_role;

create policy "caterlink_station_capabilities_read"
  on public.caterlink_station_capabilities for select
  to authenticated
  using (
    -- Any authenticated user can read station capabilities for their assigned AOC
    public.has_any_active_assignment_in_aoc(caterlink_station_capabilities.aoc_id)
    or public.has_active_entity_membership_in_aoc(caterlink_station_capabilities.aoc_id)
  );

-- =======================================================================
-- PART B: CaterLink Core Tables & Multi-AOC Columns
-- =======================================================================

create table if not exists public.transactions (
  id uuid primary key default gen_random_uuid(),
  transaction_number text unique not null default '',
  aoc_id uuid references public.aocs(id),
  operating_entity_id uuid references public.operating_entities(id),
  direction text not null check (direction in ('OUTBOUND', 'INBOUND', 'WAREHOUSE_TO_AIRCRAFT', 'AIRCRAFT_TO_WAREHOUSE')),
  vehicle_number text not null,
  driver_name text not null,
  driver_id text not null,
  seal_number text,
  status text not null default 'CREATED'
    check (status in ('CREATED', 'INFLIGHT_POST_APPROVED', 'AIRPORT_POST_APPROVED', 'REDQ_RESEALED', 'COMPLETED', 'ESCALATED', 'POST2_APPROVED', 'POST6_APPROVED')),
  route text not null default 'AIRCRAFT' check (route in ('AIRCRAFT', 'HUB', 'REDQ', 'MAINTENANCE')),
  hub_destination text check (hub_destination in ('PEN', 'JHB', 'NILAI') or hub_destination is null),
  station text,
  origin_station_id uuid references public.org_stations(id),
  destination_station_id uuid references public.org_stations(id),
  destination_hub_id uuid references public.hubs(id),
  flight_number text,
  aircraft_registration text,
  catering_company_id uuid,
  vehicle_id uuid,
  driver_id_ref uuid,
  trolley_count integer not null default 0,
  cargo_types text[] not null default '{}',
  qr_token text,
  completed_form_url text,
  completed_at timestamptz,
  archived boolean not null default false,
  archived_at timestamptz,
  archived_by uuid references public.profiles(id),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Ensure multi-AOC columns exist if table was already created
do $$
begin
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='transactions' and column_name='aoc_id') then
    alter table public.transactions add column aoc_id uuid references public.aocs(id);
  end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='transactions' and column_name='operating_entity_id') then
    alter table public.transactions add column operating_entity_id uuid references public.operating_entities(id);
  end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='transactions' and column_name='origin_station_id') then
    alter table public.transactions add column origin_station_id uuid references public.org_stations(id);
  end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='transactions' and column_name='destination_station_id') then
    alter table public.transactions add column destination_station_id uuid references public.org_stations(id);
  end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='transactions' and column_name='destination_hub_id') then
    alter table public.transactions add column destination_hub_id uuid references public.hubs(id);
  end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='transactions' and column_name='archived_by') then
    alter table public.transactions add column archived_by uuid references public.profiles(id);
  end if;
end $$;

create index if not exists idx_transactions_aoc_status on public.transactions (aoc_id, status);
create index if not exists idx_transactions_dest_station on public.transactions (destination_station_id);

alter table public.transactions enable row level security;
revoke all on public.transactions from public, anon, authenticated;
grant all on public.transactions to service_role;
grant select on public.transactions to authenticated;

-- RLS policies execute as the querying (non-privileged) role, not as a security-definer
-- function body, and `authenticated` carries zero grant on public.user_role_assignments
-- (revoked in Phase 3, same lockdown pattern as public.aocs). A raw inline subquery against
-- user_role_assignments inside a USING clause therefore fails with "permission denied for
-- table user_role_assignments" -- this small SECURITY DEFINER wrapper is the same fix
-- Phase 8 applied for public.my_aoc_id().
create or replace function public.has_station_assignment_for_transaction(
  p_aoc_id uuid,
  p_destination_station_id uuid,
  p_origin_station_id uuid
)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select exists (
    select 1 from public.user_role_assignments ura
    where ura.profile_id = auth.uid()
      and ura.aoc_id = p_aoc_id
      and (ura.station_id = p_destination_station_id or ura.station_id = p_origin_station_id)
      and ura.revoked_at is null
      and ura.starts_at <= now()
      and (ura.ends_at is null or ura.ends_at > now())
  );
$function$;
revoke execute on function public.has_station_assignment_for_transaction(uuid, uuid, uuid) from public, anon;
grant execute on function public.has_station_assignment_for_transaction(uuid, uuid, uuid) to authenticated, service_role;

create policy "transactions_read_policy"
  on public.transactions for select
  to authenticated
  using (
    -- Service role sees everything
    current_user = 'service_role'
    -- CaterLink Management sees all transactions in their assigned AOC
    or (
      aoc_id is not null
      and public.has_active_role_for_aoc('caterlink_management', aoc_id)
    )
    -- Operation Manager or Main Enforcement in same AOC
    or (
      aoc_id is not null
      and (
        public.has_active_role_for_aoc('operation_manager', aoc_id)
        or public.has_active_role_for_aoc('main_enforcement', aoc_id)
      )
    )
    -- Submitter / creator
    or created_by = auth.uid()
    -- Destination or origin station staff holding active AVSEC assignment
    or (
      aoc_id is not null
      and public.has_station_assignment_for_transaction(aoc_id, destination_station_id, origin_station_id)
    )
  );

-- Seals and Verifications
create table if not exists public.seals (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references public.transactions(id) on delete cascade,
  seal_number text not null,
  seal_type text not null default 'TRUCK_SEAL' check (seal_type in ('TRUCK_SEAL', 'TROLLEY', 'OTHER')),
  seal_color text not null default 'BLUE' check (seal_color in ('BLUE', 'GREEN', 'OTHER')),
  applied_at timestamptz not null default now(),
  superseded_at timestamptz,
  superseded_by uuid references public.profiles(id),
  superseded_reason text
);

create table if not exists public.seal_verifications (
  id uuid primary key default gen_random_uuid(),
  seal_id uuid not null references public.seals(id) on delete cascade,
  checkpoint text not null check (checkpoint in ('INFLIGHT_POST', 'AIRPORT_POST', 'PART_D', 'REDQ', 'HUB')),
  entered_seal_number text not null,
  observed_seal_color text check (observed_seal_color in ('BLUE', 'GREEN', 'OTHER') or observed_seal_color is null),
  matched boolean not null,
  verified_by uuid references public.profiles(id),
  verified_at timestamptz not null default now(),
  photo_url text
);

-- Checkpoint Details
create table if not exists public.part_a (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null unique references public.transactions(id) on delete cascade,
  pic_name text not null,
  pic_staff_id text not null,
  vehicle_search_completed boolean not null default true,
  signature_url text not null,
  signature_hash text,
  remarks text,
  completed_by uuid not null references public.profiles(id),
  completed_at timestamptz not null default now()
);

create table if not exists public.part_b_c (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references public.transactions(id) on delete cascade,
  checkpoint_stage text not null check (checkpoint_stage in ('B', 'C')),
  avsec_name text not null,
  avsec_staff_id text not null,
  vehicle_verified boolean not null default true,
  driver_verified boolean not null default true,
  seal_verified boolean not null default true,
  signature_url text not null,
  signature_hash text,
  remarks text,
  result text not null default 'PASS' check (result in ('PASS', 'ESCALATE')),
  escalation_reason text,
  completed_by uuid not null references public.profiles(id),
  completed_at timestamptz not null default now()
);

create table if not exists public.part_d (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null unique references public.transactions(id) on delete cascade,
  delivery_location text not null check (delivery_location in ('SRA_WAREHOUSE', 'AIRCRAFT')),
  receiver_name text not null,
  receiver_staff_id text not null,
  seal_intact boolean not null default true,
  signature_url text not null,
  signature_hash text,
  remarks text,
  result text not null default 'PASS' check (result in ('PASS', 'ESCALATE')),
  escalation_reason text,
  aircraft_identifier text,
  completed_by uuid not null references public.profiles(id),
  completed_at timestamptz not null default now()
);

create table if not exists public.part_hub (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null unique references public.transactions(id) on delete cascade,
  confirmed_destination text not null,
  hub_avsec_name text not null,
  hub_avsec_staff_id text not null,
  remarks text,
  signature_url text not null,
  signature_hash text,
  completed_by uuid not null references public.profiles(id),
  completed_at timestamptz not null default now()
);

create table if not exists public.part_redq (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null unique references public.transactions(id) on delete cascade,
  old_seal_id uuid not null references public.seals(id),
  new_seal_id uuid not null references public.seals(id),
  redq_avsec_name text not null,
  redq_avsec_staff_id text not null,
  remarks text,
  signature_url text not null,
  signature_hash text,
  completed_by uuid not null references public.profiles(id),
  completed_at timestamptz not null default now()
);

-- =======================================================================
-- PART C: Whitelist System -- built on the EXISTING legacy ICMS tables
-- (public.catering_companies / public.vehicles / public.drivers), not a
-- new table.
--
-- CORRECTED (post-review): an earlier draft of this migration created a
-- brand-new public.caterlink_whitelist_entries table, entirely separate
-- from the legacy catering_companies/vehicles/drivers tables that
-- enforce_whitelist_on_create() and enforce_secondary_whitelist() (see
-- icms/20260810000001_strict_whitelist.sql) actually consult on every
-- real Part A creation and every Part B/C checkpoint. That would have
-- created two independently writable whitelist stores -- the new table
-- would sit unused while the real hard-block scanner path kept reading
-- only the legacy tables, and CaterLink Management would have no way to
-- see or change what the scanner actually enforces.
--
-- This corrected version instead extends the three legacy tables with
-- the AOC/entity scoping and audit fields CaterLink Management needs,
-- keeps `is_active` as the single authoritative gate the scanner/trigger
-- path already reads (untouched), and adds a derived `status` column
-- that always reflects is_active/revoked_at/approval state rather than
-- being independently writable -- eliminating any risk of the two
-- diverging. Existing KUL rows are backfilled to the 'MY' AOC below;
-- nothing about the existing hard-block enforcement changes.
-- =======================================================================

-- This test/CI harness's migrate.mjs deliberately never applies anything
-- under supabase/migrations/icms/ (see migrate.mjs's own EXCLUDED list),
-- so the disposable PGlite/native test databases never get
-- catering_companies/vehicles/drivers from icms/20260301000003_phase4_
-- whitelists.sql the way production does. `create table if not exists`
-- below is therefore a genuine bootstrap ONLY on a database that never
-- ran the icms/ chain (test/dev); against real production it is a no-op,
-- exactly like this file's own `create table if not exists
-- public.transactions` earlier. The shape mirrors that migration and its
-- later icms/ follow-ups (20260810000004_whitelist_extended_fields.sql)
-- exactly, including drivers.staff_id (renamed from driver_id there) and
-- vehicles.truck_type/truck_registration_number, so scan.ts and
-- transactions.ts's existing raw table reads work unchanged against
-- either bootstrap path.
create table if not exists public.catering_companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  code text not null unique,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.vehicles (
  id uuid primary key default gen_random_uuid(),
  vehicle_number text not null unique,
  catering_company_id uuid references public.catering_companies (id),
  airport_pass_number text,
  pass_expiry_date date,
  truck_type text check (truck_type in ('Hi-Lift', 'Bonded Truck')),
  truck_registration_number text,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.drivers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  staff_id text not null unique,
  catering_company_id uuid references public.catering_companies (id),
  airport_pass_number text,
  pass_expiry_date date,
  swap_to_staff_ic boolean not null default false,
  staff_ic_number text,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

-- Bootstrap-only RLS/grants (only ever runs when this migration itself
-- just created the tables above -- a no-op check against production,
-- where icms/20260301000003_phase4_whitelists.sql already set up its own
-- RLS/policies/triggers that this migration must never touch).
do $$
begin
  if not exists (
    select 1 from pg_trigger where tgname = 'trg_catering_companies_no_delete'
  ) then
    alter table public.catering_companies enable row level security;
    alter table public.vehicles enable row level security;
    alter table public.drivers enable row level security;
    grant select on public.catering_companies, public.vehicles, public.drivers to authenticated;
    grant all on public.catering_companies, public.vehicles, public.drivers to service_role;

    create policy "catering_companies_bootstrap_read" on public.catering_companies for select to authenticated using (true);
    create policy "vehicles_bootstrap_read" on public.vehicles for select to authenticated using (true);
    create policy "drivers_bootstrap_read" on public.drivers for select to authenticated using (true);
  end if;
end $$;

alter table public.catering_companies
  add column if not exists aoc_id uuid references public.aocs(id),
  add column if not exists operating_entity_id uuid references public.operating_entities(id),
  add column if not exists status text,
  add column if not exists pass_expiry_date date,
  add column if not exists effective_from date not null default current_date,
  add column if not exists created_by uuid references public.profiles(id),
  add column if not exists approved_by uuid references public.profiles(id),
  add column if not exists approved_at timestamptz,
  add column if not exists revoked_by uuid references public.profiles(id),
  add column if not exists revoked_at timestamptz,
  add column if not exists deactivated_by uuid references public.profiles(id),
  add column if not exists deactivated_at timestamptz,
  add column if not exists reason text,
  add column if not exists updated_at timestamptz not null default now();

alter table public.vehicles
  add column if not exists aoc_id uuid references public.aocs(id),
  add column if not exists operating_entity_id uuid references public.operating_entities(id),
  add column if not exists status text,
  add column if not exists effective_from date not null default current_date,
  add column if not exists created_by uuid references public.profiles(id),
  add column if not exists approved_by uuid references public.profiles(id),
  add column if not exists approved_at timestamptz,
  add column if not exists revoked_by uuid references public.profiles(id),
  add column if not exists revoked_at timestamptz,
  add column if not exists deactivated_by uuid references public.profiles(id),
  add column if not exists deactivated_at timestamptz,
  add column if not exists reason text,
  add column if not exists updated_at timestamptz not null default now();

alter table public.drivers
  add column if not exists aoc_id uuid references public.aocs(id),
  add column if not exists operating_entity_id uuid references public.operating_entities(id),
  add column if not exists status text,
  add column if not exists effective_from date not null default current_date,
  add column if not exists created_by uuid references public.profiles(id),
  add column if not exists approved_by uuid references public.profiles(id),
  add column if not exists approved_at timestamptz,
  add column if not exists revoked_by uuid references public.profiles(id),
  add column if not exists revoked_at timestamptz,
  add column if not exists deactivated_by uuid references public.profiles(id),
  add column if not exists deactivated_at timestamptz,
  add column if not exists reason text,
  add column if not exists updated_at timestamptz not null default now();

-- Backfill every pre-existing row (and any row a legacy insert path adds
-- without an aoc_id) to the 'MY' AOC -- current production behavior is
-- entirely Malaysia-scoped, so this is a lossless default, not a guess
-- about which specific AOC an existing row belongs to.
do $$
declare
  v_my_aoc_id uuid;
begin
  select id into v_my_aoc_id from public.aocs where code = 'MY';
  if v_my_aoc_id is not null then
    update public.catering_companies set aoc_id = v_my_aoc_id where aoc_id is null;
    update public.vehicles set aoc_id = v_my_aoc_id where aoc_id is null;
    update public.drivers set aoc_id = v_my_aoc_id where aoc_id is null;
  end if;
end $$;

-- status is DERIVED, never written directly by any RPC or client -- always
-- recomputed from is_active/revoked_at/deactivated_at/approved_at so it can
-- never disagree with the column the scanner/trigger path actually reads
-- (is_active). Seven real lifecycle stages (plus one legacy catch-all,
-- 'inactive', for pre-migration rows that predate this entire concept of
-- approval/rejection -- never produced for any row created through the
-- RPCs below), each with its own timestamp/actor pair so no two stages
-- share a meaning:
--
--   pending     created_by set, approved_at null            -- awaiting CaterLink Management review
--   active      approved_at set, is_active=true, currently effective and not expired
--   rejected    revoked_at set, approved_at NEVER was set     -- denied before ever going live (terminal)
--   revoked     revoked_at set, approved_at WAS set           -- pulled for cause after being live (terminal)
--   deactivated deactivated_at set, revoked_at still null     -- temporarily set aside (reversible via activate)
--   future      approved_at set, but effective_from is still in the future -- NOT yet usable; is_active is
--               force-held false here (unlike 'expired' below) because an entry that has never yet become
--               effective is not the same pre-existing-production escape hatch as a lapsed pass -- nothing
--               today relies on "approved early, usable early", so there is no compatibility reason to allow it.
--   expired     is_active stays true (display/legacy-compatibility column only -- see
--               icms/20260810000001_strict_whitelist.sql's pre-existing EXPIRED_PASS "record anyway, then
--               escalate an incident" override, which this migration does not remove). CORRECTED (post-
--               review, round 2): is_active alone is NO LONGER sufficient for AUTHORIZATION anywhere. Every
--               real scanner/transaction-creation/checkpoint/receipt path now calls
--               public.caterlink_identity_is_usable() (directly, or via resolve_usable_caterlink_vehicle/
--               driver()) -- which treats an expired pass_expiry_date as categorically unusable, full stop.
--               EXPIRED_PASS is a post-denial incident/result code, never a bypass that lets a movement
--               proceed; see lib/icms/actions/transactions.ts's createTransaction() and
--               checkWhitelistAtCheckpoint().
--   inactive    legacy-only: is_active=false, created_by/approved_at/revoked_at/deactivated_at all null --
--               a pre-Phase-9 row toggled off via the old (now-replaced) requireRole-gated
--               toggleWhitelistRow() action, before this migration's approval concept existed.
--
-- CORRECTED (post-review): the first version of this trigger reused
-- revoked_by/revoked_at for BOTH reject() and deactivate(), which made a
-- rejected-before-ever-approved entry and a deactivated-after-being-active
-- entry indistinguishable in the schema (both just "revoked_at is not
-- null"), and worse, deactivate() was changed to leave revoked_at null
-- specifically so it stayed reversible -- silently making "deactivated"
-- and "revoked" collapse to the SAME status value the trigger computed
-- from is_active alone. deactivated_by/deactivated_at (added above) give
-- deactivation its own unambiguous column pair, and this version checks
-- approved_at to split revoked_at's two real meanings (rejected vs.
-- revoked) apart instead of merging them.
create or replace function public.sync_caterlink_whitelist_status()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if new.revoked_at is not null then
    new.status := case when new.approved_at is null then 'rejected' else 'revoked' end;
  elsif new.deactivated_at is not null then
    new.status := 'deactivated';
    new.is_active := false;
  elsif new.created_by is not null and new.approved_at is null then
    new.status := 'pending';
    new.is_active := false;
  elsif new.effective_from is not null and new.effective_from > current_date then
    new.status := 'future';
    new.is_active := false;
  elsif new.is_active and new.pass_expiry_date is not null and new.pass_expiry_date < current_date then
    new.status := 'expired';
  elsif new.is_active then
    new.status := 'active';
  else
    new.status := 'inactive';
  end if;
  new.updated_at := now();
  return new;
end;
$function$;
revoke execute on function public.sync_caterlink_whitelist_status() from public, anon, authenticated;

drop trigger if exists trg_catering_companies_sync_status on public.catering_companies;
create trigger trg_catering_companies_sync_status
  before insert or update on public.catering_companies
  for each row execute function public.sync_caterlink_whitelist_status();

drop trigger if exists trg_vehicles_sync_status on public.vehicles;
create trigger trg_vehicles_sync_status
  before insert or update on public.vehicles
  for each row execute function public.sync_caterlink_whitelist_status();

drop trigger if exists trg_drivers_sync_status on public.drivers;
create trigger trg_drivers_sync_status
  before insert or update on public.drivers
  for each row execute function public.sync_caterlink_whitelist_status();

-- One-time backfill so every pre-existing row gets a correct initial
-- status (the trigger above only fires on future writes).
update public.catering_companies set updated_at = updated_at;
update public.vehicles set updated_at = updated_at;
update public.drivers set updated_at = updated_at;

alter table public.catering_companies drop constraint if exists catering_companies_status_check;
alter table public.catering_companies add constraint catering_companies_status_check
  check (status in ('pending', 'active', 'inactive', 'rejected', 'deactivated', 'revoked', 'expired', 'future'));
alter table public.vehicles drop constraint if exists vehicles_status_check;
alter table public.vehicles add constraint vehicles_status_check
  check (status in ('pending', 'active', 'inactive', 'rejected', 'deactivated', 'revoked', 'expired', 'future'));
alter table public.drivers drop constraint if exists drivers_status_check;
alter table public.drivers add constraint drivers_status_check
  check (status in ('pending', 'active', 'inactive', 'rejected', 'deactivated', 'revoked', 'expired', 'future'));

create index if not exists idx_catering_companies_aoc_status on public.catering_companies (aoc_id, status);
create index if not exists idx_vehicles_aoc_status on public.vehicles (aoc_id, status);
create index if not exists idx_drivers_aoc_status on public.drivers (aoc_id, status);

-- NOTE (deliberately NOT bootstrapped here, unlike the RLS/grants block
-- above): icms/20260810000001_strict_whitelist.sql's real
-- enforce_whitelist_on_create() trigger fires unconditionally on EVERY
-- insert into public.transactions, including create_caterlink_
-- transaction_secure()'s (Part G below), which never populates
-- vehicle_id/driver_id_ref -- it stores vehicle_number/driver_name/
-- driver_id as plain text params, not FK lookups against vehicles/
-- drivers. If that trigger is actually active in a target environment,
-- every CaterLink transaction creation would be rejected by it. This is
-- a genuine, pre-existing risk this review surfaced, not something
-- introduced by this migration -- flagged prominently in the final
-- report rather than guessed at here. Replicating that trigger into this
-- harness's bootstrap path would either mask the risk (if skipped) or
-- make every already-verified Section 3 transaction-creation test in
-- verify_phase9_caterlink.mjs fail for a behavior this migration cannot
-- safely change without product guidance on whether CaterLink movements
-- are meant to consult the vehicle/driver whitelist at all.

-- -----------------------------------------------------------------------
-- Whitelist management RPCs -- the single authorized write/read path for
-- CaterLink Management. Every one requires an active caterlink_management
-- assignment in the target AOC (auth.uid(), Phase 3 model), never the
-- legacy ICMS single-role system. list/create/approve/reject/activate/
-- deactivate all funnel through the three legacy tables above so there is
-- exactly one place the scanner and the admin surface both read from.
-- -----------------------------------------------------------------------

create or replace function public.list_caterlink_whitelist_secure(
  p_aoc_id uuid default null,
  p_entry_type text default null,
  p_status text default null,
  p_search text default null
)
returns table (
  entry_type text, id uuid, aoc_id uuid, operating_entity_id uuid,
  display_name text, identifier text, company_name text, status text,
  pass_expiry_date date, effective_from date,
  created_by uuid, approved_by uuid, approved_at timestamptz,
  deactivated_by uuid, deactivated_at timestamptz,
  revoked_by uuid, revoked_at timestamptz, reason text,
  created_at timestamptz, updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_aoc_id uuid := coalesce(p_aoc_id, public.my_aoc_id());
begin
  if not public.has_active_role_for_aoc('caterlink_management', v_aoc_id) then
    raise exception 'Only CaterLink Management may list the whitelist.';
  end if;

  return query
  select 'vendor'::text, c.id, c.aoc_id, c.operating_entity_id, c.name, c.code, null::text, c.status,
         c.pass_expiry_date, c.effective_from, c.created_by, c.approved_by, c.approved_at,
         c.deactivated_by, c.deactivated_at, c.revoked_by, c.revoked_at, c.reason, c.created_at, c.updated_at
  from public.catering_companies c
  where c.aoc_id = v_aoc_id
    and (p_entry_type is null or p_entry_type = 'vendor')
    and (p_status is null or c.status = p_status)
    and (p_search is null or c.name ilike '%' || p_search || '%' or c.code ilike '%' || p_search || '%')
  union all
  select 'vehicle'::text, v.id, v.aoc_id, v.operating_entity_id, v.vehicle_number, v.vehicle_number,
         cc.name, v.status, v.pass_expiry_date, v.effective_from, v.created_by, v.approved_by, v.approved_at,
         v.deactivated_by, v.deactivated_at, v.revoked_by, v.revoked_at, v.reason, v.created_at, v.updated_at
  from public.vehicles v
  left join public.catering_companies cc on cc.id = v.catering_company_id
  where v.aoc_id = v_aoc_id
    and (p_entry_type is null or p_entry_type = 'vehicle')
    and (p_status is null or v.status = p_status)
    and (p_search is null or v.vehicle_number ilike '%' || p_search || '%')
  union all
  select 'driver'::text, d.id, d.aoc_id, d.operating_entity_id, d.name, d.staff_id,
         cc.name, d.status, d.pass_expiry_date, d.effective_from, d.created_by, d.approved_by, d.approved_at,
         d.deactivated_by, d.deactivated_at, d.revoked_by, d.revoked_at, d.reason, d.created_at, d.updated_at
  from public.drivers d
  left join public.catering_companies cc on cc.id = d.catering_company_id
  where d.aoc_id = v_aoc_id
    and (p_entry_type is null or p_entry_type = 'driver')
    and (p_status is null or d.status = p_status)
    and (p_search is null or d.name ilike '%' || p_search || '%' or d.staff_id ilike '%' || p_search || '%')
  order by 20 desc;
end;
$function$;
revoke execute on function public.list_caterlink_whitelist_secure(uuid, text, text, text) from public, anon;
grant execute on function public.list_caterlink_whitelist_secure(uuid, text, text, text) to authenticated, service_role;

create or replace function public.create_caterlink_whitelist_entry_secure(
  p_entry_type text,
  p_aoc_id uuid,
  p_operating_entity_id uuid default null,
  p_name text default null,
  p_code text default null,
  p_identifier text default null,
  p_catering_company_id uuid default null,
  p_airport_pass_number text default null,
  p_pass_expiry_date date default null,
  p_truck_type text default null,
  p_truck_registration_number text default null,
  p_swap_to_staff_ic boolean default false,
  p_staff_ic_number text default null,
  p_effective_from date default null
)
returns table (id uuid, status text)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_caller uuid := auth.uid();
  v_id uuid;
  v_status text;
begin
  if v_caller is null then raise exception 'Must be signed in.'; end if;
  if not public.has_active_role_for_aoc('caterlink_management', p_aoc_id) then
    raise exception 'Only CaterLink Management may add whitelist entries.';
  end if;

  if p_entry_type = 'vendor' then
    if p_name is null or p_code is null then raise exception 'Vendor entries require name and code.'; end if;
    insert into public.catering_companies as cc (name, code, aoc_id, operating_entity_id, created_by, effective_from)
    values (p_name, upper(p_code), p_aoc_id, p_operating_entity_id, v_caller, coalesce(p_effective_from, current_date))
    returning cc.id, cc.status into v_id, v_status;
  elsif p_entry_type = 'vehicle' then
    if p_identifier is null then raise exception 'Vehicle entries require an identifier (vehicle number).'; end if;
    insert into public.vehicles as v (
      vehicle_number, catering_company_id, airport_pass_number, pass_expiry_date,
      truck_type, truck_registration_number, aoc_id, operating_entity_id, created_by, effective_from
    ) values (
      upper(p_identifier), p_catering_company_id, p_airport_pass_number, p_pass_expiry_date,
      p_truck_type, p_truck_registration_number, p_aoc_id, p_operating_entity_id, v_caller, coalesce(p_effective_from, current_date)
    ) returning v.id, v.status into v_id, v_status;
  elsif p_entry_type = 'driver' then
    if p_name is null or p_identifier is null then raise exception 'Driver entries require name and identifier (staff ID).'; end if;
    insert into public.drivers as d (
      name, staff_id, catering_company_id, airport_pass_number, pass_expiry_date,
      swap_to_staff_ic, staff_ic_number, aoc_id, operating_entity_id, created_by, effective_from
    ) values (
      p_name, upper(p_identifier), p_catering_company_id, p_airport_pass_number, p_pass_expiry_date,
      coalesce(p_swap_to_staff_ic, false), p_staff_ic_number, p_aoc_id, p_operating_entity_id, v_caller, coalesce(p_effective_from, current_date)
    ) returning d.id, d.status into v_id, v_status;
  else
    raise exception 'Unknown whitelist entry_type: %', p_entry_type;
  end if;

  perform public.phase8_write_audit('caterlink_whitelist_create', 'caterlink_whitelist_' || p_entry_type, v_id,
    jsonb_build_object('aoc_id', p_aoc_id, 'entry_type', p_entry_type));

  return query select v_id, v_status;
end;
$function$;
revoke execute on function public.create_caterlink_whitelist_entry_secure(text, uuid, uuid, text, text, text, uuid, text, date, text, text, boolean, text, date) from public, anon;
grant execute on function public.create_caterlink_whitelist_entry_secure(text, uuid, uuid, text, text, text, uuid, text, date, text, text, boolean, text, date) to authenticated, service_role;

-- Shared by approve/reject/activate/deactivate: resolves the row's aoc_id
-- and current status, and enforces the caterlink_management gate for that
-- specific AOC -- never the caller's own default AOC, so a cross-AOC id
-- can never be acted on even if the caller happens to also manage another AOC.
create or replace function public.resolve_caterlink_whitelist_row(p_entry_type text, p_id uuid, out aoc_id uuid, out status text, out created_by uuid)
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if p_entry_type = 'vendor' then
    select c.aoc_id, c.status, c.created_by into aoc_id, status, created_by from public.catering_companies c where c.id = p_id for update;
  elsif p_entry_type = 'vehicle' then
    select v.aoc_id, v.status, v.created_by into aoc_id, status, created_by from public.vehicles v where v.id = p_id for update;
  elsif p_entry_type = 'driver' then
    select d.aoc_id, d.status, d.created_by into aoc_id, status, created_by from public.drivers d where d.id = p_id for update;
  else
    raise exception 'Unknown whitelist entry_type: %', p_entry_type;
  end if;
  if aoc_id is null then
    raise exception 'Whitelist entry not found.';
  end if;
end;
$function$;
revoke execute on function public.resolve_caterlink_whitelist_row(text, uuid) from public, anon, authenticated;
grant execute on function public.resolve_caterlink_whitelist_row(text, uuid) to service_role;

create or replace function public.approve_caterlink_whitelist_entry_secure(p_entry_type text, p_id uuid)
returns table (id uuid, status text)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_caller uuid := auth.uid();
  v_row record;
  v_status text;
begin
  if v_caller is null then raise exception 'Must be signed in.'; end if;
  select * into v_row from public.resolve_caterlink_whitelist_row(p_entry_type, p_id);
  if not public.has_active_role_for_aoc('caterlink_management', v_row.aoc_id) then
    raise exception 'Only CaterLink Management may approve whitelist entries.';
  end if;
  if v_row.status <> 'pending' then
    raise exception 'Only a pending entry can be approved (current status: %).', v_row.status;
  end if;

  if p_entry_type = 'vendor' then
    update public.catering_companies as cc set approved_by = v_caller, approved_at = now(), is_active = true where cc.id = p_id returning cc.status into v_status;
  elsif p_entry_type = 'vehicle' then
    update public.vehicles as v set approved_by = v_caller, approved_at = now(), is_active = true where v.id = p_id returning v.status into v_status;
  else
    update public.drivers as d set approved_by = v_caller, approved_at = now(), is_active = true where d.id = p_id returning d.status into v_status;
  end if;

  perform public.phase8_write_audit('caterlink_whitelist_approve', 'caterlink_whitelist_' || p_entry_type, p_id,
    jsonb_build_object('aoc_id', v_row.aoc_id));
  if v_row.created_by is not null then
    perform public.notify(v_row.created_by, 'caterlink_whitelist_approved', 'caterlink_wl_approve_' || p_id::text,
      null, null, null, jsonb_build_object('entry_type', p_entry_type, 'entry_id', p_id));
  end if;

  return query select p_id, v_status;
end;
$function$;
revoke execute on function public.approve_caterlink_whitelist_entry_secure(text, uuid) from public, anon;
grant execute on function public.approve_caterlink_whitelist_entry_secure(text, uuid) to authenticated, service_role;

create or replace function public.reject_caterlink_whitelist_entry_secure(p_entry_type text, p_id uuid, p_reason text)
returns table (id uuid, status text)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_caller uuid := auth.uid();
  v_row record;
  v_status text;
begin
  if v_caller is null then raise exception 'Must be signed in.'; end if;
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'A reason is required to reject a whitelist entry.';
  end if;
  select * into v_row from public.resolve_caterlink_whitelist_row(p_entry_type, p_id);
  if not public.has_active_role_for_aoc('caterlink_management', v_row.aoc_id) then
    raise exception 'Only CaterLink Management may reject whitelist entries.';
  end if;
  if v_row.status <> 'pending' then
    raise exception 'Only a pending entry can be rejected (current status: %).', v_row.status;
  end if;

  if p_entry_type = 'vendor' then
    update public.catering_companies as cc set revoked_by = v_caller, revoked_at = now(), reason = p_reason, is_active = false where cc.id = p_id returning cc.status into v_status;
  elsif p_entry_type = 'vehicle' then
    update public.vehicles as v set revoked_by = v_caller, revoked_at = now(), reason = p_reason, is_active = false where v.id = p_id returning v.status into v_status;
  else
    update public.drivers as d set revoked_by = v_caller, revoked_at = now(), reason = p_reason, is_active = false where d.id = p_id returning d.status into v_status;
  end if;

  perform public.phase8_write_audit('caterlink_whitelist_reject', 'caterlink_whitelist_' || p_entry_type, p_id,
    jsonb_build_object('aoc_id', v_row.aoc_id, 'reason', p_reason));
  if v_row.created_by is not null then
    perform public.notify(v_row.created_by, 'caterlink_whitelist_rejected', 'caterlink_wl_reject_' || p_id::text,
      null, null, null, jsonb_build_object('entry_type', p_entry_type, 'entry_id', p_id, 'reason', p_reason));
  end if;

  return query select p_id, v_status;
end;
$function$;
revoke execute on function public.reject_caterlink_whitelist_entry_secure(text, uuid, text) from public, anon;
grant execute on function public.reject_caterlink_whitelist_entry_secure(text, uuid, text) to authenticated, service_role;

create or replace function public.deactivate_caterlink_whitelist_entry_secure(p_entry_type text, p_id uuid, p_reason text)
returns table (id uuid, status text)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_caller uuid := auth.uid();
  v_row record;
  v_status text;
begin
  if v_caller is null then raise exception 'Must be signed in.'; end if;
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'A reason is required to deactivate a whitelist entry.';
  end if;
  select * into v_row from public.resolve_caterlink_whitelist_row(p_entry_type, p_id);
  if not public.has_active_role_for_aoc('caterlink_management', v_row.aoc_id) then
    raise exception 'Only CaterLink Management may deactivate whitelist entries.';
  end if;
  if v_row.status not in ('active', 'expired', 'future') then
    raise exception 'Only an active (or expired-but-still-listed) entry can be deactivated (current status: %).', v_row.status;
  end if;

  -- Sets deactivated_by/deactivated_at (its own dedicated column pair --
  -- never revoked_by/revoked_at, which are reject()'s exclusive, terminal
  -- markers) so status recomputes to 'deactivated', unambiguous from both
  -- 'rejected' and 'revoked'. is_active=false is what actually gates the
  -- scanner/trigger path; reversible via activate().
  if p_entry_type = 'vendor' then
    update public.catering_companies as cc set deactivated_by = v_caller, deactivated_at = now(), reason = p_reason, is_active = false where cc.id = p_id returning cc.status into v_status;
  elsif p_entry_type = 'vehicle' then
    update public.vehicles as v set deactivated_by = v_caller, deactivated_at = now(), reason = p_reason, is_active = false where v.id = p_id returning v.status into v_status;
  else
    update public.drivers as d set deactivated_by = v_caller, deactivated_at = now(), reason = p_reason, is_active = false where d.id = p_id returning d.status into v_status;
  end if;

  perform public.phase8_write_audit('caterlink_whitelist_deactivate', 'caterlink_whitelist_' || p_entry_type, p_id,
    jsonb_build_object('aoc_id', v_row.aoc_id, 'reason', p_reason));

  return query select p_id, v_status;
end;
$function$;
revoke execute on function public.deactivate_caterlink_whitelist_entry_secure(text, uuid, text) from public, anon;
grant execute on function public.deactivate_caterlink_whitelist_entry_secure(text, uuid, text) to authenticated, service_role;

create or replace function public.activate_caterlink_whitelist_entry_secure(p_entry_type text, p_id uuid)
returns table (id uuid, status text)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_caller uuid := auth.uid();
  v_row record;
  v_status text;
begin
  if v_caller is null then raise exception 'Must be signed in.'; end if;
  select * into v_row from public.resolve_caterlink_whitelist_row(p_entry_type, p_id);
  if not public.has_active_role_for_aoc('caterlink_management', v_row.aoc_id) then
    raise exception 'Only CaterLink Management may reactivate whitelist entries.';
  end if;
  if v_row.status not in ('inactive', 'deactivated') then
    raise exception 'Only a deactivated entry (never pending/rejected/revoked) can be reactivated this way (current status: %).', v_row.status;
  end if;

  if p_entry_type = 'vendor' then
    update public.catering_companies as cc set deactivated_by = null, deactivated_at = null, reason = null, is_active = true where cc.id = p_id returning cc.status into v_status;
  elsif p_entry_type = 'vehicle' then
    update public.vehicles as v set deactivated_by = null, deactivated_at = null, reason = null, is_active = true where v.id = p_id returning v.status into v_status;
  else
    update public.drivers as d set deactivated_by = null, deactivated_at = null, reason = null, is_active = true where d.id = p_id returning d.status into v_status;
  end if;

  perform public.phase8_write_audit('caterlink_whitelist_activate', 'caterlink_whitelist_' || p_entry_type, p_id,
    jsonb_build_object('aoc_id', v_row.aoc_id));

  return query select p_id, v_status;
end;
$function$;
revoke execute on function public.activate_caterlink_whitelist_entry_secure(text, uuid) from public, anon;
grant execute on function public.activate_caterlink_whitelist_entry_secure(text, uuid) to authenticated, service_role;

-- Permanent, terminal revocation of a previously-approved entry (never
-- reversible through this schema -- distinct from deactivate(), which is
-- a reversible "set aside"). Sets revoked_by/revoked_at (the SAME columns
-- reject() uses), but only ever reachable from an entry that WAS approved
-- (approved_at is not null), which is exactly what makes
-- sync_caterlink_whitelist_status() compute 'revoked' here and 'rejected'
-- for reject()'s pending-only case -- the two terminal outcomes stay
-- distinguishable by approved_at, never by which RPC happened to run.
create or replace function public.revoke_caterlink_whitelist_entry_secure(p_entry_type text, p_id uuid, p_reason text)
returns table (id uuid, status text)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_caller uuid := auth.uid();
  v_row record;
  v_status text;
begin
  if v_caller is null then raise exception 'Must be signed in.'; end if;
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'A reason is required to revoke a whitelist entry.';
  end if;
  select * into v_row from public.resolve_caterlink_whitelist_row(p_entry_type, p_id);
  if not public.has_active_role_for_aoc('caterlink_management', v_row.aoc_id) then
    raise exception 'Only CaterLink Management may revoke whitelist entries.';
  end if;
  if v_row.status not in ('active', 'deactivated', 'expired', 'future') then
    raise exception 'Only a previously-approved entry can be revoked (current status: %). Legacy pre-migration rows (status=inactive, no recorded approval) are not eligible -- deactivate/reactivate them instead.', v_row.status;
  end if;

  if p_entry_type = 'vendor' then
    update public.catering_companies as cc set revoked_by = v_caller, revoked_at = now(), reason = p_reason, is_active = false where cc.id = p_id returning cc.status into v_status;
  elsif p_entry_type = 'vehicle' then
    update public.vehicles as v set revoked_by = v_caller, revoked_at = now(), reason = p_reason, is_active = false where v.id = p_id returning v.status into v_status;
  else
    update public.drivers as d set revoked_by = v_caller, revoked_at = now(), reason = p_reason, is_active = false where d.id = p_id returning d.status into v_status;
  end if;

  perform public.phase8_write_audit('caterlink_whitelist_revoke', 'caterlink_whitelist_' || p_entry_type, p_id,
    jsonb_build_object('aoc_id', v_row.aoc_id, 'reason', p_reason));

  return query select p_id, v_status;
end;
$function$;
revoke execute on function public.revoke_caterlink_whitelist_entry_secure(text, uuid, text) from public, anon;
grant execute on function public.revoke_caterlink_whitelist_entry_secure(text, uuid, text) to authenticated, service_role;

-- Permitted non-identity field update (pass expiry only -- never the
-- identifying vehicle_number/staff_id/code, which would silently change
-- what the row actually whitelists).
create or replace function public.update_caterlink_whitelist_pass_expiry_secure(
  p_entry_type text, p_id uuid, p_pass_expiry_date date
)
returns table (id uuid, pass_expiry_date date)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_row record;
begin
  if auth.uid() is null then raise exception 'Must be signed in.'; end if;
  select * into v_row from public.resolve_caterlink_whitelist_row(p_entry_type, p_id);
  if not public.has_active_role_for_aoc('caterlink_management', v_row.aoc_id) then
    raise exception 'Only CaterLink Management may update whitelist entries.';
  end if;
  if p_entry_type = 'vendor' then
    raise exception 'Vendors do not carry a pass expiry date.';
  elsif p_entry_type = 'vehicle' then
    update public.vehicles set pass_expiry_date = p_pass_expiry_date where id = p_id;
  else
    update public.drivers set pass_expiry_date = p_pass_expiry_date where id = p_id;
  end if;
  perform public.phase8_write_audit('caterlink_whitelist_update_expiry', 'caterlink_whitelist_' || p_entry_type, p_id,
    jsonb_build_object('pass_expiry_date', p_pass_expiry_date));
  return query select p_id, p_pass_expiry_date;
end;
$function$;
revoke execute on function public.update_caterlink_whitelist_pass_expiry_secure(text, uuid, date) from public, anon;
grant execute on function public.update_caterlink_whitelist_pass_expiry_secure(text, uuid, date) to authenticated, service_role;

-- -----------------------------------------------------------------------
-- CORRECTED (post-review, round 2): the ONE authoritative "is this
-- whitelist identity currently usable for a real movement/checkpoint"
-- predicate. Every scanner, transaction-creation, checkpoint and receipt
-- authorization path below calls this -- or one of the two resolver
-- functions built on it -- instead of each re-implementing its own
-- is_active-only check. Deliberately recomputes from the raw columns
-- every time (never reads the stored `status` text column), so this
-- stays correct even if a future direct UPDATE ever bypassed
-- sync_caterlink_whitelist_status()'s trigger.
--
-- An entry is usable only when ALL of:
--   - is_active = true (the column every legacy trigger/app check already
--     reads -- kept as the single physical gate, never duplicated)
--   - not pending (created_by set with no approved_at yet)
--   - not deactivated (deactivated_at is null)
--   - not revoked/rejected (revoked_at is null)
--   - effective_from has arrived (or is null)
--   - pass_expiry_date has not passed (or is null) -- an EXPIRED entry is
--     NEVER usable through this predicate, closing the previous gap where
--     is_active=true alone let an expired pass authorize a movement.
create or replace function public.caterlink_identity_is_usable(
  p_is_active boolean,
  p_revoked_at timestamptz,
  p_deactivated_at timestamptz,
  p_created_by uuid,
  p_approved_at timestamptz,
  p_effective_from date,
  p_pass_expiry_date date
)
returns boolean
language sql
stable
as $function$
  select coalesce(p_is_active, false)
    and p_revoked_at is null
    and p_deactivated_at is null
    and not (p_created_by is not null and p_approved_at is null)
    and (p_effective_from is null or p_effective_from <= current_date)
    and (p_pass_expiry_date is null or p_pass_expiry_date >= current_date);
$function$;

-- Resolvers: the one place every caller (app code via RPC, triggers via
-- direct SQL call) looks up a currently-usable vehicle/driver by its
-- natural identifier. p_aoc_id defaults to 'MY' for every pre-Phase-9,
-- single-AOC caller (scan.ts, transactions.ts) that has never had to pass
-- one; CaterLink's own RPC below always passes its real target AOC
-- explicitly, closing the cross-AOC authorization gap a bare
-- vehicle_number/staff_id lookup would otherwise have.
create or replace function public.resolve_usable_caterlink_vehicle(p_vehicle_number text, p_aoc_id uuid default null)
returns uuid
language sql
stable
security definer
set search_path to 'public'
as $function$
  select v.id from public.vehicles v
  where upper(v.vehicle_number) = upper(p_vehicle_number)
    and v.aoc_id = coalesce(p_aoc_id, (select id from public.aocs where code = 'MY'))
    and public.caterlink_identity_is_usable(v.is_active, v.revoked_at, v.deactivated_at, v.created_by, v.approved_at, v.effective_from, v.pass_expiry_date)
  limit 1;
$function$;
revoke execute on function public.resolve_usable_caterlink_vehicle(text, uuid) from public, anon;
grant execute on function public.resolve_usable_caterlink_vehicle(text, uuid) to authenticated, service_role;

create or replace function public.resolve_usable_caterlink_driver(p_staff_id text, p_aoc_id uuid default null)
returns uuid
language sql
stable
security definer
set search_path to 'public'
as $function$
  select d.id from public.drivers d
  where upper(d.staff_id) = upper(p_staff_id)
    and d.aoc_id = coalesce(p_aoc_id, (select id from public.aocs where code = 'MY'))
    and public.caterlink_identity_is_usable(d.is_active, d.revoked_at, d.deactivated_at, d.created_by, d.approved_at, d.effective_from, d.pass_expiry_date)
  limit 1;
$function$;
revoke execute on function public.resolve_usable_caterlink_driver(text, uuid) from public, anon;
grant execute on function public.resolve_usable_caterlink_driver(text, uuid) to authenticated, service_role;

-- CORRECTED (post-review, round 2): enforce_whitelist_on_create()
-- previously only null-checked vehicle_id/driver_id_ref -- it trusted
-- whatever the app layer resolved earlier and never independently
-- re-verified usability at the actual insert. This version re-verifies
-- both referenced rows against the same authoritative predicate,
-- defense-in-depth against any future caller that supplies a stale or
-- otherwise-unusable id. Still never accepts a null reference.
create or replace function public.enforce_whitelist_on_create()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_vehicle_ok boolean := false;
  v_driver_ok boolean := false;
begin
  if new.vehicle_id is null or new.driver_id_ref is null then
    raise exception 'ICMS: WHITELIST_VIOLATION - vehicle and driver must both be on the active whitelist to create a transaction / Kenderaan dan pemandu mesti berada dalam senarai putih aktif untuk mencipta transaksi';
  end if;

  select public.caterlink_identity_is_usable(v.is_active, v.revoked_at, v.deactivated_at, v.created_by, v.approved_at, v.effective_from, v.pass_expiry_date)
    into v_vehicle_ok
    from public.vehicles v where v.id = new.vehicle_id;
  select public.caterlink_identity_is_usable(d.is_active, d.revoked_at, d.deactivated_at, d.created_by, d.approved_at, d.effective_from, d.pass_expiry_date)
    into v_driver_ok
    from public.drivers d where d.id = new.driver_id_ref;

  if not coalesce(v_vehicle_ok, false) or not coalesce(v_driver_ok, false) then
    raise exception 'ICMS: WHITELIST_VIOLATION - vehicle and driver must both be an active, approved, currently-effective, non-expired whitelist entry / Kenderaan dan pemandu mesti berada dalam senarai putih yang aktif, diluluskan, berkesan dan tidak tamat tempoh';
  end if;

  return new;
end;
$function$;

-- CORRECTED (post-review, round 2): enforce_secondary_whitelist() (Part
-- B/C defense-in-depth) previously checked raw is_active only, which let
-- an expired pass pass a secondary check as long as it was still
-- is_active. Now routed through the same authoritative resolvers used
-- everywhere else.
create or replace function public.enforce_secondary_whitelist()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if new.result = 'PASS' then
    if public.resolve_usable_caterlink_vehicle(coalesce(new.observed_vehicle_number, '')) is null
       or public.resolve_usable_caterlink_driver(coalesce(new.observed_driver_id, '')) is null
    then
      raise exception 'ICMS: WHITELIST_VIOLATION - observed vehicle/driver is not an active, approved, currently-effective, non-expired whitelist entry; escalate instead of passing / Kenderaan/pemandu yang diperhatikan tiada dalam senarai putih yang aktif, diluluskan, berkesan dan tidak tamat tempoh; eskalasi, jangan lulus';
    end if;
  end if;
  return new;
end;
$function$;

-- Bootstrap-only: this test/CI harness never applies icms/ migrations, so
-- trg_enforce_whitelist_on_create does not exist there yet either (unlike
-- production, where icms/20260810000001_strict_whitelist.sql already
-- installed it). Registering it here -- guarded by the same "did icms/
-- already run" signal used elsewhere in this file -- is what lets
-- create_caterlink_transaction_secure()'s tests exercise the REAL hard-
-- block trigger, not a simulation of it. A no-op against production,
-- where the trigger already exists and this migration only replaces its
-- function body above.
do $$
begin
  if not exists (
    select 1 from pg_trigger where tgname = 'trg_catering_companies_no_delete'
  ) then
    drop trigger if exists trg_enforce_whitelist_on_create on public.transactions;
    create trigger trg_enforce_whitelist_on_create
      before insert on public.transactions
      for each row execute function public.enforce_whitelist_on_create();
  end if;
end $$;

revoke execute on function public.enforce_whitelist_on_create() from public, anon, authenticated;
revoke execute on function public.enforce_secondary_whitelist() from public, anon, authenticated;

-- =======================================================================
-- PART D: CaterLink Incident System
-- =======================================================================
create table if not exists public.caterlink_incidents (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references public.transactions(id) on delete cascade,
  aoc_id uuid not null references public.aocs(id),
  operating_entity_id uuid references public.operating_entities(id),
  station_id uuid references public.org_stations(id),
  incident_type text not null check (incident_type in (
    'BROKEN_SEAL', 'SEAL_MISMATCH', 'UNAUTHORIZED_DRIVER', 'UNAUTHORIZED_VEHICLE',
    'EXPIRED_PASS', 'WRONG_SEAL_COLOR', 'TIMEOUT', 'OTHER', 'WHITELIST_VIOLATION', 'SEGMENT_TIMEOUT'
  )),
  severity text not null default 'medium' check (severity in ('low', 'medium', 'high', 'critical')),
  description text not null,
  reported_by uuid not null references public.profiles(id),
  status text not null default 'OPEN' check (status in ('OPEN', 'UNDER_REVIEW', 'RESOLVED', 'CLOSED')),
  assigned_to uuid references public.profiles(id),
  assigned_at timestamptz,
  resolved_by uuid references public.profiles(id),
  resolution_notes text,
  resolved_at timestamptz,
  reopen_count integer not null default 0,
  reopened_by uuid references public.profiles(id),
  reopened_at timestamptz,
  reopen_reason text,
  photo_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.caterlink_incident_notes (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references public.caterlink_incidents(id) on delete cascade,
  author_id uuid not null references public.profiles(id),
  note text not null,
  action_taken text,
  created_at timestamptz not null default now()
);

alter table public.caterlink_incidents enable row level security;
revoke all on public.caterlink_incidents from public, anon, authenticated;
grant all on public.caterlink_incidents to service_role;
grant select on public.caterlink_incidents to authenticated;

alter table public.caterlink_incident_notes enable row level security;
revoke all on public.caterlink_incident_notes from public, anon, authenticated;
grant all on public.caterlink_incident_notes to service_role;
grant select on public.caterlink_incident_notes to authenticated;

create policy "caterlink_incidents_read"
  on public.caterlink_incidents for select
  to authenticated
  using (
    -- CaterLink Management, Operation Manager, Main Enforcement in same AOC
    public.has_active_role_for_aoc('caterlink_management', aoc_id)
    or public.has_active_role_for_aoc('operation_manager', aoc_id)
    or public.has_active_role_for_aoc('main_enforcement', aoc_id)
    or reported_by = auth.uid()
    or assigned_to = auth.uid()
  );

create policy "caterlink_incident_notes_read"
  on public.caterlink_incident_notes for select
  to authenticated
  using (
    exists (
      select 1 from public.caterlink_incidents ci
      where ci.id = caterlink_incident_notes.incident_id
        and (
          public.has_active_role_for_aoc('caterlink_management', ci.aoc_id)
          or public.has_active_role_for_aoc('operation_manager', ci.aoc_id)
          or public.has_active_role_for_aoc('main_enforcement', ci.aoc_id)
          or ci.reported_by = auth.uid()
          or ci.assigned_to = auth.uid()
        )
    )
  );

-- =======================================================================
-- PART E: CaterLink Archive System
-- =======================================================================
create table if not exists public.caterlink_archives (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null unique references public.transactions(id),
  aoc_id uuid not null references public.aocs(id),
  operating_entity_id uuid references public.operating_entities(id),
  transaction_number text not null,
  archived_by uuid not null references public.profiles(id),
  archived_at timestamptz not null default now(),
  archive_reason text,
  transaction_snapshot jsonb not null,
  status text not null default 'archived' check (status in ('archived', 'restored')),
  restored_by uuid references public.profiles(id),
  restored_at timestamptz,
  restore_reason text
);

alter table public.caterlink_archives enable row level security;
revoke all on public.caterlink_archives from public, anon, authenticated;
grant all on public.caterlink_archives to service_role;
grant select on public.caterlink_archives to authenticated;

create policy "caterlink_archives_read"
  on public.caterlink_archives for select
  to authenticated
  using (
    public.has_active_role_for_aoc('caterlink_management', aoc_id)
    or public.has_active_role_for_aoc('operation_manager', aoc_id)
  );

-- =======================================================================
-- PART F: Capability Checking & Authorization Helper Functions
-- =======================================================================

create or replace function public.check_station_caterlink_capability(
  p_aoc_id uuid,
  p_station_code text,
  p_capability text
)
returns boolean
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_station_id uuid;
  v_cap record;
begin
  if p_aoc_id is null or p_station_code is null or p_capability is null then
    return false;
  end if;

  select id into v_station_id from public.org_stations where code = p_station_code and is_active = true;
  if v_station_id is null and p_station_code = 'KUL' then
    select id into v_station_id from public.org_stations where code in ('KUL - MAA', 'KUL - AAX') and is_active = true limit 1;
  end if;
  if v_station_id is null then
    return false;
  end if;

  select * into v_cap
  from public.caterlink_station_capabilities
  where aoc_id = p_aoc_id and station_id = v_station_id and is_active = true;

  if v_cap is null then
    return false;
  end if;

  case p_capability
    when 'view' then return v_cap.can_view;
    when 'create' then return v_cap.can_create;
    when 'scan' then return v_cap.can_scan;
    when 'confirm_station_receipt' then return v_cap.can_confirm_station_receipt;
    when 'confirm_hub_receipt' then return v_cap.can_confirm_hub_receipt;
    when 'report_incident' then return v_cap.can_report_incident;
    when 'view_history' then return v_cap.can_view_history;
    when 'download_pdf' then return v_cap.can_download_pdf;
    else return false;
  end case;
end;
$function$;

revoke execute on function public.check_station_caterlink_capability(uuid, text, text) from public, anon;
grant execute on function public.check_station_caterlink_capability(uuid, text, text) to authenticated, service_role;

create or replace function public.can_user_scan_caterlink(
  p_profile_id uuid,
  p_aoc_id uuid,
  p_station_code text
)
returns boolean
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_user_id uuid := coalesce(p_profile_id, auth.uid());
  v_aoc_id uuid := p_aoc_id;
  v_is_profiling boolean;
  v_station_can_scan boolean;
  v_has_active_assignment boolean;
begin
  if v_user_id is null or p_station_code is null then
    return false;
  end if;

  if v_aoc_id is null then
    select id into v_aoc_id from public.aocs where code = 'MY';
  end if;

  -- 1. PROFILING EXCLUSION: profiling_so and profiling_aso are unconditionally DENIED scanning
  select exists (
    select 1
    from public.user_role_assignments ura
    join public.role_definitions rd on rd.id = ura.role_definition_id
    where ura.profile_id = v_user_id
      and rd.code in ('profiling_so', 'profiling_aso')
      and ura.revoked_at is null
      and ura.starts_at <= now()
      and (ura.ends_at is null or ura.ends_at > now())
  ) into v_is_profiling;

  if v_is_profiling then
    return false;
  end if;

  -- 2. Station capability check: station must have 'scan' capability enabled in target AOC
  v_station_can_scan := public.check_station_caterlink_capability(v_aoc_id, p_station_code, 'scan');
  if not v_station_can_scan then
    return false;
  end if;

  -- 3. Phase 3 active assignment check: user must have an active assignment in the same AOC
  select exists (
    select 1
    from public.user_role_assignments ura
    join public.role_definitions rd on rd.id = ura.role_definition_id
    where ura.profile_id = v_user_id
      and ura.aoc_id = v_aoc_id
      and rd.code in (
        'operation_manager', 'main_enforcement', 'hub_se', 'dse', 'sso', 'so', 'aso',
        'post2_avsec', 'post6_avsec', 'hub_avsec', 'redq_avsec'
      )
      and ura.revoked_at is null
      and ura.starts_at <= now()
      and (ura.ends_at is null or ura.ends_at > now())
  ) into v_has_active_assignment;

  return v_has_active_assignment;
end;
$function$;

revoke execute on function public.can_user_scan_caterlink(uuid, uuid, text) from public, anon;
grant execute on function public.can_user_scan_caterlink(uuid, uuid, text) to authenticated, service_role;

create or replace function public.can_user_scan_caterlink(
  p_aoc_id uuid,
  p_station_code text
)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select public.can_user_scan_caterlink(auth.uid(), p_aoc_id, p_station_code);
$$;

revoke execute on function public.can_user_scan_caterlink(uuid, text) from public, anon;
grant execute on function public.can_user_scan_caterlink(uuid, text) to authenticated, service_role;

create or replace function public.can_user_scan_caterlink(
  p_station_code text,
  p_aoc_id uuid default null
)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select public.can_user_scan_caterlink(auth.uid(), p_aoc_id, p_station_code);
$$;

revoke execute on function public.can_user_scan_caterlink(text, uuid) from public, anon;
grant execute on function public.can_user_scan_caterlink(text, uuid) to authenticated, service_role;

-- =======================================================================
-- PART G: Core RPCs — Transaction Lifecycle & Checkpoint Execution
-- =======================================================================

create or replace function public.create_caterlink_transaction_secure(
  p_aoc_id uuid,
  p_origin_station text,
  p_direction text,
  p_route text,
  p_vehicle_number text,
  p_driver_name text,
  p_driver_id text,
  p_seal_number text,
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
  v_station_id uuid;
  v_hub_dest_id uuid;
  v_can_create boolean;
  v_tx_id uuid;
  v_tx_number text;
  v_seal_id uuid;
  v_year integer := extract(year from now())::integer;
  v_seq integer;
  v_vehicle_id uuid;
  v_driver_id uuid;
begin
  if v_caller is null then
    raise exception 'Must be signed in.';
  end if;

  if p_aoc_id is null or p_origin_station is null or p_direction is null or p_route is null then
    raise exception 'Missing required fields.';
  end if;

  select id into v_station_id from public.org_stations where code = p_origin_station and is_active = true;
  if v_station_id is null then
    raise exception 'Unknown origin station: %', p_origin_station;
  end if;

  -- Station capability check: station must be allowed to create movements
  v_can_create := public.check_station_caterlink_capability(p_aoc_id, p_origin_station, 'create');
  if not v_can_create then
    raise exception 'Station % is not configured to initiate CaterLink transactions.', p_origin_station;
  end if;

  -- CORRECTED (post-review, round 2): resolve the vehicle/driver whitelist
  -- rows to their canonical ids INSIDE this RPC, against the target AOC,
  -- using the same authoritative predicate every other authorization path
  -- uses. enforce_whitelist_on_create() independently re-verifies these
  -- same ids at the actual INSERT below (defense-in-depth, not a
  -- duplicate decision) -- this resolution is what makes that trigger
  -- pass for a genuinely valid movement instead of rejecting every
  -- CaterLink transaction for a null vehicle_id/driver_id_ref. The error
  -- here deliberately does not reveal WHY a given plate/staff id failed
  -- (unlisted vs expired vs revoked vs not-yet-effective are all the same
  -- caller-facing message) -- that detail is for CaterLink Management's
  -- own whitelist admin view, not the checkpoint officer's screen.
  v_vehicle_id := public.resolve_usable_caterlink_vehicle(p_vehicle_number, p_aoc_id);
  v_driver_id := public.resolve_usable_caterlink_driver(p_driver_id, p_aoc_id);
  if v_vehicle_id is null or v_driver_id is null then
    raise exception 'Vehicle or driver is not an active, approved, currently-effective whitelist entry for this AOC.';
  end if;

  -- Caller role verification: Must hold active assignment in target AOC
  if not exists (
    select 1 from public.user_role_assignments ura
    where ura.profile_id = v_caller
      and ura.aoc_id = p_aoc_id
      and ura.revoked_at is null
      and ura.starts_at <= now()
      and (ura.ends_at is null or ura.ends_at > now())
  ) then
    raise exception 'No active role assignment in target AOC.';
  end if;

  if p_route = 'HUB' then
    if p_hub_destination is null then
      raise exception 'Hub destination is required for HUB route.';
    end if;
    select id into v_hub_dest_id from public.org_stations where code = p_hub_destination;
  end if;

  -- CORRECTED (post-review, round 2): max(...)+1 over existing rows is a
  -- genuine read-then-write race -- two concurrent callers can compute the
  -- SAME v_seq before either commits, then both fail (or worse, under a
  -- weaker isolation level, both succeed) on transaction_number's unique
  -- constraint. Proven empirically via a real two-connection concurrency
  -- test before this fix. A real Postgres SEQUENCE's nextval() is atomic
  -- across concurrent callers by construction -- the same pattern the
  -- legacy icms next_transaction_number() already uses for its own
  -- 'CSCS-YYYY-NNNNNN' numbers, applied here for 'CL-YYYY-NNNNNN'.
  -- "IF NOT EXISTS" alone is not safe here: two sessions can both pass the
  -- existence check before either commits the CREATE, so the second
  -- CREATE still raises duplicate_table against the catalog -- the exact
  -- same read-then-write race this whole fix exists to avoid, just moved
  -- one level down. Catching that specific exception and retrying the
  -- nextval() is what actually makes this safe under real concurrency.
  if to_regclass('public.cl_txn_seq_' || v_year) is null then
    begin
      execute format('create sequence public.cl_txn_seq_%s start with 1', v_year);
    exception when duplicate_table or unique_violation then
      -- a concurrent caller created it first -- under real concurrent DDL,
      -- Postgres can surface this as either condition depending on timing;
      -- both mean the same thing here, so both are swallowed the same way.
      null;
    end;
  end if;
  execute format('select nextval(''public.cl_txn_seq_%s'')', v_year) into v_seq;
  v_tx_number := 'CL-' || v_year || '-' || lpad(v_seq::text, 6, '0');

  insert into public.transactions (
    transaction_number, aoc_id, direction, route, vehicle_number, driver_name, driver_id,
    vehicle_id, driver_id_ref,
    seal_number, hub_destination, station, origin_station_id, destination_station_id,
    flight_number, aircraft_registration, trolley_count, cargo_types, status, created_by
  ) values (
    v_tx_number, p_aoc_id, p_direction, p_route, p_vehicle_number, p_driver_name, p_driver_id,
    v_vehicle_id, v_driver_id,
    p_seal_number, p_hub_destination, p_origin_station, v_station_id, v_hub_dest_id,
    p_flight_number, p_aircraft_reg, p_trolley_count, p_cargo_types, 'CREATED', v_caller
  )
  returning id into v_tx_id;

  -- Insert initial seal record
  insert into public.seals (transaction_id, seal_number, seal_type, seal_color)
  values (v_tx_id, p_seal_number, 'TRUCK_SEAL', case when p_direction = 'INBOUND' then 'GREEN' else 'BLUE' end)
  returning id into v_seal_id;

  -- Record audit
  perform public.phase8_write_audit('caterlink_transaction_create', 'transaction', v_tx_id,
    jsonb_build_object('transaction_number', v_tx_number, 'station', p_origin_station, 'route', p_route));

  return query select v_tx_id, v_tx_number;
end;
$function$;

revoke execute on function public.create_caterlink_transaction_secure from public, anon;
grant execute on function public.create_caterlink_transaction_secure to authenticated, service_role;

-- Destination Receipt Confirmation RPC
create or replace function public.confirm_caterlink_destination_receipt_secure(
  p_transaction_id uuid,
  p_station_code text,
  p_signature_url text,
  p_remarks text default null
)
returns table (transaction_id uuid, status text)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_caller uuid := auth.uid();
  v_tx record;
  v_station_id uuid;
  v_hub_id uuid;
  v_can_confirm boolean;
  v_officer_name text;
  v_officer_staff_no text;
begin
  if v_caller is null then
    raise exception 'Must be signed in.';
  end if;

  select * into v_tx from public.transactions where id = p_transaction_id for update;
  if v_tx is null then
    raise exception 'Transaction not found.';
  end if;

  if v_tx.status = 'COMPLETED' then
    raise exception 'Transaction is already completed.';
  end if;

  if v_tx.status = 'ESCALATED' then
    raise exception 'Cannot confirm receipt on an escalated transaction with open incident.';
  end if;

  -- Upstream checkpoint check
  if v_tx.route = 'HUB' and v_tx.status <> 'INFLIGHT_POST_APPROVED' then
    raise exception 'HUB route movement requires In-flight Post approval before destination receipt.';
  end if;

  -- Resolve destination station
  select id, hub_id into v_station_id, v_hub_id from public.org_stations where code = p_station_code and is_active = true;
  if v_station_id is null then
    raise exception 'Unknown station %', p_station_code;
  end if;

  -- Cross-AOC denial
  if not exists (
    select 1 from public.user_role_assignments ura
    where ura.profile_id = v_caller
      and ura.aoc_id = v_tx.aoc_id
      and ura.revoked_at is null
      and ura.starts_at <= now()
      and (ura.ends_at is null or ura.ends_at > now())
  ) then
    raise exception 'Cross-AOC confirmation denied: caller does not belong to transaction AOC.';
  end if;

  -- Station capability check: Must have receipt confirmation capability
  v_can_confirm := (
    public.check_station_caterlink_capability(v_tx.aoc_id, p_station_code, 'confirm_hub_receipt')
    or public.check_station_caterlink_capability(v_tx.aoc_id, p_station_code, 'confirm_station_receipt')
  );

  if not v_can_confirm then
    raise exception 'Station % is not authorized to confirm CaterLink destination receipts.', p_station_code;
  end if;

  -- Destination matching: station must match hub_destination
  if v_tx.route = 'HUB' and v_tx.hub_destination is not null and v_tx.hub_destination <> p_station_code then
    raise exception 'Station mismatch: transaction destination is %, not %.', v_tx.hub_destination, p_station_code;
  end if;

  -- Sender cannot confirm own cross-station movement
  if v_tx.created_by = v_caller and v_tx.origin_station_id <> v_station_id then
    raise exception 'Sender cannot confirm destination receipt for their own cross-station movement.';
  end if;

  select name, staff_no into v_officer_name, v_officer_staff_no from public.profiles where id = v_caller;

  -- Insert Part Hub receipt confirmation
  insert into public.part_hub (
    transaction_id, confirmed_destination, hub_avsec_name, hub_avsec_staff_id, remarks, signature_url, completed_by
  ) values (
    p_transaction_id, p_station_code, coalesce(v_officer_name, 'AVSEC'), coalesce(v_officer_staff_no, 'OFFICER'),
    p_remarks, p_signature_url, v_caller
  )
  on conflict on constraint part_hub_transaction_id_key do update set
    confirmed_destination = excluded.confirmed_destination,
    hub_avsec_name = excluded.hub_avsec_name,
    completed_at = now();

  -- Update transaction to COMPLETED
  update public.transactions
  set status = 'COMPLETED',
      completed_at = now(),
      destination_station_id = v_station_id,
      updated_at = now()
  where id = p_transaction_id;

  -- Record audit log
  perform public.phase8_write_audit('caterlink_receipt_confirm', 'transaction', p_transaction_id,
    jsonb_build_object('destination_station', p_station_code, 'transaction_number', v_tx.transaction_number));

  -- Issue notification to creator
  perform public.notify(
    v_tx.created_by,
    'caterlink_movement_received',
    'caterlink_rcpt_' || p_transaction_id::text,
    null, null, null,
    jsonb_build_object('transaction_id', p_transaction_id, 'station', p_station_code)
  );

  return query select p_transaction_id, 'COMPLETED'::text;
end;
$function$;

revoke execute on function public.confirm_caterlink_destination_receipt_secure from public, anon;
grant execute on function public.confirm_caterlink_destination_receipt_secure to authenticated, service_role;

-- Incident Lifecycle RPCs
create or replace function public.raise_caterlink_incident_secure(
  p_transaction_id uuid,
  p_incident_type text,
  p_description text,
  p_severity text default 'medium',
  p_photo_url text default null
)
returns table (incident_id uuid, transaction_status text)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_caller uuid := auth.uid();
  v_tx record;
  v_inc_id uuid;
begin
  if v_caller is null then raise exception 'Must be signed in.'; end if;
  select * into v_tx from public.transactions where id = p_transaction_id for update;
  if v_tx is null then raise exception 'Transaction not found.'; end if;

  -- Caller must be in same AOC
  if not exists (
    select 1 from public.user_role_assignments ura
    where ura.profile_id = v_caller
      and ura.aoc_id = v_tx.aoc_id
      and ura.revoked_at is null
      and ura.starts_at <= now()
      and (ura.ends_at is null or ura.ends_at > now())
  ) then
    raise exception 'Cross-AOC denial: caller cannot report incident on foreign AOC transaction.';
  end if;

  insert into public.caterlink_incidents (
    transaction_id, aoc_id, operating_entity_id, station_id, incident_type,
    severity, description, reported_by, status, photo_url
  ) values (
    p_transaction_id, v_tx.aoc_id, v_tx.operating_entity_id, v_tx.origin_station_id,
    p_incident_type, p_severity, p_description, v_caller, 'OPEN', p_photo_url
  ) returning id into v_inc_id;

  -- Escalate transaction state
  update public.transactions
  set status = 'ESCALATED', updated_at = now()
  where id = p_transaction_id;

  perform public.phase8_write_audit('caterlink_incident_raise', 'caterlink_incident', v_inc_id,
    jsonb_build_object('transaction_id', p_transaction_id, 'type', p_incident_type, 'severity', p_severity));

  return query select v_inc_id, 'ESCALATED'::text;
end;
$function$;

revoke execute on function public.raise_caterlink_incident_secure from public, anon;
grant execute on function public.raise_caterlink_incident_secure to authenticated, service_role;

create or replace function public.resolve_caterlink_incident_secure(
  p_incident_id uuid,
  p_resolution_notes text,
  p_resume_status text default 'CREATED'
)
returns table (incident_id uuid, new_status text)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_caller uuid := auth.uid();
  v_inc record;
begin
  if v_caller is null then raise exception 'Must be signed in.'; end if;
  select * into v_inc from public.caterlink_incidents where id = p_incident_id for update;
  if v_inc is null then raise exception 'Incident not found.'; end if;

  -- Only CaterLink Management or Operation Manager in same AOC can resolve incidents
  if not (
    public.has_active_role_for_aoc('caterlink_management', v_inc.aoc_id)
    or public.has_active_role_for_aoc('operation_manager', v_inc.aoc_id)
  ) then
    raise exception 'Only CaterLink Management or Operation Manager may resolve incidents.';
  end if;

  if p_resolution_notes is null or trim(p_resolution_notes) = '' then
    raise exception 'Resolution notes are required.';
  end if;

  update public.caterlink_incidents
  set status = 'RESOLVED',
      resolved_by = v_caller,
      resolution_notes = trim(p_resolution_notes),
      resolved_at = now(),
      updated_at = now()
  where id = p_incident_id;

  -- Resume transaction
  update public.transactions
  set status = p_resume_status, updated_at = now()
  where id = v_inc.transaction_id;

  perform public.phase8_write_audit('caterlink_incident_resolve', 'caterlink_incident', p_incident_id,
    jsonb_build_object('resumed_status', p_resume_status, 'notes', p_resolution_notes));

  return query select p_incident_id, 'RESOLVED'::text;
end;
$function$;

revoke execute on function public.resolve_caterlink_incident_secure from public, anon;
grant execute on function public.resolve_caterlink_incident_secure to authenticated, service_role;

create or replace function public.reopen_caterlink_incident_secure(
  p_incident_id uuid,
  p_reopen_reason text
)
returns table (incident_id uuid, status text)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_caller uuid := auth.uid();
  v_inc record;
begin
  if v_caller is null then raise exception 'Must be signed in.'; end if;
  select * into v_inc from public.caterlink_incidents where id = p_incident_id for update;
  if v_inc is null then raise exception 'Incident not found.'; end if;

  if v_inc.status not in ('RESOLVED', 'CLOSED') then
    raise exception 'Only resolved or closed incidents may be reopened (current: %).', v_inc.status;
  end if;

  if not (
    public.has_active_role_for_aoc('caterlink_management', v_inc.aoc_id)
    or public.has_active_role_for_aoc('operation_manager', v_inc.aoc_id)
  ) then
    raise exception 'Only CaterLink Management or Operation Manager may reopen incidents.';
  end if;

  if p_reopen_reason is null or trim(p_reopen_reason) = '' then
    raise exception 'Reopen reason is required.';
  end if;

  update public.caterlink_incidents
  set status = 'OPEN',
      reopen_count = v_inc.reopen_count + 1,
      reopened_by = v_caller,
      reopened_at = now(),
      reopen_reason = trim(p_reopen_reason),
      updated_at = now()
  where id = p_incident_id;

  update public.transactions
  set status = 'ESCALATED', updated_at = now()
  where id = v_inc.transaction_id;

  perform public.phase8_write_audit('caterlink_incident_reopen', 'caterlink_incident', p_incident_id,
    jsonb_build_object('reason', p_reopen_reason, 'reopen_count', v_inc.reopen_count + 1));

  return query select p_incident_id, 'OPEN'::text;
end;
$function$;

revoke execute on function public.reopen_caterlink_incident_secure from public, anon;
grant execute on function public.reopen_caterlink_incident_secure to authenticated, service_role;

-- Archive RPC
create or replace function public.archive_caterlink_transaction_secure(
  p_transaction_id uuid,
  p_reason text default null
)
returns table (archive_id uuid, transaction_number text)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_caller uuid := auth.uid();
  v_tx record;
  v_arch_id uuid;
begin
  if v_caller is null then raise exception 'Must be signed in.'; end if;
  select * into v_tx from public.transactions where id = p_transaction_id for update;
  if v_tx is null then raise exception 'Transaction not found.'; end if;

  if not (
    public.has_active_role_for_aoc('caterlink_management', v_tx.aoc_id)
    or public.has_active_role_for_aoc('operation_manager', v_tx.aoc_id)
  ) then
    raise exception 'Only CaterLink Management or Operation Manager may archive transactions.';
  end if;

  if v_tx.status <> 'COMPLETED' then
    raise exception 'Only COMPLETED transactions can be archived.';
  end if;

  insert into public.caterlink_archives (
    transaction_id, aoc_id, operating_entity_id, transaction_number,
    archived_by, archive_reason, transaction_snapshot
  ) values (
    p_transaction_id, v_tx.aoc_id, v_tx.operating_entity_id, v_tx.transaction_number,
    v_caller, p_reason, to_jsonb(v_tx)
  ) returning id into v_arch_id;

  update public.transactions
  set archived = true, archived_at = now(), archived_by = v_caller, updated_at = now()
  where id = p_transaction_id;

  perform public.phase8_write_audit('caterlink_transaction_archive', 'caterlink_archive', v_arch_id,
    jsonb_build_object('transaction_id', p_transaction_id, 'transaction_number', v_tx.transaction_number));

  return query select v_arch_id, v_tx.transaction_number;
end;
$function$;

revoke execute on function public.archive_caterlink_transaction_secure from public, anon;
grant execute on function public.archive_caterlink_transaction_secure to authenticated, service_role;

-- Management Export RPC (Scoped to caller's AOC)
create or replace function public.export_caterlink_data_secure(
  p_target_aoc_id uuid default null
)
returns table (
  transaction_id uuid, transaction_number text, aoc_code text, origin_station text,
  destination text, route text, status text, driver_name text, vehicle_number text,
  created_at timestamptz, completed_at timestamptz
)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_caller uuid := auth.uid();
  v_aoc_id uuid;
begin
  if v_caller is null then raise exception 'Must be signed in.'; end if;
  if p_target_aoc_id is null then
    select id into v_aoc_id from public.aocs where code = 'MY';
  else
    v_aoc_id := p_target_aoc_id;
  end if;

  if not (
    public.has_active_role_for_aoc('caterlink_management', v_aoc_id)
    or public.has_active_role_for_aoc('operation_manager', v_aoc_id)
  ) then
    raise exception 'Only CaterLink Management or Operation Manager may export CaterLink datasets.';
  end if;

  perform public.phase8_write_audit('caterlink_export_generated', 'caterlink_export', null,
    jsonb_build_object('aoc_id', v_aoc_id));

  return query
  select t.id, t.transaction_number, a.code, t.station, coalesce(t.hub_destination, 'AIRCRAFT'),
         t.route, t.status, t.driver_name, t.vehicle_number, t.created_at, t.completed_at
  from public.transactions t
  join public.aocs a on a.id = t.aoc_id
  where t.aoc_id = v_aoc_id
  order by t.created_at desc
  limit 1000;
end;
$function$;

revoke execute on function public.export_caterlink_data_secure from public, anon;
grant execute on function public.export_caterlink_data_secure to authenticated, service_role;

-- Final Transaction PDF Authorization RPC
create or replace function public.authorize_caterlink_pdf_secure(
  p_transaction_id uuid
)
returns table (authorized boolean, transaction_number text, pdf_storage_path text)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_caller uuid := auth.uid();
  v_tx record;
  v_is_auth boolean := false;
begin
  if v_caller is null then raise exception 'Must be signed in.'; end if;
  select * into v_tx from public.transactions where id = p_transaction_id;
  if v_tx is null then raise exception 'Transaction not found.'; end if;

  if v_tx.status <> 'COMPLETED' then
    raise exception 'Final transaction PDF is only available for COMPLETED transactions (current: %).', v_tx.status;
  end if;

  -- CaterLink Management in same AOC
  if public.has_active_role_for_aoc('caterlink_management', v_tx.aoc_id) then
    v_is_auth := true;
  -- Submitter
  elsif v_tx.created_by = v_caller then
    v_is_auth := true;
  -- Destination AVSEC officer who signed receipt
  elsif exists (
    select 1 from public.part_hub ph
    where ph.transaction_id = p_transaction_id and ph.completed_by = v_caller
  ) then
    v_is_auth := true;
  -- Operation Manager in same AOC
  elsif public.has_active_role_for_aoc('operation_manager', v_tx.aoc_id) then
    v_is_auth := true;
  end if;

  if not v_is_auth then
    raise exception 'Unauthorized to access final PDF for transaction %.', v_tx.transaction_number;
  end if;

  perform public.phase8_write_audit('caterlink_pdf_access', 'transaction_pdf', p_transaction_id,
    jsonb_build_object('transaction_number', v_tx.transaction_number));

  return query select true, v_tx.transaction_number, coalesce(v_tx.completed_form_url, 'caterlink-pdfs/' || v_tx.transaction_number || '.pdf');
end;
$function$;

revoke execute on function public.authorize_caterlink_pdf_secure from public, anon;
grant execute on function public.authorize_caterlink_pdf_secure to authenticated, service_role;

-- =======================================================================
-- PART H: Seed Initial Station Capabilities (Malaysia AOC)
-- =======================================================================
do $$
declare
  v_aoc_id uuid;
  v_kul_station_id uuid;
  v_pen_station_id uuid;
  v_jhb_station_id uuid;
  v_aor_station_id uuid;
  v_iph_station_id uuid;
  v_lgk_station_id uuid;
  v_kch_station_id uuid;
  v_bki_station_id uuid;
begin
  select id into v_aoc_id from public.aocs where code = 'MY';
  if v_aoc_id is null then return; end if;

  select id into v_kul_station_id from public.org_stations where code = 'KUL - MAA';
  select id into v_pen_station_id from public.org_stations where code = 'PEN';
  select id into v_jhb_station_id from public.org_stations where code = 'JHB';
  select id into v_aor_station_id from public.org_stations where code = 'AOR';
  select id into v_iph_station_id from public.org_stations where code = 'IPH';
  select id into v_lgk_station_id from public.org_stations where code = 'LGK';
  select id into v_kch_station_id from public.org_stations where code = 'KCH';
  select id into v_bki_station_id from public.org_stations where code = 'BKI';

  -- 1. KUL: full operational workflow (both MAA and AAX stations)
  for v_kul_station_id in select id from public.org_stations where code in ('KUL - MAA', 'KUL - AAX') loop
    insert into public.caterlink_station_capabilities (
      aoc_id, station_id, can_view, can_create, can_scan, can_confirm_station_receipt,
      can_confirm_hub_receipt, can_report_incident, can_view_history, can_download_pdf, is_active
    ) values (
      v_aoc_id, v_kul_station_id, true, true, true, true, true, true, true, true, true
    ) on conflict (aoc_id, station_id) do update set
      can_view = true, can_create = true, can_scan = true, can_confirm_station_receipt = true,
      can_confirm_hub_receipt = true, can_report_incident = true, can_view_history = true,
      can_download_pdf = true, is_active = true, updated_at = now();
  end loop;

  -- 2. PEN: scanning and destination receipt enabled
  if v_pen_station_id is not null then
    insert into public.caterlink_station_capabilities (
      aoc_id, station_id, can_view, can_create, can_scan, can_confirm_station_receipt,
      can_confirm_hub_receipt, can_report_incident, can_view_history, can_download_pdf, is_active
    ) values (
      v_aoc_id, v_pen_station_id, true, false, true, true, true, true, true, true, true
    ) on conflict (aoc_id, station_id) do update set
      can_view = true, can_create = false, can_scan = true, can_confirm_station_receipt = true,
      can_confirm_hub_receipt = true, can_report_incident = true, can_view_history = true,
      can_download_pdf = true, is_active = true, updated_at = now();
  end if;

  -- 3. JHB: scanning and destination receipt enabled
  if v_jhb_station_id is not null then
    insert into public.caterlink_station_capabilities (
      aoc_id, station_id, can_view, can_create, can_scan, can_confirm_station_receipt,
      can_confirm_hub_receipt, can_report_incident, can_view_history, can_download_pdf, is_active
    ) values (
      v_aoc_id, v_jhb_station_id, true, false, true, true, true, true, true, true, true
    ) on conflict (aoc_id, station_id) do update set
      can_view = true, can_create = false, can_scan = true, can_confirm_station_receipt = true,
      can_confirm_hub_receipt = true, can_report_incident = true, can_view_history = true,
      can_download_pdf = true, is_active = true, updated_at = now();
  end if;

  -- 4. AOR, IPH, LGK, KCH, BKI: scanning disabled explicitly
  for v_kul_station_id in select id from public.org_stations where code in ('AOR', 'IPH', 'LGK', 'KCH', 'BKI') loop
    insert into public.caterlink_station_capabilities (
      aoc_id, station_id, can_view, can_create, can_scan, can_confirm_station_receipt,
      can_confirm_hub_receipt, can_report_incident, can_view_history, can_download_pdf, is_active
    ) values (
      v_aoc_id, v_kul_station_id, true, false, false, false, false, true, true, false, true
    ) on conflict (aoc_id, station_id) do update set
      can_view = true, can_create = false, can_scan = false, can_confirm_station_receipt = false,
      can_confirm_hub_receipt = false, can_report_incident = true, can_view_history = true,
      can_download_pdf = false, is_active = true, updated_at = now();
  end loop;

end $$;
