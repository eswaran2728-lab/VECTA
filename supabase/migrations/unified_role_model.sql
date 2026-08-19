-- ============================================================
-- Unified role model layer (additive, non-destructive).
--
-- Final unified role vocabulary: admin, management, enforcement, so,
-- aso, dse, vendor.
--
-- IMPORTANT: this does NOT rename AVSEC's existing `user_role` enum
-- values (ASO/SO/DSE/ENFORCEMENT/MANAGEMENT/ADMIN) or ICMS's existing
-- `users.role` text values (warehouse_pic/post2_avsec/.../supervisor).
-- Dozens of live RLS policies across ~20 tables (role_rank(),
-- current_role_name(), current_role_rank(), per-table policies) are
-- hardcoded against those exact strings; renaming them in place would
-- risk breaking every report/duty/admin policy in the running
-- production app instantly. Instead, a new `unified_role` column
-- carries the new vocabulary as a read layer for the app (middleware,
-- landing page); the original `role` column and every existing policy
-- keep working exactly as they do today.
--
-- Applied directly against AVSEC's Supabase project (ddlctzbnqewubltcavkh)
-- via the Supabase MCP tool. This file records that migration for the
-- repo's history/reproducibility.
-- ============================================================

alter table public.profiles
  add column if not exists unified_role text
    check (unified_role in ('admin', 'management', 'enforcement', 'so', 'aso', 'dse', 'vendor')),
  add column if not exists duty_post text
    check (duty_post in ('Post 2', 'Post 6', 'Hub', 'REDQ', 'Warehouse', 'Receiver'));

-- profiles_enforce_self_update blocks bulk updates outside an
-- authenticated user's own row — disable for this one-time backfill.
alter table public.profiles disable trigger profiles_enforce_self_update;

update public.profiles set unified_role = case role::text
  when 'ADMIN' then 'admin'
  when 'MANAGEMENT' then 'management'
  when 'ENFORCEMENT' then 'enforcement'
  when 'SO' then 'so'
  when 'ASO' then 'aso'
  when 'DSE' then 'dse'
  else null
end
where unified_role is null;

alter table public.profiles enable trigger profiles_enforce_self_update;

-- ICMS users: same unified_role column + duty_post (the ICMS role IS
-- the "original station/post" per the unified-role mapping: every
-- ICMS role other than supervisor/enforcement/vendor maps to 'aso',
-- with duty_post recording which post/station it came from).
alter table public.users
  add column if not exists unified_role text
    check (unified_role in ('admin', 'management', 'enforcement', 'so', 'aso', 'dse', 'vendor')),
  add column if not exists duty_post text
    check (duty_post in ('Post 2', 'Post 6', 'Hub', 'REDQ', 'Warehouse', 'Receiver'));

update public.users set
  unified_role = case role
    when 'supervisor' then 'admin'
    when 'enforcement' then 'enforcement'
    when 'vendor' then 'vendor'
    when 'warehouse_pic' then 'aso'
    when 'post2_avsec' then 'aso'
    when 'post6_avsec' then 'aso'
    when 'receiver' then 'aso'
    when 'hub_avsec' then 'aso'
    when 'redq_avsec' then 'aso'
    else null
  end,
  duty_post = case role
    when 'warehouse_pic' then 'Warehouse'
    when 'post2_avsec' then 'Post 2'
    when 'post6_avsec' then 'Post 6'
    when 'receiver' then 'Receiver'
    when 'hub_avsec' then 'Hub'
    when 'redq_avsec' then 'REDQ'
    else null
  end
where unified_role is null;
