-- ============================================================
-- Demo accounts for each ICMS movement checkpoint/duty post — these
-- are separate physical stations, each needing its own login (unlike
-- AVSEC's own generic ASO role, which is a different thing: security
-- patrol/reporting, not an ICMS movement checkpoint). All map to the
-- unified 'aso' role with duty_post recording which post they are.
-- Live in ICMS's public.users table, same as the vendor demo account.
-- Password: Vecta-Demo-2026! (same convention as the rest of the roster).
-- ============================================================

do $$
declare
  v_pw text := 'Vecta-Demo-2026!';
  v_accounts jsonb := '[
    {"id":"a0000000-0000-4000-8000-000000000009","email":"demo.warehouse@vecta.local","name":"Demo Warehouse PIC","staff_id":"WH-9001","role":"warehouse_pic","duty_post":"Warehouse"},
    {"id":"a0000000-0000-4000-8000-00000000000a","email":"demo.post2@vecta.local","name":"Demo Post 2 AVSEC","staff_id":"AV2-9001","role":"post2_avsec","duty_post":"Post 2"},
    {"id":"a0000000-0000-4000-8000-00000000000b","email":"demo.post6@vecta.local","name":"Demo Post 6 AVSEC","staff_id":"AV6-9001","role":"post6_avsec","duty_post":"Post 6"},
    {"id":"a0000000-0000-4000-8000-00000000000c","email":"demo.receiver@vecta.local","name":"Demo Receiver","staff_id":"SR-9001","role":"receiver","duty_post":"Receiver"},
    {"id":"a0000000-0000-4000-8000-00000000000d","email":"demo.hub@vecta.local","name":"Demo Hub AVSEC","staff_id":"HB-9001","role":"hub_avsec","duty_post":"Hub"},
    {"id":"a0000000-0000-4000-8000-00000000000e","email":"demo.redq@vecta.local","name":"Demo REDQ AVSEC","staff_id":"RQ-9001","role":"redq_avsec","duty_post":"REDQ"}
  ]'::jsonb;
  r record;
  v_identity_id uuid;
begin
  for r in select * from jsonb_to_recordset(v_accounts) as x(
    id uuid, email text, name text, staff_id text, role text, duty_post text
  )
  loop
    v_identity_id := gen_random_uuid();

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
      jsonb_build_object('email', r.email),
      false, false, now(), now(),
      -- GoTrue's Go scanner errors on NULL here ("converting NULL to
      -- string is unsupported") — these columns must be '' not NULL.
      '', '', '', '', '', '', '', ''
    );

    insert into auth.identities (
      id, user_id, provider_id, provider, identity_data, created_at, updated_at, last_sign_in_at
    ) values (
      v_identity_id, r.id, r.id::text, 'email',
      jsonb_build_object('sub', r.id::text, 'email', r.email, 'email_verified', true),
      now(), now(), now()
    );

    insert into public.users (id, name, staff_id, email, role, status, preferred_language, unified_role, duty_post)
    values (r.id, r.name, r.staff_id, r.email, r.role, 'active', 'en', 'aso', r.duty_post);
  end loop;
end $$;

-- Clean up the stray public.profiles stub on_auth_user_created makes
-- for every new auth.users row — these six belong only in public.users.
alter table public.profiles disable trigger profiles_enforce_self_update;
delete from public.profiles where id in (
  'a0000000-0000-4000-8000-000000000009','a0000000-0000-4000-8000-00000000000a',
  'a0000000-0000-4000-8000-00000000000b','a0000000-0000-4000-8000-00000000000c',
  'a0000000-0000-4000-8000-00000000000d','a0000000-0000-4000-8000-00000000000e'
);
alter table public.profiles enable trigger profiles_enforce_self_update;
