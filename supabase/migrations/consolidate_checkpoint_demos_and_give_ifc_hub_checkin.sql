-- ============================================================
-- Two decisions from the project owner:
-- 1. Consolidate the per-checkpoint ICMS-origin demo accounts
--    (post2/post6/redq) into one account per team — Scan itself
--    determines the specific checkpoint from the transaction, not
--    from who's logged in, so separate logins per checkpoint added
--    no value. demo.hub is untouched (already just one account).
-- 2. IFC and Hub should ALSO go through real geofence check-in with
--    a real shift roster, like Operation already does — not exempted
--    from the check-in gate. This means giving them a real
--    public.profiles row (AVSEC-side identity, station+team) in
--    ADDITION to their existing public.users row (ICMS-side identity,
--    needed for Scan/transaction access) — same dual-identity pattern
--    already used for admin/enforcement in
--    grant_icms_access_to_admin_enforcement.sql, just the other
--    direction (ICMS-origin account gaining an AVSEC identity instead
--    of the reverse).
-- ============================================================

-- Disable the superseded per-checkpoint demo accounts.
update auth.users
set banned_until = '2099-01-01T00:00:00Z'
where id in (
  'a0000000-0000-4000-8000-00000000000a', -- demo.post2
  'a0000000-0000-4000-8000-00000000000b', -- demo.post6
  'a0000000-0000-4000-8000-00000000000e'  -- demo.redq
);

update public.users set status = 'disabled'
where id in (
  'a0000000-0000-4000-8000-00000000000a',
  'a0000000-0000-4000-8000-00000000000b',
  'a0000000-0000-4000-8000-00000000000e'
);

-- New consolidated IFC demo account: one account for the whole IFC
-- team, with both an AVSEC profile (for check-in) and an ICMS user
-- row (for Scan/transaction access at whichever IFC checkpoint the
-- transaction is actually at).
do $$
declare
  v_pw text := 'Vecta-Demo-2026!';
  v_id uuid := 'a0000000-0000-4000-8000-00000000000f';
  v_identity_id uuid := gen_random_uuid();
begin
  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
    is_sso_user, is_anonymous, created_at, updated_at,
    confirmation_token, email_change, email_change_token_new,
    email_change_token_current, recovery_token, phone_change,
    phone_change_token, reauthentication_token
  ) values (
    '00000000-0000-0000-0000-000000000000',
    v_id, 'authenticated', 'authenticated', 'demo.ifc@vecta.local',
    crypt(v_pw, gen_salt('bf')),
    now(),
    '{"provider":"email","providers":["email"]}',
    '{"email":"demo.ifc@vecta.local"}',
    false, false, now(), now(),
    -- GoTrue's Go scanner errors on NULL here — see full_account_wipe_and_fresh_roster.sql.
    '', '', '', '', '', '', '', ''
  );

  insert into auth.identities (
    id, user_id, provider_id, provider, identity_data, created_at, updated_at, last_sign_in_at
  ) values (
    v_identity_id, v_id, v_id::text, 'email',
    jsonb_build_object('sub', v_id::text, 'email', 'demo.ifc@vecta.local', 'email_verified', true),
    now(), now(), now()
  );

  insert into public.users (id, name, staff_id, email, role, status, preferred_language, unified_role, duty_post)
  values (v_id, 'Demo IFC AVSEC', 'IFC-9001', 'demo.ifc@vecta.local', 'post2_avsec', 'active', 'en', 'aso', 'Post 2');
end $$;

-- Clean up the stray public.profiles stub on_auth_user_created makes
-- for the new IFC account, before inserting the real one below.
alter table public.profiles disable trigger profiles_enforce_self_update;
delete from public.profiles where id = 'a0000000-0000-4000-8000-00000000000f';

insert into public.profiles (id, email, name, staff_no, station, team, role, status, unified_role, ops_group)
values ('a0000000-0000-4000-8000-00000000000f', 'demo.ifc@vecta.local', 'Demo IFC AVSEC', 'IFC-9001', 'KUL - MAA', 'BRAVO', 'ASO', 'approved', 'aso', 'ifc_avsec');

-- demo.hub already exists (ICMS-side, unchanged) — add its AVSEC-side
-- identity so it can check in too.
insert into public.profiles (id, email, name, staff_no, station, team, role, status, unified_role, ops_group)
values ('a0000000-0000-4000-8000-00000000000d', 'demo.hub@vecta.local', 'Demo Hub AVSEC', 'HB-9001', 'KUL - MAA', 'CHARLIE', 'ASO', 'approved', 'aso', 'hub_avsec')
on conflict (id) do update set
  station = excluded.station, team = excluded.team, role = excluded.role,
  status = excluded.status, unified_role = excluded.unified_role, ops_group = excluded.ops_group;

alter table public.profiles enable trigger profiles_enforce_self_update;

-- Roster + station_teams for the two new teams, same date range as ALPHA.
insert into public.station_teams (station, team, display_order) values
  ('KUL - MAA', 'BRAVO', 2),
  ('KUL - MAA', 'CHARLIE', 3)
on conflict (station, team) do nothing;

insert into public.team_rosters (station, team, roster_date, shift_code, set_by)
select 'KUL - MAA', t.team, d::date, 'M',
  (select id from public.profiles where role = 'ADMIN' limit 1)
from generate_series(current_date - 1, current_date + 6, interval '1 day') as d
cross join (values ('BRAVO'), ('CHARLIE')) as t(team)
on conflict (station, team, roster_date) do nothing;
