-- shift_handovers: canonical RLS policies (additive; replaces three policies, no table, column, grant or data change).
--
-- DEFECT (found by the native verify_canonical_compat regression): 20261102000003_shift_handovers_reconciliation recreated the
-- shift_handovers policies in their LEGACY form. Two of them authorize from the compatibility rank (current_role_rank() >= role_rank(...)),
-- which the canonical model retired (20261020000001 section 6e removes every such policy), and all three were created without a role, i.e.
-- for PUBLIC. On a full rebuild this silently reverted the canonical closure.
--
-- Fix: the same visibility, minus the legacy-rank branch and with explicit roles.
--   * insert:      the author, while active (unchanged condition)
--   * select:      the author, the author's own station+team, canonical oversight of that station/team, Operation Manager, Main Enforcement
--   * acknowledge: the same readers, only while unacknowledged, and only as themselves
-- The legacy "rank >= ENFORCEMENT" branch is replaced by the canonical Operation Manager / Main Enforcement role check already present.

drop policy if exists "shift_handovers own insert" on public.shift_handovers;
create policy "shift_handovers own insert" on public.shift_handovers
  for insert to authenticated
  with check (
    outgoing_profile_id = auth.uid()
    and (canon_is_active() or current_status() = 'approved'::profile_status)
  );

drop policy if exists "shift_handovers team select" on public.shift_handovers;
create policy "shift_handovers team select" on public.shift_handovers
  for select to authenticated
  using (
    outgoing_profile_id = auth.uid()
    or (station = current_station() and coalesce(team, '') = coalesce(current_team(), ''))
    or canon_oversees(outgoing_profile_id, station, team)
    or canon_has_role(array['operation_manager'::text, 'main_enforcement'::text])
  );

drop policy if exists "shift_handovers team acknowledge" on public.shift_handovers;
create policy "shift_handovers team acknowledge" on public.shift_handovers
  for update to authenticated
  using (
    acknowledged_at is null
    and (
      (station = current_station() and coalesce(team, '') = coalesce(current_team(), ''))
      or canon_oversees(outgoing_profile_id, station, team)
      or canon_has_role(array['operation_manager'::text, 'main_enforcement'::text])
    )
  )
  with check (
    acknowledged_by = auth.uid()
  );
