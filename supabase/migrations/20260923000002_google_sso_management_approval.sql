-- Google SSO registration + Management approval workflow (2026-09-23).
--
-- Adds audit columns for the approval decision and widens the
-- MANAGEMENT-approve RLS policy so Management can assign the FINAL
-- role/station/team/ops_group at approval time, instead of only ever
-- trusting whatever the pending registrant typed into their own request
-- (the pre-existing "profiles management approve pending" policy from
-- 20260921091615 deliberately forbade any field change except status,
-- exactly to stop a self-service request being silently treated as
-- final -- but the actual product requirement is for Management to
-- REVIEW and explicitly set the final values, which needs a wider,
-- still-narrow write path).
--
-- Does not touch: CaterLink scanning/checkpoint policies (20260922113723),
-- report acknowledgement isolation (20260922115335), roster isolation
-- (20260922000005/20260923000001), leave/overtime/attendance policies,
-- or the ADMIN-only "profiles admin manage" policy.

alter table public.profiles
  add column if not exists approved_by uuid references public.profiles(id),
  add column if not exists approved_at timestamptz,
  add column if not exists rejection_reason text;

-- Replaces "profiles management approve pending" (20260921091615): same
-- actor (MANAGEMENT), same pending->approved/rejected transition, same
-- self-target/ADMIN-promotion protections -- but now also permits
-- role/station/team/ops_group to change in that one statement, which is
-- exactly the "atomic: save final assignments + flip status" requirement.
-- Application-layer validation (lib/avsec/admin/actions.ts
-- approveUserWithAssignment) is still the place that enforces "station
-- mandatory", "team+ops_group mandatory for ASO/SO/DSE", and "never
-- trust the requested role" -- this policy only gates WHO may write and
-- prevents the specific unsafe cases (self-target, ADMIN promotion) that
-- must never be possible regardless of what the application layer does.
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
);

-- Closes a self-modification gap found while implementing this: the
-- existing broader "profiles management manage non-admin staff" policy
-- (20260922000001) has no self-exclusion at all, so a MANAGEMENT user
-- could in principle update their OWN station/team/ops_group/role
-- through it. Explicit requirement here: a user must never modify their
-- own authorization attributes. ADMIN's own broad policy is untouched
-- (ADMIN is not self-approvable either, but that's out of scope for this
-- pass and was true before this change).
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
);

-- The BEFORE UPDATE trigger runs regardless of RLS and independently
-- enforces its own rules (20260921080846/20260922000002). Its MANAGEMENT
-- branch previously required every field except status to stay
-- unchanged -- widen it to allow role/station/team/ops_group to change
-- on the pending->approved/rejected transition, matching the RLS policy
-- above. Self-target and promotion-to-ADMIN remain forbidden.
create or replace function public.enforce_profile_self_update()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if auth.role() = 'service_role' then
    return new;
  end if;

  if current_role_name() = 'ADMIN' then
    return new;
  end if;

  if old.id is distinct from auth.uid() then
    -- Mirrors the RLS "profiles management manage non-admin staff" policy
    -- (20260922000001, self-excluded as of this migration): MANAGEMENT
    -- may write any non-ADMIN profile that isn't their own, for any
    -- status transition (approve, reject, deactivate, reassign role/
    -- station/team/ops_group). Found and fixed here: the trigger
    -- previously only had a narrower pending-status-only branch, which
    -- silently blocked deactivateUser()/updateUserAssignment() for
    -- MANAGEMENT on already-approved rows even though RLS allowed it -
    -- the RLS fix for those two actions (20260922000001) was never
    -- actually completed at the trigger layer until now.
    if current_role_name() = 'MANAGEMENT' and new.role <> 'ADMIN' then
      return new;
    end if;
    raise exception 'Not authorized to modify this profile.';
  end if;

  if old.status in ('approved', 'rejected') then
    -- Found while implementing this migration: this branch previously
    -- only guarded role/status, leaving station/team/ops_group entirely
    -- unguarded for a self-update once reviewed - a user could freely
    -- change their own authorization attributes via the ordinary
    -- "profiles self update" RLS path (id = auth.uid()), which has no
    -- restriction of its own. Explicit requirement: a user must never
    -- modify their own role, station, team, ops_group, or status.
    if new.role <> old.role
       or new.status <> old.status
       or new.station is distinct from old.station
       or new.team is distinct from old.team
       or new.ops_group is distinct from old.ops_group
    then
      raise exception 'Your account has already been reviewed. Contact an admin to change your role, station, team, or ops group.';
    end if;
  else
    if new.status <> 'pending' then
      raise exception 'Cannot change your own approval status.';
    end if;
    if new.role = 'ADMIN' then
      raise exception 'Cannot self-assign the ADMIN role.';
    end if;
  end if;

  return new;
end;
$function$;
