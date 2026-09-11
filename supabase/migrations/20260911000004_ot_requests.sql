-- ============================================================
-- Phase 4: OT (Overtime) Request & Approval Workflow
-- Additive migration: Creates `ot_requests` table, RLS policies for ASO submission,
-- DSE branch-scoped approval, and Management audit oversight.
-- ============================================================

create table if not exists public.ot_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) default '00000000-0000-0000-0000-000000000001'::uuid,
  requester_id uuid not null references public.profiles (id),
  branch text not null check (branch in ('operation_avsec', 'ifc_avsec', 'hub_avsec')),
  work_date date not null,
  hours numeric not null check (hours > 0),
  reason text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  requested_at timestamptz not null default now(),
  reviewed_by uuid references public.profiles (id),
  reviewed_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.ot_requests enable row level security;

create index if not exists idx_ot_requests_org_id on public.ot_requests (org_id);
create index if not exists idx_ot_requests_requester on public.ot_requests (requester_id, status);
create index if not exists idx_ot_requests_branch_status on public.ot_requests (branch, status);

-- RLS: ASO can view their own OT requests
create policy "ot_requests_requester_select" on public.ot_requests
  for select using (
    requester_id = auth.uid()
  );

-- RLS: ASO can submit OT requests for themselves
create policy "ot_requests_aso_insert" on public.ot_requests
  for insert with check (
    requester_id = auth.uid()
    and exists (
      select 1 from public.profiles
      where id = auth.uid()
        and role = 'ASO'
        and status = 'approved'
        and ops_group = branch
    )
  );

-- RLS: DSE of the matching branch and org can view pending & reviewed OT requests
create policy "ot_requests_dse_select" on public.ot_requests
  for select using (
    exists (
      select 1 from public.profiles
      where id = auth.uid()
        and role = 'DSE'
        and status = 'approved'
        and ops_group = branch
    )
    or exists (
      select 1 from public.profiles
      where id = auth.uid()
        and role in ('MANAGEMENT', 'ENFORCEMENT', 'SUPER_ADMIN')
        and status = 'approved'
    )
  );

-- RLS: DSE of the matching branch can update/review OT requests (approve or reject)
create policy "ot_requests_dse_update" on public.ot_requests
  for update using (
    exists (
      select 1 from public.profiles
      where id = auth.uid()
        and role = 'DSE'
        and status = 'approved'
        and ops_group = branch
    )
  ) with check (
    reviewed_by = auth.uid()
  );
