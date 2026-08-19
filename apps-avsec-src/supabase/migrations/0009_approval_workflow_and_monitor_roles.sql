create or replace function current_status()
returns profile_status as $$
  select status from profiles where id = auth.uid();
$$ language sql stable security definer set search_path = public;

create or replace function is_monitor_or_above()
returns boolean as $$
  select current_role_name() in ('SO', 'DSE', 'ENFORCEMENT', 'ADMIN');
$$ language sql stable security definer set search_path = public;

-- Drop policies that depend on the old station/manager helper functions.
drop policy "profiles self select" on profiles;
drop policy "profiles self update" on profiles;
drop policy "sec016 station select" on report_sec016;
drop policy "sec016 own insert" on report_sec016;
drop policy "sec014 station select" on report_sec014;
drop policy "sec014 own insert" on report_sec014;
drop policy "sec014_patrols via parent select" on report_sec014_patrols;
drop policy "sec029 station select" on report_sec029;
drop policy "sec029 own insert" on report_sec029;
drop policy "sec029_items via parent select" on report_sec029_items;
drop policy "sec018 station select" on report_sec018;
drop policy "sec018 own insert" on report_sec018;
drop policy "sec018_patrols via parent select" on report_sec018_patrols;
drop policy "bay_board station select" on bay_board;
drop policy "bay_board station insert" on bay_board;
drop policy "bay_board station update" on bay_board;

drop function if exists is_supervisor_or_above();
drop function if exists is_manager_or_above();

-- Recreate policies against the new role model: ASO submits, SO/DSE/ENFORCEMENT/ADMIN
-- monitor everything (no station scoping), ADMIN also manages users/reference data.
create policy "profiles self select" on profiles for select
  using (id = auth.uid() or is_monitor_or_above());

create policy "profiles self update" on profiles for update
  using (id = auth.uid())
  with check (id = auth.uid());

create policy "sec016 monitor select" on report_sec016 for select using (is_monitor_or_above());
create policy "sec016 own insert" on report_sec016 for insert
  with check (profile_id = auth.uid() and current_role_name() = 'ASO' and current_status() = 'approved');

create policy "sec014 monitor select" on report_sec014 for select using (is_monitor_or_above());
create policy "sec014 own insert" on report_sec014 for insert
  with check (profile_id = auth.uid() and current_role_name() = 'ASO' and current_status() = 'approved');
create policy "sec014_patrols via parent select" on report_sec014_patrols for select
  using (exists (
    select 1 from report_sec014 r where r.id = report_id
    and (r.profile_id = auth.uid() or is_monitor_or_above())
  ));

create policy "sec029 monitor select" on report_sec029 for select using (is_monitor_or_above());
create policy "sec029 own insert" on report_sec029 for insert
  with check (profile_id = auth.uid() and current_role_name() = 'ASO' and current_status() = 'approved');
create policy "sec029_items via parent select" on report_sec029_items for select
  using (exists (
    select 1 from report_sec029 r where r.id = report_id
    and (r.profile_id = auth.uid() or is_monitor_or_above())
  ));

create policy "sec018 monitor select" on report_sec018 for select using (is_monitor_or_above());
create policy "sec018 own insert" on report_sec018 for insert
  with check (profile_id = auth.uid() and current_role_name() = 'ASO' and current_status() = 'approved');
create policy "sec018_patrols via parent select" on report_sec018_patrols for select
  using (exists (
    select 1 from report_sec018 r where r.id = report_id
    and (r.profile_id = auth.uid() or is_monitor_or_above())
  ));

create policy "bay_board station select" on bay_board for select
  using (station = current_station() or is_monitor_or_above());
create policy "bay_board station insert" on bay_board for insert
  with check (station = current_station() or is_monitor_or_above());
create policy "bay_board station update" on bay_board for update
  using (station = current_station() or is_monitor_or_above());

-- Once an account has been reviewed, role/status can only change via the admin-manage
-- policy (ADMIN role); before that, the applicant may still edit their own requested
-- role (but never to ADMIN) and cannot self-approve.
create or replace function enforce_profile_self_update()
returns trigger as $$
begin
  if current_role_name() = 'ADMIN' then
    return new;
  end if;

  if old.id is distinct from auth.uid() then
    raise exception 'Not authorized to modify this profile.';
  end if;

  if old.status in ('approved', 'rejected') then
    if new.role <> old.role or new.status <> old.status then
      raise exception 'Your account has already been reviewed. Contact an admin to change your role.';
    end if;
  else
    if new.status <> 'pending' then
      raise exception 'Cannot change your own approval status.';
    end if;
    if new.role = 'ADMIN' then
      raise exception 'Cannot self-assign the ADMIN role.';
    end if;
  end if;

  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger profiles_enforce_self_update before update on profiles
  for each row execute function enforce_profile_self_update();
