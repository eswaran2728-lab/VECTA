-- ============================================================
-- Auto-provision ICMS shadow rows for every AVSEC-native account.
--
-- ICMS's own access control (lib/icms/auth.ts requireProfile()) only
-- recognizes a row in public.users, keyed off ICMS's native role
-- vocabulary. An account that exists only in public.profiles
-- (AVSEC-origin) has no ICMS identity at all and always redirects to
-- /login?error=no-profile regardless of unified_role.
-- grant_icms_access_to_admin_enforcement.sql already did this for 3
-- specific accounts (admin x2, enforcement x1). This is the general
-- version: for EVERY public.profiles row with no matching public.users
-- row, insert one, so it also catches demo.management/demo.so/
-- demo.aso/demo.dse and any future ones — `where not exists` makes it
-- safe to re-run without erroring or duplicating on the 3 already
-- provisioned.
--
-- Role mapping (see lib/icms/shadow-user.ts mapAvsecRoleToIcmsRole —
-- this SQL restates the same rules; keep the two in sync):
--   ADMIN      -> supervisor  (ICMS's own admin-equivalent role)
--   ENFORCEMENT -> enforcement (direct match)
--   MANAGEMENT -> management  (new role, full parity with enforcement
--                              — see management_icms_parity.sql)
--   SO/ASO/DSE -> ops_staff   (JUDGMENT CALL, made in the project
--     owner's absence, flagged for their review — not a confirmed
--     decision like the three mappings above. No existing ICMS role
--     represents generic patrol staff: only checkpoint-specific roles
--     like post2_avsec, or elevated roles like supervisor/enforcement/
--     management. A checkpoint role would over-grant that checkpoint's
--     permissions; an elevated role would over-grant org-wide
--     visibility. 'ops_staff' is new and minimal — no RLS policy
--     anywhere lists it (verified against every policy in
--     supabase/migrations/icms/*.sql before adding it), so it carries
--     no elevated or checkpoint-specific ICMS permission beyond what
--     every valid role already gets from "current_user_role() is not
--     null" catch-all policies. It exists purely so requireProfile()
--     finds a row, and so scanTransaction()'s ops_group check — which
--     reads `ops_group` directly, independent of this `role` column —
--     works.)
--
-- staff_id: carried over from profiles.staff_no when present;
-- otherwise synthesized as 'AVSEC-<first 8 chars of the uuid>' so the
-- not-null column is never left blank.
-- duty_post: always null (these accounts have no ICMS checkpoint).
-- ============================================================

insert into public.users (
  id, name, staff_id, email, role, status, preferred_language,
  unified_role, ops_group, duty_post
)
select
  p.id,
  p.name,
  coalesce(nullif(trim(p.staff_no), ''), 'AVSEC-' || substr(p.id::text, 1, 8)),
  p.email,
  case p.role::text
    when 'ADMIN' then 'supervisor'
    when 'ENFORCEMENT' then 'enforcement'
    when 'MANAGEMENT' then 'management'
    else 'ops_staff' -- SO / ASO / DSE
  end,
  'active',
  'en',
  p.unified_role,
  p.ops_group,
  null
from public.profiles p
where not exists (select 1 from public.users u where u.id = p.id);
