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
    'caterlink_movement_received'
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
-- PART C: Whitelist System (AOC & Entity Scoped)
-- =======================================================================
create table if not exists public.caterlink_whitelist_entries (
  id uuid primary key default gen_random_uuid(),
  aoc_id uuid not null references public.aocs(id),
  operating_entity_id uuid references public.operating_entities(id),
  entry_type text not null check (entry_type in ('vendor', 'driver', 'vehicle', 'warehouse_user')),
  identifier text not null,             -- vehicle registration, driver staff/IC, vendor code
  name text not null,                   -- driver name, company name, model
  company_name text,
  airport_pass_number text,
  pass_expiry_date date,
  status text not null default 'active' check (status in ('active', 'inactive', 'revoked')),
  effective_from date not null default current_date,
  effective_until date,
  created_by uuid not null references public.profiles(id),
  approved_by uuid references public.profiles(id),
  approved_at timestamptz,
  deactivated_by uuid references public.profiles(id),
  deactivated_at timestamptz,
  reason text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (aoc_id, entry_type, identifier)
);

create index if not exists idx_caterlink_whitelist_lookup
  on public.caterlink_whitelist_entries (aoc_id, entry_type, status, identifier);

alter table public.caterlink_whitelist_entries enable row level security;
revoke all on public.caterlink_whitelist_entries from public, anon, authenticated;
grant all on public.caterlink_whitelist_entries to service_role;
grant select on public.caterlink_whitelist_entries to authenticated;

create policy "caterlink_whitelist_read"
  on public.caterlink_whitelist_entries for select
  to authenticated
  using (
    -- Visible to CaterLink Management, entity Admins, and scanning personnel within same AOC
    public.has_active_role_for_aoc('caterlink_management', aoc_id)
    or public.has_active_role_for_aoc('operation_manager', aoc_id)
    or public.has_active_role_for_aoc('main_enforcement', aoc_id)
    or (
      operating_entity_id is not null
      and (
        (public.has_role_in_scope('maa_admin', aoc_id, operating_entity_id))
        or (public.has_role_in_scope('aax_admin', aoc_id, operating_entity_id))
      )
    )
    or public.has_any_active_assignment_in_aoc(caterlink_whitelist_entries.aoc_id)
  );

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

  -- Generate sequential transaction number
  v_seq := (select coalesce(max(substr(t.transaction_number, 11)::integer), 0) + 1
            from public.transactions t
            where t.transaction_number like 'CL-' || v_year || '-%');
  v_tx_number := 'CL-' || v_year || '-' || lpad(v_seq::text, 6, '0');

  insert into public.transactions (
    transaction_number, aoc_id, direction, route, vehicle_number, driver_name, driver_id,
    seal_number, hub_destination, station, origin_station_id, destination_station_id,
    flight_number, aircraft_registration, trolley_count, cargo_types, status, created_by
  ) values (
    v_tx_number, p_aoc_id, p_direction, p_route, p_vehicle_number, p_driver_name, p_driver_id,
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
