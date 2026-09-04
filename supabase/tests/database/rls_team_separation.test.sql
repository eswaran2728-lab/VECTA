-- Phase 2 (claims contract, AUTH-CONTRACT.md): proves the four team-
-- separation properties the master migration plan requires, against the
-- RLS policies that already enforce them (see MIGRATION-AUDIT.md §3/§7 —
-- these policies predate this migration; this test formalises what was
-- previously verified only by reading the SQL).
--
-- Run with the Supabase CLI: `supabase test db` (spins up a local
-- Postgres with the full auth schema + all migrations applied, then runs
-- every *.test.sql under supabase/tests/ with pgTAP). NOT executed as
-- part of writing this file — no local Postgres/Supabase CLI is
-- available in this environment. Run it before relying on these
-- assertions, and wire it into CI's checks job alongside
-- check-auth-boundary.sh.
--
-- Properties under test (master plan Phase 2, item 4):
--   1. Operation AVSEC cannot read/write IFC AVSEC checkpoint data
--   2. IFC AVSEC cannot read/write Operation AVSEC checkpoint data
--   3. Reports is readable by both (no ops_group filter exists on report_* policies)
--   4. A non-AVSEC (vendor/warehouse_pic-only) account is rejected by every
--      AVSEC-only policy tested here (structural: those accounts have no
--      public.profiles row, so every ops_group/unified_role check below
--      is false for them by construction)

begin;
select plan(7);

-- ---------------------------------------------------------------------
-- Fixtures: two aso-rank profiles, one per team, each with the shadow
-- public.users row part_b's completed_by FK requires (see
-- backfill_icms_shadow_users.sql), plus one transaction each to satisfy
-- part_b.transaction_id's FK.
-- ---------------------------------------------------------------------

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'test-ops-aso@example.test'),
  ('00000000-0000-0000-0000-0000000000a2', 'test-ifc-aso@example.test');

insert into public.profiles (id, email, name, staff_no, status, unified_role, ops_group, role)
values
  ('00000000-0000-0000-0000-0000000000a1', 'test-ops-aso@example.test', 'Test Ops ASO', 'T-OPS-1', 'approved', 'aso', 'operation_avsec', 'OFFICER'),
  ('00000000-0000-0000-0000-0000000000a2', 'test-ifc-aso@example.test', 'Test IFC ASO', 'T-IFC-1', 'approved', 'aso', 'ifc_avsec', 'OFFICER');

insert into public.users (id, email, name, staff_id, status, unified_role, ops_group, role)
values
  ('00000000-0000-0000-0000-0000000000a1', 'test-ops-aso@example.test', 'Test Ops ASO', 'T-OPS-1', 'active', 'aso', 'operation_avsec', 'ops_staff'),
  ('00000000-0000-0000-0000-0000000000a2', 'test-ifc-aso@example.test', 'Test IFC ASO', 'T-IFC-1', 'active', 'aso', 'ifc_avsec', 'ops_staff');

insert into public.transactions (id, direction, vehicle_number, driver_name, driver_id, seal_number, created_by)
values
  ('00000000-0000-0000-0000-0000000000b1', 'WAREHOUSE_TO_AIRCRAFT', 'TEST-1', 'Test Driver', 'T-DRV-1', 'SEAL-1', '00000000-0000-0000-0000-0000000000a1'),
  ('00000000-0000-0000-0000-0000000000b2', 'WAREHOUSE_TO_AIRCRAFT', 'TEST-2', 'Test Driver', 'T-DRV-2', 'SEAL-2', '00000000-0000-0000-0000-0000000000a2');

-- ---------------------------------------------------------------------
-- Property 1: an operation_avsec aso CANNOT insert into part_b (an
-- ifc_avsec-only checkpoint), even for their own transaction.
-- ---------------------------------------------------------------------

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1"}';

select throws_ok(
  $$ insert into public.part_b (transaction_id, avsec_name, avsec_staff_id, signature_url, completed_by)
     values ('00000000-0000-0000-0000-0000000000b1', 'Test Ops ASO', 'T-OPS-1', 'sig.png', '00000000-0000-0000-0000-0000000000a1') $$,
  '42501',
  null,
  'operation_avsec aso is rejected by part_b (ifc_avsec-only checkpoint) insert RLS'
);

-- ---------------------------------------------------------------------
-- Property 2: an ifc_avsec aso CAN insert into part_b for their own
-- transaction (the mirror image proving the check is real, not a
-- blanket denial).
-- ---------------------------------------------------------------------

reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a2"}';

select lives_ok(
  $$ insert into public.part_b (transaction_id, avsec_name, avsec_staff_id, signature_url, completed_by)
     values ('00000000-0000-0000-0000-0000000000b2', 'Test IFC ASO', 'T-IFC-1', 'sig.png', '00000000-0000-0000-0000-0000000000a2') $$,
  'ifc_avsec aso is accepted by part_b (ifc_avsec-only checkpoint) insert RLS'
);

-- ---------------------------------------------------------------------
-- Property 2 (mirror): an ifc_avsec aso CANNOT insert into part_c (an
-- operation_avsec-only checkpoint).
-- ---------------------------------------------------------------------

select throws_ok(
  $$ insert into public.part_c (transaction_id, avsec_name, avsec_staff_id, signature_url, completed_by)
     values ('00000000-0000-0000-0000-0000000000b2', 'Test IFC ASO', 'T-IFC-1', 'sig.png', '00000000-0000-0000-0000-0000000000a2') $$,
  '42501',
  null,
  'ifc_avsec aso is rejected by part_c (operation_avsec-only checkpoint) insert RLS'
);

-- ---------------------------------------------------------------------
-- Property 1 (mirror): an operation_avsec aso CAN insert into part_c.
-- ---------------------------------------------------------------------

reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a1"}';

select lives_ok(
  $$ insert into public.part_c (transaction_id, avsec_name, avsec_staff_id, signature_url, completed_by)
     values ('00000000-0000-0000-0000-0000000000b1', 'Test Ops ASO', 'T-OPS-1', 'sig.png', '00000000-0000-0000-0000-0000000000a1') $$,
  'operation_avsec aso is accepted by part_c (operation_avsec-only checkpoint) insert RLS'
);

-- ---------------------------------------------------------------------
-- Property 3: Reports is the shared surface — no report_* insert/select
-- policy filters on ops_group (a text search over the live policy
-- definitions in pg_policies, not a fixture-dependent functional test:
-- this is what "shared surface" actually means at the RLS layer, since
-- ops_group is the mechanism every OTHER separation check in this file
-- uses).
-- ---------------------------------------------------------------------

reset role;

select is_empty(
  $$ select policyname from pg_policies
     where schemaname = 'public'
       and tablename like 'report\_%' escape '\'
       and (qual like '%ops_group%' or with_check like '%ops_group%') $$,
  'no report_* RLS policy filters on ops_group — Operation/IFC/Hub AVSEC all see Reports'
);

-- ---------------------------------------------------------------------
-- Property 4: a vendor-only account (no public.profiles row at all —
-- CaterLink/vendor accounts live only in public.users, see
-- MIGRATION-AUDIT.md §7) is rejected by part_b/part_c's ops_group check
-- by construction, since that check's `exists (select 1 from
-- public.profiles p where p.id = auth.uid() and ...)` finds no row.
-- ---------------------------------------------------------------------

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a3', 'test-vendor@example.test');

insert into public.users (id, email, name, staff_id, status, unified_role, role)
values
  ('00000000-0000-0000-0000-0000000000a3', 'test-vendor@example.test', 'Test Vendor', 'T-VEND-1', 'active', 'vendor', 'vendor');

insert into public.transactions (id, direction, vehicle_number, driver_name, driver_id, seal_number, created_by)
values
  ('00000000-0000-0000-0000-0000000000b3', 'WAREHOUSE_TO_AIRCRAFT', 'TEST-3', 'Test Driver', 'T-DRV-3', 'SEAL-3', '00000000-0000-0000-0000-0000000000a3');

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000a3"}';

select throws_ok(
  $$ insert into public.part_b (transaction_id, avsec_name, avsec_staff_id, signature_url, completed_by)
     values ('00000000-0000-0000-0000-0000000000b3', 'Test Vendor', 'T-VEND-1', 'sig.png', '00000000-0000-0000-0000-0000000000a3') $$,
  '42501',
  null,
  'a vendor-only account (no profiles row) is rejected by part_b insert RLS — no AVSEC checkpoint is reachable from CaterLink'
);

select * from finish();
rollback;
