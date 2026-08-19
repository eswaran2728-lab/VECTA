-- ============================================================
-- ICMS: add the `enforcement` role.
--
-- Enforcement gets the same READ visibility as supervisor across
-- transactions/parts/seals/incidents (full detail, not scoped to "own
-- part" like the checkpoint roles), and the same incident-resolution
-- power (OPEN -> UNDER_REVIEW -> RESOLVED -> CLOSED, and the lighter
-- OPEN -> RESOLVED lifecycle for SEGMENT_TIMEOUT — that lifecycle
-- selection is keyed off incident_type in guard_incident_update(),
-- untouched by this migration). It does NOT get whitelist/user/archive
-- admin access or audit_logs visibility, and does not perform any
-- Part A/B/C/D checkpoint action (no INSERT policies granted below).
--
-- Architecture note: only `transactions` has an explicit per-role
-- SELECT policy. part_a/part_b/part_c/part_d/seals/seal_verifications/
-- incidents all use a "read follows transaction visibility" pattern
-- (EXISTS (SELECT 1 FROM transactions WHERE id = ...)), which cascades
-- from whatever the transactions SELECT policy allows since RLS on
-- transactions applies inside that subquery too. So widening the one
-- transactions policy below is sufficient to give enforcement full
-- read parity with supervisor across all of those tables — there is
-- no separate supervisor-only SELECT policy on any of them to mirror.
-- ============================================================

alter table public.users drop constraint users_role_check;
alter table public.users
  add constraint users_role_check
  check (role = any (array[
    'warehouse_pic', 'post2_avsec', 'post6_avsec', 'receiver', 'supervisor', 'enforcement'
  ]));

-- Widen the one policy that grants broad (non-"own only") transaction
-- read access. part_a/b/c/d, seals, seal_verifications and incidents
-- SELECT all cascade from this automatically (see note above).
alter policy "transactions: checkpoint and supervisor read all"
  on public.transactions
  using (current_user_role() = any (array[
    'post2_avsec', 'post6_avsec', 'receiver', 'supervisor', 'enforcement'
  ]));

-- Widen incident resolution to enforcement, same as supervisor today.
alter policy "incidents: supervisor resolves"
  on public.incidents
  using (current_user_role() = any (array['supervisor', 'enforcement']))
  with check (current_user_role() = any (array['supervisor', 'enforcement']));

-- Deliberately NOT touched: vehicles, drivers, catering_companies and
-- audit_logs policies all stay supervisor-only. Enforcement gets no
-- whitelist/user-management/archive access and no audit log visibility.
