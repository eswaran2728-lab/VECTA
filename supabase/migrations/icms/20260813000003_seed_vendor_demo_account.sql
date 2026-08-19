-- ============================================================
-- Demo account for the new vendor role, mirroring the enforcement demo
-- account's structure/password convention exactly (see
-- 20260812000002_seed_enforcement_demo_account.sql). This time the
-- confirmation_token/recovery_token/email_change_token_new/email_change
-- columns are set to '' directly in the insert (not left NULL) — a NULL
-- there broke the enforcement demo account's login (GoTrue scans these
-- into non-nullable Go strings) and had to be hotfixed separately;
-- avoiding that repeat here.
-- ============================================================

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data,
  is_sso_user, is_anonymous, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change
) values (
  '00000000-0000-0000-0000-000000000000',
  '634683a6-00af-47f1-b36b-3098617c2574',
  'authenticated', 'authenticated',
  'vendor@icms.local',
  crypt('ICMS-demo-2026!', gen_salt('bf')),
  now(),
  '{"provider":"email","providers":["email"]}',
  '{"email":"vendor@icms.local"}',
  false, false, now(), now(),
  '', '', '', ''
);

insert into auth.identities (
  id, user_id, provider_id, provider, identity_data, created_at, updated_at, last_sign_in_at
) values (
  '9e73d046-6373-4fc6-b9be-5a3c2eed6fd4',
  '634683a6-00af-47f1-b36b-3098617c2574',
  '634683a6-00af-47f1-b36b-3098617c2574',
  'email',
  '{"sub":"634683a6-00af-47f1-b36b-3098617c2574","email":"vendor@icms.local","email_verified":true}',
  now(), now(), now()
);

insert into public.users (id, name, staff_id, email, role, status) values (
  '634683a6-00af-47f1-b36b-3098617c2574',
  'Vendor Demo',
  'VD-9001',
  'vendor@icms.local',
  'vendor',
  'active'
);
