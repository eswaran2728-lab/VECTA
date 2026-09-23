-- SECURITY CONTAINMENT (2026-09-23): C-01 (public.profiles) and C-02
-- (public.users) -- self-promotion through unified_role and other
-- server-controlled identity/authorization fields. This is temporary
-- containment for the UNFINISHED Super Admin feature, not an expansion of
-- it -- it does NOT build the planned Super Admin UI, multi-station,
-- multi-hub, multi-AOC, or the major Malaysia upgrade. It only prevents
-- privilege escalation while preserving current KUL functionality.
--
-- Single combined migration covering both tables -- extends the original
-- C-01-only version of this file (never applied/pushed) rather than
-- adding a second migration, per instruction to avoid duplicate/
-- conflicting migrations for the same unapplied change.
--
-- CONFIRMED ROOT CAUSE (verified by direct policy/trigger/grant/CHECK
-- inspection against vecta-prod, no data changed, no exploit attempted):
--   1. "profiles self update" RLS policy: USING/WITH CHECK (id = auth.uid())
--      places NO restriction on which columns change -- RLS gates rows,
--      not columns.
--   2. enforce_profile_self_update() (20260922031647) never inspected
--      new.unified_role in ANY branch -- self-update, approved/rejected
--      lock, and the Management branch all left it completely open.
--   3. profiles_unified_role_check allows 'super_admin' as a valid value
--      (needed so service_role can legitimately set it later -- this is
--      correct and is NOT changed here).
--   4. lib/super-admin/actions.ts's isSuperAdmin() trusts
--      profiles.unified_role = 'super_admin' and then uses
--      createAdminClient() (service-role) for getOrganizations /
--      createOrganization / updateOrganizationStatus.
--   5. lib/supabase/middleware.ts and middleware-gate-logic.ts route
--      unified_role = 'super_admin' straight to /super-admin.
-- Net effect: any authenticated user (pending or approved) could issue a
-- direct PostgREST PATCH on their own profiles row setting
-- unified_role='super_admin' (or 'management'), and Management could set
-- it on another non-ADMIN account -- both would have silently succeeded
-- against every layer that existed before this migration. No application
-- UI form ever sends this value; the gap is at the database layer,
-- exploitable by bypassing the UI.
--
-- EXISTING DATA CHECKED (2026-09-23, read-only): no unexpected
-- 'super_admin' value exists anywhere in profiles.unified_role today --
-- only 3 legitimate 'management' rows (role='MANAGEMENT'), matching known
-- accounts. No data is changed by this migration.
--
-- C-02 (public.users, the ICMS-origin shadow/driver/vendor/warehouse
-- table) -- FOLLOW-UP INVESTIGATION (2026-09-23, read-only, no exploit
-- attempted, no data changed):
--   1. "users: own language preference" RLS policy: USING/WITH CHECK
--      (id = auth.uid()), same row-only shape as profiles' old policy.
--   2. NO trigger exists on public.users at all (0 rows in pg_trigger for
--      this table) -- no column-level validation of any kind.
--   3. HOWEVER: table_privileges/column_privileges show `authenticated`
--      has UPDATE granted on EXACTLY ONE column of public.users:
--      preferred_language. `anon` has NO UPDATE grant on this table at
--      all. This is the ONLY reason C-02 is not immediately exploitable
--      today the same way C-01 was -- it is a single, un-reinforced
--      control (the GRANT), with no RLS column check and no trigger
--      backing it up. A single future migration that broadens the GRANT
--      (an easy, unreviewed mistake -- profiles itself had exactly this
--      broad default before this migration) would silently reopen the
--      identical self-promotion path with zero remaining defense. This
--      migration closes that latent gap with the same defense-in-depth
--      pattern as C-01: an explicit-allowlist trigger, independent of the
--      GRANT being correct.
--   4. No INSERT policy exists on public.users (0 policies with cmd='a'),
--      so despite broad INSERT column grants to anon/authenticated (used,
--      not fixed here, by lib/icms/actions/registration.ts's CaterLink
--      self-registration upsert), RLS already default-denies every such
--      INSERT attempt today -- a separate, pre-existing FUNCTIONAL bug
--      (registerUser's users-table upsert silently fails; the error is
--      swallowed and "success" is still returned), not a security hole,
--      and NOT fixed by this migration (out of scope -- fixing it would
--      require adding a permissive INSERT policy, which is a feature
--      change, not containment).
--   5. lib/icms/actions/registration.ts's approveStaff/rejectStaff
--      (supervisor-gated) also write public.users.status via the
--      request-scoped (non-service-role) client, but no RLS UPDATE policy
--      permits a supervisor to write another user's row on this table
--      either -- that write also already silently fails today. Also
--      pre-existing, also not fixed here (same reasoning as #4).
-- EXISTING DATA CHECKED: public.users.unified_role has no 'super_admin'
-- value today -- aso x8, dse x8, enforcement x1, management x2, so x9,
-- vendor x2. No data is changed by this migration.
--
-- Does not touch: CaterLink/checkpoint policies, reports, rosters, duty,
-- leave, overtime, transactions, the profiles_unified_role_check /
-- users_unified_role_check CHECK constraints (super_admin remains a valid
-- domain value on both tables -- service_role must retain the ability to
-- set it; only self/Management writes are restricted), or the (already
-- RLS-default-denied) INSERT paths on public.users.

-- ---------------------------------------------------------------------
-- 1. Grants: anon has no legitimate reason to write profiles at all (RLS
--    already blocks it via auth.uid() being null for anon, but the
--    underlying GRANT was default-broad -- narrow it explicitly).
--    org_id is never written by any authenticated-role application code
--    path (only service_role, via createAdminClient()) -- revoke it from
--    authenticated too, as an independent layer that doesn't depend on
--    the trigger being correct.
-- ---------------------------------------------------------------------
revoke insert, update, delete, truncate on public.profiles from anon;
revoke update (org_id) on public.profiles from authenticated;
revoke update (org_id) on public.profiles from anon;

-- ---------------------------------------------------------------------
-- 1b. Centralized helper for "is the acting user an APPROVED Management
--     user" -- current_role_name() alone (raw profiles.role, no status
--     check) is NOT sufficient; see Part 3 below for the full
--     investigation this closes. Defined here, early, because it's
--     referenced by policies created in both Part 1 (profiles) and
--     Part 3 (team_rosters, absence_notices, announcements, feedback,
--     enforcement_search_log).
-- ---------------------------------------------------------------------
create or replace function public.is_approved_management()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select current_role_name() = 'MANAGEMENT' and current_status() = 'approved';
$function$;

-- ---------------------------------------------------------------------
-- 2. RLS: block the literal exploit value at the policy layer too, so
--    protection does not depend solely on the trigger. Cheap and safe --
--    no legitimate self-update or Management write has ever set
--    unified_role='super_admin'.
-- ---------------------------------------------------------------------
drop policy if exists "profiles self update" on public.profiles;
create policy "profiles self update" on public.profiles
for update
using (id = auth.uid())
with check (id = auth.uid() and coalesce(unified_role, '') <> 'super_admin');

-- PENDING-MANAGEMENT containment (see Part 3 below for the full
-- investigation): these two policies previously authorized the acting
-- Management user with `current_role_name() = 'MANAGEMENT'` alone --
-- current_role_name() reads raw profiles.role with NO status check, so a
-- pending role='MANAGEMENT' applicant (profile-setup explicitly allows
-- requesting this role while status stays 'pending' -- see
-- lib/avsec/reference-data.ts's REQUESTABLE_ROLES) satisfied this
-- condition before ever being approved. Now requires
-- is_approved_management() (defined in Part 3), which adds
-- current_status() = 'approved' on the ACTOR.
drop policy if exists "profiles management approve pending" on public.profiles;
create policy "profiles management approve pending" on public.profiles
for update
using (
  is_approved_management()
  and status = 'pending'
  and id <> auth.uid()
)
with check (
  is_approved_management()
  and status in ('approved', 'rejected')
  and role <> 'ADMIN'
  and id <> auth.uid()
  and coalesce(unified_role, '') <> 'super_admin'
);

drop policy if exists "profiles management manage non-admin staff" on public.profiles;
create policy "profiles management manage non-admin staff" on public.profiles
for update
using (
  is_approved_management()
  and role <> 'ADMIN'
  and id <> auth.uid()
)
with check (
  is_approved_management()
  and role <> 'ADMIN'
  and id <> auth.uid()
  and coalesce(unified_role, '') <> 'super_admin'
);

-- ---------------------------------------------------------------------
-- 3. Trigger: the real column-by-column allowlist. Runs regardless of
--    RLS (BEFORE UPDATE, SECURITY DEFINER) and is the layer that
--    actually enumerates every protected field.
-- ---------------------------------------------------------------------
create or replace function public.enforce_profile_self_update()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  -- Trusted backend writes (createAdminClient() / auth admin flows,
  -- shadow-user backfill) bypass all of the below.
  if auth.role() = 'service_role' then
    return new;
  end if;

  -- Legacy ADMIN role: no accounts currently hold it (merged into
  -- MANAGEMENT, see 20260911000002/20260911000009) -- kept only so this
  -- trigger doesn't regress if that merge is ever reversed.
  if current_role_name() = 'ADMIN' then
    return new;
  end if;

  ----------------------------------------------------------------
  -- SELF-UPDATE (old.id = auth.uid())
  ----------------------------------------------------------------
  if old.id = auth.uid() then
    -- C-01 containment: these are server-controlled identity/audit
    -- fields. None of them are ever legitimately written by a
    -- self-update (lib/avsec/profile-actions.ts's updateProfile() only
    -- ever writes name/staff_no/station/team/role) -- deny by default,
    -- regardless of the row's current status. id and created_at are
    -- listed explicitly even though "profiles self update"'s WITH CHECK
    -- (id = auth.uid()) already makes id practically immutable here --
    -- this is the trigger's own independent guarantee, not reliant on
    -- that policy staying correct. updated_at is deliberately NOT in
    -- this list: profiles_set_updated_at (a separate BEFORE UPDATE
    -- trigger, name-ordered after this one -- Postgres fires same-table
    -- BEFORE triggers in trigger-name order, "profiles_enforce_self_update"
    -- < "profiles_set_updated_at") unconditionally sets NEW.updated_at =
    -- now() on every update; comparing it here would reject that
    -- legitimate, automatic write. This function only ever inspects OLD/
    -- NEW as they stand when IT runs, before that second trigger touches
    -- updated_at, so there is no ordering conflict either way.
    if new.id is distinct from old.id
       or new.created_at is distinct from old.created_at
       or new.unified_role is distinct from old.unified_role
       or new.status is distinct from old.status
       or new.ops_group is distinct from old.ops_group
       or new.org_id is distinct from old.org_id
       or new.approved_by is distinct from old.approved_by
       or new.approved_at is distinct from old.approved_at
       or new.rejection_reason is distinct from old.rejection_reason
       or new.email is distinct from old.email
       or new.duty_post is distinct from old.duty_post
    then
      raise exception 'Not authorized to modify this field on your own profile.';
    end if;

    if old.status = 'pending' then
      -- Explicit allowlist for the profile-setup workflow: only name,
      -- staff_no, station, team, role are writable here (all still
      -- permitted; the check above already excludes everything else).
      -- Role itself still can't self-escalate to ADMIN/SUPER_ADMIN.
      if new.role = 'ADMIN' or new.role::text = 'SUPER_ADMIN' then
        raise exception 'Cannot self-assign this role.';
      end if;
    else
      -- Approved / rejected / deactivated: fully reviewed, fully locked.
      -- Was previously role/status/station/team/ops_group only --
      -- staff_no now locks too (status/ops_group already covered above).
      if new.role is distinct from old.role
         or new.station is distinct from old.station
         or new.team is distinct from old.team
         or new.staff_no is distinct from old.staff_no
      then
        raise exception 'Your account has already been reviewed. Contact an admin to change your role, station, team, or staff ID.';
      end if;
    end if;

    return new;
  end if;

  ----------------------------------------------------------------
  -- MANAGEMENT acting on someone else's (non-ADMIN) row
  ----------------------------------------------------------------
  if current_role_name() = 'MANAGEMENT' and new.role <> 'ADMIN' then
    -- C-01 containment: Management may never grant unified_role
    -- 'super_admin', and may not set it to 'management' through this
    -- generic write path either -- that needs its own dedicated, audited
    -- promotion workflow (not yet built; out of scope here). Every
    -- ordinary AVSEC-role transition Management currently performs
    -- (aso/so/dse/enforcement, via updateUserAssignment /
    -- approveUserWithAssignment's mapAvsecRoleToUnifiedRole mapping)
    -- keeps working.
    if new.unified_role is distinct from old.unified_role
       and new.unified_role in ('super_admin', 'management')
    then
      raise exception 'Management cannot assign this unified_role value through a generic profile update.';
    end if;

    -- Defense in depth: the application layer already refuses to target
    -- a Super Admin account (lib/avsec/admin/actions.ts) -- back it at
    -- the trigger layer too.
    if old.role::text = 'SUPER_ADMIN' or old.unified_role = 'super_admin' then
      raise exception 'Cannot modify a Super Admin account.';
    end if;

    -- org_id and the approval-audit fields are only ever legitimately
    -- written together with a pending -> approved/rejected transition
    -- (approveUserWithAssignment / rejectUser) -- never as a standalone
    -- edit on an already-reviewed row.
    if new.org_id is distinct from old.org_id then
      raise exception 'Management cannot change org_id.';
    end if;
    if old.status <> 'pending'
       and (new.approved_by is distinct from old.approved_by
            or new.approved_at is distinct from old.approved_at
            or new.rejection_reason is distinct from old.rejection_reason)
    then
      raise exception 'Management cannot modify approval audit fields outside the approval workflow.';
    end if;

    return new;
  end if;

  raise exception 'Not authorized to modify this profile.';
end;
$function$;

-- =======================================================================
-- C-02: public.users (ICMS-origin shadow / driver / vendor / warehouse
-- accounts)
-- =======================================================================

-- ---------------------------------------------------------------------
-- 4. Grants: anon has no legitimate reason to write public.users at all.
--    authenticated's UPDATE grant is already correctly narrowed to just
--    preferred_language (verified above) -- re-affirmed here, not
--    widened, so this migration is also idempotent/self-documenting if
--    re-run.
-- ---------------------------------------------------------------------
revoke update, delete, truncate on public.users from anon;

-- ---------------------------------------------------------------------
-- 5. RLS: keep the existing row-scoping (id = auth.uid()) -- the real
--    column enforcement is the trigger below (RLS can't cleanly diff
--    OLD vs NEW without a subquery per column). Re-created here only so
--    this migration is the single source of truth for the policy's
--    current definition.
-- ---------------------------------------------------------------------
drop policy if exists "users: own language preference" on public.users;
create policy "users: own language preference" on public.users
for update
using (id = auth.uid())
with check (id = auth.uid());

-- ---------------------------------------------------------------------
-- 6. Trigger: explicit allowlist, mirroring enforce_profile_self_update().
--    public.users has no station/team/approval-audit columns (those are
--    profiles-only), so the protected set here is: role, unified_role,
--    status, ops_group, org_id, duty_post, email, staff_id, name. The
--    ONLY self-editable field is preferred_language -- the one already
--    granted at the column level, and the only field
--    lib/icms/actions/language.ts's setLanguage() ever writes.
-- ---------------------------------------------------------------------
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
    -- public.users has no updated_at column and no other BEFORE UPDATE
    -- trigger (verified: 0 other triggers on this table) -- no ordering
    -- concern here, unlike profiles.
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

  -- No other actor (including a "supervisor") currently has a matching
  -- RLS policy to write another user's row on this table -- this trigger
  -- fires after RLS/GRANT already gate the statement, so reaching here
  -- with old.id <> auth.uid() should be unreachable in practice; deny
  -- explicitly rather than silently falling through.
  raise exception 'Not authorized to modify this account.';
end;
$function$;

drop trigger if exists users_enforce_self_update on public.users;
create trigger users_enforce_self_update
  before update on public.users
  for each row execute function public.enforce_users_self_update();

-- =======================================================================
-- PART 3: pending-Management privilege-escalation containment
-- =======================================================================
--
-- REMAINING RISK REPORTED (2026-09-23): the profile-setup workflow lets a
-- new pending user request role='MANAGEMENT' (REQUESTABLE_ROLES in
-- lib/avsec/reference-data.ts includes MANAGEMENT, by design -- Management
-- applicants must be able to self-register the same as any other role).
-- Multiple policies and functions authorize "is this user Management"
-- using ONLY current_role_name() = 'MANAGEMENT' -- and current_role_name()
-- (select role from profiles where id = auth.uid()) has NO status check.
-- Blocking unified_role in Parts 1-2 does not close this: it's the
-- LEGACY role='MANAGEMENT' column, not unified_role, that these checks
-- read.
--
-- CONFIRMED: yes. A profile with role='MANAGEMENT', status='pending'
-- satisfies current_role_name() = 'MANAGEMENT' today, and therefore every
-- policy/function listed below, via direct PostgREST/RPC calls, before
-- any Management approval ever happens.
--
-- current_status() (select status from profiles where id = auth.uid())
-- already exists and correctly reads status -- it was simply never
-- combined with current_role_name() at any of these call sites. Fixed
-- here with a single centralized helper, is_approved_management()
-- (Part 1b above: current_role_name() = 'MANAGEMENT' and current_status()
-- = 'approved'), substituted into every policy/function found below that
-- grants Management-specific authority. Middleware
-- (lib/supabase/middleware.ts) was NOT the only protection -- it never
-- was the protection for the DATABASE layer at all; it only gates which
-- pages a pending user's own BROWSER can navigate to, and was never
-- involved in any RLS/RPC decision.
--
-- COMPLETE AUDIT RESULTS (read-only inspection, 2026-09-23, no exploit
-- attempted):
--
-- Already correctly required approved status (no change needed) --
-- confirms current_status() was already the established pattern for
-- SELF-submission checks, just never reused for MANAGEMENT-acting-on-
-- others checks:
--   report_sec013/014/016/018/029/033 "own insert" policies
--     (current_role_name() = ... AND current_status() = 'approved')
--   offload_records "offload own insert"
--
-- VULNERABLE (fixed below) -- direct current_role_name() = 'MANAGEMENT'
-- or an EXISTS-subquery equivalent, with NO status check on the actor:
--   1. profiles "profiles management approve pending" (Part 1, fixed above)
--   2. profiles "profiles management manage non-admin staff" (Part 1, fixed above)
--   3. team_rosters "roster management manage" (ALL commands -- full CRUD
--      on rosters)
--   4. enforcement_search_log "search log select"
--   5. absence_notices "absence_notices_dse_management_update"
--   6. absence_notices "absence_notices_select_elevated"
--   7. announcement_acknowledgements "announcement_acks_management_select"
--   8. announcement_targets "announcement_targets_management_all" (ALL commands)
--   9. announcements "announcements_management_all" (ALL commands)
--   10. feedback_messages "feedback_messages_management_insert"
--   11. feedback_messages "feedback_messages_management_select"
--   12. feedback_threads "feedback_threads_management_select"
--   13. feedback_threads "feedback_threads_management_update"
--   14. function public.search_flight_attendance() -- privileged RPC,
--       "if current_role_name() not in ('ENFORCEMENT','MANAGEMENT')"
--   15. function public.enforce_overtime_transition() -- the 'approved'
--       and 'rejected' transitions both gate on
--       "role_rank(actor_role) >= role_rank('MANAGEMENT')", which is
--       equally blind to status (role_rank() takes a bare role value)
--
-- DELIBERATELY NOT TOUCHED (each is either not Management-specific, has
-- no live pending-Management path, or is explicitly out of scope per
-- instruction 8 -- "do not touch unrelated CaterLink scanning, Hub
-- separation, report acknowledgement or roster group-isolation logic"):
--   - is_monitor_or_above() / current_role_rank() / role_rank() /
--     duty_records "duty monitor select" / shift_handovers / the
--     report_sec0xx "rank select" (visibility) policies / offload rank
--     select / overtime_requests "monitor select" -- these are the
--     numeric role-rank family used for SO/DSE/ENFORCEMENT/MANAGEMENT
--     READ visibility and roster/report group-isolation across the whole
--     app. A pending Management applicant does inherit rank=5 read
--     visibility through these (see "Remaining risks" in the report) --
--     but rewriting this shared family risks regressing the SO/DSE/
--     ENFORCEMENT behavior those exact policies also enforce, which
--     instruction 8 explicitly protects. Flagged, not fixed.
--   - duty_zones "duty_zones admin write" -- gated on role='ADMIN', not
--     MANAGEMENT; a pending Management applicant already fails this
--     regardless of status.
--   - guard_transaction_update() / unescalate_transaction() /
--     "incidents: supervisor resolves" / the transactions/
--     vendor_transactions "checkpoint roles read" policies -- these read
--     current_user_role() from public.users (the ICMS-origin shadow
--     table), not profiles. Verified: there is no live path that creates
--     a public.users row with unified_role='management' and
--     status='pending' -- the AVSEC profile-setup path (the one that
--     actually offers "request Management") only ever writes to
--     profiles; the ICMS shadow row is created post-approval, already
--     status='active', via approveUserWithAssignment's service-role sync.
--     No exploitable pending-Management surface exists on public.users
--     today. Also CaterLink/ICMS transaction logic, explicitly protected
--     by instruction 8.
--
-- No production data was changed by this investigation or this fix.
-- =======================================================================

-- ---------------------------------------------------------------------
-- 7. team_rosters: full CRUD for Management was gated on
--    current_role_name() = 'MANAGEMENT' alone.
-- ---------------------------------------------------------------------
drop policy if exists "roster management manage" on public.team_rosters;
create policy "roster management manage" on public.team_rosters
for all
using (is_approved_management())
with check (is_approved_management());

-- ---------------------------------------------------------------------
-- 8. enforcement_search_log: read access to who searched what flight
--    attendance data. ENFORCEMENT/ADMIN branches untouched (no live
--    pending-privilege path for either -- ADMIN is unused, and this task
--    is scoped to Management).
-- ---------------------------------------------------------------------
drop policy if exists "search log select" on public.enforcement_search_log;
create policy "search log select" on public.enforcement_search_log
for select
using (
  current_role_name() = ANY (ARRAY['ENFORCEMENT'::user_role, 'ADMIN'::user_role])
  or is_approved_management()
);

-- ---------------------------------------------------------------------
-- 9. absence_notices: leave/absence management. Each policy's DSE branch
--    (station/team/ops_group-scoped) and any ADMIN/SUPER_ADMIN branch are
--    preserved verbatim -- only the Management membership test gains a
--    status='approved' requirement, inlined against the same `p`/
--    `profiles` row the EXISTS subquery already fetches (cheaper than a
--    second lookup via the helper function, same effect).
-- ---------------------------------------------------------------------
drop policy if exists "absence_notices_dse_management_update" on public.absence_notices;
create policy "absence_notices_dse_management_update" on public.absence_notices
for update
using (
  ((org_id is null) or (org_id = current_org_id()))
  and (exists (
    select 1 from profiles p
    where p.id = auth.uid()
      and (
        (p.role::text = any (array['ADMIN', 'SUPER_ADMIN']))
        or (p.unified_role = 'super_admin')
        or (((p.role::text = 'MANAGEMENT') or (p.unified_role = 'management')) and p.status = 'approved')
        or (
          (p.role = 'DSE'::user_role)
          and ((absence_notices.station = p.station) or (absence_notices.station is null))
          and (coalesce(p.team, '') = coalesce(absence_notices.team, ''))
          and (coalesce(p.ops_group, '') = coalesce(absence_notices.ops_group, ''))
        )
      )
  ))
)
with check (
  ((org_id is null) or (org_id = current_org_id()))
  and (exists (
    select 1 from profiles p
    where p.id = auth.uid()
      and (
        (p.role::text = any (array['ADMIN', 'SUPER_ADMIN']))
        or (p.unified_role = 'super_admin')
        or (((p.role::text = 'MANAGEMENT') or (p.unified_role = 'management')) and p.status = 'approved')
        or (
          (p.role = 'DSE'::user_role)
          and ((absence_notices.station = p.station) or (absence_notices.station is null))
          and (coalesce(p.team, '') = coalesce(absence_notices.team, ''))
          and (coalesce(p.ops_group, '') = coalesce(absence_notices.ops_group, ''))
        )
      )
  ))
);

drop policy if exists "absence_notices_select_elevated" on public.absence_notices;
create policy "absence_notices_select_elevated" on public.absence_notices
for select
using (
  ((org_id is null) or (org_id = current_org_id()))
  and (exists (
    select 1 from profiles p
    where p.id = auth.uid()
      and (
        (p.role::text = any (array['ADMIN', 'ENFORCEMENT', 'SUPER_ADMIN']))
        or (p.unified_role = any (array['super_admin', 'enforcement']))
        or (((p.role::text = 'MANAGEMENT') or (p.unified_role = 'management')) and p.status = 'approved')
        or (
          (p.role = 'DSE'::user_role)
          and ((p.station is null) or (p.station = absence_notices.station))
          and (coalesce(p.team, '') = coalesce(absence_notices.team, ''))
          and (coalesce(p.ops_group, '') = coalesce(absence_notices.ops_group, ''))
        )
      )
  ))
);

-- ---------------------------------------------------------------------
-- 10. Announcements: create/target/acknowledge visibility.
-- ---------------------------------------------------------------------
drop policy if exists "announcement_acks_management_select" on public.announcement_acknowledgements;
create policy "announcement_acks_management_select" on public.announcement_acknowledgements
for select
using (
  exists (
    select 1 from profiles
    where profiles.id = auth.uid()
      and (
        (profiles.role::text = any (array['ADMIN', 'SUPER_ADMIN']))
        or (profiles.unified_role = 'super_admin')
        or (((profiles.role::text = 'MANAGEMENT') or (profiles.unified_role = 'management')) and profiles.status = 'approved')
      )
  )
);

drop policy if exists "announcement_targets_management_all" on public.announcement_targets;
create policy "announcement_targets_management_all" on public.announcement_targets
for all
using (
  exists (
    select 1 from profiles
    where profiles.id = auth.uid()
      and (
        (profiles.role::text = any (array['ADMIN', 'SUPER_ADMIN']))
        or (profiles.unified_role = 'super_admin')
        or (((profiles.role::text = 'MANAGEMENT') or (profiles.unified_role = 'management')) and profiles.status = 'approved')
      )
  )
);

drop policy if exists "announcements_management_all" on public.announcements;
create policy "announcements_management_all" on public.announcements
for all
using (
  exists (
    select 1 from profiles
    where profiles.id = auth.uid()
      and (
        (profiles.role::text = any (array['ADMIN', 'SUPER_ADMIN']))
        or (profiles.unified_role = 'super_admin')
        or (((profiles.role::text = 'MANAGEMENT') or (profiles.unified_role = 'management')) and profiles.status = 'approved')
      )
  )
);

-- ---------------------------------------------------------------------
-- 11. Management feedback inbox (no SUPER_ADMIN branch in the originals
--     -- preserved as found, not added).
-- ---------------------------------------------------------------------
drop policy if exists "feedback_messages_management_insert" on public.feedback_messages;
create policy "feedback_messages_management_insert" on public.feedback_messages
for insert
with check (
  (sender_role = 'management'::text)
  and exists (
    select 1 from profiles
    where profiles.id = auth.uid()
      and (
        (profiles.role::text = 'ADMIN')
        or (((profiles.role::text = 'MANAGEMENT') or (profiles.unified_role = 'management')) and profiles.status = 'approved')
      )
  )
);

drop policy if exists "feedback_messages_management_select" on public.feedback_messages;
create policy "feedback_messages_management_select" on public.feedback_messages
for select
using (
  exists (
    select 1 from profiles
    where profiles.id = auth.uid()
      and (
        (profiles.role::text = 'ADMIN')
        or (((profiles.role::text = 'MANAGEMENT') or (profiles.unified_role = 'management')) and profiles.status = 'approved')
      )
  )
);

drop policy if exists "feedback_threads_management_select" on public.feedback_threads;
create policy "feedback_threads_management_select" on public.feedback_threads
for select
using (
  exists (
    select 1 from profiles
    where profiles.id = auth.uid()
      and (
        (profiles.role::text = 'ADMIN')
        or (((profiles.role::text = 'MANAGEMENT') or (profiles.unified_role = 'management')) and profiles.status = 'approved')
      )
  )
);

drop policy if exists "feedback_threads_management_update" on public.feedback_threads;
create policy "feedback_threads_management_update" on public.feedback_threads
for update
using (
  exists (
    select 1 from profiles
    where profiles.id = auth.uid()
      and (
        (profiles.role::text = 'ADMIN')
        or (((profiles.role::text = 'MANAGEMENT') or (profiles.unified_role = 'management')) and profiles.status = 'approved')
      )
  )
);

-- ---------------------------------------------------------------------
-- 12. search_flight_attendance(): privileged RPC, callable directly via
--     /rest/v1/rpc/search_flight_attendance. ENFORCEMENT branch and every
--     other line of this function are untouched.
-- ---------------------------------------------------------------------
create or replace function public.search_flight_attendance(p_flight_no text, p_date date default null::date)
returns setof v_flight_attendance
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_flight_no text := trim(coalesce(p_flight_no, ''));
  v_count int;
begin
  if not (current_role_name() = 'ENFORCEMENT' or is_approved_management()) then
    raise exception 'Not authorized to search flight attendance.';
  end if;
  if v_flight_no = '' then
    raise exception 'Flight number is required.';
  end if;

  select count(*) into v_count
  from v_flight_attendance
  where flight_no ilike ('%' || v_flight_no || '%')
    and (p_date is null or flight_date = p_date);

  insert into enforcement_search_log (searched_by, flight_no, search_date, result_count)
  values (auth.uid(), v_flight_no, p_date, v_count);

  return query
    select * from v_flight_attendance
    where flight_no ilike ('%' || v_flight_no || '%')
      and (p_date is null or flight_date = p_date)
    order by flight_date desc nulls last, submitted_at desc nulls last;
end;
$function$;

-- ---------------------------------------------------------------------
-- 13. enforce_overtime_transition(): overtime approval/rejection. Only
--     the two role_rank(actor_role) >= role_rank('MANAGEMENT')
--     comparisons are replaced, with an ADMIN-or-approved-Management
--     boolean computed once. The DSE-endorsement branch (a separate,
--     non-Management authorization) and the claimant-cancels branch are
--     completely untouched.
-- ---------------------------------------------------------------------
create or replace function public.enforce_overtime_transition()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  actor_role user_role;
  actor_is_admin_or_approved_management boolean;
begin
  if new.status = old.status then
    return new;
  end if;

  actor_role := current_role_name();
  actor_is_admin_or_approved_management := (actor_role = 'ADMIN') or is_approved_management();

  if new.status = 'endorsed' then
    if not (actor_role = 'DSE' and old.status = 'pending') then
      raise exception 'Only DSE can endorse a pending overtime request.';
    end if;
  elsif new.status = 'approved' then
    if not (actor_is_admin_or_approved_management and old.status = 'endorsed') then
      raise exception 'Only Management/Admin can approve, and only once DSE has endorsed.';
    end if;
  elsif new.status = 'rejected' then
    if not (
      (actor_role = 'DSE' and old.status = 'pending')
      or (actor_is_admin_or_approved_management and old.status in ('pending', 'endorsed'))
    ) then
      raise exception 'You are not authorized to reject this overtime request at its current stage.';
    end if;
  elsif new.status = 'cancelled' then
    if not (old.profile_id = auth.uid() and old.status = 'pending') then
      raise exception 'Only the claimant can withdraw their own pending request.';
    end if;
  end if;

  return new;
end;
$function$;
