-- Rank-based hierarchy: ASO(1) < SO(2) < DSE(3) < ENFORCEMENT(4) < ADMIN(5).
-- Each role monitors every report submitted by a strictly lower-ranked role, in addition
-- to its own submissions. SO/DSE/ENFORCEMENT can now also submit the SEC014 daily report
-- (previously ASO-only); SEC016/029/018 remain ASO-only submissions.

create or replace function role_rank(r user_role)
returns int as $$
  select case r
    when 'ASO' then 1
    when 'SO' then 2
    when 'DSE' then 3
    when 'ENFORCEMENT' then 4
    when 'ADMIN' then 5
  end;
$$ language sql immutable;

create or replace function current_role_rank()
returns int as $$
  select role_rank(current_role_name());
$$ language sql stable security definer set search_path = public;

create or replace function submitter_role_rank(p_profile_id uuid)
returns int as $$
  select role_rank(role) from profiles where id = p_profile_id;
$$ language sql stable security definer set search_path = public;

-- sec016 (ASO-only submitter; visibility becomes rank-based instead of flat monitor check)
drop policy "sec016 monitor select" on report_sec016;
create policy "sec016 rank select" on report_sec016 for select
  using (profile_id = auth.uid() or current_role_rank() > submitter_role_rank(profile_id));

-- sec014: now submittable by ASO, SO, DSE, ENFORCEMENT
drop policy "sec014 monitor select" on report_sec014;
create policy "sec014 rank select" on report_sec014 for select
  using (profile_id = auth.uid() or current_role_rank() > submitter_role_rank(profile_id));

drop policy "sec014 own insert" on report_sec014;
create policy "sec014 own insert" on report_sec014 for insert
  with check (
    profile_id = auth.uid()
    and current_role_name() in ('ASO', 'SO', 'DSE', 'ENFORCEMENT')
    and current_status() = 'approved'
  );

drop policy "sec014_patrols via parent select" on report_sec014_patrols;
create policy "sec014_patrols via parent select" on report_sec014_patrols for select
  using (exists (
    select 1 from report_sec014 r where r.id = report_id
    and (r.profile_id = auth.uid() or current_role_rank() > submitter_role_rank(r.profile_id))
  ));

-- sec029 (ASO-only submitter)
drop policy "sec029 monitor select" on report_sec029;
create policy "sec029 rank select" on report_sec029 for select
  using (profile_id = auth.uid() or current_role_rank() > submitter_role_rank(profile_id));

drop policy "sec029_items via parent select" on report_sec029_items;
create policy "sec029_items via parent select" on report_sec029_items for select
  using (exists (
    select 1 from report_sec029 r where r.id = report_id
    and (r.profile_id = auth.uid() or current_role_rank() > submitter_role_rank(r.profile_id))
  ));

-- sec018 (ASO-only submitter)
drop policy "sec018 monitor select" on report_sec018;
create policy "sec018 rank select" on report_sec018 for select
  using (profile_id = auth.uid() or current_role_rank() > submitter_role_rank(profile_id));

drop policy "sec018_patrols via parent select" on report_sec018_patrols;
create policy "sec018_patrols via parent select" on report_sec018_patrols for select
  using (exists (
    select 1 from report_sec018 r where r.id = report_id
    and (r.profile_id = auth.uid() or current_role_rank() > submitter_role_rank(r.profile_id))
  ));
