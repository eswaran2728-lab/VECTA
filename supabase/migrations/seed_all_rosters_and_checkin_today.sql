-- ==============================================================================
-- VECTA: Seed Full Shift Rosters & Auto Check-In All Duty Roles for Today
-- ==============================================================================
-- 1. Provisions station_teams and shifts if missing
-- 2. Creates team_rosters for all stations & teams (ALPHA, BRAVO, CHARLIE, DELTA, etc.)
--    for a rolling date window (current_date - 7 days to current_date + 30 days)
-- 3. Automatically checks in all operational duty roles (ASO, SO, DSE) for today
--    into duty_records with status = 'present'
-- ==============================================================================

begin;

-- 1. Ensure Shift Presets exist
insert into public.shifts (code, label, default_start, default_end, color_hex, display_order)
values
  ('M1', 'Morning (07:00 - 15:00)', '07:00:00', '15:00:00', '#3b82f6', 1),
  ('A1', 'Afternoon (15:00 - 23:00)', '15:00:00', '23:00:00', '#f59e0b', 2),
  ('N1', 'Night (23:00 - 07:00)', '23:00:00', '07:00:00', '#8b5cf6', 3),
  ('M',  'Normal Shift (07:00 - 15:00)', '07:00:00', '15:00:00', '#10b981', 4),
  ('OFF', 'Off Duty', null, null, '#64748b', 5)
on conflict (code) do update set
  label = excluded.label,
  default_start = excluded.default_start,
  default_end = excluded.default_end,
  color_hex = excluded.color_hex;

-- 2. Ensure Station Teams exist for all teams found in profiles
insert into public.station_teams (station, team, display_order, active)
select distinct
  coalesce(station, 'KUL - MAA') as station,
  team,
  case team
    when 'ALPHA' then 1
    when 'BRAVO' then 2
    when 'CHARLIE' then 3
    when 'DELTA' then 4
    else 5
  end as display_order,
  true as active
from public.profiles
where team is not null and team <> ''
on conflict (station, team) do update set
  active = true;

-- Default fallback station teams for KUL - MAA if not present
insert into public.station_teams (station, team, display_order, active)
values
  ('KUL - MAA', 'ALPHA', 1, true),
  ('KUL - MAA', 'BRAVO', 2, true),
  ('KUL - MAA', 'CHARLIE', 3, true),
  ('KUL - MAA', 'DELTA', 4, true)
on conflict (station, team) do update set active = true;

-- 3. Ensure active Duty Zones exist for KUL - MAA
insert into public.duty_zones (id, station, name, active, polygon)
values (
  'd0000000-0000-4000-8000-000000000001',
  'KUL - MAA',
  'KLIA Main & CaterLink Security Zone',
  true,
  '{"type":"Polygon","coordinates":[[[101.68,2.73],[101.72,2.73],[101.72,2.76],[101.68,2.76],[101.68,2.73]]]}'::jsonb
)
on conflict (id) do update set
  station = excluded.station,
  name = excluded.name,
  active = true;

-- 4. Populate team_rosters for every station and team for rolling dates (today - 7 to today + 30)
do $$
declare
  v_admin_id uuid;
  v_zone_id uuid;
begin
  select id into v_admin_id from public.profiles where role = 'ADMIN' limit 1;
  if v_admin_id is null then
    select id into v_admin_id from public.profiles limit 1;
  end if;

  select id into v_zone_id from public.duty_zones where station = 'KUL - MAA' and active = true limit 1;

  insert into public.team_rosters (
    station,
    team,
    roster_date,
    shift_code,
    start_time,
    end_time,
    zone_id,
    set_by,
    notes
  )
  select
    st.station,
    st.team,
    d::date,
    'M1',
    '07:00:00'::time,
    '15:00:00'::time,
    v_zone_id,
    v_admin_id,
    'Auto-provisioned shift roster'
  from generate_series(
    (now() at time zone 'Asia/Kuala_Lumpur')::date - 7,
    (now() at time zone 'Asia/Kuala_Lumpur')::date + 30,
    interval '1 day'
  ) as d
  cross join public.station_teams st
  where st.active = true
  on conflict (station, team, roster_date) do update set
    shift_code = excluded.shift_code,
    start_time = excluded.start_time,
    end_time = excluded.end_time,
    zone_id = coalesce(team_rosters.zone_id, excluded.zone_id);

end $$;

-- 5. Auto Check-In All Operational Duty Roles (ASO, SO, DSE) for Today
do $$
declare
  v_today date := (now() at time zone 'Asia/Kuala_Lumpur')::date;
  v_check_in_time timestamptz := (now() at time zone 'Asia/Kuala_Lumpur');
  v_zone_id uuid;
  p record;
begin
  select id into v_zone_id from public.duty_zones where station = 'KUL - MAA' and active = true limit 1;

  for p in
    select
      id,
      name,
      staff_no,
      coalesce(station, 'KUL - MAA') as station,
      coalesce(team, 'ALPHA') as team,
      role::text as role,
      ops_group
    from public.profiles
    where role in ('ASO', 'SO', 'DSE')
      and status = 'approved'
  loop
    -- Upsert duty_record for today
    insert into public.duty_records (
      profile_id,
      station,
      team,
      role,
      duty_date,
      shift_code,
      zone_id,
      check_in_at,
      check_in_lat,
      check_in_lng,
      check_in_accuracy_m,
      check_in_inside_fence,
      check_in_offline,
      status,
      late_minutes,
      early_out_minutes,
      post_assignment
    ) values (
      p.id,
      p.station,
      p.team,
      p.role,
      v_today,
      'M1',
      v_zone_id,
      coalesce(v_check_in_time, now()),
      2.7433,
      101.6981,
      5.0,
      true,
      false,
      'present',
      0,
      0,
      case
        when p.ops_group = 'ifc_avsec' then 'In-Flight Catering Security Post'
        when p.ops_group = 'hub_avsec' then 'Hub Delivery / Transfer Post'
        else 'Main Security Post & Screening'
      end
    )
    on conflict (profile_id, duty_date, shift_code) do update set
      status = 'present',
      check_in_at = coalesce(duty_records.check_in_at, excluded.check_in_at),
      check_in_lat = coalesce(duty_records.check_in_lat, excluded.check_in_lat),
      check_in_lng = coalesce(duty_records.check_in_lng, excluded.check_in_lng),
      check_in_inside_fence = true,
      check_out_at = null,
      updated_at = now();

  end loop;
end $$;

commit;

-- ==============================================================================
-- Verification Output
-- ==============================================================================
select 'TOTAL ROSTERS PROVISIONED' as metric, count(*) as count
from public.team_rosters
where roster_date = (now() at time zone 'Asia/Kuala_Lumpur')::date
union all
select 'OFFICERS CHECKED IN TODAY' as metric, count(*) as count
from public.duty_records
where duty_date = (now() at time zone 'Asia/Kuala_Lumpur')::date
  and check_in_at is not null
  and check_out_at is null;
