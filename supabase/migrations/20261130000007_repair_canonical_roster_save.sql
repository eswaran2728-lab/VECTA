-- Reconcile the roster RPC with canonical station/team/date roster storage.
-- Replace one function only; preserve all existing table policies and grants.
create or replace function public.upsert_roster_cell_secure(
  p_station text,
  p_team text,
  p_roster_date date,
  p_shift_code text,
  p_start_time time default null,
  p_end_time time default null,
  p_notes text default null
)
returns table(row_id uuid)
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_row_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Must be signed in.';
  end if;
  if not exists (select 1 from public.profiles where id = auth.uid() and status = 'approved') then
    raise exception 'Only an approved account may write rosters.';
  end if;
  if p_station is null or p_team is null or p_roster_date is null or p_shift_code is null then
    raise exception 'station, team, roster_date and shift_code are all required.';
  end if;
  if not public.can_manage_roster_secure(p_station, p_team) then
    raise exception 'No active Phase 3 role assignment grants roster-write authority for %/%.', p_station, p_team;
  end if;

  insert into public.team_rosters
    (station, team, roster_date, shift_code, start_time, end_time, notes, set_by)
  values
    (p_station, p_team, p_roster_date, p_shift_code, p_start_time, p_end_time, p_notes, auth.uid())
  on conflict (station, team, roster_date)
  do update set shift_code = excluded.shift_code,
    start_time = excluded.start_time, end_time = excluded.end_time,
    notes = excluded.notes, set_by = excluded.set_by, updated_at = now()
  returning public.team_rosters.id into v_row_id;

  perform public.phase8_write_audit('roster_upsert', 'team_roster', v_row_id,
    jsonb_build_object('station', p_station, 'team', p_team,
      'roster_date', p_roster_date, 'shift_code', p_shift_code));
  return query select v_row_id;
end;
$function$;
