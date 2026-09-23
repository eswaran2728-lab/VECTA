-- SECURITY CONTAINMENT (2026-09-23): C-01 -- self-promotion through
-- profiles.unified_role. This is temporary containment for the UNFINISHED
-- Super Admin feature, not an expansion of it -- it does NOT build the
-- planned Super Admin UI, multi-station, multi-hub, multi-AOC, or the
-- major Malaysia upgrade. It only prevents privilege escalation while
-- preserving current KUL functionality.
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
-- RELATED FINDING, OUT OF SCOPE HERE: public.users (the ICMS-origin
-- shadow table) has an analogous "users: own language preference" RLS
-- policy (id = auth.uid(), no column restriction) and NO trigger at all --
-- an equivalent, currently-unprotected self-promotion surface. Flagged in
-- the report for a separate authorized fix; not touched by this
-- migration (task scope is profiles only).
--
-- Does not touch: CaterLink/checkpoint policies, reports, rosters, duty,
-- leave, overtime, transactions, or the profiles_unified_role_check CHECK
-- constraint (super_admin remains a valid domain value -- service_role
-- must retain the ability to set it; only self/Management writes are
-- restricted).

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

drop policy if exists "profiles management approve pending" on public.profiles;
create policy "profiles management approve pending" on public.profiles
for update
using (
  current_role_name() = 'MANAGEMENT'
  and status = 'pending'
  and id <> auth.uid()
)
with check (
  current_role_name() = 'MANAGEMENT'
  and status in ('approved', 'rejected')
  and role <> 'ADMIN'
  and id <> auth.uid()
  and coalesce(unified_role, '') <> 'super_admin'
);

drop policy if exists "profiles management manage non-admin staff" on public.profiles;
create policy "profiles management manage non-admin staff" on public.profiles
for update
using (
  current_role_name() = 'MANAGEMENT'
  and role <> 'ADMIN'
  and id <> auth.uid()
)
with check (
  current_role_name() = 'MANAGEMENT'
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
    -- regardless of the row's current status.
    if new.unified_role is distinct from old.unified_role
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
