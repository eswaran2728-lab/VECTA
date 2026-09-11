-- ============================================================
-- Phase 1: Multi-tenant Scaffolding & Organizations
-- Additive migration: Creates `organizations` table, seeds default 'AirAsia' tenant,
-- adds `org_id` column to existing AVSEC and ICMS tables, and backfills existing rows.
-- ============================================================

-- 1. Organizations table
create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  code text unique,
  status text not null default 'active' check (status in ('active', 'inactive', 'suspended')),
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Enable RLS on organizations
alter table public.organizations enable row level security;

-- Seed default AirAsia organization
insert into public.organizations (id, name, code, status)
values ('00000000-0000-0000-0000-000000000001', 'AirAsia', 'AIRASIA', 'active')
on conflict (id) do update set name = 'AirAsia', code = 'AIRASIA', status = 'active';

-- Helper function to get current user's organization id
create or replace function current_org_id()
returns uuid as $$
  select coalesce(
    (select org_id from public.profiles where id = auth.uid()),
    (select org_id from public.users where id = auth.uid()),
    '00000000-0000-0000-0000-000000000001'::uuid
  );
$$ language sql stable security definer set search_path = public;

-- 2. Add org_id to AVSEC tables and backfill
do $$
declare
  v_default_org uuid := '00000000-0000-0000-0000-000000000001'::uuid;
  v_table text;
  v_tables text[] := array[
    'profiles',
    'stations',
    'teams',
    'aircraft_types',
    'station_teams',
    'report_sec016',
    'report_sec014',
    'report_sec014_patrols',
    'report_sec029',
    'report_sec029_items',
    'report_sec018',
    'report_sec018_patrols',
    'report_sec033',
    'report_sec033_hold_checks',
    'report_sec013',
    'report_sec013_profiling_duties',
    'offload_records',
    'offload_items',
    'bay_board',
    'report_acknowledgements',
    'duty_zones',
    'duty_records',
    'overtime_requests',
    'duty_audit_log',
    'report_counters',
    'shifts',
    'report_drafts',
    'users',
    'transactions',
    'transaction_counters',
    'part_a',
    'part_b',
    'part_c',
    'part_d',
    'part_hub',
    'part_redq',
    'incidents',
    'incident_photos',
    'notifications',
    'audit_logs',
    'segment_timeouts',
    'vendor_transactions',
    'vendor_transaction_counters',
    'vendor_part_a',
    'vendor_part_b',
    'vendor_part_c',
    'seals',
    'seal_verifications',
    'catering_companies',
    'vehicles',
    'drivers',
    'cscs_settings'
  ];
begin
  foreach v_table in array v_tables loop
    if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = v_table) then
      -- Add column if not exists
      execute format('alter table public.%I add column if not exists org_id uuid references public.organizations(id) default %L', v_table, v_default_org);
      -- Backfill existing rows
      execute format('update public.%I set org_id = %L where org_id is null', v_table, v_default_org);
      -- Create index on org_id if not exists
      execute format('create index if not exists %I on public.%I (org_id)', 'idx_' || v_table || '_org_id', v_table);
    end if;
  end loop;
end $$;

-- 3. Super Admin RLS Policies for Organizations table
-- Platform super admins can manage organizations.
create policy "organizations_super_admin_all" on public.organizations
  for all using (
    exists (
      select 1 from public.profiles
      where id = auth.uid() and (role = 'SUPER_ADMIN' or unified_role = 'super_admin')
    ) or exists (
      select 1 from public.users
      where id = auth.uid() and (role = 'super_admin' or unified_role = 'super_admin')
    )
  );

-- Regular users can view their own organization
create policy "organizations_member_select" on public.organizations
  for select using (
    id = current_org_id()
  );
