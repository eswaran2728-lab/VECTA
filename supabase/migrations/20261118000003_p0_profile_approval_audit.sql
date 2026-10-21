-- Approval/rejection audit fields used by the current registration admin
-- actions. This intentionally does not restore unified_role, org_id, duty_post
-- or ops_group authority columns.
alter table public.profiles
  add column if not exists approved_by uuid references public.profiles(id),
  add column if not exists approved_at timestamptz,
  add column if not exists rejection_reason text;
