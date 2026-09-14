-- ============================================================
-- VECTA & CATERLINK: Clean Roster Reset & Hierarchy Provisioning
-- strictly according to the Organizational Hierarchy Diagram:
--
--                         [ ADMIN ]
--                             |
--                             v
--                       [ MANAGEMENT ]
--                             |
--                             v
--                       [ ENFORCEMENT ]
--                        /           \
--                       v             v
--                  [ VECTA ]       [ CATERLINK ]
--                  /       \         /         \
--                 v         v       v           v
--       [OPERATION AVSEC] [IFC AVSEC] [IFC DRIVER] [THIRD PARTY DRIVER]
--         /   |   |   \     / | | \
--        A    B   C    D   A  B C  D
--      (DSE, (DSE,(DSE,(DSE) (each with DSE, SO, ASO)
--       SO,   SO,  SO,  SO,
--       ASO) ASO) ASO) ASO)
--
-- Password for all accounts: Vecta2026!
-- Preserves existing Super Admin: eswaranp@airasia.com
-- ============================================================

-- 1. Temporarily disable user-level triggers on operational tables
alter table if exists public.audit_logs disable trigger user;
alter table if exists public.part_a disable trigger user;
alter table if exists public.part_b disable trigger user;
alter table if exists public.part_c disable trigger user;
alter table if exists public.part_d disable trigger user;
alter table if exists public.part_hub disable trigger user;
alter table if exists public.part_redq disable trigger user;
alter table if exists public.incidents disable trigger user;
alter table if exists public.incident_photos disable trigger user;
alter table if exists public.transactions disable trigger user;
alter table if exists public.seals disable trigger user;
alter table if exists public.seal_verifications disable trigger user;
alter table if exists public.vendor_transactions disable trigger user;
alter table if exists public.vendor_part_a disable trigger user;
alter table if exists public.vendor_part_b disable trigger user;
alter table if exists public.vendor_part_c disable trigger user;
alter table if exists public.report_sec013 disable trigger user;
alter table if exists public.report_sec014 disable trigger user;
alter table if exists public.report_sec016 disable trigger user;
alter table if exists public.report_sec018 disable trigger user;
alter table if exists public.report_sec029 disable trigger user;
alter table if exists public.report_sec033 disable trigger user;
alter table if exists public.report_sec013_profiling_duties disable trigger user;
alter table if exists public.report_sec014_patrols disable trigger user;
alter table if exists public.report_sec018_patrols disable trigger user;
alter table if exists public.report_sec029_items disable trigger user;
alter table if exists public.report_sec033_hold_checks disable trigger user;
alter table if exists public.report_attachments disable trigger user;
alter table if exists public.report_acknowledgements disable trigger user;
alter table if exists public.report_drafts disable trigger user;
alter table if exists public.bay_board disable trigger user;
alter table if exists public.duty_records disable trigger user;
alter table if exists public.overtime_requests disable trigger user;
alter table if exists public.team_rosters disable trigger user;
alter table if exists public.enforcement_search_log disable trigger user;
alter table if exists public.sheet_sync_queue disable trigger user;
alter table if exists public.notifications disable trigger user;

-- 2. Clear out operational data that reference auth.users / public.profiles / public.users
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

-- Re-enable operational triggers
alter table if exists public.audit_logs enable trigger user;
alter table if exists public.part_a enable trigger user;
alter table if exists public.part_b enable trigger user;
alter table if exists public.part_c enable trigger user;
alter table if exists public.part_d enable trigger user;
alter table if exists public.part_hub enable trigger user;
alter table if exists public.part_redq enable trigger user;
alter table if exists public.incidents enable trigger user;
alter table if exists public.incident_photos enable trigger user;
alter table if exists public.transactions enable trigger user;
alter table if exists public.seals enable trigger user;
alter table if exists public.seal_verifications enable trigger user;
alter table if exists public.vendor_transactions enable trigger user;
alter table if exists public.vendor_part_a enable trigger user;
alter table if exists public.vendor_part_b enable trigger user;
alter table if exists public.vendor_part_c enable trigger user;
alter table if exists public.report_sec013 enable trigger user;
alter table if exists public.report_sec014 enable trigger user;
alter table if exists public.report_sec016 enable trigger user;
alter table if exists public.report_sec018 enable trigger user;
alter table if exists public.report_sec029 enable trigger user;
alter table if exists public.report_sec033 enable trigger user;
alter table if exists public.report_sec013_profiling_duties enable trigger user;
alter table if exists public.report_sec014_patrols enable trigger user;
alter table if exists public.report_sec018_patrols enable trigger user;
alter table if exists public.report_sec029_items enable trigger user;
alter table if exists public.report_sec033_hold_checks enable trigger user;
alter table if exists public.report_attachments enable trigger user;
alter table if exists public.report_acknowledgements enable trigger user;
alter table if exists public.report_drafts enable trigger user;
alter table if exists public.bay_board enable trigger user;
alter table if exists public.duty_records enable trigger user;
alter table if exists public.overtime_requests enable trigger user;
alter table if exists public.team_rosters enable trigger user;
alter table if exists public.enforcement_search_log enable trigger user;
alter table if exists public.sheet_sync_queue enable trigger user;
alter table if exists public.notifications enable trigger user;

update public.duty_zones set created_by = null;

-- 3. Delete old users (keeping only eswaranp@airasia.com)
alter table if exists public.profiles disable trigger profiles_enforce_self_update;

delete from public.users where lower(email) != 'eswaranp@airasia.com';
delete from public.profiles where lower(email) != 'eswaranp@airasia.com';
delete from auth.identities where user_id in (select id from auth.users where lower(email) != 'eswaranp@airasia.com');
delete from auth.users where lower(email) != 'eswaranp@airasia.com';

-- 4. Ensure eswaranp@airasia.com exists and is confirmed Super Admin
do $$
declare
  v_admin_id uuid;
  v_pw text := 'Vecta2026!';
  v_identity_id uuid := gen_random_uuid();
begin
  select id into v_admin_id from auth.users where lower(email) = 'eswaranp@airasia.com';

  if v_admin_id is null then
    v_admin_id := 'b0000000-0000-4000-8000-000000000001'::uuid;
    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password,
      email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
      is_sso_user, is_anonymous, created_at, updated_at,
      confirmation_token, email_change, email_change_token_new,
      email_change_token_current, recovery_token, phone_change,
      phone_change_token, reauthentication_token
    ) values (
      '00000000-0000-0000-0000-000000000000',
      v_admin_id, 'authenticated', 'authenticated', 'eswaranp@airasia.com',
      crypt(v_pw, gen_salt('bf')),
      now(),
      '{"provider":"email","providers":["email"]}',
      '{"email":"eswaranp@airasia.com","name":"Eswaran Padmanathan"}',
      false, false, now(), now(),
      '', '', '', '', '', '', '', ''
    );

    insert into auth.identities (
      id, user_id, provider_id, provider, identity_data, created_at, updated_at, last_sign_in_at
    ) values (
      v_identity_id, v_admin_id, v_admin_id::text, 'email',
      jsonb_build_object('sub', v_admin_id::text, 'email', 'eswaranp@airasia.com', 'email_verified', true),
      now(), now(), now()
    );
  else
    -- Update existing admin password to standard Vecta2026! and ensure confirmed
    update auth.users set
      encrypted_password = crypt(v_pw, gen_salt('bf')),
      email_confirmed_at = coalesce(email_confirmed_at, now()),
      confirmation_token = '',
      email_change = '',
      email_change_token_new = '',
      email_change_token_current = '',
      recovery_token = '',
      phone_change = '',
      phone_change_token = '',
      reauthentication_token = ''
    where id = v_admin_id;
  end if;

  -- Ensure profile in profiles and users
  insert into public.profiles (id, email, name, staff_no, station, team, role, status, unified_role, ops_group)
  values (v_admin_id, 'eswaranp@airasia.com', 'Eswaran Padmanathan', 'MGT-0001', null, null, 'MANAGEMENT', 'approved', 'management', null)
  on conflict (id) do update set
    name = 'Eswaran Padmanathan',
    role = 'MANAGEMENT',
    status = 'approved',
    unified_role = 'management';

  insert into public.users (id, name, staff_id, email, role, status, preferred_language, unified_role, ops_group, duty_post)
  values (v_admin_id, 'Eswaran Padmanathan', 'MGT-0001', 'eswaranp@airasia.com', 'management', 'active', 'en', 'management', null, null)
  on conflict (id) do update set
    name = 'Eswaran Padmanathan',
    role = 'management',
    status = 'active',
    unified_role = 'management';
end $$;

-- 5. Provision the Fresh Hierarchy Roster
do $$
declare
  v_pw text := 'Vecta2026!';
  v_accounts jsonb := '[
    {"id":"b0000000-0000-4000-8000-000000000002","email":"admin@vecta.local","name":"VECTA Management","staff_no":"MGT-9000","station":null,"team":null,"role":"MANAGEMENT","unified_role":"management","ops_group":null,"is_driver":false},
    {"id":"b0000000-0000-4000-8000-000000000003","email":"management@vecta.local","name":"VECTA Management","staff_no":"MGT-9001","station":null,"team":null,"role":"MANAGEMENT","unified_role":"management","ops_group":null,"is_driver":false},
    {"id":"b0000000-0000-4000-8000-000000000004","email":"enforcement@vecta.local","name":"VECTA Enforcement","staff_no":"ENF-9001","station":null,"team":null,"role":"ENFORCEMENT","unified_role":"enforcement","ops_group":null,"is_driver":false},

    {"id":"b0000000-0000-4000-8000-000000000010","email":"dse.ops.alpha@vecta.local","name":"DSE Alpha (Ops)","staff_no":"DSE-OA-01","station":"KUL - MAA","team":"ALPHA","role":"DSE","unified_role":"dse","ops_group":"operation_avsec","is_driver":false},
    {"id":"b0000000-0000-4000-8000-000000000011","email":"so.ops.alpha@vecta.local","name":"SO Alpha (Ops)","staff_no":"SO-OA-01","station":"KUL - MAA","team":"ALPHA","role":"SO","unified_role":"so","ops_group":"operation_avsec","is_driver":false},
    {"id":"b0000000-0000-4000-8000-000000000012","email":"aso.ops.alpha@vecta.local","name":"ASO Alpha (Ops)","staff_no":"ASO-OA-01","station":"KUL - MAA","team":"ALPHA","role":"ASO","unified_role":"aso","ops_group":"operation_avsec","is_driver":false},

    {"id":"b0000000-0000-4000-8000-000000000013","email":"dse.ops.bravo@vecta.local","name":"DSE Bravo (Ops)","staff_no":"DSE-OB-01","station":"KUL - MAA","team":"BRAVO","role":"DSE","unified_role":"dse","ops_group":"operation_avsec","is_driver":false},
    {"id":"b0000000-0000-4000-8000-000000000014","email":"so.ops.bravo@vecta.local","name":"SO Bravo (Ops)","staff_no":"SO-OB-01","station":"KUL - MAA","team":"BRAVO","role":"SO","unified_role":"so","ops_group":"operation_avsec","is_driver":false},
    {"id":"b0000000-0000-4000-8000-000000000015","email":"aso.ops.bravo@vecta.local","name":"ASO Bravo (Ops)","staff_no":"ASO-OB-01","station":"KUL - MAA","team":"BRAVO","role":"ASO","unified_role":"aso","ops_group":"operation_avsec","is_driver":false},

    {"id":"b0000000-0000-4000-8000-000000000016","email":"dse.ops.charlie@vecta.local","name":"DSE Charlie (Ops)","staff_no":"DSE-OC-01","station":"KUL - MAA","team":"CHARLIE","role":"DSE","unified_role":"dse","ops_group":"operation_avsec","is_driver":false},
    {"id":"b0000000-0000-4000-8000-000000000017","email":"so.ops.charlie@vecta.local","name":"SO Charlie (Ops)","staff_no":"SO-OC-01","station":"KUL - MAA","team":"CHARLIE","role":"SO","unified_role":"so","ops_group":"operation_avsec","is_driver":false},
    {"id":"b0000000-0000-4000-8000-000000000018","email":"aso.ops.charlie@vecta.local","name":"ASO Charlie (Ops)","staff_no":"ASO-OC-01","station":"KUL - MAA","team":"CHARLIE","role":"ASO","unified_role":"aso","ops_group":"operation_avsec","is_driver":false},

    {"id":"b0000000-0000-4000-8000-000000000019","email":"dse.ops.delta@vecta.local","name":"DSE Delta (Ops)","staff_no":"DSE-OD-01","station":"KUL - MAA","team":"DELTA","role":"DSE","unified_role":"dse","ops_group":"operation_avsec","is_driver":false},
    {"id":"b0000000-0000-4000-8000-000000000020","email":"so.ops.delta@vecta.local","name":"SO Delta (Ops)","staff_no":"SO-OD-01","station":"KUL - MAA","team":"DELTA","role":"SO","unified_role":"so","ops_group":"operation_avsec","is_driver":false},
    {"id":"b0000000-0000-4000-8000-000000000021","email":"aso.ops.delta@vecta.local","name":"ASO Delta (Ops)","staff_no":"ASO-OD-01","station":"KUL - MAA","team":"DELTA","role":"ASO","unified_role":"aso","ops_group":"operation_avsec","is_driver":false},

    {"id":"b0000000-0000-4000-8000-000000000022","email":"dse.ifc.alpha@vecta.local","name":"DSE Alpha (IFC)","staff_no":"DSE-IA-01","station":"KUL - MAA","team":"ALPHA","role":"DSE","unified_role":"dse","ops_group":"ifc_avsec","is_driver":false},
    {"id":"b0000000-0000-4000-8000-000000000023","email":"so.ifc.alpha@vecta.local","name":"SO Alpha (IFC)","staff_no":"SO-IA-01","station":"KUL - MAA","team":"ALPHA","role":"SO","unified_role":"so","ops_group":"ifc_avsec","is_driver":false},
    {"id":"b0000000-0000-4000-8000-000000000024","email":"aso.ifc.alpha@vecta.local","name":"ASO Alpha (IFC)","staff_no":"ASO-IA-01","station":"KUL - MAA","team":"ALPHA","role":"ASO","unified_role":"aso","ops_group":"ifc_avsec","is_driver":false},

    {"id":"b0000000-0000-4000-8000-000000000025","email":"dse.ifc.bravo@vecta.local","name":"DSE Bravo (IFC)","staff_no":"DSE-IB-01","station":"KUL - MAA","team":"BRAVO","role":"DSE","unified_role":"dse","ops_group":"ifc_avsec","is_driver":false},
    {"id":"b0000000-0000-4000-8000-000000000026","email":"so.ifc.bravo@vecta.local","name":"SO Bravo (IFC)","staff_no":"SO-IB-01","station":"KUL - MAA","team":"BRAVO","role":"SO","unified_role":"so","ops_group":"ifc_avsec","is_driver":false},
    {"id":"b0000000-0000-4000-8000-000000000027","email":"aso.ifc.bravo@vecta.local","name":"ASO Bravo (IFC)","staff_no":"ASO-IB-01","station":"KUL - MAA","team":"BRAVO","role":"ASO","unified_role":"aso","ops_group":"ifc_avsec","is_driver":false},

    {"id":"b0000000-0000-4000-8000-000000000028","email":"dse.ifc.charlie@vecta.local","name":"DSE Charlie (IFC)","staff_no":"DSE-IC-01","station":"KUL - MAA","team":"CHARLIE","role":"DSE","unified_role":"dse","ops_group":"ifc_avsec","is_driver":false},
    {"id":"b0000000-0000-4000-8000-000000000029","email":"so.ifc.charlie@vecta.local","name":"SO Charlie (IFC)","staff_no":"SO-IC-01","station":"KUL - MAA","team":"CHARLIE","role":"SO","unified_role":"so","ops_group":"ifc_avsec","is_driver":false},
    {"id":"b0000000-0000-4000-8000-000000000030","email":"aso.ifc.charlie@vecta.local","name":"ASO Charlie (IFC)","staff_no":"ASO-IC-01","station":"KUL - MAA","team":"CHARLIE","role":"ASO","unified_role":"aso","ops_group":"ifc_avsec","is_driver":false},

    {"id":"b0000000-0000-4000-8000-000000000031","email":"dse.ifc.delta@vecta.local","name":"DSE Delta (IFC)","staff_no":"DSE-ID-01","station":"KUL - MAA","team":"DELTA","role":"DSE","unified_role":"dse","ops_group":"ifc_avsec","is_driver":false},
    {"id":"b0000000-0000-4000-8000-000000000032","email":"so.ifc.delta@vecta.local","name":"SO Delta (IFC)","staff_no":"SO-ID-01","station":"KUL - MAA","team":"DELTA","role":"SO","unified_role":"so","ops_group":"ifc_avsec","is_driver":false},
    {"id":"b0000000-0000-4000-8000-000000000033","email":"aso.ifc.delta@vecta.local","name":"ASO Delta (IFC)","staff_no":"ASO-ID-01","station":"KUL - MAA","team":"DELTA","role":"ASO","unified_role":"aso","ops_group":"ifc_avsec","is_driver":false},

    {"id":"b0000000-0000-4000-8000-000000000040","email":"driver.ifc@caterlink.local","name":"IFC Driver (AirAsia)","staff_no":"DRV-IFC-01","station":null,"team":null,"role":"vendor","unified_role":"vendor","ops_group":null,"is_driver":true,"icms_role":"warehouse_pic","duty_post":"Warehouse"},
    {"id":"b0000000-0000-4000-8000-000000000041","email":"driver.vendor@caterlink.local","name":"3rd Party Driver","staff_no":"DRV-3RD-01","station":null,"team":null,"role":"vendor","unified_role":"vendor","ops_group":null,"is_driver":true,"icms_role":"vendor","duty_post":null}
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

    -- Insert into auth.users with empty string for token fields (GoTrue safe)
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
        'system_type', case when r.is_driver then 'caterlink' else 'avsec' end,
        'role', r.unified_role
      ),
      false, false, now(), now(),
      '', '', '', '', '', '', '', ''
    )
    on conflict (id) do update set
      encrypted_password = crypt(v_pw, gen_salt('bf')),
      email = excluded.email,
      email_confirmed_at = now();

    -- Identity mapping
    insert into auth.identities (
      id, user_id, provider_id, provider, identity_data, created_at, updated_at, last_sign_in_at
    ) values (
      v_identity_id, r.id, r.id::text, 'email',
      jsonb_build_object('sub', r.id::text, 'email', r.email, 'email_verified', true),
      now(), now(), now()
    )
    on conflict (provider, provider_id) do nothing;

    -- Profiles table (for VECTA AVSEC, Management, Admin, Enforcement)
    if not r.is_driver then
      insert into public.profiles (id, email, name, staff_no, station, team, role, status, unified_role, ops_group)
      values (r.id, r.email, r.name, r.staff_no, r.station, r.team, r.role::user_role, 'approved', r.unified_role, r.ops_group)
      on conflict (id) do update set
        email = excluded.email,
        name = excluded.name,
        staff_no = excluded.staff_no,
        station = excluded.station,
        team = excluded.team,
        role = excluded.role,
        status = excluded.status,
        unified_role = excluded.unified_role,
        ops_group = excluded.ops_group;

      -- Matching shadow row in public.users for system integration
      insert into public.users (
        id, name, staff_id, email, role, status, preferred_language,
        unified_role, ops_group, duty_post
      ) values (
        r.id, r.name, r.staff_no, r.email,
        case r.role
          when 'ADMIN' then 'supervisor'
          when 'ENFORCEMENT' then 'enforcement'
          when 'MANAGEMENT' then 'management'
          else 'ops_staff'
        end,
        'active', 'en', r.unified_role, r.ops_group, null
      )
      on conflict (id) do update set
        name = excluded.name,
        staff_id = excluded.staff_id,
        email = excluded.email,
        role = excluded.role,
        status = excluded.status,
        unified_role = excluded.unified_role,
        ops_group = excluded.ops_group;

    else
      -- CaterLink Drivers: live in public.users with unified_role = 'vendor'
      insert into public.users (
        id, name, staff_id, email, role, status, preferred_language,
        unified_role, ops_group, duty_post
      ) values (
        r.id, r.name, r.staff_no, r.email,
        coalesce(r.icms_role, 'vendor'),
        'active', 'en', 'vendor', null, r.duty_post
      )
      on conflict (id) do update set
        name = excluded.name,
        staff_id = excluded.staff_id,
        email = excluded.email,
        role = excluded.role,
        status = excluded.status,
        unified_role = excluded.unified_role,
        duty_post = excluded.duty_post;

      -- Remove any auto-stubbed profile in public.profiles created by on_auth_user_created trigger
      delete from public.profiles where id = r.id;
    end if;

  end loop;
end $$;

alter table if exists public.profiles enable trigger profiles_enforce_self_update;

-- ============================================================
-- Verification query: summarize total accounts by branch & role
-- ============================================================
select 'AVSEC PROFILES' as table_name, unified_role, ops_group, team, count(*)
from public.profiles
group by unified_role, ops_group, team
union all
select 'CATERLINK DRIVERS' as table_name, role as unified_role, null as ops_group, null as team, count(*)
from public.users
where role in ('vendor', 'warehouse_pic') and id != 'b0000000-0000-4000-8000-000000000001'
group by role;
