-- PROPOSED (NOT APPLIED, NOT APPROVED): a movement is readable through the station-assignment path only by an APPROVED profile.
--
-- Defect: public.has_station_assignment_for_transaction() (used only by transactions_read_policy) checks the assignment's
-- station, AOC, revocation and dates, but never the holder's profile status. has_role_in_scope() / has_active_role_for_aoc()
-- (the other branches of the same policy) DO require profiles.status = 'approved'. So a PENDING, REJECTED or DEACTIVATED
-- profile that still holds an otherwise-active station assignment can read every movement at its station, and through the
-- parent-visibility policies of 20261025000001 also that movement's seals, seal verifications and checkpoint rows.
-- Revoked, expired and future-dated assignments are already denied.
--
-- Minimum correction: require the approved profile state inside the helper (trusted database state, nothing client-supplied).
-- Signature, volatility, SECURITY DEFINER, pinned search_path and grants are unchanged; no policy is edited.

create or replace function public.has_station_assignment_for_transaction(
  p_aoc_id uuid,
  p_destination_station_id uuid,
  p_origin_station_id uuid
)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select exists (
    select 1
    from public.user_role_assignments ura
    join public.profiles p on p.id = ura.profile_id
    where ura.profile_id = auth.uid()
      and p.status = 'approved'
      and ura.aoc_id = p_aoc_id
      and (ura.station_id = p_destination_station_id or ura.station_id = p_origin_station_id)
      and ura.revoked_at is null
      and ura.starts_at <= now()
      and (ura.ends_at is null or ura.ends_at > now())
  );
$function$;
