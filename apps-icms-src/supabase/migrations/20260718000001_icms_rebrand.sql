-- ============================================================
-- ICMS rebrand (formerly CSCS) — Migration: transaction number
-- prefix + demo account rename. Incremental only: no tables
-- dropped, no historical CSCS-* transaction numbers touched.
-- ============================================================

-- ------------------------------------------------------------
-- 1. New transactions get an ICMS-YYYY-NNNNNN number. The
--    per-year sequence itself is unchanged (still resumes from
--    wherever it left off) — only the display prefix changes.
--    Existing CSCS-YYYY-NNNNNN rows are left exactly as they are.
-- ------------------------------------------------------------
create or replace function public.next_transaction_number()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_year int := extract(year from now())::int;
  v_seq text := format('cscs_txn_seq_%s', v_year);
  v_n bigint;
begin
  if to_regclass('public.' || v_seq) is null then
    execute format(
      'create sequence if not exists public.%I start with %s',
      v_seq,
      coalesce((select counter from transaction_counters where year = v_year), 0) + 1
    );
  end if;
  execute format('select nextval(''public.%I'')', v_seq) into v_n;
  return format('ICMS-%s-%s', v_year, lpad(v_n::text, 6, '0'));
end;
$$;

-- ------------------------------------------------------------
-- 2. Demo account rename: @cscs.local -> @icms.local, and the
--    supervisor demo account moves to admin@icms.local (display
--    role label changes to "Admin" in the app; the DB role value
--    stays 'supervisor' so RLS/policies need no changes).
--    Password updated to ICMS-demo-2026! for all six.
--    No-ops harmlessly if a given demo account doesn't exist yet.
-- ------------------------------------------------------------
do $$
declare
  v_pw text := 'ICMS-demo-2026!';
  v_map jsonb := '[
    {"old": "pic@cscs.local", "new": "pic@icms.local"},
    {"old": "sra@cscs.local", "new": "sra@icms.local"},
    {"old": "post2@cscs.local", "new": "post2@icms.local"},
    {"old": "post6@cscs.local", "new": "post6@icms.local"},
    {"old": "receiver@cscs.local", "new": "receiver@icms.local"},
    {"old": "supervisor@cscs.local", "new": "admin@icms.local"}
  ]'::jsonb;
  r record;
begin
  for r in select value ->> 'old' as old_email, value ->> 'new' as new_email
           from jsonb_array_elements(v_map)
  loop
    update auth.users
    set email = r.new_email,
        encrypted_password = extensions.crypt(v_pw, extensions.gen_salt('bf')),
        raw_user_meta_data = jsonb_set(coalesce(raw_user_meta_data, '{}'::jsonb), '{email}', to_jsonb(r.new_email))
    where email = r.old_email;

    update auth.identities
    set identity_data = jsonb_set(coalesce(identity_data, '{}'::jsonb), '{email}', to_jsonb(r.new_email))
    where identity_data ->> 'email' = r.old_email;

    update public.users
    set email = r.new_email,
        name = case when r.old_email = 'supervisor@cscs.local' then 'Farah Admin' else name end
    where email = r.old_email;
  end loop;
end $$;
