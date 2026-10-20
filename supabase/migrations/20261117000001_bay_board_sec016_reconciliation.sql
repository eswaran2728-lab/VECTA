-- Bay Board / SEC016 reconciliation. The approved staging project never received 20260911000005 (SEC016 arrival/departure toggle and Bay Board
-- auto-link), so on staging:
--   * public.bay_board has no flight / is_manual / arrival_report_id / departure_report_id, so get_bay_board_secure() fails 42703 and the
--     SEC016 arrival insert, the SEC016 departure clear and the manual Bay Board entry (lib/avsec/reports/actions.ts) all fail;
--   * public.report_sec016 has no flight_type / aircraft_search_completed / search_overdue_flag / search_remark, so SEC016 submission itself fails;
--   * the legacy bay_board_cleared_by_report_id_fkey (-> report_sec029 only) still rejects a SEC016 id in cleared_by_report_id.
-- This migration applies exactly the structural part of 20260911000005 that the current application uses, with identical definitions, and nothing
-- else: no org_id (the multi-tenant scaffolding is not part of the canonical model; bay_board RLS is station-scoped), no policy or grant change,
-- no backfill beyond the column defaults. Every statement is idempotent, so it is a no-op on a database that already has them (the repository chain).
-- get_bay_board_secure() is re-created with the same body, SECURITY DEFINER, fixed search_path and unchanged authorization.

alter table public.report_sec016
  add column if not exists flight_type text not null default 'arrival' check (flight_type in ('arrival', 'departure')),
  add column if not exists aircraft_search_completed boolean not null default false,
  add column if not exists search_overdue_flag boolean not null default false,
  add column if not exists search_remark text;

create index if not exists idx_report_sec016_flight_type on public.report_sec016 (flight_type);
create index if not exists idx_report_sec016_station_reg on public.report_sec016 (station, reg_no);

alter table public.bay_board drop constraint if exists bay_board_cleared_by_report_id_fkey;

alter table public.bay_board
  add column if not exists flight text,
  add column if not exists is_manual boolean not null default false,
  add column if not exists arrival_report_id uuid references public.report_sec016(id),
  add column if not exists departure_report_id uuid references public.report_sec016(id);

create index if not exists idx_bay_board_match on public.bay_board (station, reg_no, cleared_at);
create index if not exists idx_bay_board_arrival_report on public.bay_board (arrival_report_id);

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
