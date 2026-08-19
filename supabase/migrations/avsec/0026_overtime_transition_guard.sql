-- Fixes a real bug in 0025: with multiple permissive UPDATE policies, Postgres OR's their
-- USING clauses and OR's their WITH CHECK clauses *independently* — not as USING+CHECK
-- pairs per policy. That let Management/Admin's "reject a pending request" USING clause
-- combine with the "approve" policy's WITH CHECK to approve straight from pending,
-- skipping DSE endorsement entirely. Verified live against the real database before this
-- fix (a synthetic pending row, rolled back — no production data affected).
--
-- Replaces the 4 split policies with one broad "attempt" policy (same shape as the
-- original) plus a trigger that is the actual authority on which status transitions are
-- allowed — the same pattern already used for duty_records' field-level immutability.

drop policy "overtime dse endorse" on overtime_requests;
drop policy "overtime dse reject" on overtime_requests;
drop policy "overtime management approve" on overtime_requests;
drop policy "overtime management reject" on overtime_requests;

create policy "overtime settle update" on overtime_requests for update
  using (
    current_role_rank() > submitter_role_rank(profile_id)
    and (
      current_role_rank() >= role_rank('ENFORCEMENT')
      or (station = current_station() and coalesce(team, '') = coalesce(current_team(), ''))
    )
  )
  with check (
    current_role_rank() > submitter_role_rank(profile_id)
    and (
      current_role_rank() >= role_rank('ENFORCEMENT')
      or (station = current_station() and coalesce(team, '') = coalesce(current_team(), ''))
    )
  );

create or replace function enforce_overtime_transition()
returns trigger as $$
declare
  actor_role user_role;
begin
  if new.status = old.status then
    return new;
  end if;

  actor_role := current_role_name();

  if new.status = 'endorsed' then
    if not (actor_role = 'DSE' and old.status = 'pending') then
      raise exception 'Only DSE can endorse a pending overtime request.';
    end if;
  elsif new.status = 'approved' then
    if not (role_rank(actor_role) >= role_rank('MANAGEMENT') and old.status = 'endorsed') then
      raise exception 'Only Management/Admin can approve, and only once DSE has endorsed.';
    end if;
  elsif new.status = 'rejected' then
    if not (
      (actor_role = 'DSE' and old.status = 'pending')
      or (role_rank(actor_role) >= role_rank('MANAGEMENT') and old.status in ('pending', 'endorsed'))
    ) then
      raise exception 'You are not authorized to reject this overtime request at its current stage.';
    end if;
  elsif new.status = 'cancelled' then
    if not (old.profile_id = auth.uid() and old.status = 'pending') then
      raise exception 'Only the claimant can withdraw their own pending request.';
    end if;
  end if;

  return new;
end;
$$ language plpgsql security definer set search_path = public;

-- Named to sort after "overtime_requests_immutable" (already blocks any mutation once
-- status is approved/rejected) — this one narrows further, for the still-open statuses.
create trigger overtime_requests_z_transition_guard before update on overtime_requests
  for each row execute function enforce_overtime_transition();
