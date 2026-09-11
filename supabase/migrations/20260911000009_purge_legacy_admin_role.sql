-- ============================================================
-- Migration: Purge Legacy Admin Role & Align Identities to Management
-- Migration ID: 20260911000009_purge_legacy_admin_role.sql
-- Description:
-- 1. Updates any profiles with role = 'ADMIN' to 'MANAGEMENT'
-- 2. Updates any profiles with unified_role = 'admin' to 'management'
-- 3. Updates any profiles/users with name 'VECTA Admin' to 'VECTA Management'
-- 4. Updates any ICMS users with unified_role = 'admin' to 'management'
-- 5. Ensures unified_role check constraints remain strictly enforced
-- ============================================================

-- 1. Update public.profiles table
alter table public.profiles disable trigger user;

update public.profiles
set
  role = 'MANAGEMENT',
  unified_role = 'management'
where role = 'ADMIN' or unified_role = 'admin';

update public.profiles
set name = 'VECTA Management'
where name = 'VECTA Admin';

alter table public.profiles enable trigger user;

-- 2. Update public.users table (ICMS & shadow users)
update public.users
set
  role = case when role = 'supervisor' then 'management' else role end,
  unified_role = 'management'
where unified_role = 'admin' or role = 'supervisor';

update public.users
set name = 'VECTA Management'
where name = 'VECTA Admin';

-- 3. Re-verify unified_role check constraints
alter table public.profiles drop constraint if exists profiles_unified_role_check;
alter table public.profiles
  add constraint profiles_unified_role_check
  check (unified_role in ('super_admin', 'management', 'enforcement', 'dse', 'so', 'aso', 'vendor'));

alter table public.users drop constraint if exists users_unified_role_check;
alter table public.users
  add constraint users_unified_role_check
  check (unified_role in ('super_admin', 'management', 'enforcement', 'dse', 'so', 'aso', 'vendor'));
