-- Found retesting registration end-to-end (2026-09-22): a freshly
-- registered, approved test account logged in successfully (the auth/
-- email-confirmation fix worked) but its profile still showed empty
-- name/station/team - "User / Staff" instead of the submitted details.
--
-- Root cause: app/api/auth/register/route.ts writes the full profile via
-- the service-role admin client (createAdminClient()), which bypasses RLS
-- POLICIES (service_role has BYPASSRLS) but NOT this table's BEFORE UPDATE
-- trigger - triggers always run regardless of RLS bypass. The trigger only
-- ever checked auth.uid()/current_role_name(), which are both null for a
-- genuine backend/service-role request (no end-user JWT exists to check),
-- so it had no path recognizing "this is a trusted server-side write" at
-- all - unlike the standard Supabase idiom of checking
-- auth.role() = 'service_role' for exactly this case.
--
-- This is safe to add: auth.role() only ever returns 'service_role' for
-- requests authenticated with the service-role key, which is never
-- exposed to a browser and is only ever invoked from this codebase's own
-- server-side actions/routes, each of which performs its own
-- authorization before reaching this client (requireRole() in the admin
-- actions; the register route only writes a fresh row it just created
-- with status='pending', never touches an existing account). Ordinary
-- users (role = 'authenticated') are completely unaffected - this adds
-- no new capability reachable from a logged-in session.

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
