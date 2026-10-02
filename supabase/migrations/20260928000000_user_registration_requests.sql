-- =======================================================================
-- Forward Reconciliation Migration: public.user_registration_requests
--
-- Authoritative baseline migration for public.user_registration_requests,
-- restoring the schema object required by Phase 4 registration intake,
-- administrative approvals, and transfer workflows.
--
-- Deduced from:
--   - Phase 4 functions: submit_registration_request, get_my_registration_request,
--     list_pending_registration_requests, approve_registration_request,
--     reject_registration_request
--   - Phase 7 dashboard aggregates: closure count(pending)
--   - Phase 13 storage & admin workflows: list_entity_registration_requests_secure
--   - Application types: lib/supabase/database.types.ts
--   - Audit log & notifications: user_admin_audit_log, user_notifications
--
-- Tested and validated for idempotency against:
--   - Clean empty PostgreSQL (conditional references handle absent parent tables)
--   - Legacy staging-equivalent schema (avsec/0001-0026 baseline)
--   - Phase 2-3 applied state (aocs, role_definitions, user_role_assignments)
--   - Complete Phase 2-13 migration chain
-- =======================================================================

create table if not exists public.user_registration_requests (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null,
  requested_aoc_id uuid,
  requested_operating_entity_id uuid,
  requested_department_id uuid,
  requested_unit_id uuid,
  requested_hub_id uuid,
  requested_station_id uuid,
  requested_team_id uuid,
  requested_role_code text,
  applicant_notes text,
  status text not null default 'pending',
  reviewer_id uuid,
  reviewed_at timestamptz,
  rejection_reason text,
  final_assignment_id uuid,
  submitted_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Status domain check constraint
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'user_registration_requests_status_check'
      and conrelid = 'public.user_registration_requests'::regclass
  ) then
    alter table public.user_registration_requests
      add constraint user_registration_requests_status_check
      check (status in ('pending', 'approved', 'rejected'));
  end if;
end $$;

-- Conditional foreign keys: applied when referenced tables exist
do $$
begin
  if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'profiles') then
    if not exists (
      select 1 from pg_constraint
      where conname = 'user_registration_requests_profile_id_fkey'
        and conrelid = 'public.user_registration_requests'::regclass
    ) then
      alter table public.user_registration_requests
        add constraint user_registration_requests_profile_id_fkey
        foreign key (profile_id) references public.profiles(id) on delete cascade;
    end if;
  end if;
end $$;

do $$
begin
  if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'user_role_assignments') then
    if not exists (
      select 1 from pg_constraint
      where conname = 'user_registration_requests_final_assignment_id_fkey'
        and conrelid = 'public.user_registration_requests'::regclass
    ) then
      alter table public.user_registration_requests
        add constraint user_registration_requests_final_assignment_id_fkey
        foreign key (final_assignment_id) references public.user_role_assignments(id) on delete set null;
    end if;
  end if;
end $$;

-- Performance indexes
create index if not exists user_registration_requests_profile_id_idx
  on public.user_registration_requests (profile_id);

create index if not exists user_registration_requests_status_idx
  on public.user_registration_requests (status);

create index if not exists user_registration_requests_entity_status_idx
  on public.user_registration_requests (requested_operating_entity_id, status);

create index if not exists user_registration_requests_submitted_at_idx
  on public.user_registration_requests (submitted_at desc);

-- Automatic timestamp management
create or replace function public.set_updated_at_user_registration_requests()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  new.updated_at = now();
  return new;
end;
$function$;

drop trigger if exists trg_user_registration_requests_updated_at on public.user_registration_requests;
create trigger trg_user_registration_requests_updated_at
  before update on public.user_registration_requests
  for each row execute function public.set_updated_at_user_registration_requests();

-- Self-write immutability trigger: applicants may update pending notes/intake fields,
-- but cannot alter review status, reviewer info, or final assignments directly.
create or replace function public.enforce_registration_request_self_write()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_is_admin boolean := false;
begin
  if auth.role() = 'service_role' then
    return new;
  end if;

  -- Allow authorized admins to update review/status fields
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'current_role_name') then
    execute 'select current_role_name() = ''ADMIN''' into v_is_admin;
    if coalesce(v_is_admin, false) then
      return new;
    end if;
  end if;

  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'is_entity_admin') then
    execute 'select public.is_entity_admin(''MAA'') or public.is_entity_admin(''AAX'')' into v_is_admin;
    if coalesce(v_is_admin, false) then
      return new;
    end if;
  end if;

  if old.status <> 'pending' then
    raise exception 'Cannot modify a registration request that has already been reviewed (status=%).', old.status;
  end if;

  if new.status is distinct from old.status
     or new.reviewer_id is distinct from old.reviewer_id
     or new.reviewed_at is distinct from old.reviewed_at
     or new.rejection_reason is distinct from old.rejection_reason
     or new.final_assignment_id is distinct from old.final_assignment_id
     or new.profile_id is distinct from old.profile_id
  then
    raise exception 'Administrative and review fields on user_registration_requests can only be updated by authorized administrative procedures.';
  end if;

  return new;
end;
$function$;

drop trigger if exists trg_enforce_registration_request_self_write on public.user_registration_requests;
create trigger trg_enforce_registration_request_self_write
  before update on public.user_registration_requests
  for each row execute function public.enforce_registration_request_self_write();

-- Row Level Security & Access Grants
alter table public.user_registration_requests enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.user_registration_requests from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select, insert, update on public.user_registration_requests to authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant all on public.user_registration_requests to service_role;
    grant execute on function public.set_updated_at_user_registration_requests() to service_role;
    grant execute on function public.enforce_registration_request_self_write() to service_role;
  end if;
end $$;

-- Note on RLS Policies:
-- Table-level RLS is enabled above and role grants are established.
-- Specific self-service policies ("registration_requests: self select",
-- "registration_requests: self insert", and "registration_requests: self update while pending")
-- are formally authored and attached by 20260928000003_phase4_registration_approval_admin.sql
-- (Part N). They are not pre-emptively created here to maintain forward-compatibility
-- with Phase 4's unmodified migration execution.

-- =======================================================================
-- DOCUMENTED ROLLBACK
--
-- drop policy if exists "registration_requests: self update while pending" on public.user_registration_requests;
-- drop policy if exists "registration_requests: self insert" on public.user_registration_requests;
-- drop policy if exists "registration_requests: self select" on public.user_registration_requests;
-- drop trigger if exists trg_enforce_registration_request_self_write on public.user_registration_requests;
-- drop trigger if exists trg_user_registration_requests_updated_at on public.user_registration_requests;
-- drop function if exists public.enforce_registration_request_self_write();
-- drop function if exists public.set_updated_at_user_registration_requests();
-- drop table if exists public.user_registration_requests;
-- =======================================================================
