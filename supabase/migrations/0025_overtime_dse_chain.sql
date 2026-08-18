-- Overtime approval chain: DSE endorses -> Management/Admin approves. Previously any
-- rank above the submitter (including SO, and Management/Admin skipping straight from
-- pending) could move a request through "overtime settle update" — this replaces that one
-- policy with four narrower ones so the DB itself enforces the sequence, not just the UI.

drop policy "overtime settle update" on overtime_requests;

-- DSE endorses or rejects a still-pending request, within their own station+team (DSE is
-- never org-wide, so no ENFORCEMENT-rank branch needed here).
create policy "overtime dse endorse" on overtime_requests for update
  using (
    current_role_name() = 'DSE'
    and current_role_rank() > submitter_role_rank(profile_id)
    and status = 'pending'
    and station = current_station()
    and coalesce(team, '') = coalesce(current_team(), '')
  )
  with check (current_role_name() = 'DSE' and status = 'endorsed');

create policy "overtime dse reject" on overtime_requests for update
  using (
    current_role_name() = 'DSE'
    and current_role_rank() > submitter_role_rank(profile_id)
    and status = 'pending'
    and station = current_station()
    and coalesce(team, '') = coalesce(current_team(), '')
  )
  with check (current_role_name() = 'DSE' and status = 'rejected');

-- Management/Admin give final approval only once DSE has endorsed — no skipping straight
-- from pending. They can still reject at either stage.
create policy "overtime management approve" on overtime_requests for update
  using (
    current_role_rank() >= role_rank('MANAGEMENT')
    and current_role_rank() > submitter_role_rank(profile_id)
    and status = 'endorsed'
  )
  with check (current_role_rank() >= role_rank('MANAGEMENT') and status = 'approved');

create policy "overtime management reject" on overtime_requests for update
  using (
    current_role_rank() >= role_rank('MANAGEMENT')
    and current_role_rank() > submitter_role_rank(profile_id)
    and status in ('pending', 'endorsed')
  )
  with check (current_role_rank() >= role_rank('MANAGEMENT') and status = 'rejected');
