-- Bay Board RPC repair: public.get_bay_board_secure() selects b.flight, but the approved staging project's public.bay_board never received the
-- SEC016 migration (20260911000005) that adds that column, so every call failed with 42703 "column b.flight does not exist" and the entity /
-- leadership Bay Board showed "could not be loaded". The column is additive and nullable; `if not exists` makes this a no-op on databases that
-- already have it. get_bay_board_secure() is re-created with the same body, SECURITY DEFINER, fixed search_path and the same authorization
-- (caller_bay_board_aoc()); only the dependency on the column is repaired. Nothing else on bay_board is altered here.
alter table public.bay_board add column if not exists flight text;

create or replace function public.get_bay_board_secure(p_hub_code text default null, p_station_code text default null)
returns table (id uuid, station text, reg_no text, aircraft_type text, bay text, flight text, on_ground_since timestamptz)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_aoc uuid := public.caller_bay_board_aoc();
begin
  if v_aoc is null then
    raise exception 'Only an approved entity leader or operations / enforcement oversight role may view the Bay Board through this path.';
  end if;
  return query
  select b.id, b.station, b.reg_no, b.aircraft_type, b.bay, b.flight, b.on_ground_since
  from public.bay_board b
  join public.org_stations s on s.code = b.station and s.is_active
  join public.hubs h on h.id = s.hub_id and h.aoc_id = v_aoc
  where b.cleared_at is null
    and (p_station_code is null or s.code = p_station_code)
    and (p_hub_code is null or h.code = p_hub_code)
  order by b.station, b.bay nulls last, b.on_ground_since;
end;
$function$;
revoke execute on function public.get_bay_board_secure(text, text) from public, anon;
grant execute on function public.get_bay_board_secure(text, text) to authenticated, service_role;
