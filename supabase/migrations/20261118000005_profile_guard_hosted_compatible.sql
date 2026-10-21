-- Forward repair of public.enforce_profile_self_update() (function body only; no column, policy, grant or trigger change).
--
-- The canonical body reads NEW.unified_role / ops_group / org_id / duty_post directly. Those retired authority columns do not exist on every
-- database (hosted staging never had them, and they must NOT be restored), so every non-service-role UPDATE of public.profiles -- a user editing
-- their own profile, an entity Admin reviewing a registration -- raised 42703 before reaching any rule. This body keeps every rule and reads the
-- retired fields through to_jsonb(), which yields NULL when a column is absent and the real value when it is present, so the guard behaves
-- identically on both shapes. approval_state is added to the server-controlled self-update denial list (it is written only by the approval
-- workflow). Security properties are unchanged: SECURITY DEFINER, search_path = public, owner and ACL untouched by CREATE OR REPLACE.
set local lock_timeout = '5s';

create or replace function public.enforce_profile_self_update()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_new jsonb := to_jsonb(new);
  v_old jsonb := to_jsonb(old);
begin
  -- Trusted backend writes (createAdminClient() / auth admin flows,
  -- shadow-user backfill) bypass all of the below.
  if auth.role() = 'service_role' then
    return new;
  end if;

  -- Canonical registration review (merged operations model): the entity Admin who is authorised to
  -- review this profile's registration request (is_entity_admin, the same check approve_registration_request
  -- and reject_registration_request make) may write the review fields. It can never assign super_admin, and it
  -- applies only to a profile that has a registration request in that Admin's own entity.
  if auth.uid() is not null
     and old.id is distinct from auth.uid()
     and coalesce(lower(v_new->>'unified_role'), '') <> 'super_admin'
     and exists (
       select 1
       from public.user_registration_requests r
       join public.operating_entities oe on oe.id = r.requested_operating_entity_id
       where r.profile_id = old.id
         and (r.status = 'pending' or r.reviewer_id = auth.uid())
         and public.is_entity_admin(oe.code)
     ) then
    return new;
  end if;

  -- Entity-admin maintenance (deactivate / transfer an own-entity assignment): the database helper that re-derives the person's PRIMARY
  -- operating entity touches profiles.operating_entity_id and nothing else. The entity Admin who holds authority over a membership of this
  -- profile in their own entity may cause exactly that derived-field write; any other changed column falls through to the denial below.
  if auth.uid() is not null
     and old.id is distinct from auth.uid()
     and (v_new - 'operating_entity_id' - 'updated_at') = (v_old - 'operating_entity_id' - 'updated_at')
     and exists (
       select 1
       from public.user_entity_memberships m
       join public.operating_entities oe on oe.id = m.operating_entity_id
       where m.profile_id = old.id
         and public.is_entity_admin(oe.code)
     ) then
    return new;
  end if;

  ----------------------------------------------------------------
  -- SELF-UPDATE (old.id = auth.uid())
  ----------------------------------------------------------------
  if old.id = auth.uid() then
    -- Server-controlled identity/audit fields: never legitimately written by a self-update (the profile action only writes
    -- name / staff_no / station / team / role). updated_at is deliberately not compared: profiles_set_updated_at sets it on every update.
    if new.id is distinct from old.id
       or new.created_at is distinct from old.created_at
       or new.status is distinct from old.status
       or new.email is distinct from old.email
       or (v_new->>'unified_role') is distinct from (v_old->>'unified_role')
       or (v_new->>'ops_group') is distinct from (v_old->>'ops_group')
       or (v_new->>'org_id') is distinct from (v_old->>'org_id')
       or (v_new->>'duty_post') is distinct from (v_old->>'duty_post')
       or (v_new->>'approved_by') is distinct from (v_old->>'approved_by')
       or (v_new->>'approved_at') is distinct from (v_old->>'approved_at')
       or (v_new->>'rejection_reason') is distinct from (v_old->>'rejection_reason')
       or (v_new->>'approval_state') is distinct from (v_old->>'approval_state')
    then
      raise exception 'Not authorized to modify this field on your own profile.';
    end if;

    if old.status = 'pending' then
      -- Profile-setup workflow: name, staff_no, station, team, role are writable; role still can't self-escalate to ADMIN/SUPER_ADMIN.
      if new.role::text = 'ADMIN' or new.role::text = 'SUPER_ADMIN' then
        raise exception 'Cannot self-assign this role.';
      end if;
    else
      -- Approved / rejected / deactivated: fully reviewed, fully locked.
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

  raise exception 'Not authorized to modify this profile.';
end;
$function$;
