-- ============================================================
-- Migration: Absence Late-Notice Tracker
-- Migration ID: 20260911000010_absence_late_notice_tracker.sql
-- Description: Creates table public.absence_notices with RLS policies,
-- indexing, and green/red timing status for advance notice tracking.
-- ============================================================

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
  gap_minutes integer not null,
  status text not null check (status in ('green', 'red')),
  remarks text not null,
  created_at timestamptz not null default now()
);

-- Indices for fast querying and filtering
create index if not exists idx_absence_notices_user_id on public.absence_notices(user_id);
create index if not exists idx_absence_notices_duty_date on public.absence_notices(duty_date desc);
create index if not exists idx_absence_notices_station_team on public.absence_notices(station, team);
create index if not exists idx_absence_notices_ops_group on public.absence_notices(ops_group);
create index if not exists idx_absence_notices_status on public.absence_notices(status);

-- Enable Row Level Security
alter table public.absence_notices enable row level security;

-- Policy: Authenticated staff can insert their own absence notice
drop policy if exists "absence_notices_insert_own" on public.absence_notices;
create policy "absence_notices_insert_own" on public.absence_notices
  for insert with check (auth.uid() = user_id);

-- Policy: Staff can view their own absence notices
drop policy if exists "absence_notices_select_own" on public.absence_notices;
create policy "absence_notices_select_own" on public.absence_notices
  for select using (auth.uid() = user_id);

-- Policy: DSE, Enforcement, Management, and Super Admin can view absence notices
drop policy if exists "absence_notices_select_elevated" on public.absence_notices;
create policy "absence_notices_select_elevated" on public.absence_notices
  for select using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and p.role in ('DSE', 'ENFORCEMENT', 'MANAGEMENT', 'ADMIN', 'SUPER_ADMIN')
        and (
          p.role in ('MANAGEMENT', 'ADMIN', 'ENFORCEMENT', 'SUPER_ADMIN')
          or (p.role = 'DSE' and (p.station is null or p.station = absence_notices.station))
        )
    )
  );
