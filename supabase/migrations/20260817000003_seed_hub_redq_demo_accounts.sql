-- ============================================================
-- Demo accounts for the two new Multi-Route Restructure roles
-- (hub_avsec, redq_avsec), mirroring the vendor/enforcement demo
-- accounts' structure and password convention exactly (see
-- 20260813000003_seed_vendor_demo_account.sql). confirmation_token/
-- recovery_token/email_change_token_new/email_change are set to ''
-- directly in the insert (not left NULL) — a NULL there broke the
-- enforcement demo account's login previously (GoTrue scans these
-- into non-nullable Go strings) and had to be hotfixed separately.
-- ============================================================

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data,
  is_sso_user, is_anonymous, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change
) values
(
  '00000000-0000-0000-0000-000000000000',
  '74e96265-bb0f-4b47-adf7-d7d6402e1182',
  'authenticated', 'authenticated',
  'hub@icms.local',
  crypt('ICMS-demo-2026!', gen_salt('bf')),
  now(),
  '{"provider":"email","providers":["email"]}',
  '{"email":"hub@icms.local"}',
  false, false, now(), now(),
  '', '', '', ''
),
(
  '00000000-0000-0000-0000-000000000000',
  '42747ffe-9ea5-4ff3-b8f5-dcd05862c12d',
  'authenticated', 'authenticated',
  'redq@icms.local',
  crypt('ICMS-demo-2026!', gen_salt('bf')),
  now(),
  '{"provider":"email","providers":["email"]}',
  '{"email":"redq@icms.local"}',
  false, false, now(), now(),
  '', '', '', ''
);

insert into auth.identities (
  id, user_id, provider_id, provider, identity_data, created_at, updated_at, last_sign_in_at
) values
(
  '4a3a4ee7-2147-4e40-a952-6204b718ef00',
  '74e96265-bb0f-4b47-adf7-d7d6402e1182',
  '74e96265-bb0f-4b47-adf7-d7d6402e1182',
  'email',
  '{"sub":"74e96265-bb0f-4b47-adf7-d7d6402e1182","email":"hub@icms.local","email_verified":true}',
  now(), now(), now()
),
(
  'dc1eade0-03fe-473b-8c35-8ef8d2856b3a',
  '42747ffe-9ea5-4ff3-b8f5-dcd05862c12d',
  '42747ffe-9ea5-4ff3-b8f5-dcd05862c12d',
  'email',
  '{"sub":"42747ffe-9ea5-4ff3-b8f5-dcd05862c12d","email":"redq@icms.local","email_verified":true}',
  now(), now(), now()
);

insert into public.users (id, name, staff_id, email, role, status) values
(
  '74e96265-bb0f-4b47-adf7-d7d6402e1182',
  'Hub AVSEC Demo',
  'HB-8001',
  'hub@icms.local',
  'hub_avsec',
  'active'
),
(
  '42747ffe-9ea5-4ff3-b8f5-dcd05862c12d',
  'REDQ AVSEC Demo',
  'RQ-8001',
  'redq@icms.local',
  'redq_avsec',
  'active'
);
