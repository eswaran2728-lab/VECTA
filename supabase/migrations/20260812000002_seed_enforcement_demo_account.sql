-- ============================================================
-- Demo account for the enforcement role, mirroring the existing demo
-- accounts (pic@icms.local, admin@icms.local, etc.) in structure and
-- password convention.
--
-- Created via direct SQL against auth.users + auth.identities,
-- replicating the exact field pattern of an existing working account
-- (admin@icms.local) rather than guessing at GoTrue's expected shape.
-- This session had no access to the Supabase Auth admin API (needs
-- the service role key, which isn't available here) and no reachable
-- network path to call it directly, so this is the closest safe
-- equivalent to admin.auth.admin.createUser(). Two generated columns
-- (auth.users.confirmed_at, auth.identities.email) are intentionally
-- omitted from the insert lists — they're computed automatically.
-- ============================================================

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data,
  is_sso_user, is_anonymous, created_at, updated_at
) values (
  '00000000-0000-0000-0000-000000000000',
  'd4fea398-6039-47d0-9e64-4ccbd2187b91',
  'authenticated', 'authenticated',
  'enforcement@icms.local',
  crypt('ICMS-demo-2026!', gen_salt('bf')),
  now(),
  '{"provider":"email","providers":["email"]}',
  '{"email":"enforcement@icms.local"}',
  false, false, now(), now()
);

insert into auth.identities (
  id, user_id, provider_id, provider, identity_data, created_at, updated_at, last_sign_in_at
) values (
  '26c303a3-70b7-4099-8923-22d0f612c585',
  'd4fea398-6039-47d0-9e64-4ccbd2187b91',
  'd4fea398-6039-47d0-9e64-4ccbd2187b91',
  'email',
  '{"sub":"d4fea398-6039-47d0-9e64-4ccbd2187b91","email":"enforcement@icms.local","email_verified":true}',
  now(), now(), now()
);

insert into public.users (id, name, staff_id, email, role, status) values (
  'd4fea398-6039-47d0-9e64-4ccbd2187b91',
  'Enforcement Demo',
  'EN-7001',
  'enforcement@icms.local',
  'enforcement',
  'active'
);
