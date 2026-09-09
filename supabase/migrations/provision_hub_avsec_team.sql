-- ============================================================
-- VECTA: Provision Hub AVSEC Operational Staff Accounts
-- Adds Alpha and Bravo teams (DSE, SO, ASO) for Hub AVSEC operations.
--
-- Password for all accounts: Vecta2026!
-- ============================================================

do $$
declare
  v_pw text := 'Vecta2026!';
  v_accounts jsonb := '[
    {"id":"b0000000-0000-4000-8000-000000000050","email":"dse.hub.alpha@vecta.local","name":"DSE Alpha (Hub)","staff_no":"DSE-HA-01","station":"KUL - MAA","team":"ALPHA","role":"DSE","unified_role":"dse","ops_group":"hub_avsec","is_driver":false,"icms_role":"hub_avsec","duty_post":"Hub Security"},
    {"id":"b0000000-0000-4000-8000-000000000051","email":"so.hub.alpha@vecta.local","name":"SO Alpha (Hub)","staff_no":"SO-HA-01","station":"KUL - MAA","team":"ALPHA","role":"SO","unified_role":"so","ops_group":"hub_avsec","is_driver":false,"icms_role":"hub_avsec","duty_post":"Hub Security"},
    {"id":"b0000000-0000-4000-8000-000000000052","email":"aso.hub.alpha@vecta.local","name":"ASO Alpha (Hub)","staff_no":"ASO-HA-01","station":"KUL - MAA","team":"ALPHA","role":"ASO","unified_role":"aso","ops_group":"hub_avsec","is_driver":false,"icms_role":"hub_avsec","duty_post":"Hub Security"},

    {"id":"b0000000-0000-4000-8000-000000000053","email":"dse.hub.bravo@vecta.local","name":"DSE Bravo (Hub)","staff_no":"DSE-HB-01","station":"KUL - MAA","team":"BRAVO","role":"DSE","unified_role":"dse","ops_group":"hub_avsec","is_driver":false,"icms_role":"hub_avsec","duty_post":"Hub Security"},
    {"id":"b0000000-0000-4000-8000-000000000054","email":"so.hub.bravo@vecta.local","name":"SO Bravo (Hub)","staff_no":"SO-HB-01","station":"KUL - MAA","team":"BRAVO","role":"SO","unified_role":"so","ops_group":"hub_avsec","is_driver":false,"icms_role":"hub_avsec","duty_post":"Hub Security"},
    {"id":"b0000000-0000-4000-8000-000000000055","email":"aso.hub.bravo@vecta.local","name":"ASO Bravo (Hub)","staff_no":"ASO-HB-01","station":"KUL - MAA","team":"BRAVO","role":"ASO","unified_role":"aso","ops_group":"hub_avsec","is_driver":false,"icms_role":"hub_avsec","duty_post":"Hub Security"}
  ]'::jsonb;
  r record;
  v_identity_id uuid;
begin
  for r in select * from jsonb_to_recordset(v_accounts) as x(
    id uuid, email text, name text, staff_no text, station text, team text,
    role text, unified_role text, ops_group text, is_driver boolean,
    icms_role text, duty_post text
  )
  loop
    v_identity_id := gen_random_uuid();

    -- Upsert auth.users
    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password,
      email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
      is_sso_user, is_anonymous, created_at, updated_at,
      confirmation_token, email_change, email_change_token_new,
      email_change_token_current, recovery_token, phone_change,
      phone_change_token, reauthentication_token
    ) values (
      '00000000-0000-0000-0000-000000000000',
      r.id, 'authenticated', 'authenticated', r.email,
      crypt(v_pw, gen_salt('bf')),
      now(),
      '{"provider":"email","providers":["email"]}',
      jsonb_build_object(
        'email', r.email,
        'name', r.name,
        'system_type', 'avsec',
        'role', r.unified_role,
        'ops_group', r.ops_group
      ),
      false, false, now(), now(),
      '', '', '', '', '', '', '', ''
    )
    on conflict (id) do update set
      encrypted_password = crypt(v_pw, gen_salt('bf')),
      email_confirmed_at = now(),
      raw_user_meta_data = jsonb_build_object(
        'email', r.email,
        'name', r.name,
        'system_type', 'avsec',
        'role', r.unified_role,
        'ops_group', r.ops_group
      );

    -- Upsert auth.identities
    insert into auth.identities (
      id, user_id, identity_data, provider, provider_id, last_sign_in_at, created_at, updated_at
    ) values (
      v_identity_id, r.id,
      jsonb_build_object('sub', r.id::text, 'email', r.email),
      'email', r.id::text, now(), now(), now()
    )
    on conflict (provider, provider_id) do nothing;

    -- Upsert public.profiles
    insert into public.profiles (
      id, email, name, staff_no, station, team, role, status, unified_role, ops_group
    ) values (
      r.id, r.email, r.name, r.staff_no, r.station, r.team,
      r.role::public.user_role, 'approved'::public.profile_status,
      r.unified_role, r.ops_group
    )
    on conflict (id) do update set
      name = r.name,
      staff_no = r.staff_no,
      station = r.station,
      team = r.team,
      role = r.role::public.user_role,
      status = 'approved'::public.profile_status,
      unified_role = r.unified_role,
      ops_group = r.ops_group;

    -- Upsert public.users (ICMS role)
    insert into public.users (
      id, name, staff_id, email, role, status, preferred_language, unified_role, ops_group, duty_post
    ) values (
      r.id, r.name, r.staff_no, r.email,
      coalesce(r.icms_role, 'hub_avsec'),
      'active', 'en', r.unified_role, r.ops_group, r.duty_post
    )
    on conflict (id) do update set
      name = r.name,
      staff_id = r.staff_no,
      role = coalesce(r.icms_role, 'hub_avsec'),
      status = 'active',
      unified_role = r.unified_role,
      ops_group = r.ops_group,
      duty_post = r.duty_post;
  end loop;
end $$;
