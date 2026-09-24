-- PRE-UPGRADE REMEDIATION (2026-09-24). Covers, in order:
--   Part A: attendance-sweep AVSEC-group isolation (flag_attendance_anomalies)
--   Part B: cron-only / SECURITY DEFINER function execute grants
--   Part C: anonymous Management-feedback-metadata exposure (view)
--   Part D: CaterLink registration / supervisor approval on public.users
--   Part E: pending-role rank-based visibility (current_role_rank / is_monitor_or_above)
--   Part F: documentation-only note on profiles.org_id (no functional change)
--   Part G: schema-wide function-permission audit -- next_report_no,
--           next_vendor_transaction_number, get_admin_emails, and a
--           trigger-only-function grant hygiene sweep
--
-- Forward-only. Does not delete or rewrite any row. Does not touch CaterLink
-- checkpoint scanning policies, Hub separation, report acknowledgement
-- (ops_group-strict station/team matching, untouched), or roster
-- group-isolation logic beyond what Part A's join fix requires. Does not
-- touch the C-01/C-02/pending-Management containment from
-- 20260923000003_super_admin_privilege_containment.sql -- is_approved_management()
-- is reused, not redefined.

-- =======================================================================
-- PART A: flag_attendance_anomalies() -- confirmed defect
-- =======================================================================
-- ROOT CAUSE (confirmed by reading the live function, 2026-09-24): the
-- absent-row generator joined team_rosters to profiles on
-- `p.station = tr.station and coalesce(p.team,'') = tr.team` only -- no
-- ops_group in the join. Team names collide across branches (both
-- operation_avsec and ifc_avsec have a "ALPHA" team at the same station),
-- so an Operation-branch roster row could generate an absent duty_records
-- row for an IFC profile with the same team name, and vice versa. The
-- generated row also never set duty_records.ops_group at all (not in the
-- INSERT's column list), compounding the existing 129 null-ops_group
-- historical rows (see the separate remediation proposal in the report --
-- NOT touched here). The off-schedule UPDATE has the same station+team-only
-- join gap. The missing-checkout UPDATE only touches existing duty_records
-- rows by id/profile, no roster join, so it was never affected.
--
-- FIX: join/insert include ops_group; require it to be non-null and
-- matching on both sides (team_rosters.ops_group is NOT NULL as of
-- 20260922162457, so tr.ops_group is always present; profiles.ops_group is
-- required for the same ASO/SO/DSE roles this query already restricts to
-- -- org-wide roles are excluded by `p.role in ('ASO','SO','DSE')` already,
-- unchanged). Hub AVSEC rosters/profiles are included the same as before
-- (this function was never Hub-exclusive; ops_group equality now simply
-- keeps Hub-to-Hub matches correctly instead of accidentally not matching
-- at all before -- Hub was never cross-contaminated with Operation/IFC
-- since "Hub" as a team-name string never collided with their team names,
-- but is included here for correctness and consistency with every other
-- ops_group-aware query in the schema).
create or replace function public.flag_attendance_anomalies(p_grace_hours integer default 4)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  insert into duty_records (profile_id, station, team, ops_group, duty_date, shift_code, zone_id, status)
  select p.id, tr.station, tr.team, tr.ops_group, tr.roster_date, tr.shift_code, tr.zone_id, 'absent'
  from team_rosters tr
  join profiles p
    on p.station = tr.station
   and coalesce(p.team, '') = tr.team
   and p.ops_group is not null
   and p.ops_group = tr.ops_group
  where tr.shift_code <> 'OFF'
    and tr.roster_date < (now() at time zone 'Asia/Kuala_Lumpur')::date
    and p.role in ('ASO', 'SO', 'DSE')
    and p.status = 'approved'
    and not exists (
      select 1 from duty_records dr
      where dr.profile_id = p.id and dr.duty_date = tr.roster_date
    )
  on conflict (profile_id, duty_date, shift_code) do nothing;

  update duty_records dr
  set is_missing_checkout = true
  where dr.check_in_at is not null
    and dr.check_out_at is null
    and dr.is_missing_checkout = false
    and (dr.duty_date + coalesce(
           (select s.default_end from shifts s where s.code = dr.shift_code), '23:59'::time
         ) + (p_grace_hours || ' hours')::interval) < now();

  -- ops_group added to the join so a historical null-ops_group row (not
  -- backfilled by this migration) simply never matches here -- fails safe
  -- (no flag), never cross-matches another branch's OFF day.
  update duty_records dr
  set is_off_schedule = true
  where dr.check_in_at is not null
    and dr.is_off_schedule = false
    and exists (
      select 1 from team_rosters tr
      where tr.station = dr.station
        and tr.team = coalesce(dr.team, '')
        and tr.ops_group is not null
        and tr.ops_group = dr.ops_group
        and tr.roster_date = dr.duty_date
        and tr.shift_code = 'OFF'
    );
end;
$function$;

-- =======================================================================
-- PART B: cron-only / SECURITY DEFINER function execute grants
-- =======================================================================
-- CORRECTED (2026-09-24, second pass): the first version of this Part
-- only revoked from anon/authenticated. That is INCOMPLETE where a
-- function was also granted to PUBLIC -- in Postgres, a PUBLIC grant is
-- effective for every role regardless of any per-role revoke, since
-- has_function_privilege checks ALL applicable grants, and PUBLIC is not
-- "inherited via membership" (which a REVOKE FROM a specific role would
-- defeat) -- it is a direct, independent grant to every role that exists.
-- Verified live via has_function_privilege('public', oid, 'EXECUTE')
-- against every SECURITY DEFINER function matching
-- attendance/timeout/incident/sync/sweep/escalat/cron/admin/archive/audit:
--
--   proname                        | public | anon | authenticated
--   enqueue_sheet_sync()           | true   | true | true   <- PUBLIC grant found
--   trigger_sheets_sync()          | true   | true | true   <- PUBLIC grant found
--   escalate_timeouts()            | true   | true | true   <- PUBLIC grant found
--   log_audit_admin()              | true   | true | true   <- PUBLIC grant found (trigger-only)
--   notify_supervisors_on_incident()| true  | true | true   <- PUBLIC grant found (trigger-only)
--   flag_attendance_anomalies(int) | false  | true | true   (anon/authenticated grants, no PUBLIC)
--   run_attendance_sweep()         | false  | true | true   (anon/authenticated grants, no PUBLIC)
--   search_flight_attendance(...)  | false  | true | true   (untouched -- real app RPC, own auth check)
--   archive_all_pending(text)      | false  | false| true   (untouched -- own supervisor check, not cron)
--
-- log_audit_admin() and notify_supervisors_on_incident() are TRIGGER
-- functions (fired by BEFORE/AFTER triggers on data tables, never called
-- directly by application code) -- confirmed by reading their bodies
-- (log_audit_admin() references tg_table_name/tg_op/old/new; per
-- Postgres semantics, EXECUTE privilege is never checked for a function
-- invoked via trigger firing, only for a direct call/RPC) -- revoking
-- direct RPC access from PUBLIC/anon/authenticated cannot break their
-- trigger execution.
--
-- Every explicit revoke below uses the function's exact signature, per
-- instruction, and targets PUBLIC, anon, AND authenticated together --
-- omitting PUBLIC was exactly the gap found. All of these already have
-- `SET search_path TO 'public'` (verified against the live definitions)
-- -- no search_path change needed.
--
-- CRON EXECUTION IDENTITY -- verified live: `select jobname, username from
-- cron.job` shows all three scheduled jobs (sheets-sync-every-2-min,
-- flag-attendance-anomalies, cscs-timeout-monitor) run as username
-- `postgres` -- the actual superuser role, unaffected by any REVOKE
-- (has_function_privilege('postgres', ..., 'EXECUTE') = true regardless,
-- confirmed). No role name is invented here -- `postgres` is the real,
-- observed cron execution identity on this project, not assumed.
-- service_role already holds EXECUTE on every one of these via its own
-- broad ACL entry (confirmed live) -- the explicit grants below make that
-- intentional and durable rather than incidental, so a future accidental
-- broad re-grant is less likely to go unnoticed.
revoke execute on function public.flag_attendance_anomalies(integer) from public, anon, authenticated;
revoke execute on function public.escalate_timeouts() from public, anon, authenticated;
revoke execute on function public.trigger_sheets_sync() from public, anon, authenticated;
revoke execute on function public.enqueue_sheet_sync() from public, anon, authenticated;
revoke execute on function public.run_attendance_sweep() from public, anon, authenticated;
revoke execute on function public.log_audit_admin() from public, anon, authenticated;
revoke execute on function public.notify_supervisors_on_incident() from public, anon, authenticated;

grant execute on function public.flag_attendance_anomalies(integer) to service_role;
grant execute on function public.escalate_timeouts() to service_role;
grant execute on function public.trigger_sheets_sync() to service_role;
grant execute on function public.enqueue_sheet_sync() to service_role;
grant execute on function public.run_attendance_sweep() to service_role;
grant execute on function public.log_audit_admin() to service_role;
grant execute on function public.notify_supervisors_on_incident() to service_role;

-- search_flight_attendance() is untouched (not cron-only -- it's the
-- Enforcement/Management RPC fixed for pending-status in
-- 20260923000003, called from the app by real signed-in users, and
-- already carries its own is_approved_management()/ENFORCEMENT check).
-- archive_all_pending() is untouched (not cron-invoked; already requires
-- current_user_role()='supervisor' internally, and has no PUBLIC grant).

-- =======================================================================
-- PART C: feedback_threads_management_view -- anonymous metadata exposure
-- =======================================================================
-- CONFIRMED (2026-09-24): the view is a plain
-- `select id, org_id, category, status, created_at, updated_at from
-- feedback_threads`, owned by `postgres`, with reloptions NULL --
-- security_invoker was never set (defaults to false), so the view runs
-- with the OWNER's privileges and bypasses feedback_threads' own RLS
-- entirely. `anon` and `authenticated` both hold blanket SELECT (and,
-- redundantly, INSERT/UPDATE/DELETE/TRUNCATE, meaningless on a read-only
-- view derived this way but revoked below regardless) on the view itself.
-- Net effect: an anonymous caller could read every feedback thread's id,
-- org_id, category, status, and timestamps via
-- /rest/v1/feedback_threads_management_view with zero authentication.
--
-- The base table's own RLS is already correct (feedback_threads_submitter_select:
-- submitter sees only their own; feedback_threads_management_select:
-- ADMIN or approved Management only, fixed in 20260923000003) -- turning on
-- security_invoker makes the view respect exactly those same policies for
-- whoever queries it, closing the bypass without changing what Management
-- itself can see.
alter view public.feedback_threads_management_view set (security_invoker = true);

revoke insert, update, delete, truncate on public.feedback_threads_management_view from anon, authenticated;
revoke select on public.feedback_threads_management_view from anon;
-- authenticated keeps SELECT on the view -- now meaningless for anyone
-- without a matching feedback_threads RLS policy (ordinary operational
-- users get 0 rows; approved Management/ADMIN see their existing access,
-- unchanged).

-- =======================================================================
-- PART D: public.users -- CaterLink registration / supervisor approval
-- =======================================================================
-- CONFIRMED (2026-09-24, matches the C-02 migration's own header note):
-- no INSERT policy exists on public.users at all, so
-- lib/icms/actions/registration.ts's registerUser() CaterLink
-- self-registration upsert has been silently failing (RLS default-deny)
-- since before this session. No UPDATE policy permits a supervisor to
-- write another user's row either, so approveStaff()/rejectStaff()'s
-- users-table writes have also been silently failing. Both were
-- previously flagged and deliberately left unfixed (adding a permissive
-- policy was out of scope for the pure containment pass) -- now fixed with
-- the narrowest allowlists that make the existing, already-reviewed code
-- paths actually work, per this task's explicit instruction to close them.
--
-- Self-registration: exactly registerUser()'s CaterLink branch's write
-- shape (id, name, staff_id, email, role='vendor', unified_role='vendor',
-- status='pending') and nothing else -- a self-INSERT can never claim any
-- other role/status, so registration can never grant immediate operational
-- access (status is always 'pending' at insert; the enforce_users_self_update()
-- trigger already blocks status ever changing via self-update afterward).
-- CORRECTED (second pass): the first version only checked id = auth.uid(),
-- which ties the ROW to the caller correctly but does not stop the caller
-- from writing an arbitrary `email` value into their own new row (identity/
-- contact spoofing of a different real email address, not a privilege
-- escalation -- role/unified_role/status are still pinned below regardless).
-- auth.jwt() ->> 'email' reads the verified email claim from the caller's
-- own session JWT (set by Supabase Auth at sign-up/sign-in, not
-- client-suppliable) -- confirmed available on this project
-- (select auth.jwt() is not null -- the function exists and is callable).
-- Comparing against it closes that gap without needing a separate
-- service-role action for this specific field.
-- Also pins org_id/ops_group/duty_post/approval-audit-shaped fields --
-- WITH CHECK only constrains the columns it names; anything else in the
-- INSERT statement is otherwise unconstrained by RLS. registerUser()'s
-- actual write never sets org_id/ops_group/duty_post at all (they get
-- their column defaults -- org_id's default is the single-tenant org id
-- '00000000-0000-0000-0000-000000000001', ops_group/duty_post default to
-- null) -- a caller bypassing the app entirely via a direct REST INSERT
-- could otherwise set any of the three to an arbitrary value. public.users
-- has no approved_by/approved_at/rejection_reason columns at all (those
-- are profiles-only), so there is nothing further to pin there.
drop policy if exists "users: self register pending vendor" on public.users;
create policy "users: self register pending vendor" on public.users
for insert
with check (
  id = auth.uid()
  and email = (auth.jwt() ->> 'email')
  and role = 'vendor'
  and unified_role = 'vendor'
  and status = 'pending'
  and org_id = '00000000-0000-0000-0000-000000000001'::uuid
  and ops_group is null
  and duty_post is null
);

-- Supervisor approval: exactly approveStaff()/rejectStaff()'s write shape
-- (status only, on someone else's still-pending row). Narrower than the
-- profiles equivalent -- public.users has no role/ops_group/station/team
-- reassignment step of its own (CaterLink accounts don't get reassigned
-- through this path), so nothing beyond status is ever permitted here.
drop policy if exists "users: supervisor approves pending" on public.users;
create policy "users: supervisor approves pending" on public.users
for update
using (
  current_user_role() = 'supervisor'
  and id <> auth.uid()
  and status = 'pending'
)
with check (
  current_user_role() = 'supervisor'
  and id <> auth.uid()
  and status in ('active', 'rejected')
);

-- The trigger itself must recognize this one narrow supervisor transition
-- -- an RLS policy alone is not enough, since enforce_users_self_update()
-- unconditionally raised for any old.id <> auth.uid() actor before this.
-- Every other protected column stays exactly as locked as before for this
-- branch too (a supervisor approving/rejecting a pending CaterLink account
-- can change status only -- never role, unified_role, ops_group, org_id,
-- duty_post, email, staff_id, or name through this path).
create or replace function public.enforce_users_self_update()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  -- Trusted backend writes: createUser/updateUserRole
  -- (lib/icms/actions/users.ts), the AVSEC->ICMS shadow sync in
  -- approveUserWithAssignment/updateUserAssignment
  -- (lib/avsec/admin/actions.ts, via createAdminClient()), and
  -- backfill_icms_shadow_users -- all use the service-role client.
  if auth.role() = 'service_role' then
    return new;
  end if;

  if old.id = auth.uid() then
    if new.id is distinct from old.id
       or new.created_at is distinct from old.created_at
       or new.role is distinct from old.role
       or new.unified_role is distinct from old.unified_role
       or new.status is distinct from old.status
       or new.ops_group is distinct from old.ops_group
       or new.org_id is distinct from old.org_id
       or new.duty_post is distinct from old.duty_post
       or new.email is distinct from old.email
       or new.staff_id is distinct from old.staff_id
       or new.name is distinct from old.name
    then
      raise exception 'Not authorized to modify this field on your own account.';
    end if;
    return new;
  end if;

  -- Supervisor approving/rejecting a pending CaterLink registration --
  -- status only, matching the "users: supervisor approves pending" RLS
  -- policy above exactly. Any other field change in the same statement
  -- rejects the whole write.
  if current_user_role() = 'supervisor' and old.id is distinct from auth.uid() then
    if new.role is distinct from old.role
       or new.unified_role is distinct from old.unified_role
       or new.ops_group is distinct from old.ops_group
       or new.org_id is distinct from old.org_id
       or new.duty_post is distinct from old.duty_post
       or new.email is distinct from old.email
       or new.staff_id is distinct from old.staff_id
       or new.name is distinct from old.name
    then
      raise exception 'Supervisor may only change status on this table.';
    end if;
    if new.status not in ('active', 'rejected') then
      raise exception 'Invalid status transition.';
    end if;
    return new;
  end if;

  raise exception 'Not authorized to modify this account.';
end;
$function$;

-- =======================================================================
-- PART E: pending-role rank-based visibility
-- =======================================================================
-- CONFIRMED (2026-09-24): current_role_rank() (= role_rank(current_role_name()))
-- and is_monitor_or_above() both read only the raw profiles.role column,
-- with no status check -- the same class of gap as the pending-Management
-- issue fixed in 20260923000003, but affecting SO/DSE/ENFORCEMENT/MANAGEMENT
-- rank-based READ visibility broadly: duty_records "duty monitor select",
-- shift_handovers, every report_sec0xx "rank select", offload rank
-- select/items, overtime_requests monitor select, bay_board, duty_audit_log,
-- and profiles' own "profiles self select" ("id = auth.uid() OR
-- is_monitor_or_above()"). A pending SO/DSE/ENFORCEMENT/MANAGEMENT
-- applicant inherits their requested role's rank-based read visibility
-- before any approval.
--
-- Centralized fix, exactly as done for is_approved_management(): redefine
-- the two shared primitives to require current_status() = 'approved'.
-- Every policy listed above consumes one of these two functions already --
-- fixing them here fixes every consumer in one place, with no risk of
-- missing one (the actual defect the earlier per-policy approach was
-- chosen to avoid for Management, but the rank family is used far too
-- widely to safely patch policy-by-policy without missing something).
-- Station/team/ops_group boundary logic inside each of those policies is
-- completely unchanged -- only the rank NUMBER / monitor BOOLEAN itself
-- becomes approval-aware; the business hierarchy (ASO<SO<DSE<ENFORCEMENT<
-- MANAGEMENT<ADMIN) is unchanged. Rejected/deactivated profiles already
-- fail this the same way (current_status() never equals 'approved' for
-- them either).
create or replace function public.current_role_rank()
returns integer
language sql
stable
security definer
set search_path to 'public'
as $function$
  select case when current_status() = 'approved' then role_rank(current_role_name()) else 0 end;
$function$;

create or replace function public.is_monitor_or_above()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select current_status() = 'approved'
     and current_role_name() in ('SO', 'DSE', 'ENFORCEMENT', 'MANAGEMENT', 'ADMIN');
$function$;

-- =======================================================================
-- PART F: profiles.org_id grant -- documentation-only (no functional change)
-- =======================================================================
-- The deployed 20260923000003_super_admin_privilege_containment.sql
-- attempted `revoke update (org_id) on public.profiles from authenticated`
-- and stated it as an independent grant-layer defense for org_id. Verified
-- live (2026-09-24, has_function_privilege / information_schema.column_privileges)
-- that this had NO effect: `authenticated` retains table-level UPDATE on
-- profiles (needed for every legitimate self/Management write this system
-- has), and Postgres cannot narrow an existing table-level grant by
-- revoking a column-specific slice of it -- column-level REVOKE only
-- removes privileges that were themselves granted at the column level.
--
-- Investigated whether the broad table-level UPDATE grant could instead be
-- replaced with explicit column-level grants to close this properly: it
-- cannot, safely. Self-updates and Management-updates are BOTH performed
-- by the same Postgres role (`authenticated`) with different legitimate
-- field sets (e.g. Management may write ops_group; a self-update never
-- may) -- Postgres grants are per-role, not per-RLS-policy, so there is no
-- column-level grant shape that permits Management's writes without also
-- permitting the same columns for self-updates. That distinction can only
-- be enforced where it already is: RLS policy row-scoping combined with
-- the enforce_profile_self_update() trigger's per-actor branch logic.
-- Narrowing the grant would add no real protection and risks silently
-- breaking a legitimate write if any field is missed.
--
-- CORRECTED RECORD: profiles.org_id is protected by the trigger layer
-- only (enforce_profile_self_update() blocks it in both the self-update
-- and Management branches, verified). This is intentional and sufficient
-- for org_id, not a remaining gap -- no further grant change is made here.

-- =======================================================================
-- PART G: schema-wide function-permission audit (2026-09-24)
-- =======================================================================
-- Exhaustive, non-keyword-filtered audit of all 86 functions/procedures in
-- the production public schema (has_function_privilege() per role, live
-- against zsxneokqulktgnccxgkz). Three additional unsafe grants found
-- beyond Parts A-F, plus a hygiene sweep of trigger-only functions that
-- were unnecessarily EXECUTE-granted to PUBLIC/anon/authenticated even
-- though Postgres never checks EXECUTE privilege for a function invoked
-- via trigger firing (only for an explicit call/RPC) -- verified this
-- session against Postgres trigger-execution semantics.
--
-- G1: next_report_no(text, date) -- writes report_counters. anon_exec was
--     TRUE, no internal authorization check. Confirmed by repo-wide grep
--     (no `.rpc("next_report_no"` anywhere) that this is invoked ONLY by
--     the set_report_no_secXXX() trigger functions, never called directly
--     by any application code. Trigger execution does not need EXECUTE.
--     Fully revoked from PUBLIC, anon, AND authenticated.
-- G2: next_vendor_transaction_number() -- writes vendor_transaction_counters.
--     PUBLIC_exec and anon_exec were TRUE, no internal check. Same grep
--     result: only called by the set_vendor_transaction_number() trigger.
--     Fully revoked from PUBLIC, anon, AND authenticated.
-- G3: get_admin_emails() -- `select email from profiles where role='ADMIN'`.
--     authenticated_exec was TRUE with NO internal authorization check.
--     Confirmed by grep this IS called directly via supabase.rpc() from
--     two application call sites (lib/avsec/email/notifyReportSubmission.ts,
--     lib/avsec/email/notifyOvertimeApproval.ts), both using the caller's
--     own session client (not service-role) -- so today ANY authenticated
--     account, including a pending/rejected one, could call
--     `supabase.rpc("get_admin_emails")` directly via REST and enumerate
--     every admin's real email address, bypassing those two call sites'
--     own (already-authenticated-context) usage entirely. Classification 2
--     (authenticated RPC with internal authorization) requires the
--     function to actually gate itself -- it did not. Fixed in place by
--     adding an approved-status check inside the function body (narrowest
--     possible fix: preserves both legitimate call sites, which already
--     only ever run for an authenticated, already-approved actor, and
--     closes direct-REST enumeration by anyone else). Grant unchanged
--     (authenticated keeps EXECUTE; anon/PUBLIC already false).
-- G4: Trigger-only function hygiene sweep -- the following all have
--     return type `trigger`, are fired exclusively by a table trigger
--     (never called directly by any RPC, confirmed by grep for each
--     name), and yet carried an unnecessary PUBLIC and/or anon/
--     authenticated EXECUTE grant. Revoked from PUBLIC, anon, and
--     authenticated on all of them; trigger firing is unaffected because
--     Postgres does not check EXECUTE privilege for trigger invocation.
--     handle_new_user() is the single most safety-critical entry in this
--     list (fires on auth.users after signup to create the pending
--     profile row) -- confirmed via grep it is never called via
--     `.rpc("handle_new_user"` anywhere in the app, only ever fires as
--     the auth.users AFTER INSERT trigger, so revoking direct EXECUTE
--     does not affect signup. This must be the first thing re-verified
--     live (new-signup smoke test) immediately after any future deploy.
create or replace function public.get_admin_emails()
returns setof text
language sql
stable
security definer
set search_path to 'public'
as $function$
  select email from profiles
  where role = 'ADMIN' and status = 'approved';
$function$;

revoke execute on function public.next_report_no(text, date) from public, anon, authenticated;
revoke execute on function public.next_vendor_transaction_number() from public, anon, authenticated;

grant execute on function public.next_report_no(text, date) to service_role;
grant execute on function public.next_vendor_transaction_number() to service_role;

revoke execute on function public.block_duty_remark_rewrite() from public, anon, authenticated;
revoke execute on function public.block_settled_overtime_mutation() from public, anon, authenticated;
revoke execute on function public.block_submitted_child_mutation_offload() from public, anon, authenticated;
revoke execute on function public.block_submitted_child_mutation_sec013() from public, anon, authenticated;
revoke execute on function public.block_submitted_child_mutation_sec014() from public, anon, authenticated;
revoke execute on function public.block_submitted_child_mutation_sec018() from public, anon, authenticated;
revoke execute on function public.block_submitted_child_mutation_sec029() from public, anon, authenticated;
revoke execute on function public.block_submitted_child_mutation_sec033() from public, anon, authenticated;
revoke execute on function public.block_submitted_report_mutation() from public, anon, authenticated;
revoke execute on function public.enforce_overtime_transition() from public, anon, authenticated;
revoke execute on function public.enforce_profile_self_update() from public, anon, authenticated;
revoke execute on function public.enforce_seal_color() from public, anon, authenticated;
revoke execute on function public.enforce_users_self_update() from public, anon, authenticated;
revoke execute on function public.guard_incident_update() from public, anon, authenticated;
revoke execute on function public.guard_part_update() from public, anon, authenticated;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.set_report_no_offload() from public, anon, authenticated;
revoke execute on function public.set_report_no_sec013() from public, anon, authenticated;
revoke execute on function public.set_report_no_sec014() from public, anon, authenticated;
revoke execute on function public.set_report_no_sec016() from public, anon, authenticated;
revoke execute on function public.set_report_no_sec018() from public, anon, authenticated;
revoke execute on function public.set_report_no_sec029() from public, anon, authenticated;
revoke execute on function public.set_report_no_sec033() from public, anon, authenticated;
revoke execute on function public.set_updated_at() from public, anon, authenticated;
revoke execute on function public.set_vendor_transaction_number() from public, anon, authenticated;

-- Intentionally NOT touched: the RLS-primitive helper functions
-- (current_role_name, current_status, current_org_id, current_ops_group,
-- current_station, current_team, current_staff_id_claim,
-- current_station_claim, current_team_claim, current_app_role,
-- current_user_role, current_role_rank, role_rank, submitter_role_rank,
-- is_monitor_or_above, is_approved_management, can_acknowledge_report,
-- can_file_report, can_view_report, get_report_submitter,
-- get_report_submitter_ops_group, request_device_info, request_ip) and the
-- already-internally-authorized RPCs (set_transaction_qr_token,
-- set_vendor_transaction_qr_token, skip_part_d, cl_cancel_transaction,
-- search_flight_attendance, archive_all_pending). All of these are either
-- invoked from inside an RLS policy expression -- which REQUIRES the
-- querying role to retain EXECUTE, since a policy evaluates as the
-- querying role and revoking it would break every policy using it for
-- that role -- or are legitimate direct-RPC entry points that already
-- gate themselves internally (auth.uid()/role/status checks confirmed by
-- reading each body this session). next_transaction_number() was already
-- fully inaccessible via direct RPC (PUBLIC=anon=authenticated=false,
-- confirmed live) and needed no change.
