-- ============================================================================
-- VECTA — Phase 8-13 Dependency Reconciliation: Workforce, Announcements & WOIS Prerequisites
-- Migration ID: 20260929000001_phase8_absence_prerequisites.sql
--
-- Context & Root Cause Analysis:
-- In hosted staging (ddlctzbnqewubltcavkh), the historical baseline stopped at
-- 20260819133729_strip_icms_and_unified_role_restore_bare_avsec.sql (43 migrations).
-- The 20260911 historical workforce family was never applied.
--
-- Replaying the raw 20260911 migrations is demonstrably unsafe because:
--   1. 20260911000001 introduced a single-tenant `organizations` table that conflicts
--      with the Phase 2 multi-AOC architecture (public.aocs / operating_entities);
--   2. 20260911000002 & 20260911000009 perform direct data mutations on profiles.role
--      and profile triggers that violate account immutability;
--   3. 20260911000004 created `ot_requests`, which was deprecated and dropped on 2026-09-14
--      in favor of `public.overtime_requests`;
--   4. 20260911000006 created `feedback_threads` which is superseded by Phase 10 discussion tables;
--   5. 20260911000007 & 20260911000008 created initial tables for announcements and WOIS
--      with foreign keys referencing the obsolete `organizations` table.
--
-- However, downstream migrations rely on the existence of these base relations:
--   - Phase 8 (20260930000001) requires public.absence_notices;
--   - Phase 11 (20261008000001) requires public.announcements & public.announcement_acknowledgements;
--   - Phase 12 (20261010000001) requires public.wois_conversations & public.wois_messages.
--
-- This reconciliation migration provides clean, additive, non-destructive base definitions
-- for all prerequisite relations without any obsolete single-tenant scaffolding.
-- ============================================================================

-- ============================================================================
-- PART 1: ABSENCE NOTICES & LEAVE SYSTEM (REQUIRED BY PHASE 8)
-- ============================================================================

create table if not exists public.absence_notices (
  id uuid primary key default gen_random_uuid(),
  org_id uuid,
  user_id uuid not null references public.profiles(id) on delete cascade,
  staff_name text not null,
  staff_id text,
  role text not null,
  station text,
  team text,
  ops_group text,
  shift_code text,
  duty_date date not null,
  shift_start_time timestamptz not null,
  submitted_at timestamptz not null default now(),
  gap_minutes integer,
  status text check (status in ('green', 'red')),
  remarks text not null,
  created_at timestamptz not null default now(),
  leave_type text not null default 'absent',
  start_date date not null default current_date,
  end_date date not null default current_date,
  approval_status text not null default 'pending',
  reviewed_by uuid references public.profiles(id) on delete set null,
  reviewed_at timestamptz,
  review_notes text,
  cancellation_reason text,
  cancel_requested_at timestamptz
);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'absence_notices_leave_type_check'
  ) then
    alter table public.absence_notices
      add constraint absence_notices_leave_type_check
      check (leave_type in (
        'absent',
        'mc',
        'emergency',
        'annual',
        'compassionate',
        'hospitalization',
        'maternity_paternity',
        'parental',
        'unpaid',
        'representative'
      ));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'absence_notices_approval_status_check'
  ) then
    alter table public.absence_notices
      add constraint absence_notices_approval_status_check
      check (approval_status in (
        'pending',
        'approved',
        'rejected',
        'pending_cancellation',
        'cancelled'
      ));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'absence_notices_date_range_check'
  ) then
    alter table public.absence_notices
      add constraint absence_notices_date_range_check
      check (end_date >= start_date);
  end if;
end $$;

create index if not exists idx_absence_notices_user_id
  on public.absence_notices (user_id);

create index if not exists idx_absence_notices_duty_date
  on public.absence_notices (duty_date desc);

create index if not exists idx_absence_notices_station_team
  on public.absence_notices (station, team);

create index if not exists idx_absence_notices_ops_group
  on public.absence_notices (ops_group);

create index if not exists idx_absence_notices_status
  on public.absence_notices (status);

create index if not exists idx_absence_notices_leave_type
  on public.absence_notices (leave_type);

create index if not exists idx_absence_notices_station_team_status
  on public.absence_notices (station, team, approval_status);

create index if not exists idx_absence_notices_user_dates
  on public.absence_notices (user_id, start_date, end_date);

create index if not exists idx_absence_notices_status_dates
  on public.absence_notices (approval_status, start_date, end_date);

-- Compound indexes for companion workforce tables (from 20260911000014)
create index if not exists idx_overtime_requests_work_date_status
  on public.overtime_requests (work_date, status);

create index if not exists idx_duty_records_station_team_date
  on public.duty_records (station, team, duty_date);

alter table public.absence_notices enable row level security;

revoke all on public.absence_notices from public, anon;
grant select, insert, update on public.absence_notices to authenticated;
grant all on public.absence_notices to service_role;

drop policy if exists "absence_notices_insert_own" on public.absence_notices;
create policy "absence_notices_insert_own" on public.absence_notices
  for insert with check (auth.uid() = user_id);

drop policy if exists "absence_notices_select_own" on public.absence_notices;
create policy "absence_notices_select_own" on public.absence_notices
  for select using (auth.uid() = user_id);

drop policy if exists "absence_notices_owner_cancellation_request" on public.absence_notices;
create policy "absence_notices_owner_cancellation_request" on public.absence_notices
  for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "absence_notices_select_elevated" on public.absence_notices;
create policy "absence_notices_select_elevated" on public.absence_notices
  for select using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and p.role::text in ('DSE', 'ENFORCEMENT', 'MANAGEMENT', 'ADMIN', 'SUPER_ADMIN')
        and (
          p.role::text in ('MANAGEMENT', 'ADMIN', 'ENFORCEMENT', 'SUPER_ADMIN')
          or (p.role::text = 'DSE' and (p.station is null or p.station = absence_notices.station))
        )
    )
  );

drop policy if exists "absence_notices_dse_management_update" on public.absence_notices;
create policy "absence_notices_dse_management_update" on public.absence_notices
  for update
  using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and (
          p.role::text in ('MANAGEMENT', 'ADMIN', 'SUPER_ADMIN')
          or (
            p.role::text = 'DSE'
            and (absence_notices.station = p.station or absence_notices.station is null)
          )
        )
    )
  )
  with check (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and (
          p.role::text in ('MANAGEMENT', 'ADMIN', 'SUPER_ADMIN')
          or (
            p.role::text = 'DSE'
            and (absence_notices.station = p.station or absence_notices.station is null)
          )
        )
    )
  );

-- ============================================================================
-- PART 2: ANNOUNCEMENTS FOUNDATION (REQUIRED BY PHASE 11)
-- ============================================================================

create table if not exists public.announcements (
  id uuid primary key default gen_random_uuid(),
  org_id uuid,
  created_by uuid references public.profiles(id) on delete set null,
  title text not null,
  body text not null,
  photo_url text,
  is_pop boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.announcement_acknowledgements (
  id uuid primary key default gen_random_uuid(),
  announcement_id uuid not null references public.announcements(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  acknowledged_at timestamptz not null default now(),
  unique (announcement_id, user_id)
);

create index if not exists idx_announcements_created_at
  on public.announcements (created_at desc);

create index if not exists idx_announcement_acks_user
  on public.announcement_acknowledgements (user_id, announcement_id);

alter table public.announcements enable row level security;
alter table public.announcement_acknowledgements enable row level security;

revoke all on public.announcements from public, anon;
grant select on public.announcements to authenticated;
grant all on public.announcements to service_role;

revoke all on public.announcement_acknowledgements from public, anon;
grant select, insert on public.announcement_acknowledgements to authenticated;
grant all on public.announcement_acknowledgements to service_role;

-- ============================================================================
-- PART 3: WOIS AI FOUNDATION (REQUIRED BY PHASE 12)
-- ============================================================================

create table if not exists public.wois_conversations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null default 'New Chat',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.wois_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.wois_conversations(id) on delete cascade,
  sender text not null check (sender in ('user', 'assistant')),
  body text not null,
  confidence_tag text check (confidence_tag in ('VERIFIED', 'GENERAL_KNOWLEDGE', 'REQUIRES_SOP', 'UNCERTAIN', 'ESCALATE')),
  source_type text check (source_type in ('sop', 'regulatory', 'app_help', 'general')),
  sources jsonb default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_wois_conversations_user_id
  on public.wois_conversations (user_id, created_at desc);

create index if not exists idx_wois_messages_conversation_id
  on public.wois_messages (conversation_id, created_at asc);

alter table public.wois_conversations enable row level security;
alter table public.wois_messages enable row level security;

revoke all on public.wois_conversations from public, anon;
grant select, insert, update on public.wois_conversations to authenticated;
grant all on public.wois_conversations to service_role;

revoke all on public.wois_messages from public, anon;
grant select, insert on public.wois_messages to authenticated;
grant all on public.wois_messages to service_role;
