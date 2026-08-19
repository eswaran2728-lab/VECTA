-- ============================================================
-- Give admin/enforcement accounts a real ICMS-side identity too.
--
-- ICMS's own access control (lib/icms/auth.ts requireProfile()) is
-- entirely separate from the unified_role model — it only recognizes
-- a row in public.users, keyed off ICMS's native role vocabulary
-- (warehouse_pic/post2_avsec/post6_avsec/receiver/supervisor/
-- enforcement/vendor/hub_avsec/redq_avsec). An account that exists
-- only in public.profiles (AVSEC-origin) — which is where admin,
-- management, and enforcement accounts normally live — has no ICMS
-- identity at all, so the IFC module always redirected them to
-- /login?error=no-profile regardless of unified_role.
--
-- 'supervisor' is ICMS's own top/admin-equivalent role (see the RLS
-- policy allowing array['supervisor','enforcement'] elevated access),
-- and 'enforcement' already matches directly — so admin and
-- enforcement accounts get a matching public.users row here.
--
-- 'management' has NO equivalent in ICMS's role vocabulary or RLS
-- policies at all — there is no role value, and no policy grants
-- access to one called "management". Giving management real ICMS
-- access would require adding a new role value and its own RLS
-- policies, which is a design decision (what should Management be
-- able to see/do in ICMS?), not a bug fix — deliberately left undone
-- pending that decision.
-- ============================================================

insert into public.users (id, name, staff_id, email, role, status, preferred_language, unified_role, duty_post)
select 'a0000000-0000-4000-8000-000000000001', 'Eswaran Padmanathan', 'ADM-0001', 'eswaranp@airasia.com', 'supervisor', 'active', 'en', 'admin', null
where not exists (select 1 from public.users where id = 'a0000000-0000-4000-8000-000000000001');

insert into public.users (id, name, staff_id, email, role, status, preferred_language, unified_role, duty_post)
select 'a0000000-0000-4000-8000-000000000002', 'Demo Admin', 'ADM-9002', 'demo.admin@vecta.local', 'supervisor', 'active', 'en', 'admin', null
where not exists (select 1 from public.users where id = 'a0000000-0000-4000-8000-000000000002');

insert into public.users (id, name, staff_id, email, role, status, preferred_language, unified_role, duty_post)
select 'a0000000-0000-4000-8000-000000000004', 'Demo Enforcement', 'ENF-9001', 'demo.enforcement@vecta.local', 'enforcement', 'active', 'en', 'enforcement', null
where not exists (select 1 from public.users where id = 'a0000000-0000-4000-8000-000000000004');
