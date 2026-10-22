-- CaterLink movement visibility: least privilege.
--
-- Defect (observed on staging): public.transactions_read_policy let ANY approved profile with an active assignment at a movement's origin or destination
-- station read that movement (public.has_station_assignment_for_transaction), whatever its role. A Staff Profiling officer or an unrelated station
-- officer therefore read CaterLink movements (and, through the EXISTS-based policies, their seals, Part A checkpoints and signature objects) merely
-- because of station membership.
--
-- Fix: station membership alone no longer grants access. A station-assigned user may read a movement only when the established, reviewed CaterLink
-- capability model grants them an operation on it:
--   * origin scan      -> the origin station's explicit 'scan' capability + an active sso/so/aso/dse assignment AT that station
--   * station / hub receipt at the receiving station
--                      -> public.can_user_confirm_caterlink_receipt(receiving station) (explicit receipt capability + sso/so/aso at that station)
--   * origin creation  -> the origin station's explicit 'create' capability + an active sso/so/aso assignment AT that station
--   (the scan DECISION function is deliberately not referenced: no other permission derives from it)
-- Staff Profiling (profiling_so / profiling_aso) is excluded unconditionally, exactly as in the capability functions. The other branches of the policy
-- (service_role, CaterLink Management, Operation Manager / Main Enforcement, the creator) are unchanged. Seals, Part A / hub checkpoints and the
-- signature objects derive their visibility from this policy and so tighten with it. has_station_assignment_for_transaction is left in place, unused.
set local lock_timeout = '5s';

create or replace function public.caterlink_can_read_transaction_at_stations(
  p_aoc_id uuid,
  p_origin_station_id uuid,
  p_destination_station_id uuid,
  p_hub_destination text
)
returns boolean
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_origin text;
  v_receiving text;
begin
  if v_uid is null or p_aoc_id is null then
    return false;
  end if;
  if not exists (select 1 from public.profiles p where p.id = v_uid and p.status = 'approved') then
    return false;
  end if;
  -- Staff Profiling is excluded, also when combined with an operational role.
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

  if p_origin_station_id is not null then
    select s.code into v_origin from public.org_stations s where s.id = p_origin_station_id and s.is_active;
    -- origin side: an operator assigned AT the origin station whose station holds the explicit capability (scan for scan stations, create for creation stations)
    if v_origin is not null and exists (
      select 1
      from public.user_role_assignments ura
      join public.role_definitions rd on rd.id = ura.role_definition_id and rd.is_active
      where ura.profile_id = v_uid
        and ura.aoc_id = p_aoc_id
        and ura.station_id = p_origin_station_id
        and ura.revoked_at is null
        and (ura.starts_at is null or ura.starts_at <= now())
        and (ura.ends_at is null or ura.ends_at > now())
        and (
          (rd.code in ('sso', 'so', 'aso', 'dse') and public.check_station_caterlink_capability(p_aoc_id, v_origin, 'scan'))
          or (rd.code in ('sso', 'so', 'aso') and public.check_station_caterlink_capability(p_aoc_id, v_origin, 'create'))
        )
    ) then
      return true;
    end if;
  end if;

  v_receiving := public.caterlink_expected_receiving_station(p_hub_destination, p_destination_station_id);
  if v_receiving is not null and public.can_user_confirm_caterlink_receipt(v_receiving, p_aoc_id) then
    return true;
  end if;
  return false;
end;
$function$;

revoke execute on function public.caterlink_can_read_transaction_at_stations(uuid, uuid, uuid, text) from public, anon;
grant execute on function public.caterlink_can_read_transaction_at_stations(uuid, uuid, uuid, text) to authenticated, service_role;

drop policy transactions_read_policy on public.transactions;

create policy transactions_read_policy on public.transactions
  for select to authenticated
  using (
    (current_user = 'service_role'::name)
    or ((aoc_id is not null) and public.has_active_role_for_aoc('caterlink_management'::text, aoc_id))
    or ((aoc_id is not null) and (public.has_active_role_for_aoc('operation_manager'::text, aoc_id) or public.has_active_role_for_aoc('main_enforcement'::text, aoc_id)))
    or (created_by = auth.uid())
    or ((aoc_id is not null) and public.caterlink_can_read_transaction_at_stations(aoc_id, origin_station_id, destination_station_id, hub_destination))
  );
