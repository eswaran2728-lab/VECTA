-- =======================================================================
-- CaterLink external-account table (additive, create-if-missing).
--
-- CaterLink Driver and Third-Party Vendor are the existing ICMS external account roles
-- (`warehouse_pic` = Driver, `vendor` = Third-Party Vendor) held in the trusted `public.users` account table.
-- That table exists in the legacy ICMS schema but is ABSENT on the staging project, so no external account can
-- be represented there. This migration creates a minimal, locked-down version ONLY when the table is missing;
-- where `public.users` already exists (any environment that has the ICMS schema) it changes nothing.
--
-- Security posture of the created table:
--   * identity = the Supabase Auth user id (same UUID; no second identity); no password material;
--   * role restricted to the two external roles -- the table can never carry VECTA staff authority;
--   * RLS enabled; a user may read ONLY their own row; no client INSERT/UPDATE/DELETE grant (service-side
--     provisioning only); anon has no access;
--   * the application treats a row as authoritative only for external CaterLink identity and only when
--     status = 'active' and the account holds no canonical VECTA assignment (conflicts fail closed).
-- =======================================================================
do $users$
begin
  if to_regclass('public.users') is null then
    create table public.users (
      id uuid primary key references auth.users (id) on delete cascade,
      name text not null,
      staff_id text not null unique,
      email text not null unique,
      role text not null check (role in ('warehouse_pic', 'vendor')),
      status text not null default 'pending' check (status in ('pending', 'active', 'rejected', 'deactivated')),
      unified_role text,
      preferred_language text not null default 'en',
      duty_post text,
      created_at timestamptz not null default now()
    );

    alter table public.users enable row level security;
    revoke all on public.users from public, anon, authenticated;
    grant select on public.users to authenticated;
    grant all on public.users to service_role;

    create policy users_self_select on public.users
      for select to authenticated
      using (id = auth.uid());
  end if;
end
$users$;
