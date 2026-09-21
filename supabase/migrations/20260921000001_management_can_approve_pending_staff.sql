-- Fix authorization mismatch: app-layer approveUser()/rejectUser() require
-- MANAGEMENT_ROLES = ["MANAGEMENT", "ADMIN"] (lib/avsec/auth.ts), but the
-- profiles_enforce_self_update trigger only special-cased role = 'ADMIN',
-- so a real MANAGEMENT user clicking Approve/Reject on a pending staff
-- registration would hit "Not authorized to modify this profile." This
-- fails safe (no unauthorized write occurs) but breaks the intended
-- workflow. Found during VECTA production certification, 2026-09-21.
--
-- Fix is intentionally narrow: MANAGEMENT may only flip an existing
-- PENDING profile's status to approved/rejected — no other field may
-- change in that same statement, it may not approve into the ADMIN role,
-- and it cannot act on its own profile (that still goes through the
-- unchanged self-update branch below, which already forbids self-approval).

create or replace function public.enforce_profile_self_update()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if current_role_name() = 'ADMIN' then
    return new;
  end if;

  if old.id is distinct from auth.uid() then
    if current_role_name() = 'MANAGEMENT'
       and old.status = 'pending'
       and new.status in ('approved', 'rejected')
       and new.role = old.role
       and new.role <> 'ADMIN'
       and new.name is not distinct from old.name
       and new.staff_no is not distinct from old.staff_no
       and new.station is not distinct from old.station
       and new.team is not distinct from old.team
       and new.ops_group is not distinct from old.ops_group
    then
      return new;
    end if;
    raise exception 'Not authorized to modify this profile.';
  end if;

  if old.status in ('approved', 'rejected') then
    if new.role <> old.role or new.status <> old.status then
      raise exception 'Your account has already been reviewed. Contact an admin to change your role.';
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
