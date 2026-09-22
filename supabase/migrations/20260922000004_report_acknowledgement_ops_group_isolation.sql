-- Confirmed authorization vulnerability (2026-09-22), found investigating
-- the unified AVSEC CaterLink scanning change: can_acknowledge_report()
-- checks role-rank + station + team, but NEVER ops_group. Since team
-- NAMES collide across branches (both Operation and IFC AVSEC have a
-- "Team ALPHA" at the same station), a same-station/same-team acker from
-- the OTHER branch passes every check today.
--
-- Live-proven against real seeded accounts before this fix: SO Alpha
-- (IFC, ops_group='ifc_avsec') evaluated TRUE against ASO Alpha (Ops,
-- ops_group='operation_avsec')'s real submitted SEC014 report
-- (e7c1ee3b-8251-4d9c-a491-722809931e7b) - rank check passed (ASO->SO),
-- station/team matched, ops_group was never consulted.
--
-- This is entirely independent of, and does NOT touch, the unified
-- AVSEC CaterLink scanning union (part_b/c/d/redq/hub, seals,
-- vendor_part_b) from migration 20260922000003 - that remains unchanged.
--
-- Org-wide authority check: inspected the current function - it has no
-- "org-wide role bypasses station/team/ops_group" branch at all. An
-- org-wide role (ADMIN/MANAGEMENT/ENFORCEMENT) has station = NULL in
-- profiles, and `acker_station = sub.station` already evaluates to NULL
-- (falsy) whenever acker_station is NULL - so org-wide roles have NEVER
-- had acknowledgement authority through this function; there is no
-- existing legitimate org-wide behavior to preserve here. (Org-wide
-- oversight/read access to reports is granted elsewhere, via
-- is_monitor_or_above() on the report SELECT policies - untouched.)

create or replace function public.get_report_submitter(p_report_type text, p_report_id uuid)
returns table(profile_id uuid, station text, team text, ops_group text)
language plpgsql
stable security definer
set search_path to 'public'
as $function$
begin
  if p_report_type = 'sec016' then
    return query select r.profile_id, r.station, r.team, p.ops_group from report_sec016 r join profiles p on p.id = r.profile_id where r.id = p_report_id;
  elsif p_report_type = 'sec014' then
    return query select r.profile_id, r.station, r.team, p.ops_group from report_sec014 r join profiles p on p.id = r.profile_id where r.id = p_report_id;
  elsif p_report_type = 'sec029' then
    return query select r.profile_id, r.station, r.team, p.ops_group from report_sec029 r join profiles p on p.id = r.profile_id where r.id = p_report_id;
  elsif p_report_type = 'sec018' then
    return query select r.profile_id, r.station, r.team, p.ops_group from report_sec018 r join profiles p on p.id = r.profile_id where r.id = p_report_id;
  elsif p_report_type = 'sec033' then
    return query select r.profile_id, r.station, r.team, p.ops_group from report_sec033 r join profiles p on p.id = r.profile_id where r.id = p_report_id;
  elsif p_report_type = 'sec013' then
    return query select r.profile_id, r.station, r.team, p.ops_group from report_sec013 r join profiles p on p.id = r.profile_id where r.id = p_report_id;
  elsif p_report_type = 'offload' then
    return query select r.profile_id, r.station, r.team, p.ops_group from offload_records r join profiles p on p.id = r.profile_id where r.id = p_report_id;
  end if;
end;
$function$;

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
  acker_ops_group text;
begin
  select * into sub from get_report_submitter(p_report_type, p_report_id);
  if sub is null then
    return false;
  end if;

  select role, station, team, ops_group into acker_role, acker_station, acker_team, acker_ops_group
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
    and coalesce(acker_team, '') = coalesce(sub.team, '')
    -- Plain equality, deliberately NOT coalesced: if either side's
    -- ops_group is null, this evaluates to NULL (falsy in a boolean AND
    -- chain), so a missing ops_group can never satisfy the check and
    -- can never create a bypass.
    and acker_ops_group = sub.ops_group;
end;
$function$;
