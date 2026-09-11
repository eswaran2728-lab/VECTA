-- ============================================================
-- Phase 5: SEC016 Arrival/Departure Toggle & Bay Board Auto-Link
-- Additive migration:
-- 1. Adds `flight_type`, `aircraft_search_completed`, `search_overdue_flag`,
--    and `search_remark` to `report_sec016`.
-- 2. Expands `bay_board` with `flight`, `is_manual`, `arrival_report_id`,
--    and `departure_report_id`, removing strict sec029-only FK on cleared_by_report_id.
-- ============================================================

-- 1. SEC016 Table Enhancements
alter table public.report_sec016
  add column if not exists flight_type text not null default 'arrival' check (flight_type in ('arrival', 'departure')),
  add column if not exists aircraft_search_completed boolean not null default false,
  add column if not exists search_overdue_flag boolean not null default false,
  add column if not exists search_remark text;

create index if not exists idx_report_sec016_flight_type on public.report_sec016 (flight_type);
create index if not exists idx_report_sec016_station_reg on public.report_sec016 (station, reg_no);

-- 2. Bay Board Table Enhancements
-- Relax old SEC029-only foreign key on cleared_by_report_id so SEC016 departure or manual clear can reference it
alter table public.bay_board drop constraint if exists bay_board_cleared_by_report_id_fkey;

alter table public.bay_board
  add column if not exists flight text,
  add column if not exists is_manual boolean not null default false,
  add column if not exists arrival_report_id uuid references public.report_sec016(id),
  add column if not exists departure_report_id uuid references public.report_sec016(id);

create index if not exists idx_bay_board_match on public.bay_board (station, reg_no, cleared_at);
create index if not exists idx_bay_board_arrival_report on public.bay_board (arrival_report_id);
