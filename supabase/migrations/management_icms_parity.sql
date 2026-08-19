-- ============================================================
-- ICMS: give 'management' the same permission footprint as
-- 'enforcement' — a distinct role string, not merged into it.
--
-- 'management' has no equivalent ICMS role value or RLS grant today
-- (see supabase/migrations/grant_icms_access_to_admin_enforcement.sql,
-- which deliberately left this undone pending a design decision). The
-- project owner has now confirmed: management gets the exact same
-- ICMS-side permission footprint as enforcement (full read visibility
-- across transactions/parts/seals/incidents/vendor_transactions, plus
-- incident-resolution power) — nothing more, nothing less. It does
-- NOT get whitelist/user/archive admin access or audit_logs
-- visibility either, same as enforcement.
--
-- Every RLS policy that currently mentions 'enforcement' gets
-- 'management' added alongside it, below. There are exactly three
-- such policies in the live schema (verified via pg_policy):
--   - transactions: checkpoint and supervisor read all
--   - vendor_transactions: checkpoint roles read all
--   - incidents: supervisor resolves
-- (part_a/part_b/part_c/part_d/seals/seal_verifications/vendor_part_*
-- all cascade from the transactions/vendor_transactions read policies
-- via the "read follows transaction visibility" pattern, same as the
-- original enforcement migration's read parity — no separate policy
-- to touch on any of them.)
-- ============================================================

alter table public.users drop constraint users_role_check;
alter table public.users
  add constraint users_role_check
  check (role = any (array[
    'warehouse_pic', 'post2_avsec', 'post6_avsec', 'receiver',
    'supervisor', 'enforcement', 'vendor', 'hub_avsec', 'redq_avsec',
    'management', 'ops_staff'
  ]));

alter policy "transactions: checkpoint and supervisor read all"
  on public.transactions
  using (
    current_user_role() = any (array[
      'post2_avsec', 'post6_avsec', 'receiver', 'supervisor', 'enforcement',
      'hub_avsec', 'redq_avsec', 'management'
    ])
  );

alter policy "vendor_transactions: checkpoint roles read all"
  on public.vendor_transactions
  using (
    public.current_user_role() = any (array['post2_avsec', 'warehouse_pic', 'supervisor', 'enforcement', 'management'])
  );

alter policy "incidents: supervisor resolves"
  on public.incidents
  using (current_user_role() = any (array['supervisor', 'enforcement', 'management']))
  with check (current_user_role() = any (array['supervisor', 'enforcement', 'management']));

-- ------------------------------------------------------------
-- 'ops_staff': added to the role vocabulary here too (same
-- constraint statement above) since it's needed by the shadow-user
-- backfill below. NOT a permission grant — no policy anywhere lists
-- 'ops_staff', so it gets nothing beyond what every valid role
-- already gets from the "current_user_role() is not null" catch-all
-- policies (catering_companies/vehicles/drivers read, incident
-- reporting). This is a judgment call made in the project owner's
-- absence (see supabase/migrations/backfill_icms_shadow_users.sql for
-- the full reasoning) — flagged for their review, not a confirmed
-- decision like the 'management' parity work above.
-- ------------------------------------------------------------
