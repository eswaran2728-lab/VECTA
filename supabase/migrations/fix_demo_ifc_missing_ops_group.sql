-- ============================================================
-- Fix: demo.ifc@vecta.local's ICMS identity (public.users) had no
-- ops_group set, so Part D ("receiver") never became actionable for it
-- ============================================================
-- consolidate_checkpoint_demos_and_give_ifc_hub_checkin.sql created this
-- account's public.users row by hand and simply omitted ops_group from
-- the column list (unlike backfill_icms_shadow_users.sql's general
-- ASO/SO/DSE backfill, which does carry it over from profiles.ops_group).
-- Its public.profiles row already had ops_group = 'ifc_avsec' — this
-- backfills the same value onto the users row, which is what
-- requireCheckpointRole() (lib/icms/auth.ts) and the transaction detail
-- page actually read for ICMS-side checkpoint access.
--
-- demo.ifc's exact ICMS role ('post2_avsec') already covered Part B, so
-- this only affected Part D (role 'receiver', mapped to ifc_avsec) —
-- which is why Part B worked but Part D showed no way to act on it.

update public.users
set ops_group = 'ifc_avsec'
where email = 'demo.ifc@vecta.local' and ops_group is null;
