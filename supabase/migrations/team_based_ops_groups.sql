-- ============================================================
-- New team-based ops model. Adds `ops_group` — a SEPARATE axis from
-- the existing `team` column on profiles (ALPHA/BRAVO/CHARLIE/DELTA
-- shift-rotation teams, used by duty rostering/team_rosters — left
-- completely untouched). ops_group is the functional grouping that
-- scopes Reports/Scan visibility: operation_avsec, ifc_avsec,
-- hub_avsec. admin/management/enforcement get NULL (see across all
-- three); so/aso/dse must have exactly one.
--
-- Mapping decisions (confirmed with the project owner, not guessed):
-- - demo.so/demo.aso/demo.dse (AVSEC-native, shift-team ALPHA) sit
--   under operation_avsec.
-- - ICMS checkpoint accounts: Post 6 + REDQ -> operation_avsec,
--   Post 2 -> ifc_avsec, Hub -> hub_avsec.
-- - warehouse_pic/receiver/vendor are obsolete roles (moving to a
--   separate app, CaterLink, built independently) — their 3 accounts
--   are disabled (login blocked via auth.users.banned_until, status
--   set to 'disabled'), not deleted or reassigned, per an explicit
--   decision to keep them as historical record. Their role values
--   are intentionally left as-is; the app's active role list/UI no
--   longer offers these roles for new accounts (enforced in
--   application code, not by tightening the DB check constraint, so
--   these historical rows stay valid).
-- ============================================================

alter table public.profiles
  add column if not exists ops_group text
    check (ops_group in ('operation_avsec', 'ifc_avsec', 'hub_avsec'));

alter table public.users
  add column if not exists ops_group text
    check (ops_group in ('operation_avsec', 'ifc_avsec', 'hub_avsec'));

alter table public.profiles disable trigger profiles_enforce_self_update;

update public.profiles set ops_group = 'operation_avsec'
where id in (
  'a0000000-0000-4000-8000-000000000005', -- demo.so
  'a0000000-0000-4000-8000-000000000006', -- demo.aso
  'a0000000-0000-4000-8000-000000000007'  -- demo.dse
);

alter table public.profiles enable trigger profiles_enforce_self_update;

update public.users set ops_group = 'operation_avsec' where duty_post in ('Post 6', 'REDQ');
update public.users set ops_group = 'ifc_avsec' where duty_post = 'Post 2';
update public.users set ops_group = 'hub_avsec' where duty_post = 'Hub';

-- Widen status to add a real 'disabled' state, distinct from 'rejected'
-- (never-approved) — used for accounts on now-obsolete roles.
alter table public.users drop constraint users_status_check;
alter table public.users
  add constraint users_status_check
  check (status = any (array['pending', 'active', 'rejected', 'disabled']));

update auth.users
set banned_until = '2099-01-01T00:00:00Z'
where id in (
  'a0000000-0000-4000-8000-000000000008', -- demo.vendor
  'a0000000-0000-4000-8000-000000000009', -- demo.warehouse
  'a0000000-0000-4000-8000-00000000000c'  -- demo.receiver
);

update public.users set status = 'disabled'
where id in (
  'a0000000-0000-4000-8000-000000000008',
  'a0000000-0000-4000-8000-000000000009',
  'a0000000-0000-4000-8000-00000000000c'
);
