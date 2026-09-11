-- ============================================================
-- Migration: Management Announcements
-- Targeted broadcast system from Management to staff with read receipt tracking.
-- ============================================================

-- 1. Create announcements table
create table if not exists public.announcements (
  id uuid primary key default gen_random_uuid(),
  org_id text references public.organizations(id) on delete cascade,
  created_by uuid not null references public.profiles(id) on delete cascade,
  title text not null,
  body text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_announcements_org on public.announcements(org_id, created_at desc);

-- 2. Create announcement_targets join table
-- Null values mean "all" for that dimension (e.g. branch=null => all branches)
create table if not exists public.announcement_targets (
  id uuid primary key default gen_random_uuid(),
  announcement_id uuid not null references public.announcements(id) on delete cascade,
  branch text check (branch in ('operation_avsec', 'ifc_avsec', 'hub_avsec')),
  station text,
  team text,
  created_at timestamptz not null default now()
);

create index if not exists idx_announcement_targets_match on public.announcement_targets(announcement_id, branch, station, team);

-- 3. Create announcement_acknowledgements table
create table if not exists public.announcement_acknowledgements (
  id uuid primary key default gen_random_uuid(),
  announcement_id uuid not null references public.announcements(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  acknowledged_at timestamptz not null default now(),
  unique(announcement_id, user_id)
);

create index if not exists idx_announcement_acks_user on public.announcement_acknowledgements(user_id, announcement_id);

-- 4. Enable RLS
alter table public.announcements enable row level security;
alter table public.announcement_targets enable row level security;
alter table public.announcement_acknowledgements enable row level security;

-- 5. Policies for announcements
-- Management & Admin can do full CRUD
create policy "announcements_management_all"
  on public.announcements for all
  using (
    exists (
      select 1 from public.profiles
      where id = auth.uid()
      and role in ('MANAGEMENT', 'ADMIN')
    )
  )
  with check (
    exists (
      select 1 from public.profiles
      where id = auth.uid()
      and role in ('MANAGEMENT', 'ADMIN')
    )
  );

-- Staff can select announcements that target their branch, station, and team (or where null = all)
create policy "announcements_staff_select"
  on public.announcements for select
  using (
    exists (
      select 1 from public.announcement_targets t
      cross join public.profiles p
      where t.announcement_id = announcements.id
      and p.id = auth.uid()
      and (t.branch is null or t.branch = p.ops_group)
      and (t.station is null or t.station = p.station)
      and (t.team is null or t.team = p.team)
    )
  );

-- 6. Policies for announcement_targets
create policy "announcement_targets_management_all"
  on public.announcement_targets for all
  using (
    exists (
      select 1 from public.profiles
      where id = auth.uid()
      and role in ('MANAGEMENT', 'ADMIN')
    )
  )
  with check (
    exists (
      select 1 from public.profiles
      where id = auth.uid()
      and role in ('MANAGEMENT', 'ADMIN')
    )
  );

create policy "announcement_targets_staff_select"
  on public.announcement_targets for select
  using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
      and (announcement_targets.branch is null or announcement_targets.branch = p.ops_group)
      and (announcement_targets.station is null or announcement_targets.station = p.station)
      and (announcement_targets.team is null or announcement_targets.team = p.team)
    )
  );

-- 7. Policies for announcement_acknowledgements
create policy "announcement_acks_staff_insert"
  on public.announcement_acknowledgements for insert
  with check (user_id = auth.uid());

create policy "announcement_acks_staff_select"
  on public.announcement_acknowledgements for select
  using (user_id = auth.uid());

create policy "announcement_acks_management_select"
  on public.announcement_acknowledgements for select
  using (
    exists (
      select 1 from public.profiles
      where id = auth.uid()
      and role in ('MANAGEMENT', 'ADMIN')
    )
  );

-- Real-time publication for live announcements on dashboards
alter publication supabase_realtime add table public.announcements;
alter publication supabase_realtime add table public.announcement_acknowledgements;
