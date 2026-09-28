-- PHASE 3 -- SCOPED ROLE/PERMISSION FOUNDATION (2026-09-28)
-- Malaysia AOC upgrade. Additive only, same guarantee as Phase 2: no
-- existing table/column/policy/function/grant is touched, renamed or
-- dropped, and NO existing legacy permission is broadened. This phase
-- adds infrastructure only -- it does not rebuild any feature and does
-- not retire MANAGEMENT/ADMIN/ENFORCEMENT/DSE/SO/ASO or any ICMS role.
--
-- Covers:
--   Part A: role_definitions (27 required role codes, seeded, inactive
--           until a real assignment references them)
--   Part B: user_role_assignments (scoped, audited, multi-assignment-safe)
--   Part C: scope-shape validation trigger (closes null-scope bypass
--           per role category -- the international/platform roles are
--           the ONLY codes ever permitted a null aoc_id, and that is
--           enforced here, not assumed)
--   Part D: effective-permission helper functions (generic, few, reused
--           by every future scope check rather than one helper per screen)
--   Part E: RLS / grants (deny-all on the assignment table; narrow
--           read-only catalog access to role_definitions; self-read of
--           one's own effective roles via a SECURITY DEFINER RPC, never
--           direct table access)
--   Part F: compatibility layer documentation (no code here -- see the
--           report's Part 8 for what "compatibility" means structurally
--           in this phase)
--
-- NOT done in this migration (explicitly deferred):
--   - no production user is migrated or assigned any new role
--   - no existing RLS policy, requireRole() call, or legacy helper
--     (current_role_name, current_role_rank, is_approved_management,
--     is_active_supervisor, is_monitor_or_above) is modified or replaced
--   - no UI/role-management workflow (Phase 4)
--   - no report/dashboard table is granted new access because of this
--     migration (Compliance, CaterLink Management, and every other new
--     role get a role_definitions ROW and a scope-shape RULE in this
--     phase -- not a single new grant on any existing table)

-- =======================================================================
-- PART A: role_definitions
-- =======================================================================
create table if not exists public.role_definitions (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  display_name text not null,
  role_category text not null check (role_category in (
    'international', 'malaysia_leadership', 'enforcement', 'operation', 'caterlink'
  )),
  description text not null default '',
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

insert into public.role_definitions (code, display_name, role_category, description) values
  ('airasia_management', 'AirAsia Management', 'international', 'International executive dashboard-only. No operational write permissions.'),
  ('ghod', 'GHOD', 'international', 'International executive dashboard, read-only flagged reports, future global-announcement authority.'),
  ('global_reporting_controller', 'VECTA Global Reporting Controller', 'international', 'Controls the Central Reporting Repository across all AOCs. No automatic original-report modification.'),
  ('super_admin', 'Super Admin', 'international', 'Technical platform administration. No automatic operational-report authority.'),
  ('maa_boss', 'MAA Boss', 'malaysia_leadership', 'Malaysia overview + MAA detailed-report scope.'),
  ('aax_boss', 'AAX Boss', 'malaysia_leadership', 'Malaysia overview + AAX detailed-report scope.'),
  ('maa_admin', 'MAA Admin', 'malaysia_leadership', 'Malaysia AOC + MAA entity administration scope.'),
  ('aax_admin', 'AAX Admin', 'malaysia_leadership', 'Malaysia AOC + AAX entity administration scope.'),
  ('operation_manager', 'Operation Manager', 'malaysia_leadership', 'Malaysia AOC + Operation department.'),
  ('main_enforcement', 'Main Enforcement', 'malaysia_leadership', 'Malaysia AOC + Enforcement department.'),
  ('compliance', 'Compliance', 'malaysia_leadership', 'Malaysia AOC + Compliance department, read-only by design.'),
  ('investigation_sso', 'Investigation SSO', 'enforcement', 'Malaysia + Enforcement + Investigation unit.'),
  ('investigation_so', 'Investigation SO', 'enforcement', 'Malaysia + Enforcement + Investigation unit.'),
  ('investigation_aso', 'Investigation ASO', 'enforcement', 'Malaysia + Enforcement + Investigation unit.'),
  ('sat_aso', 'SAT ASO', 'enforcement', 'Malaysia + Enforcement + SAT unit + KUL hub scope.'),
  ('profiling_so', 'Profiling SO', 'enforcement', 'Malaysia + Enforcement + Profiling unit.'),
  ('profiling_aso', 'Profiling ASO', 'enforcement', 'Malaysia + Enforcement + Profiling unit.'),
  ('hub_se', 'Hub SE', 'operation', 'Malaysia + Operation + one assigned hub.'),
  ('dse', 'DSE', 'operation', 'Malaysia + Operation + KUL hub + one assigned team.'),
  ('sso', 'SSO', 'operation', 'Malaysia + Operation + assigned station/team.'),
  ('so', 'SO', 'operation', 'Malaysia + Operation + assigned station/team.'),
  ('aso', 'ASO', 'operation', 'Malaysia + Operation + assigned station/team.'),
  ('caterlink_management', 'CaterLink Management Team', 'caterlink', 'Malaysia + CaterLink department. Management/monitoring only; never checkpoint access through this role.')
on conflict (code) do nothing;

-- =======================================================================
-- PART B: user_role_assignments
-- =======================================================================
create table if not exists public.user_role_assignments (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id),
  role_definition_id uuid not null references public.role_definitions(id),

  aoc_id uuid references public.aocs(id),
  operating_entity_id uuid references public.operating_entities(id),
  department_id uuid references public.departments(id),
  unit_id uuid references public.units(id),
  hub_id uuid references public.hubs(id),
  station_id uuid references public.org_stations(id),
  team_id uuid references public.org_teams(id),

  starts_at timestamptz not null default now(),
  ends_at timestamptz,
  revoked_at timestamptz,

  granted_by uuid references public.profiles(id),
  grant_reason text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Structural self-promotion defense-in-depth: a grantor may never be
  -- the same person as the subject at the database layer, independent
  -- of whatever workflow Phase 4 builds on top. NULL granted_by is
  -- reserved for system/migration-seeded rows (documented, not used by
  -- this migration -- Part B seeds zero assignment rows).
  constraint user_role_assignments_no_self_grant check (granted_by is distinct from profile_id),

  -- ends_at, if set, must be after starts_at.
  constraint user_role_assignments_valid_window check (ends_at is null or ends_at > starts_at)
);

-- Prevents duplicate *active* assignments of the identical role+scope to
-- the same profile (a revoked/expired row does not block a fresh grant --
-- the partial index only covers currently-live rows). NULLS in a scope
-- column are treated as equal to each other here (via coalesce to a
-- fixed sentinel) so two rows that both leave e.g. team_id NULL for the
-- same hub_se are still caught as duplicates.
create unique index if not exists user_role_assignments_active_unique
  on public.user_role_assignments (
    profile_id,
    role_definition_id,
    coalesce(aoc_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(operating_entity_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(department_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(unit_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(hub_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(station_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(team_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  where revoked_at is null;

create index if not exists user_role_assignments_profile_idx on public.user_role_assignments (profile_id) where revoked_at is null;
create index if not exists user_role_assignments_role_idx on public.user_role_assignments (role_definition_id) where revoked_at is null;

create or replace function public.set_updated_at_user_role_assignments()
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

drop trigger if exists trg_user_role_assignments_updated_at on public.user_role_assignments;
create trigger trg_user_role_assignments_updated_at
  before update on public.user_role_assignments
  for each row execute function public.set_updated_at_user_role_assignments();

-- =======================================================================
-- PART C: scope-shape validation trigger
-- =======================================================================
-- Closes "null-scope bypass" structurally: the four international/
-- platform role codes are the ONLY codes ever permitted a fully null
-- scope (aoc_id included) -- every other role code REQUIRES aoc_id, and
-- most require the specific narrower scope column(s) the spec assigns
-- them. This is enforced on every INSERT/UPDATE, not just documented,
-- so a malformed row (e.g. a 'dse' assignment with no team_id, or any
-- non-international role with a null aoc_id) is rejected by Postgres
-- itself, independent of whatever application code writes the row.
create or replace function public.validate_user_role_assignment_scope()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_code text;
begin
  select rd.code into v_code from public.role_definitions rd where rd.id = new.role_definition_id;
  if v_code is null then
    raise exception 'Unknown role_definition_id.';
  end if;

  if v_code in ('airasia_management', 'ghod', 'global_reporting_controller', 'super_admin') then
    if new.aoc_id is not null
       or new.operating_entity_id is not null
       or new.department_id is not null
       or new.unit_id is not null
       or new.hub_id is not null
       or new.station_id is not null
       or new.team_id is not null
    then
      raise exception '% is an international/platform role and must carry no AOC or narrower scope.', v_code;
    end if;
    return new;
  end if;

  -- Every non-international role requires an explicit AOC -- this is the
  -- actual null-scope-bypass closure. A null aoc_id here would otherwise
  -- silently mean "every AOC" to any scope-matching helper that treats
  -- null as a wildcard, which is exactly the bypass class this rule
  -- prevents.
  if new.aoc_id is null then
    raise exception '% requires an explicit aoc_id.', v_code;
  end if;

  if v_code in ('maa_boss', 'maa_admin') then
    if new.operating_entity_id is null then
      raise exception '% requires operating_entity_id.', v_code;
    end if;
    if (select oe.code from public.operating_entities oe where oe.id = new.operating_entity_id) <> 'MAA' then
      raise exception '% must be scoped to the MAA operating entity, not any other.', v_code;
    end if;
  end if;

  if v_code in ('aax_boss', 'aax_admin') then
    if new.operating_entity_id is null then
      raise exception '% requires operating_entity_id.', v_code;
    end if;
    if (select oe.code from public.operating_entities oe where oe.id = new.operating_entity_id) <> 'AAX' then
      raise exception '% must be scoped to the AAX operating entity, not any other.', v_code;
    end if;
  end if;

  if v_code in ('operation_manager', 'main_enforcement', 'compliance', 'caterlink_management') then
    if new.department_id is null then
      raise exception '% requires department_id.', v_code;
    end if;
  end if;

  if v_code in ('investigation_sso', 'investigation_so', 'investigation_aso') then
    if new.unit_id is null then
      raise exception '% requires unit_id (Investigation).', v_code;
    end if;
  end if;

  if v_code = 'sat_aso' then
    if new.unit_id is null or new.hub_id is null then
      raise exception 'sat_aso requires unit_id (SAT) and hub_id (KUL).';
    end if;
    if (select h.code from public.hubs h where h.id = new.hub_id) <> 'kul' then
      raise exception 'sat_aso must be scoped to the KUL hub only.';
    end if;
  end if;

  if v_code in ('profiling_so', 'profiling_aso') then
    if new.unit_id is null then
      raise exception '% requires unit_id (Profiling).', v_code;
    end if;
  end if;

  if v_code = 'hub_se' then
    if new.hub_id is null then
      raise exception 'hub_se requires hub_id.';
    end if;
  end if;

  if v_code = 'dse' then
    if new.hub_id is null or new.team_id is null then
      raise exception 'dse requires hub_id (KUL) and team_id (own team only).';
    end if;
    if (select h.code from public.hubs h where h.id = new.hub_id) <> 'kul' then
      raise exception 'dse must be scoped to the KUL hub only; non-KUL hubs use hub_se instead.';
    end if;
  end if;

  if v_code in ('sso', 'so', 'aso') then
    if new.station_id is null then
      raise exception '% requires station_id.', v_code;
    end if;
  end if;

  return new;
end;
$function$;

drop trigger if exists trg_validate_user_role_assignment_scope on public.user_role_assignments;
create trigger trg_validate_user_role_assignment_scope
  before insert or update on public.user_role_assignments
  for each row execute function public.validate_user_role_assignment_scope();

-- =======================================================================
-- PART D: effective-permission helper functions
-- =======================================================================
-- Deliberately few and generic -- every future scope check (this phase
-- and every later one) should compose from these rather than adding a
-- bespoke helper per screen/role.
--
-- Every helper below:
--   - is STABLE, SECURITY DEFINER, with a fixed search_path
--   - reads ONLY auth.uid()'s own assignments (never a client-supplied
--     profile id -- there is no p_profile_id parameter anywhere here)
--   - requires the caller's own profiles.status = 'approved'
--   - requires the assignment to be currently effective: revoked_at is
--     null, starts_at <= now(), and (ends_at is null or ends_at > now())
--   - requires role_definitions.is_active = true

-- Does the caller have an active assignment for role code X, with the
-- given scope dimensions ALL matching the SAME assignment row (never a
-- union across two different narrower assignments -- see the migration
-- header and the Phase 3 report for why that distinction matters)?
-- Every parameter besides p_role_code is optional; omitted parameters
-- are not checked. Passing p_aoc_id lets an international role's
-- (aoc_id IS NULL) row match any queried AOC -- correct by construction,
-- since Part C's trigger is the only thing that can ever create such a
-- row, and it permits that only for the four global role codes.
create or replace function public.has_role_in_scope(
  p_role_code text,
  p_aoc_id uuid default null,
  p_operating_entity_id uuid default null,
  p_department_id uuid default null,
  p_unit_id uuid default null,
  p_hub_id uuid default null,
  p_station_id uuid default null,
  p_team_id uuid default null
)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select exists (
    select 1
    from public.user_role_assignments ura
    join public.role_definitions rd on rd.id = ura.role_definition_id
    join public.profiles p on p.id = ura.profile_id
    where ura.profile_id = auth.uid()
      and rd.code = p_role_code
      and rd.is_active
      and p.status = 'approved'
      and ura.revoked_at is null
      and ura.starts_at <= now()
      and (ura.ends_at is null or ura.ends_at > now())
      and (p_aoc_id is null or ura.aoc_id = p_aoc_id or ura.aoc_id is null)
      and (p_operating_entity_id is null or ura.operating_entity_id = p_operating_entity_id)
      and (p_department_id is null or ura.department_id = p_department_id)
      and (p_unit_id is null or ura.unit_id = p_unit_id)
      and (p_hub_id is null or ura.hub_id = p_hub_id)
      and (p_station_id is null or ura.station_id = p_station_id)
      and (p_team_id is null or ura.team_id = p_team_id)
  );
$function$;

-- Convenience wrapper: does the caller hold role X at all (no scope
-- check)? Used for the four international codes and for simple
-- allow/deny checks where scope is irrelevant (e.g. "is the caller
-- super_admin").
create or replace function public.has_active_role(p_role_code text)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select public.has_role_in_scope(p_role_code);
$function$;

-- Self-read only: returns the caller's OWN currently-effective
-- assignments, resolved to human-readable codes rather than raw ids, and
-- nothing about any other user. This is the only way an ordinary
-- authenticated session can read anything from user_role_assignments in
-- this phase -- there is no SELECT policy on the table itself (Part E).
create or replace function public.get_my_active_role_assignments()
returns table (
  role_code text,
  role_category text,
  aoc_code text,
  operating_entity_code text,
  department_code text,
  unit_code text,
  hub_code text,
  station_code text,
  team_name text,
  starts_at timestamptz,
  ends_at timestamptz
)
language sql
stable
security definer
set search_path to 'public'
as $function$
  select
    rd.code,
    rd.role_category,
    a.code,
    oe.code,
    d.code,
    u.code,
    h.code,
    s.code,
    t.name,
    ura.starts_at,
    ura.ends_at
  from public.user_role_assignments ura
  join public.role_definitions rd on rd.id = ura.role_definition_id
  join public.profiles p on p.id = ura.profile_id
  left join public.aocs a on a.id = ura.aoc_id
  left join public.operating_entities oe on oe.id = ura.operating_entity_id
  left join public.departments d on d.id = ura.department_id
  left join public.units u on u.id = ura.unit_id
  left join public.hubs h on h.id = ura.hub_id
  left join public.org_stations s on s.id = ura.station_id
  left join public.org_teams t on t.id = ura.team_id
  where ura.profile_id = auth.uid()
    and rd.is_active
    and p.status = 'approved'
    and ura.revoked_at is null
    and ura.starts_at <= now()
    and (ura.ends_at is null or ura.ends_at > now());
$function$;

revoke execute on function public.has_role_in_scope(text, uuid, uuid, uuid, uuid, uuid, uuid, uuid) from public, anon;
grant execute on function public.has_role_in_scope(text, uuid, uuid, uuid, uuid, uuid, uuid, uuid) to authenticated, service_role;

revoke execute on function public.has_active_role(text) from public, anon;
grant execute on function public.has_active_role(text) to authenticated, service_role;

revoke execute on function public.get_my_active_role_assignments() from public, anon;
grant execute on function public.get_my_active_role_assignments() to authenticated, service_role;

revoke execute on function public.validate_user_role_assignment_scope() from public, anon, authenticated;
grant execute on function public.validate_user_role_assignment_scope() to service_role;
-- Trigger functions never need direct EXECUTE for anyone (Postgres does
-- not check EXECUTE for trigger-fired invocation) -- granted to
-- service_role only for consistency/administrative use, not because
-- trigger firing requires it.

revoke execute on function public.set_updated_at_user_role_assignments() from public, anon, authenticated;
grant execute on function public.set_updated_at_user_role_assignments() to service_role;

-- =======================================================================
-- PART E: RLS / grants
-- =======================================================================
alter table public.role_definitions enable row level security;
alter table public.user_role_assignments enable row level security;

-- role_definitions: a non-sensitive catalog (role codes/names/categories
-- only, no assignment data) -- safe to let authenticated read directly so
-- future UI can render role pickers/labels without a bespoke RPC. No
-- write access for anyone but service_role.
revoke all on public.role_definitions from public, anon;
revoke insert, update, delete, truncate on public.role_definitions from authenticated;
grant select on public.role_definitions to authenticated;
grant all on public.role_definitions to service_role;

-- user_role_assignments: deny-all. No SELECT/INSERT/UPDATE/DELETE policy
-- for anon or authenticated at all -- self-read goes exclusively through
-- get_my_active_role_assignments() above, and writes go exclusively
-- through service_role (Phase 4 will add the narrowly-scoped MAA/AAX
-- Admin write RPCs; none exist yet, so there is currently NO path by
-- which any authenticated user, including an admin, can write a row).
-- This is the concrete mechanism behind "self-assignment denial" and
-- "self-promotion denial" in this phase: the capability to write simply
-- does not exist yet for any non-service_role caller.
revoke all on public.user_role_assignments from public, anon, authenticated;
grant all on public.user_role_assignments to service_role;

-- =======================================================================
-- DOCUMENTED ROLLBACK (not executed by this file -- reference only, run
-- manually and only against a target where this migration was actually
-- applied). Dependency-safe order: user_role_assignments references
-- profiles, role_definitions, and every Phase 2 org table, so it must be
-- dropped before role_definitions and before any Phase 2 table. This
-- migration adds no new columns to profiles or any Phase 2 table, so no
-- Phase-2-style column-drop step is needed here -- only whole objects.
--
-- 1. Drop the two triggers and their functions (dependents of the
--    table, must go before the table):
--      drop trigger if exists trg_validate_user_role_assignment_scope on public.user_role_assignments;
--      drop trigger if exists trg_user_role_assignments_updated_at on public.user_role_assignments;
--      drop function if exists public.validate_user_role_assignment_scope();
--      drop function if exists public.set_updated_at_user_role_assignments();
--
-- 2. Drop the three helper functions (they read from
--    user_role_assignments, so must go before it is dropped):
--      drop function if exists public.get_my_active_role_assignments();
--      drop function if exists public.has_active_role(text);
--      drop function if exists public.has_role_in_scope(text, uuid, uuid, uuid, uuid, uuid, uuid, uuid);
--
-- 3. Drop user_role_assignments (references role_definitions and every
--    Phase 2 org table -- must go before role_definitions):
--      drop table if exists public.user_role_assignments;
--
-- 4. Drop role_definitions last (nothing in this migration references
--    it except the table just dropped in step 3):
--      drop table if exists public.role_definitions;
--
-- This migration does not alter any Phase 2 table or profiles column, so
-- Phase 2's own documented rollback (in
-- 20260928000001_phase2_org_foundation.sql) remains valid and
-- independent -- rolling back Phase 3 first, then Phase 2, is always
-- safe; rolling back Phase 2 while Phase 3 is still applied is NOT safe
-- (user_role_assignments' FKs into aocs/operating_entities/departments/
-- units/hubs/org_stations/org_teams would block it) and must not be
-- attempted out of order.
