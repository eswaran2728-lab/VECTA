-- Replace the Day/Night shift presets with Morning/Afternoon/Night — purely data on the
-- `shifts` picker list (label/default_start/default_end/display_order). Admin can still
-- edit any roster cell's actual start/end time independently of these defaults; nothing
-- elsewhere hardcodes the "D"/"N" codes (only "OFF" is checked by code), and no
-- team_rosters/duty_records/overtime_requests rows reference them yet, so this is a
-- clean swap, not a backfill.

delete from shifts where code = 'D';

insert into shifts (code, label, default_start, default_end, display_order) values
  ('M', 'Morning 0700-1500', '07:00', '15:00', 1),
  ('A', 'Afternoon 1500-2300', '15:00', '23:00', 2)
on conflict (code) do update set
  label = excluded.label,
  default_start = excluded.default_start,
  default_end = excluded.default_end,
  display_order = excluded.display_order;

update shifts set label = 'Night 2300-0700', default_start = '23:00', default_end = '07:00', display_order = 3
where code = 'N';

update shifts set display_order = 4 where code = 'OFF';
