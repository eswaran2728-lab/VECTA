-- ============================================================
-- CSCS v2 - PHASE 5: Incident lifecycle + notifications + timeout
-- ============================================================

-- Lifecycle columns
alter table public.incidents
  add column if not exists status text not null default 'OPEN'
    check (status in ('OPEN', 'UNDER_REVIEW', 'RESOLVED', 'CLOSED')),
  add column if not exists resolved_by uuid references public.users (id),
  add column if not exists resolution_notes text,
  add column if not exists resolved_at timestamptz;

-- System-generated incidents (timeout cron) have no human reporter account.
alter table public.incidents alter column reported_by_id drop not null;

-- Photos move to a dedicated table (multiple per incident).
create table public.incident_photos (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references public.incidents (id) on delete cascade,
  photo_url text not null,
  uploaded_at timestamptz not null default now()
);

create index idx_incident_photos_incident on public.incident_photos (incident_id);

insert into public.incident_photos (incident_id, photo_url, uploaded_at)
select id, photo_url, created_at from public.incidents
where photo_url is not null;

-- In-app notifications
create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  incident_id uuid references public.incidents (id) on delete cascade,
  title text not null,
  body text not null,
  is_read boolean not null default false,
  created_at timestamptz not null default now()
);

create index idx_notifications_user on public.notifications (user_id, is_read);

-- Notify every supervisor when an incident is raised.
create or replace function public.notify_supervisors_on_incident()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tx_number text;
begin
  select transaction_number into v_tx_number from transactions where id = new.transaction_id;
  insert into notifications (user_id, incident_id, title, body)
  select u.id, new.id,
         'Incident: ' || new.incident_type,
         coalesce(v_tx_number, 'Transaction') || ' escalated — ' || left(new.description, 200)
  from users u
  where u.role = 'supervisor';
  return new;
end;
$$;

create trigger trg_notify_supervisors
  after insert on public.incidents
  for each row execute function public.notify_supervisors_on_incident();

-- Incident lifecycle guard: only status/resolution fields may change, only
-- forward transitions, notes mandatory from RESOLVED onward.
create or replace function public.guard_incident_update()
returns trigger
language plpgsql
as $$
declare
  v_rank_old int;
  v_rank_new int;
begin
  if new.transaction_id <> old.transaction_id
     or new.incident_type <> old.incident_type
     or new.description <> old.description
     or new.reported_by <> old.reported_by
     or coalesce(new.reported_by_id::text, '') <> coalesce(old.reported_by_id::text, '')
     or new.created_at <> old.created_at then
    raise exception 'CSCS: incident facts are immutable; only the resolution lifecycle may change';
  end if;
  v_rank_old := array_position(array['OPEN','UNDER_REVIEW','RESOLVED','CLOSED'], old.status);
  v_rank_new := array_position(array['OPEN','UNDER_REVIEW','RESOLVED','CLOSED'], new.status);
  if v_rank_new < v_rank_old then
    raise exception 'CSCS: incident status can only move forward (OPEN -> UNDER_REVIEW -> RESOLVED -> CLOSED)';
  end if;
  if v_rank_new >= 3 and (new.resolution_notes is null or new.resolution_notes = '') then
    raise exception 'CSCS: resolution notes are mandatory to resolve or close an incident';
  end if;
  return new;
end;
$$;

create trigger trg_guard_incident_update
  before update on public.incidents
  for each row execute function public.guard_incident_update();

create trigger trg_incidents_no_delete
  before delete on public.incidents
  for each row execute function public.block_mutation();

-- ------------------------------------------------------------
-- Timeout escalation: any transaction still in progress after
-- the configured window raises a TIMEOUT incident (which the
-- existing trigger escalates). Runs via pg_cron every 15 min.
-- ------------------------------------------------------------
create table if not exists public.cscs_settings (
  key text primary key,
  value text not null
);

insert into public.cscs_settings (key, value)
values ('timeout_hours', '4')
on conflict (key) do nothing;

alter table public.cscs_settings enable row level security;

create policy "settings: supervisor reads"
  on public.cscs_settings for select
  using (public.current_user_role() = 'supervisor');

create or replace function public.escalate_timeouts()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hours numeric := coalesce((select value::numeric from cscs_settings where key = 'timeout_hours'), 4);
  v_count int := 0;
  r record;
begin
  for r in
    select id, transaction_number, status, created_at
    from transactions
    where status in ('CREATED', 'INFLIGHT_POST_APPROVED', 'AIRPORT_POST_APPROVED')
      and created_at < now() - make_interval(hours => v_hours::int)
      and not exists (
        select 1 from incidents i
        where i.transaction_id = transactions.id and i.incident_type = 'TIMEOUT'
      )
  loop
    insert into incidents (transaction_id, incident_type, description, reported_by, reported_by_id)
    values (
      r.id,
      'TIMEOUT',
      format('Automatic escalation: transaction %s was still %s after %s hours.',
             r.transaction_number, r.status, v_hours),
      'system (timeout monitor)',
      null
    );
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

create extension if not exists pg_cron;

select cron.schedule(
  'cscs-timeout-monitor',
  '*/15 * * * *',
  $$select public.escalate_timeouts()$$
);

-- ------------------------------------------------------------
-- RLS for new tables
-- ------------------------------------------------------------
alter table public.incident_photos enable row level security;
alter table public.notifications enable row level security;

create policy "incident_photos: read follows incident visibility"
  on public.incident_photos for select
  using (exists (select 1 from public.incidents i where i.id = incident_id));

create policy "incident_photos: reporter attaches"
  on public.incident_photos for insert
  with check (public.current_user_role() is not null);

create policy "notifications: own read"
  on public.notifications for select
  using (user_id = auth.uid());

create policy "notifications: own mark read"
  on public.notifications for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Supervisor updates the incident lifecycle.
create policy "incidents: supervisor resolves"
  on public.incidents for update
  using (public.current_user_role() = 'supervisor')
  with check (public.current_user_role() = 'supervisor');

-- Realtime for the in-app notification bell.
alter publication supabase_realtime add table public.notifications;
