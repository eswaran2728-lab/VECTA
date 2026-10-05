-- Migration: 20261015000001_phase13_integration_rollout_readiness.sql
-- Phase 13: Integration, legacy transition readiness, rollout controls.
--
-- Additive and forward-only. Does not edit any historical migration file.
-- Two kinds of change:
--   1. Two safe, zero-behavior-change least-privilege corrections found
--      during the Phase 13 integration audit (see
--      docs/phase13/legacy-transition-inventory.md, "unsafe bypass"
--      findings). Both functions are confirmed, by grep, to have no
--      application caller anywhere in app/, lib/, or components/ --
--      narrowing their grant changes nothing for any current user.
--   2. A read-only legacy-role mapping report and a read-only release-
--      readiness view, both for the existing approved Super Admin/technical
--      administration model only -- no new privilege is introduced for any
--      other role.

-- =====================================================================
-- 1. Least-privilege corrections: two cron-only functions were
--    executable far more broadly than their own code comments describe
--    ("pg_cron ... (no session)"). Neither pg_cron's own invocation nor
--    any current feature depends on `authenticated`/`anon`/PUBLIC having
--    execute -- Supabase's pg_cron jobs run as the role that scheduled
--    them (effectively a privileged internal role), not as `authenticated`.
-- =====================================================================

-- flag_attendance_anomalies(int): granted to `authenticated` in
-- avsec/0024_attendance_report.sql with a comment describing an
-- "Admin-triggered RPC" use case that was never built (confirmed: zero
-- references anywhere under app/, lib/, components/). As shipped, ANY
-- authenticated staff member -- including an ordinary ASO -- could call
-- this RPC directly and force an organization-wide attendance sweep
-- (inserting 'absent' duty_records for every rostered profile, and
-- mutating is_missing_checkout/is_off_schedule flags) with no role check
-- inside the function body at all.
revoke all on function public.flag_attendance_anomalies(int) from public, anon, authenticated;
grant execute on function public.flag_attendance_anomalies(int) to service_role;

-- trigger_sheets_sync(): created in avsec/0023_sheet_sync_queue.sql with
-- no grant/revoke statement at all, so it carries Postgres's default
-- PUBLIC execute grant -- callable even by `anon` through the normal
-- Supabase RPC endpoint. It is SECURITY DEFINER and fires an HTTP POST
-- (via pg_net) to a fixed Edge Function URL carrying a webhook secret in
-- a header; the caller never sees that secret, but anyone could trigger
-- unlimited syncs against Google Sheets/Apps Script quota with no
-- authentication at all.
revoke all on function public.trigger_sheets_sync() from public, anon, authenticated;
grant execute on function public.trigger_sheets_sync() to service_role;

-- =====================================================================
-- 2. Read-only legacy-role mapping report (dry-run; never writes).
--    Identifies every approved profile still carrying a legacy
--    MANAGEMENT/ADMIN/ENFORCEMENT role and whether it already has an
--    approved Phase 3 scoped-role replacement assignment. This is the
--    read-only evidence the retirement gate (see
--    docs/phase13/legacy-transition-inventory.md) requires BEFORE any
--    legacy role may ever be removed -- it does not retire anything
--    itself.
-- =====================================================================
create or replace function public.get_legacy_role_mapping_report_secure()
returns table (
  profile_id uuid,
  legacy_role text,
  profile_status text,
  has_replacement_assignment boolean,
  active_replacement_role_codes text[]
)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_caller uuid := auth.uid();
  v_is_super_admin boolean;
begin
  if v_caller is null then
    raise exception 'Must be signed in.';
  end if;

  -- Canonical Phase 3 authority: an active, non-revoked, currently-effective
  -- super_admin role assignment for the caller's own approved profile.
  -- No dependency on any legacy profile-role column.
  v_is_super_admin := public.has_active_role('super_admin');

  if not v_is_super_admin then
    raise exception 'Only Super Admin may view the legacy-role mapping report.';
  end if;

  return query
  select
    p.id,
    p.role::text,
    p.status::text,
    exists (
      select 1 from public.user_role_assignments ura
      where ura.profile_id = p.id
        and ura.revoked_at is null
        and ura.starts_at <= now()
        and (ura.ends_at is null or ura.ends_at > now())
    ),
    coalesce(
      array_agg(rd.code) filter (
        where ura2.revoked_at is null
          and ura2.starts_at <= now()
          and (ura2.ends_at is null or ura2.ends_at > now())
      ),
      array[]::text[]
    )
  from public.profiles p
  left join public.user_role_assignments ura2 on ura2.profile_id = p.id
  left join public.role_definitions rd on rd.id = ura2.role_definition_id
  where p.role::text in ('MANAGEMENT', 'ADMIN', 'ENFORCEMENT')
  group by p.id, p.role, p.status
  order by p.role, p.id;
end;
$function$;

revoke execute on function public.get_legacy_role_mapping_report_secure() from public, anon, authenticated;
grant execute on function public.get_legacy_role_mapping_report_secure() to service_role;
-- Re-grant to authenticated at the end of this file, after the
-- audit-logging wrapper below exists, so the ONLY authenticated-callable
-- path is the audited one.

-- =====================================================================
-- 3. Read-only release-readiness view. Operational status booleans and
--    small counts only -- never a secret, key, connection string, JWT,
--    signed URL, or confidential row. Same Super Admin gate as above.
-- =====================================================================
create or replace function public.get_release_readiness_report_secure()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_caller uuid := auth.uid();
  v_is_super_admin boolean;
  v_report jsonb;
begin
  if v_caller is null then
    raise exception 'Must be signed in.';
  end if;

  v_is_super_admin := public.has_active_role('super_admin');

  if not v_is_super_admin then
    raise exception 'Only Super Admin may view the release-readiness report.';
  end if;

  select jsonb_build_object(
    -- central_reports_index has no literal "unclassified" status column --
    -- a row with no resolved aoc_id is the closest real signal that
    -- classification could not place it in the org hierarchy.
    'reports_with_unresolved_aoc', (
      select count(*) from public.central_reports_index where aoc_id is null
    ),
    'failed_indexing_queue_entries', (
      select count(*) from public.report_index_queue where status = 'failed'
    ),
    'pending_report_index_queue_entries', (
      select count(*) from public.report_index_queue where status = 'pending'
    ),
    'legacy_profiles_without_replacement_assignment', (
      select count(*) from public.profiles p
      where p.role::text in ('MANAGEMENT', 'ADMIN', 'ENFORCEMENT')
        and not exists (
          select 1 from public.user_role_assignments ura
          where ura.profile_id = p.id
            and ura.revoked_at is null
            and ura.starts_at <= now()
            and (ura.ends_at is null or ura.ends_at > now())
        )
    ),
    'orphaned_role_assignments', (
      select count(*) from public.user_role_assignments ura
      where not exists (select 1 from public.profiles p where p.id = ura.profile_id)
    ),
    'wois_provider_configured', false, -- always false locally/in this report context; the real value is an environment boolean the app layer reports (see lib/wois/config.ts), never evaluated inside the database
    'last_report_index_queue_activity_at', (
      select max(processed_at) from public.report_index_queue where processed_at is not null
    ),
    'generated_at', now()
  ) into v_report;

  return v_report;
end;
$function$;

revoke execute on function public.get_release_readiness_report_secure() from public, anon, authenticated;
grant execute on function public.get_release_readiness_report_secure() to service_role;

-- =====================================================================
-- 4. Audit wrapper -- the only authenticated-callable path to either
--    report above, so every access is logged. Reuses the existing
--    wois_audit_log table's shape is NOT appropriate here (that table is
--    scoped to WOIS conversations); a small dedicated table keeps this
--    audit trail readable only by Super Admins, matching the already-
--    approved technical administration model.
-- =====================================================================
create table if not exists public.phase13_readiness_access_log (
  id uuid primary key default gen_random_uuid(),
  actor_profile_id uuid not null references public.profiles(id) on delete cascade,
  report_type text not null check (report_type in ('legacy_role_mapping', 'release_readiness')),
  created_at timestamptz not null default now()
);

alter table public.phase13_readiness_access_log enable row level security;

drop policy if exists phase13_readiness_access_log_super_admin_read on public.phase13_readiness_access_log;
create policy phase13_readiness_access_log_super_admin_read on public.phase13_readiness_access_log
  for select to authenticated
  using (public.has_active_role('super_admin'));

revoke insert, update, delete on public.phase13_readiness_access_log from authenticated, anon, public;
grant select on public.phase13_readiness_access_log to authenticated;
grant all on public.phase13_readiness_access_log to service_role;

create or replace function public.view_legacy_role_mapping_report_secure()
returns table (
  profile_id uuid,
  legacy_role text,
  profile_status text,
  has_replacement_assignment boolean,
  active_replacement_role_codes text[]
)
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  insert into public.phase13_readiness_access_log (actor_profile_id, report_type)
  values (auth.uid(), 'legacy_role_mapping');

  return query select * from public.get_legacy_role_mapping_report_secure();
end;
$function$;

revoke execute on function public.view_legacy_role_mapping_report_secure() from public, anon;
grant execute on function public.view_legacy_role_mapping_report_secure() to authenticated, service_role;

create or replace function public.view_release_readiness_report_secure()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_report jsonb;
begin
  insert into public.phase13_readiness_access_log (actor_profile_id, report_type)
  values (auth.uid(), 'release_readiness');

  select public.get_release_readiness_report_secure() into v_report;
  return v_report;
end;
$function$;

revoke execute on function public.view_release_readiness_report_secure() from public, anon;
grant execute on function public.view_release_readiness_report_secure() to authenticated, service_role;

create index if not exists idx_phase13_readiness_access_actor on public.phase13_readiness_access_log(actor_profile_id, created_at desc);
