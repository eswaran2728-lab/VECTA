-- Real root cause of the failed live E2E approval test (2026-09-21):
-- migration 20260921000001 fixed the enforce_profile_self_update TRIGGER,
-- but the UPDATE never reaches that trigger for a MANAGEMENT user acting on
-- someone else's row, because no RLS policy on public.profiles permits it.
-- Existing policies:
--   "profiles admin manage"  (ALL)    USING/CHECK: current_role_name() = 'ADMIN'
--   "profiles self update"   (UPDATE) USING/CHECK: id = auth.uid()
-- Neither matches "MANAGEMENT updating a different user's row", so
-- PostgreSQL RLS silently excludes the row from the UPDATE's target set —
-- 0 rows affected, no exception. approveUser()/rejectUser() didn't check
-- the response, so the UI showed no error at all (root cause of the report
-- "clicking APPROVE simply did not complete").
--
-- This adds a policy mirroring the trigger's exact narrow rule as an
-- RLS-layer gate (role + status-transition direction only); the trigger
-- remains the precise enforcer that no other field changes in the same
-- statement and that self-approval/self-promotion-to-ADMIN stay blocked.

create policy "profiles management approve pending" on public.profiles
for update
using (
  current_role_name() = 'MANAGEMENT'
  and status = 'pending'
)
with check (
  current_role_name() = 'MANAGEMENT'
  and status in ('approved', 'rejected')
);
