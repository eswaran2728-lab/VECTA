-- Owner-requested KUL-MAA scanning enablement. Preserve every existing role, status, AOC, assignment and capability guard.
-- KUL-AAX, BKI, KCH, BTU and unassigned stations remain disabled.
update public.caterlink_station_capabilities c set can_scan=true,updated_at=now() from public.org_stations s, public.aocs a where c.station_id=s.id and c.aoc_id=a.id and s.code='KUL - MAA' and s.is_active and a.code='MY' and c.is_active;
CREATE OR REPLACE FUNCTION public.can_user_scan_caterlink(p_station_code text, p_aoc_id uuid DEFAULT NULL::uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  if p_station_code not in ('PEN', 'JHB', 'KUL - MAA') then
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
$function$
;
