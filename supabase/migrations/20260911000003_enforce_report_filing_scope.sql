-- ============================================================
-- Phase 3: Enforce SEC Report Filing Scope & Acknowledgements
-- Additive migration: Enforces SEC report filing scope at the database layer.
-- - SEC 014: submittable by ASO, SO, DSE across both Operation and IFC branches.
-- - SEC 016, 029, 018, 033, 013: submittable ONLY by ASO in 'operation_avsec' (or 'hub_avsec').
-- - Updates report acknowledgements for SO/DSE branch-scoped daily signoffs.
-- ============================================================

-- 1. Helper function: check if submitter is permitted to file specific SEC form
create or replace function public.can_file_report(p_form_type text, p_profile_id uuid)
returns boolean as $$
declare
  v_role user_role;
  v_ops_group text;
begin
  select role, ops_group into v_role, v_ops_group
  from public.profiles
  where id = p_profile_id;

  if v_role is null then
    return false;
  end if;

  -- SEC 014: ASO, SO, DSE of all branches can file
  if p_form_type = 'sec014' then
    return v_role in ('ASO', 'SO', 'DSE');
  end if;

  -- SEC 016, 029, 018, 033, 013: ASO in Operation (or Hub) AVSEC ONLY
  if p_form_type in ('sec016', 'sec029', 'sec018', 'sec033', 'sec013', 'offload') then
    return v_role = 'ASO' and v_ops_group in ('operation_avsec', 'hub_avsec');
  end if;

  return false;
end;
$$ language plpgsql stable security definer set search_path = public;

-- 2. Update insert RLS policies on SEC report tables

-- report_sec016
drop policy if exists "sec016 own insert" on public.report_sec016;
create policy "sec016 own insert" on public.report_sec016
  for insert with check (
    profile_id = auth.uid()
    and current_status() = 'approved'
    and can_file_report('sec016', auth.uid())
  );

-- report_sec014
drop policy if exists "sec014 own insert" on public.report_sec014;
create policy "sec014 own insert" on public.report_sec014
  for insert with check (
    profile_id = auth.uid()
    and current_status() = 'approved'
    and can_file_report('sec014', auth.uid())
  );

-- report_sec029
drop policy if exists "sec029 own insert" on public.report_sec029;
create policy "sec029 own insert" on public.report_sec029
  for insert with check (
    profile_id = auth.uid()
    and current_status() = 'approved'
    and can_file_report('sec029', auth.uid())
  );

-- report_sec018
drop policy if exists "sec018 own insert" on public.report_sec018;
create policy "sec018 own insert" on public.report_sec018
  for insert with check (
    profile_id = auth.uid()
    and current_status() = 'approved'
    and can_file_report('sec018', auth.uid())
  );

-- report_sec033
drop policy if exists "sec033 own insert" on public.report_sec033;
create policy "sec033 own insert" on public.report_sec033
  for insert with check (
    profile_id = auth.uid()
    and current_status() = 'approved'
    and can_file_report('sec033', auth.uid())
  );

-- report_sec013
drop policy if exists "sec013 own insert" on public.report_sec013;
create policy "sec013 own insert" on public.report_sec013
  for insert with check (
    profile_id = auth.uid()
    and current_status() = 'approved'
    and can_file_report('sec013', auth.uid())
  );

-- 3. Update Acknowledgement Validation
-- SO must acknowledge ASO's reports within the same team & ops_group.
-- DSE must acknowledge SO's reports within the same team & ops_group.
create or replace function public.can_acknowledge_report(p_report_type text, p_report_id uuid)
returns boolean as $$
declare
  sub record;
  sub_ops_group text;
  acker_role user_role;
  acker_station text;
  acker_team text;
  acker_ops_group text;
begin
  select * into sub from get_report_submitter(p_report_type, p_report_id);
  if sub is null then
    return false;
  end if;

  select ops_group into sub_ops_group from profiles where id = sub.profile_id;

  select role, station, team, ops_group into acker_role, acker_station, acker_team, acker_ops_group
  from profiles where id = auth.uid();

  -- Approver must be strictly one rank above submitter (SO over ASO, DSE over SO)
  -- and match station, team, and ops_group (branch)
  return role_rank(acker_role) = submitter_role_rank(sub.profile_id) + 1
    and acker_station = sub.station
    and coalesce(acker_team, '') = coalesce(sub.team, '')
    and coalesce(acker_ops_group, '') = coalesce(sub_ops_group, '');
end;
$$ language plpgsql stable security definer set search_path = public;
