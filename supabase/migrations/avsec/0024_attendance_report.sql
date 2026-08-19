-- Attendance module: officer-row weekly schedule grid (display layer only — team_rosters
-- stays team-level, per explicit product decision; edits still apply to the whole team)
-- plus a new Attendance Report with anomaly detection (no-show / missing checkout /
-- off-schedule). Additive only.

alter table shifts add column if not exists color_hex text;

update shifts set color_hex = '#d7a13a' where code = 'M' and color_hex is null;
update shifts set color_hex = '#4c7fc0' where code = 'A' and color_hex is null;
update shifts set color_hex = '#6b5fb0' where code = 'N' and color_hex is null;
update shifts set color_hex = '#6f6a58' where code = 'OFF' and color_hex is null;

alter table duty_records
  add column if not exists total_minutes integer,
  add column if not exists is_missing_checkout boolean not null default false,
  add column if not exists is_off_schedule boolean not null default false;

-- Sweep: backfills no-shows as real duty_records rows (reusing the existing, previously
-- unused 'absent' status — no new column needed for this one), flags missing checkouts
-- past a grace window, and flags off-schedule check-ins (worked a day their team's
-- roster explicitly says OFF). SECURITY DEFINER so it can run from pg_cron (no session)
-- and from an Admin-triggered RPC.
create or replace function flag_attendance_anomalies(p_grace_hours int default 4)
returns void as $$
begin
  insert into duty_records (profile_id, station, team, duty_date, shift_code, zone_id, status)
  select p.id, tr.station, tr.team, tr.roster_date, tr.shift_code, tr.zone_id, 'absent'
  from team_rosters tr
  join profiles p on p.station = tr.station and coalesce(p.team, '') = tr.team
  where tr.shift_code <> 'OFF'
    and tr.roster_date < (now() at time zone 'Asia/Kuala_Lumpur')::date
    and p.role in ('ASO', 'SO', 'DSE')
    and p.status = 'approved'
    and not exists (
      select 1 from duty_records dr
      where dr.profile_id = p.id and dr.duty_date = tr.roster_date
    )
  on conflict (profile_id, duty_date, shift_code) do nothing;

  update duty_records dr
  set is_missing_checkout = true
  where dr.check_in_at is not null
    and dr.check_out_at is null
    and dr.is_missing_checkout = false
    and (dr.duty_date + coalesce(
           (select s.default_end from shifts s where s.code = dr.shift_code), '23:59'::time
         ) + (p_grace_hours || ' hours')::interval) < now();

  update duty_records dr
  set is_off_schedule = true
  where dr.check_in_at is not null
    and dr.is_off_schedule = false
    and exists (
      select 1 from team_rosters tr
      where tr.station = dr.station
        and tr.team = coalesce(dr.team, '')
        and tr.roster_date = dr.duty_date
        and tr.shift_code = 'OFF'
    );
end;
$$ language plpgsql security definer set search_path = public;

revoke all on function flag_attendance_anomalies(int) from public;
grant execute on function flag_attendance_anomalies(int) to authenticated;

-- Admin-triggered on-demand sweep — the "Run anomaly sweep" button. The plain function
-- above is also invoked directly by pg_cron, which has no session/role to check.
create or replace function run_attendance_sweep()
returns void as $$
begin
  if current_role_name() <> 'ADMIN' then
    raise exception 'Only Admin can run the attendance sweep.';
  end if;
  perform flag_attendance_anomalies();
end;
$$ language plpgsql security definer set search_path = public;

revoke all on function run_attendance_sweep() from public;
grant execute on function run_attendance_sweep() to authenticated;

select cron.schedule('flag-attendance-anomalies', '0 20 * * *', 'select flag_attendance_anomalies();');
