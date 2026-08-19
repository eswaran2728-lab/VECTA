-- ============================================================
-- Full account + operational-data reset, requested by the project
-- owner for a clean demo roster. Confirmed explicitly after being
-- warned this cascades into real operational history (duty records,
-- submitted reports, audit logs, incidents, transactions), since the
-- FKs are NO ACTION (an account can't be deleted while referenced).
--
-- Preserved untouched: shared reference/config data that isn't
-- per-account history — vehicles, drivers, catering_companies,
-- stations, teams, aircraft_types, shifts, station_teams,
-- segment_timeouts, cscs_settings, report_counters,
-- sheet_sync_config, transaction_counters, vendor_transaction_counters.
-- duty_zones is kept too (geofence config), with created_by nulled
-- since that FK is nullable.
-- ============================================================

alter table public.audit_logs disable trigger user;
alter table public.part_a disable trigger user;
alter table public.part_b disable trigger user;
alter table public.part_c disable trigger user;
alter table public.part_d disable trigger user;
alter table public.part_hub disable trigger user;
alter table public.part_redq disable trigger user;
alter table public.incidents disable trigger user;
alter table public.incident_photos disable trigger user;
alter table public.transactions disable trigger user;
alter table public.seals disable trigger user;
alter table public.seal_verifications disable trigger user;
alter table public.vendor_transactions disable trigger user;
alter table public.vendor_part_a disable trigger user;
alter table public.vendor_part_b disable trigger user;
alter table public.vendor_part_c disable trigger user;
alter table public.report_sec013 disable trigger user;
alter table public.report_sec014 disable trigger user;
alter table public.report_sec016 disable trigger user;
alter table public.report_sec018 disable trigger user;
alter table public.report_sec029 disable trigger user;
alter table public.report_sec033 disable trigger user;
alter table public.report_sec013_profiling_duties disable trigger user;
alter table public.report_sec014_patrols disable trigger user;
alter table public.report_sec018_patrols disable trigger user;
alter table public.report_sec029_items disable trigger user;
alter table public.report_sec033_hold_checks disable trigger user;
alter table public.report_attachments disable trigger user;
alter table public.report_acknowledgements disable trigger user;
alter table public.report_drafts disable trigger user;
alter table public.bay_board disable trigger user;
alter table public.duty_records disable trigger user;
alter table public.overtime_requests disable trigger user;
alter table public.team_rosters disable trigger user;
alter table public.enforcement_search_log disable trigger user;
alter table public.sheet_sync_queue disable trigger user;
alter table public.notifications disable trigger user;

delete from public.seal_verifications;
delete from public.part_hub;
delete from public.part_redq;
delete from public.seals;
delete from public.part_a;
delete from public.part_b;
delete from public.part_c;
delete from public.part_d;
delete from public.incident_photos;
delete from public.incidents;
delete from public.transactions;
delete from public.vendor_part_a;
delete from public.vendor_part_b;
delete from public.vendor_part_c;
delete from public.vendor_transactions;
delete from public.report_sec014_patrols;
delete from public.report_sec018_patrols;
delete from public.report_sec029_items;
delete from public.report_sec033_hold_checks;
delete from public.report_sec013_profiling_duties;
delete from public.report_attachments;
delete from public.report_acknowledgements;
delete from public.report_sec016;
delete from public.report_sec014;
delete from public.report_sec018;
delete from public.report_sec029;
delete from public.report_sec033;
delete from public.report_sec013;
delete from public.report_drafts;
delete from public.bay_board;
delete from public.overtime_requests;
delete from public.duty_records;
delete from public.team_rosters;
delete from public.enforcement_search_log;
delete from public.sheet_sync_queue;
delete from public.notifications;
delete from public.audit_logs;

alter table public.audit_logs enable trigger user;
alter table public.part_a enable trigger user;
alter table public.part_b enable trigger user;
alter table public.part_c enable trigger user;
alter table public.part_d enable trigger user;
alter table public.part_hub enable trigger user;
alter table public.part_redq enable trigger user;
alter table public.incidents enable trigger user;
alter table public.incident_photos enable trigger user;
alter table public.transactions enable trigger user;
alter table public.seals enable trigger user;
alter table public.seal_verifications enable trigger user;
alter table public.vendor_transactions enable trigger user;
alter table public.vendor_part_a enable trigger user;
alter table public.vendor_part_b enable trigger user;
alter table public.vendor_part_c enable trigger user;
alter table public.report_sec013 enable trigger user;
alter table public.report_sec014 enable trigger user;
alter table public.report_sec016 enable trigger user;
alter table public.report_sec018 enable trigger user;
alter table public.report_sec029 enable trigger user;
alter table public.report_sec033 enable trigger user;
alter table public.report_sec013_profiling_duties enable trigger user;
alter table public.report_sec014_patrols enable trigger user;
alter table public.report_sec018_patrols enable trigger user;
alter table public.report_sec029_items enable trigger user;
alter table public.report_sec033_hold_checks enable trigger user;
alter table public.report_attachments enable trigger user;
alter table public.report_acknowledgements enable trigger user;
alter table public.report_drafts enable trigger user;
alter table public.bay_board enable trigger user;
alter table public.duty_records enable trigger user;
alter table public.overtime_requests enable trigger user;
alter table public.team_rosters enable trigger user;
alter table public.enforcement_search_log enable trigger user;
alter table public.sheet_sync_queue enable trigger user;
alter table public.notifications enable trigger user;

update public.duty_zones set created_by = null;

delete from auth.users;

-- ============================================================
-- Fresh demo roster after the wipe: one account per unified role,
-- eswaranp@airasia.com as a real admin, plus a second, separate demo
-- admin account. Six roles live in AVSEC's profiles table (its
-- user_role enum has no VENDOR value); vendor lives in ICMS's users
-- table instead. Password for every account: Vecta-Demo-2026!
--
-- NOTE: auth.users has an on_auth_user_created trigger that auto-stubs
-- a public.profiles row for every new account, including the vendor
-- one — that stray stub is deleted at the end since vendor belongs
-- only in public.users.
-- ============================================================

alter table public.profiles disable trigger profiles_enforce_self_update;

do $$
declare
  v_pw text := 'Vecta-Demo-2026!';
  v_profiles jsonb := '[
    {"id":"a0000000-0000-4000-8000-000000000001","email":"eswaranp@airasia.com","name":"Eswaran Padmanathan","staff_no":"ADM-0001","station":null,"team":null,"role":"ADMIN","unified_role":"admin"},
    {"id":"a0000000-0000-4000-8000-000000000002","email":"demo.admin@vecta.local","name":"Demo Admin","staff_no":"ADM-9002","station":null,"team":null,"role":"ADMIN","unified_role":"admin"},
    {"id":"a0000000-0000-4000-8000-000000000003","email":"demo.management@vecta.local","name":"Demo Management","staff_no":"MGT-9001","station":null,"team":null,"role":"MANAGEMENT","unified_role":"management"},
    {"id":"a0000000-0000-4000-8000-000000000004","email":"demo.enforcement@vecta.local","name":"Demo Enforcement","staff_no":"ENF-9001","station":null,"team":null,"role":"ENFORCEMENT","unified_role":"enforcement"},
    {"id":"a0000000-0000-4000-8000-000000000005","email":"demo.so@vecta.local","name":"Demo SO","staff_no":"SO-9001","station":"KUL - MAA","team":"ALPHA","role":"SO","unified_role":"so"},
    {"id":"a0000000-0000-4000-8000-000000000006","email":"demo.aso@vecta.local","name":"Demo ASO","staff_no":"ASO-9001","station":"KUL - MAA","team":"ALPHA","role":"ASO","unified_role":"aso"},
    {"id":"a0000000-0000-4000-8000-000000000007","email":"demo.dse@vecta.local","name":"Demo DSE","staff_no":"DSE-9001","station":"KUL - MAA","team":"ALPHA","role":"DSE","unified_role":"dse"}
  ]'::jsonb;
  r record;
  v_identity_id uuid;
begin
  for r in select * from jsonb_to_recordset(v_profiles) as x(
    id uuid, email text, name text, staff_no text, station text, team text, role text, unified_role text
  )
  loop
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

    insert into public.profiles (id, email, name, staff_no, station, team, role, status, unified_role)
    values (r.id, r.email, r.name, r.staff_no, r.station, r.team, r.role::user_role, 'approved', r.unified_role)
    on conflict (id) do update set
      email = excluded.email,
      name = excluded.name,
      staff_no = excluded.staff_no,
      station = excluded.station,
      team = excluded.team,
      role = excluded.role,
      status = excluded.status,
      unified_role = excluded.unified_role;
  end loop;
end $$;

alter table public.profiles enable trigger profiles_enforce_self_update;

do $$
declare
  v_pw text := 'Vecta-Demo-2026!';
  v_id uuid := 'a0000000-0000-4000-8000-000000000008';
  v_identity_id uuid := gen_random_uuid();
begin
  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
    is_sso_user, is_anonymous, created_at, updated_at
  ) values (
    '00000000-0000-0000-0000-000000000000',
    v_id, 'authenticated', 'authenticated', 'demo.vendor@vecta.local',
    crypt(v_pw, gen_salt('bf')),
    now(),
    '{"provider":"email","providers":["email"]}',
    '{"email":"demo.vendor@vecta.local"}',
    false, false, now(), now()
  );

  insert into auth.identities (
    id, user_id, provider_id, provider, identity_data, created_at, updated_at, last_sign_in_at
  ) values (
    v_identity_id, v_id, v_id::text, 'email',
    jsonb_build_object('sub', v_id::text, 'email', 'demo.vendor@vecta.local', 'email_verified', true),
    now(), now(), now()
  );

  insert into public.users (id, name, staff_id, email, role, status, preferred_language, unified_role, duty_post)
  values (v_id, 'Demo Vendor', 'VEN-9001', 'demo.vendor@vecta.local', 'vendor', 'active', 'en', 'vendor', null);
end $$;

-- on_auth_user_created auto-stubs a public.profiles row for every new
-- auth.users insert, including the vendor account above — remove that
-- stray stub (vendor belongs only in public.users).
alter table public.profiles disable trigger profiles_enforce_self_update;
delete from public.profiles where id = 'a0000000-0000-4000-8000-000000000008';
alter table public.profiles enable trigger profiles_enforce_self_update;
