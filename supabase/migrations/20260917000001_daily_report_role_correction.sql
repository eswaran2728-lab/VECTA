-- Daily Report (SEC014) operational correction:
--   ASO   = files the Daily Report (unchanged).
--   SO    = supervisory role — no longer files a Daily Report; instead
--           acknowledges an ASO's submitted Daily Report.
--   DSE   = same as SO: acknowledges instead of filing.
-- This migration only tightens who may INSERT a new report_sec014 row, and
-- extends the existing report-acknowledgement authorization function so both
-- SO and DSE (not just the immediate one-rank-up chain) can acknowledge an
-- ASO's Daily Report. It does not touch existing rows, does not change the
-- report_status enum, and does not alter any other report type's rules.

-- 1) Only ASO (and ENFORCEMENT, unchanged from before) may submit a new
--    SEC014 Daily Report going forward. SO/DSE removed from the allowed set.
--    Historical SEC014 rows submitted by SO/DSE before this change are left
--    exactly as they are — this only affects new inserts.
drop policy if exists "sec014 own insert" on public.report_sec014;
create policy "sec014 own insert" on public.report_sec014
  for insert
  with check (
    profile_id = auth.uid()
    and current_role_name() = any (array['ASO'::user_role, 'ENFORCEMENT'::user_role])
    and current_status() = 'approved'::profile_status
  );

-- 2) Acknowledgement eligibility: every other report type keeps the existing
--    strict "exactly one rank above the submitter" chain-of-command rule.
--    SEC014 specifically is special-cased so either SO or DSE — both are the
--    ASO's direct operational supervisors under this correction — can
--    acknowledge an ASO's Daily Report, not only the immediate next rank.
--    Station/team scoping and self-acknowledgement prevention are unchanged.
create or replace function public.can_acknowledge_report(p_report_type text, p_report_id uuid)
 returns boolean
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare
  sub record;
  acker_role user_role;
  acker_station text;
  acker_team text;
begin
  select * into sub from get_report_submitter(p_report_type, p_report_id);
  if sub is null then
    return false;
  end if;

  select role, station, team into acker_role, acker_station, acker_team
  from profiles where id = auth.uid();

  return (
    (
      p_report_type = 'sec014'
      and submitter_role_rank(sub.profile_id) = role_rank('ASO'::user_role)
      and acker_role in ('SO'::user_role, 'DSE'::user_role)
    )
    or role_rank(acker_role) = submitter_role_rank(sub.profile_id) + 1
  )
    and acker_station = sub.station
    and coalesce(acker_team, '') = coalesce(sub.team, '');
end;
$function$;
