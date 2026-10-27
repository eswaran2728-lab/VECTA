-- Owner decisions (2026-10-27): DSE leave visibility and review is scoped to the DSE's assigned station AND team, and duty-zone writes belong to
-- the Operation Manager only.
--
-- 1. absence_notices. The SELECT policy admitted any DSE assignment at the notice's STATION and the UPDATE policy admitted any DSE at the station
--    (or any DSE for a notice with no station), so a DSE of one team could list, read and approve/reject another team's leave at the same station.
--    Both policies now use canon_dse_of_team(station, team): the caller must hold an active DSE assignment at that exact station AND team. A notice
--    with no station or no team is no longer visible to a DSE. Operation Manager keeps department oversight (read and update everything) and Main
--    Enforcement keeps its separate read authority; the secure review / pending-list RPCs already enforce DSE team and Hub SE hub and are untouched.
--
-- 2. duty_zones. INSERT / UPDATE / DELETE policies used canon_can_admin_station(), which also admitted a DSE of the station and a Hub SE of the hub.
--    They now require the Operation Manager (canon_has_role). The SELECT policy (duty_zones_scoped_read) is not touched, so check-in keeps reading the
--    zones of the officer's station. canon_can_admin_station() itself is left in place, unused by any policy.
--
-- Roster hub isolation needs no change: can_manage_roster_secure() already requires the Hub SE's assigned hub (has_role_in_scope with the station's hub)
-- and team_rosters has no direct write policy, so writes only go through the RPCs. The guarded runner proves this with real-role probes.

create or replace function public.canon_dse_of_team(p_station text, p_team text)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select p_station is not null
    and p_team is not null
    and exists (
      select 1 from public.canon_assignments() a
      where a.role_code = 'dse'
        and a.station_code = p_station
        and upper(coalesce(a.team_name, '')) = upper(p_team)
    );
$function$;
revoke execute on function public.canon_dse_of_team(text, text) from public, anon;
grant execute on function public.canon_dse_of_team(text, text) to authenticated, service_role;

drop policy absence_notices_select_elevated on public.absence_notices;
create policy absence_notices_select_elevated on public.absence_notices
  for select to authenticated
  using (
    public.canon_has_role(array['operation_manager', 'main_enforcement'])
    or public.canon_dse_of_team(absence_notices.station, absence_notices.team)
  );

drop policy absence_notices_dse_management_update on public.absence_notices;
create policy absence_notices_dse_management_update on public.absence_notices
  for update to authenticated
  using (
    public.canon_has_role(array['operation_manager'])
    or public.canon_dse_of_team(absence_notices.station, absence_notices.team)
  )
  with check (
    public.canon_has_role(array['operation_manager'])
    or public.canon_dse_of_team(absence_notices.station, absence_notices.team)
  );

drop policy duty_zones_admin_insert on public.duty_zones;
create policy duty_zones_admin_insert on public.duty_zones
  for insert to authenticated
  with check (public.canon_has_role(array['operation_manager']));

drop policy duty_zones_admin_update on public.duty_zones;
create policy duty_zones_admin_update on public.duty_zones
  for update to authenticated
  using (public.canon_has_role(array['operation_manager']))
  with check (public.canon_has_role(array['operation_manager']));

drop policy duty_zones_admin_delete on public.duty_zones;
create policy duty_zones_admin_delete on public.duty_zones
  for delete to authenticated
  using (public.canon_has_role(array['operation_manager']));
