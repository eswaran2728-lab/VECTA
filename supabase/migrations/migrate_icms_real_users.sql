-- ============================================================
-- Real ICMS user migration into the shared (AVSEC) project.
-- Source: live export of ICMS's public.users, pulled by the project
-- owner from their original Supabase project (this session has no
-- direct network access to reach ICMS's project itself — see the
-- migration report). Applied directly against the shared project
-- (ddlctzbnqewubltcavkh) via the Supabase MCP tool.
--
-- DISCARDED, not migrated (confirmed by the project owner — a demo/test
-- account, not a real person; no conflict resolution needed):
--   4179bf5c-3fb5-4818-b2b9-55d33625a919, "gopi", staff_id 75656,
--   post6_avsec, email karmagaming3561@gmail.com — that email already
--   belongs to a DIFFERENT existing AVSEC account ("raq", unified_role
--   'aso') in this shared project.
--
-- Same-UUID preservation: every id below is copied verbatim from ICMS's
-- auth.users/public.users so any future historical-data migration (e.g.
-- transactions.created_by) still resolves correctly.
--
-- Passwords (not reproduced here — see the applied migration's
-- comments): the 9 @icms.local accounts reuse ICMS's own existing
-- internal/demo password convention; the 5 real personal-email accounts
-- got a random unusable password and need "Forgot password" against
-- their real email to set their own credentials.
-- ============================================================

do $$
declare
  v_icms_demo_pw text := 'ICMS-demo-2026!';
  v_users jsonb := '[
    {"id":"d4fea398-6039-47d0-9e64-4ccbd2187b91","name":"Enforcement Demo","staff_id":"EN-7001","email":"enforcement@icms.local","role":"enforcement","status":"active","lang":"en","unified_role":"enforcement","duty_post":null,"real_email":false},
    {"id":"74e96265-bb0f-4b47-adf7-d7d6402e1182","name":"Hub AVSEC Demo","staff_id":"HB-8001","email":"hub@icms.local","role":"hub_avsec","status":"active","lang":"en","unified_role":"aso","duty_post":"Hub","real_email":false},
    {"id":"7bb4709a-5f6f-462d-9097-8b50b4a12428","name":"rahmat","staff_id":"21211","email":"esdk00252@gmail.com","role":"post2_avsec","status":"active","lang":"en","unified_role":"aso","duty_post":"Post 2","real_email":true},
    {"id":"22222222-2222-2222-2222-222222222222","name":"Siti Post Two","staff_id":"AV-2001","email":"post2@icms.local","role":"post2_avsec","status":"active","lang":"en","unified_role":"aso","duty_post":"Post 2","real_email":false},
    {"id":"616b0e0a-7cde-4f4e-a9a5-6f24ab991e06","name":"eswaran","staff_id":"1047580","email":"eswaran3561@gmail.com","role":"post6_avsec","status":"active","lang":"en","unified_role":"aso","duty_post":"Post 6","real_email":true},
    {"id":"33333333-3333-3333-3333-333333333333","name":"Kumar Post Six","staff_id":"AV-6001","email":"post6@icms.local","role":"post6_avsec","status":"active","lang":"en","unified_role":"aso","duty_post":"Post 6","real_email":false},
    {"id":"abab8793-10d2-45b5-a49c-780a03d8d350","name":"Enforcement Team (AVSEC)","staff_id":"2345678","email":"fruitygo0321@gmail.com","role":"receiver","status":"active","lang":"en","unified_role":"aso","duty_post":"Receiver","real_email":true},
    {"id":"63eaaf48-f947-4510-b343-a18a89ffd0dd","name":"fatin","staff_id":"54345543","email":"eswaran162728@gmail.com","role":"receiver","status":"active","lang":"en","unified_role":"aso","duty_post":"Receiver","real_email":true},
    {"id":"44444444-4444-4444-4444-444444444444","name":"Lee Receiver","staff_id":"SR-3001","email":"receiver@icms.local","role":"receiver","status":"active","lang":"en","unified_role":"aso","duty_post":"Receiver","real_email":false},
    {"id":"42747ffe-9ea5-4ff3-b8f5-dcd05862c12d","name":"REDQ AVSEC Demo","staff_id":"RQ-8001","email":"redq@icms.local","role":"redq_avsec","status":"active","lang":"en","unified_role":"aso","duty_post":"REDQ","real_email":false},
    {"id":"55555555-5555-5555-5555-555555555555","name":"Farah Admin","staff_id":"SV-9001","email":"admin@icms.local","role":"supervisor","status":"active","lang":"ms","unified_role":"admin","duty_post":null,"real_email":false},
    {"id":"634683a6-00af-47f1-b36b-3098617c2574","name":"Vendor Demo","staff_id":"VD-9001","email":"vendor@icms.local","role":"vendor","status":"active","lang":"en","unified_role":"vendor","duty_post":null,"real_email":false},
    {"id":"11111111-1111-1111-1111-111111111111","name":"Ahmad Warehouse","staff_id":"WH-1001","email":"pic@icms.local","role":"warehouse_pic","status":"active","lang":"en","unified_role":"aso","duty_post":"Warehouse","real_email":false},
    {"id":"46445577-4526-4241-b8f6-36c8fd60b483","name":"ESWARAN","staff_id":"1234567","email":"dkes74477@gmail.com","role":"warehouse_pic","status":"active","lang":"en","unified_role":"aso","duty_post":"Warehouse","real_email":true},
    {"id":"66666666-6666-6666-6666-666666666666","name":"Nurul SRA Warehouse","staff_id":"SW-4001","email":"sra@icms.local","role":"warehouse_pic","status":"active","lang":"en","unified_role":"aso","duty_post":"Warehouse","real_email":false}
  ]'::jsonb;
  r record;
  v_pw text;
  v_identity_id uuid;
begin
  for r in select * from jsonb_to_recordset(v_users) as x(
    id uuid, name text, staff_id text, email text, role text, status text,
    lang text, unified_role text, duty_post text, real_email boolean
  )
  loop
    v_pw := case when r.real_email then encode(gen_random_bytes(24), 'hex') else v_icms_demo_pw end;
    v_identity_id := gen_random_uuid();

    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password,
      email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
      is_sso_user, is_anonymous, created_at, updated_at
    ) values (
      '00000000-0000-0000-0000-000000000000',
      r.id, 'authenticated', 'authenticated', r.email,
      crypt(v_pw, gen_salt('bf')),
      now(),
      '{"provider":"email","providers":["email"]}',
      jsonb_build_object('email', r.email),
      false, false, now(), now()
    );

    insert into auth.identities (
      id, user_id, provider_id, provider, identity_data, created_at, updated_at, last_sign_in_at
    ) values (
      v_identity_id, r.id, r.id::text, 'email',
      jsonb_build_object('sub', r.id::text, 'email', r.email, 'email_verified', true),
      now(), now(), now()
    );

    insert into public.users (id, name, staff_id, email, role, status, preferred_language, unified_role, duty_post)
    values (r.id, r.name, r.staff_id, r.email, r.role, r.status, r.lang, r.unified_role, r.duty_post);
  end loop;
end $$;
