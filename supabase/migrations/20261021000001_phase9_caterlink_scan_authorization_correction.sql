-- =======================================================================
-- Phase 9 correction: CaterLink SCAN authorization (additive; supersedes only the function bodies
-- created in 20261001000001_phase9_caterlink_station_access.sql -- that migration is not edited).
--
-- Defects found while verifying the 36 dashboard-review accounts on staging:
--   1. can_user_scan_caterlink() never checked profiles.status, so a pending / rejected / deactivated
--      profile that still held an active assignment was allowed to scan.
--   2. Its role list included hub_se, operation_manager and main_enforcement (plus legacy post*/hub
--      role names), contradicting the decision that only station-level operational officers scan.
--   3. A three-argument overload accepted a caller-supplied profile id.
--
-- Authoritative decision (owner, 2026-10-05):
--   * Scan-eligible roles: sso, so, aso, dse -- at the station of their OWN active assignment.
--   * Scan-enabled stations: PEN and JHB only. KUL / KUL - MAA / KUL - AAX, KCH, BKI, BTU and every other
--     station are disabled until separately authorized through a reviewed migration.
--   * Receipt confirmation (confirm_station_receipt / confirm_hub_receipt) is a SEPARATE capability and is
--     NOT changed here: KCH and BKI keep their receipt capabilities but receive no scan option.
--
-- Corrected function requires ALL of: auth.uid() (never a caller-supplied identity); profile status exactly
-- 'approved'; an active role definition; a non-revoked, started, non-expired assignment; role strictly in
-- (sso, so, aso, dse); the assignment's station exactly equal to the requested station; no active profiling
-- assignment; an active explicit scan capability for that station; and the station being on the reviewed
-- allowlist. Anything missing or ambiguous returns false. No hub-wide, department-wide, management,
-- compatibility-rank, profiles.role, legacy ADMIN, ops_group or Super Admin bypass exists.
-- =======================================================================

-- 1. configuration: scanning is enabled at PEN and JHB only (receipt / view / create flags untouched)
update public.caterlink_station_capabilities c
set can_scan = false,
    updated_at = now()
from public.org_stations s
where s.id = c.station_id
  and s.code not in ('PEN', 'JHB')
  and c.can_scan is distinct from false;

-- 2. the authoritative function (identity from auth.uid() only)
create or replace function public.can_user_scan_caterlink(
  p_station_code text,
  p_aoc_id uuid default null
)
returns boolean
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_aoc_id uuid := p_aoc_id;
  v_station_id uuid;
begin
  if v_uid is null or p_station_code is null or btrim(p_station_code) = '' then
    return false;
  end if;

  -- Reviewed allowlist of scan-enabled stations. Any other station fails closed even if a capability
  -- row says otherwise; enabling another station needs a new reviewed migration.
  if p_station_code not in ('PEN', 'JHB') then
    return false;
  end if;

  if v_aoc_id is null then
    select id into v_aoc_id from public.aocs where code = 'MY';
  end if;
  if v_aoc_id is null then
    return false;
  end if;

  select s.id into v_station_id
  from public.org_stations s
  where s.code = p_station_code and s.is_active = true;
  if v_station_id is null then
    return false;
  end if;

  -- The caller's own profile must be approved.
  if not exists (select 1 from public.profiles p where p.id = v_uid and p.status = 'approved') then
    return false;
  end if;

  -- Staff Profiling is unconditionally excluded (also when combined with an operational role).
  if exists (
    select 1
    from public.user_role_assignments ura
    join public.role_definitions rd on rd.id = ura.role_definition_id
    where ura.profile_id = v_uid
      and rd.code in ('profiling_so', 'profiling_aso')
      and ura.revoked_at is null
      and (ura.starts_at is null or ura.starts_at <= now())
      and (ura.ends_at is null or ura.ends_at > now())
  ) then
    return false;
  end if;

  -- The station must hold an active explicit scan capability in this AOC.
  if not public.check_station_caterlink_capability(v_aoc_id, p_station_code, 'scan') then
    return false;
  end if;

  -- An active station-operator assignment AT this exact station.
  return exists (
    select 1
    from public.user_role_assignments ura
    join public.role_definitions rd on rd.id = ura.role_definition_id and rd.is_active
    where ura.profile_id = v_uid
      and ura.aoc_id = v_aoc_id
      and ura.station_id = v_station_id
      and rd.code in ('sso', 'so', 'aso', 'dse')
      and ura.revoked_at is null
      and (ura.starts_at is null or ura.starts_at <= now())
      and (ura.ends_at is null or ura.ends_at > now())
  );
end;
$function$;

revoke execute on function public.can_user_scan_caterlink(text, uuid) from public, anon;
grant execute on function public.can_user_scan_caterlink(text, uuid) to authenticated, service_role;

-- 3. exactly ONE signature remains: remove the overload that accepted a caller-supplied profile id and the
--    swapped-argument (aoc, station) duplicate that made untyped calls ambiguous.
drop function if exists public.can_user_scan_caterlink(uuid, uuid, text);
drop function if exists public.can_user_scan_caterlink(uuid, text);
