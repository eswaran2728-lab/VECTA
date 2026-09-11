-- ============================================================
-- Migration: Anonymous Staff Feedback
-- Anonymous-by-access-control feedback channel between Staff and Management.
-- ============================================================

-- 1. Create feedback_threads table
create table if not exists public.feedback_threads (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references public.organizations(id) on delete cascade,
  submitter_id uuid not null references public.profiles(id) on delete cascade,
  category text not null check (category in ('safety_concern', 'complaint', 'suggestion', 'other')),
  status text not null check (status in ('open', 'closed')) default 'open',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Index for queries by submitter and status
create index if not exists idx_feedback_threads_submitter on public.feedback_threads(submitter_id, created_at desc);
create index if not exists idx_feedback_threads_org_status on public.feedback_threads(org_id, status, category);

-- 2. Create feedback_messages table
create table if not exists public.feedback_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.feedback_threads(id) on delete cascade,
  sender_role text not null check (sender_role in ('submitter', 'management')),
  body text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_feedback_messages_thread on public.feedback_messages(thread_id, created_at asc);

-- 3. Create Security Definier view for Management that strictly omits submitter_id
create or replace view public.feedback_threads_management_view as
select
  id,
  org_id,
  category,
  status,
  created_at,
  updated_at
from public.feedback_threads;

-- 4. Enable RLS
alter table public.feedback_threads enable row level security;
alter table public.feedback_messages enable row level security;

-- 5. RLS Policies for feedback_threads
-- Staff (Submitters) can view and insert their own threads
create policy "feedback_threads_submitter_select"
  on public.feedback_threads for select
  using (submitter_id = auth.uid());

create policy "feedback_threads_submitter_insert"
  on public.feedback_threads for insert
  with check (submitter_id = auth.uid());

-- Management & Admin can view threads and update status
create policy "feedback_threads_management_select"
  on public.feedback_threads for select
  using (
    exists (
      select 1 from public.profiles
      where id = auth.uid()
      and role in ('MANAGEMENT', 'ADMIN')
    )
  );

create policy "feedback_threads_management_update"
  on public.feedback_threads for update
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

-- 6. RLS Policies for feedback_messages
-- Submitter can view messages of their own thread and insert messages as 'submitter'
create policy "feedback_messages_submitter_select"
  on public.feedback_messages for select
  using (
    exists (
      select 1 from public.feedback_threads
      where id = feedback_messages.thread_id
      and submitter_id = auth.uid()
    )
  );

create policy "feedback_messages_submitter_insert"
  on public.feedback_messages for insert
  with check (
    sender_role = 'submitter'
    and exists (
      select 1 from public.feedback_threads
      where id = feedback_messages.thread_id
      and submitter_id = auth.uid()
    )
  );

-- Management can view all messages and reply as 'management'
create policy "feedback_messages_management_select"
  on public.feedback_messages for select
  using (
    exists (
      select 1 from public.profiles
      where id = auth.uid()
      and role in ('MANAGEMENT', 'ADMIN')
    )
  );

create policy "feedback_messages_management_insert"
  on public.feedback_messages for insert
  with check (
    sender_role = 'management'
    and exists (
      select 1 from public.profiles
      where id = auth.uid()
      and role in ('MANAGEMENT', 'ADMIN')
    )
  );

-- Real-time publication for live badges/chat updates
alter publication supabase_realtime add table public.feedback_threads;
alter publication supabase_realtime add table public.feedback_messages;
