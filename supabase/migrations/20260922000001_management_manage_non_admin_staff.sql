-- Extends the MANAGEMENT/ADMIN parity fix from the approval investigation
-- (20260921000001/000002) to the rest of lib/avsec/admin/actions.ts.
--
-- The app already gates createStaffAccount(), deactivateUser(), and
-- updateUserAssignment() on requireRole(MANAGEMENT_ROLES) = [MANAGEMENT,
-- ADMIN], but only "profiles admin manage" (role = 'ADMIN') and the narrow
-- pending-approval policy existed at the RLS layer — so a real MANAGEMENT
-- user calling any of these three would hit the same silent-no-op failure
-- approveUser() did before the fix.
--
-- This is intentionally NOT a merge into the blanket "profiles admin
-- manage" (ALL commands, no role restriction) policy - that would let
-- MANAGEMENT modify or promote ADMIN accounts, which the app itself never
-- intends (createStaffAccount/updateUserAssignment both normalize a
-- requested 'ADMIN' role down to 'MANAGEMENT' before ever reaching the
-- database). Instead this is scoped: MANAGEMENT may UPDATE any profile
-- whose role is not, and does not become, ADMIN. ADMIN accounts remain
-- untouchable by MANAGEMENT at the RLS layer, not just by app-layer
-- convention.

create policy "profiles management manage non-admin staff" on public.profiles
for update
using (
  current_role_name() = 'MANAGEMENT'
  and role <> 'ADMIN'
)
with check (
  current_role_name() = 'MANAGEMENT'
  and role <> 'ADMIN'
);
