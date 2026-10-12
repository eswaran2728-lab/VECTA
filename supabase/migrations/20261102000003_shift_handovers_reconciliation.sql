-- Forward reconciliation migration: shift_handovers table, indexes, RLS, policies and grants.
-- Applied before 20261103000001_role_workspace_completion.

create table if not exists public.shift_handovers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid,
  outgoing_profile_id uuid not null references public.profiles(id),
  station text not null,
  team text,
  ops_group text,
  staff_name text not null,
  staff_id text not null,
  place_category text not null check (place_category in ('Bay', 'Premises', 'Terminal')),
  place_detail text not null,
  flight_number text,
  handover_notes text not null,
  unfinished_work_summary jsonb not null default '[]'::jsonb,
  acknowledged_by uuid references public.profiles(id),
  acknowledged_at timestamptz,
  acknowledgment_notes text,
  created_at timestamptz not null default now()
);

-- Fail if an incompatible partial table exists missing critical columns
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'shift_handovers' and column_name = 'outgoing_profile_id'
  ) then
    raise exception 'Incompatible public.shift_handovers table structure detected';
  end if;
end $$;

-- Indexes
create index if not exists shift_handovers_station_team_idx on public.shift_handovers (station, team, created_at desc);
create index if not exists shift_handovers_flight_idx on public.shift_handovers (station, flight_number, created_at desc) where flight_number is not null;
create index if not exists shift_handovers_outgoing_profile_idx on public.shift_handovers (outgoing_profile_id);
create index if not exists shift_handovers_acknowledged_by_idx on public.shift_handovers (acknowledged_by);

-- RLS
alter table public.shift_handovers enable row level security;

-- Grants
revoke all on public.shift_handovers from public, anon;
grant select, insert, update on public.shift_handovers to authenticated;
grant all on public.shift_handovers to service_role;

-- Policies
drop policy if exists "shift_handovers own insert" on public.shift_handovers;
create policy "shift_handovers own insert" on public.shift_handovers
  for insert
  with check (
    outgoing_profile_id = auth.uid()
    and (canon_is_active() or current_status() = 'approved'::profile_status)
  );

drop policy if exists "shift_handovers team select" on public.shift_handovers;
create policy "shift_handovers team select" on public.shift_handovers
  for select
  using (
    outgoing_profile_id = auth.uid()
    or current_role_rank() >= role_rank('ENFORCEMENT'::user_role)
    or (station = current_station() and coalesce(team, '') = coalesce(current_team(), ''))
    or canon_oversees(outgoing_profile_id, station, team)
    or canon_has_role(array['operation_manager'::text, 'main_enforcement'::text])
  );

drop policy if exists "shift_handovers team acknowledge" on public.shift_handovers;
create policy "shift_handovers team acknowledge" on public.shift_handovers
  for update
  using (
    acknowledged_at is null
    and (
      current_role_rank() >= role_rank('ENFORCEMENT'::user_role)
      or (station = current_station() and coalesce(team, '') = coalesce(current_team(), ''))
      or canon_oversees(outgoing_profile_id, station, team)
      or canon_has_role(array['operation_manager'::text, 'main_enforcement'::text])
    )
  )
  with check (
    acknowledged_by = auth.uid()
  );
