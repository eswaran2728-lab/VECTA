-- Phase 2 (claims contract, see AUTH-CONTRACT.md): a read-only normalising
-- view over the two existing profile tables (public.profiles AVSEC-origin,
-- public.users ICMS-origin), plus additive, JWT-claim-aware helper
-- functions for the four claims that carry team/station/staff_id scope.
--
-- This does NOT touch current_user_role()/current_role_name()/
-- current_team()/current_station()/role_rank() or any existing RLS policy.
-- Those functions return each app's ORIGINAL per-app role vocabulary
-- (e.g. 'post2_avsec', 'ASO') that dozens of live policies are hardcoded
-- against — see unified_role_model.sql's header for why that vocabulary
-- was deliberately never touched. The claim contract's `app_role` is a
-- DIFFERENT, coarser vocabulary (unified_role: admin/management/
-- enforcement/so/aso/dse/vendor) — conflating the two would silently
-- break every checkpoint-specific policy. New code should read claims
-- through user_claims/current_app_role() below; existing RLS keeps using
-- its own functions unchanged.
--
-- Reversible: drop view public.user_claims; drop function
-- public.current_app_role(); drop function public.current_team_claim();
-- drop function public.current_station_claim(); drop function
-- public.current_staff_id_claim();

create or replace view public.user_claims
with (security_invoker = true) as
select
  p.id,
  p.email,
  'authenticated'::text as role,
  p.unified_role as app_role,
  case p.ops_group
    when 'operation_avsec' then 'operation'
    when 'ifc_avsec' then 'ifc'
    when 'hub_avsec' then 'hub'
    else null
  end as team,
  p.station,
  nullif(p.staff_no, '') as staff_id,
  null::text as vendor_id,
  p.status::text as status,
  'profiles'::text as source_table
from public.profiles p
union all
select
  u.id,
  u.email,
  'authenticated'::text as role,
  u.unified_role as app_role,
  case u.ops_group
    when 'operation_avsec' then 'operation'
    when 'ifc_avsec' then 'ifc'
    when 'hub_avsec' then 'hub'
    else null
  end as team,
  null::text as station,
  nullif(u.staff_id, '') as staff_id,
  -- No vendor_id column exists anywhere yet (see MIGRATION-AUDIT.md §7 /
  -- CATERLINK's audit): vendor association today is purely
  -- unified_role = 'vendor' on this same shared users row. Emitting a
  -- literal null keeps the claim contract's shape honest rather than
  -- inventing an id no table actually has.
  null::text as vendor_id,
  u.status,
  'users'::text as source_table
from public.users u;

comment on view public.user_claims is
  'Phase 2 claims contract (AUTH-CONTRACT.md): normalises public.profiles '
  '(AVSEC-origin) and public.users (ICMS-origin) into one row shape per '
  'account. Read-only — role data is still written through each table''s '
  'own admin actions, this view does not become a new writable source of '
  'truth. security_invoker means callers see only what their own RLS on '
  'profiles/users would already let them see.';

-- Additive, JWT-claim-aware readers for the claim contract itself (NOT a
-- replacement for current_user_role()/current_team()/current_station()
-- above). Once Phase 3 sets these as Firebase custom claims and Phase 3's
-- /api/auth/sync-claims mirrors them onto the Supabase-recognised JWT,
-- these functions read the claim directly with no DB round trip; until
-- then auth.jwt() ->> '<claim>' is always null under Supabase's own
-- token shape, so the COALESCE falls through to today's DB lookup and
-- behaviour is unchanged.

create or replace function public.current_app_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    auth.jwt() ->> 'app_role',
    (select unified_role from profiles where id = auth.uid()),
    (select unified_role from users where id = auth.uid())
  );
$$;

create or replace function public.current_team_claim()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    auth.jwt() ->> 'team',
    (select case ops_group
       when 'operation_avsec' then 'operation'
       when 'ifc_avsec' then 'ifc'
       when 'hub_avsec' then 'hub'
       else null
     end from profiles where id = auth.uid()),
    (select case ops_group
       when 'operation_avsec' then 'operation'
       when 'ifc_avsec' then 'ifc'
       when 'hub_avsec' then 'hub'
       else null
     end from users where id = auth.uid())
  );
$$;

create or replace function public.current_station_claim()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    auth.jwt() ->> 'station',
    (select station from profiles where id = auth.uid())
  );
$$;

create or replace function public.current_staff_id_claim()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    auth.jwt() ->> 'staff_id',
    (select nullif(staff_no, '') from profiles where id = auth.uid()),
    (select nullif(staff_id, '') from users where id = auth.uid())
  );
$$;

comment on function public.current_app_role() is
  'Phase 2 claims contract: app_role claim, JWT-first with a DB fallback '
  'that is exact today (no custom claims exist yet). Distinct from '
  'current_user_role()/current_role_name(), which existing RLS keeps '
  'using unchanged — see this file''s header comment.';
