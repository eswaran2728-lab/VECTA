-- =======================================================================
-- Phase 9: final Hub receipt confirmation at KCH and BKI (additive; supersedes only the receipt function
-- body from 20261001000001 -- that migration is not edited; the scan correction 20261021000001 is untouched).
--
-- Scanning and final receipt confirmation are SEPARATE permissions:
--   * Scan stays enabled at PEN and JHB only. KCH and BKI keep can_scan = false.
--   * Final Hub receipt confirmation is enabled at KCH and BKI (can_confirm_hub_receipt). No creation, view,
--     incident, history or PDF capability is granted to these stations by this migration.
--
-- Eligible roles for the receipt action: sso, so, aso. Required (all derived from auth.uid() only): approved
-- profile; active role definition; active assignment (not revoked, started, not expired) whose station EXACTLY
-- equals the destination station; an active explicit receipt capability at that station; no profiling
-- assignment. No hub-wide, department-wide, management, global, Super Admin, rank, profiles.role, legacy ADMIN,
-- ops_group or compatibility bypass. Missing or ambiguous scope fails closed.
--
-- The receipt RPC now authorizes BEFORE reading the transaction and answers unauthorized or out-of-scope
-- requests with one uniform error, so a caller cannot infer transaction existence, status or destination.
-- Only the final receipt fields change (status, completed_at, destination_station_id, updated_at).
--
-- Stations that already hold a configured receipt capability (KUL, PEN, JHB) keep it; the same strict identity
-- checks now apply to them. BTU and every other station have no receipt capability and stay denied.
-- =======================================================================

-- 1. configuration: KCH and BKI -- final hub receipt on, scanning off (no other capability is granted)
insert into public.caterlink_station_capabilities (
  aoc_id, station_id, can_view, can_create, can_scan, can_confirm_station_receipt,
  can_confirm_hub_receipt, can_report_incident, can_view_history, can_download_pdf, is_active
)
select a.id, s.id, false, false, false, false, true, false, false, false, true
from public.org_stations s
cross join (select id from public.aocs where code = 'MY') a
where s.code in ('KCH', 'BKI') and s.is_active
on conflict (aoc_id, station_id) do update
  set can_confirm_hub_receipt = true,
      can_scan = false,
      is_active = true,
      updated_at = now();

-- 2. minimum prerequisite for valid station-role assignments: the canonical ALPHA team at KCH and BKI
insert into public.org_teams (station_id, name)
select s.id, 'ALPHA'
from public.org_stations s
where s.code in ('KCH', 'BKI') and s.is_active
on conflict (station_id, name) do nothing;

-- 3. the receipt authorization decision (identity from auth.uid() only)
create or replace function public.can_user_confirm_caterlink_receipt(
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

  if not exists (select 1 from public.profiles p where p.id = v_uid and p.status = 'approved') then
    return false;
  end if;

  -- Staff Profiling is excluded (also when combined with an operational role): ambiguous scope fails closed.
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

  -- Explicit active receipt capability at the destination station (scan capability is irrelevant here).
  if not (
    public.check_station_caterlink_capability(v_aoc_id, p_station_code, 'confirm_hub_receipt')
    or public.check_station_caterlink_capability(v_aoc_id, p_station_code, 'confirm_station_receipt')
  ) then
    return false;
  end if;

  -- An active sso/so/aso assignment AT this exact station.
  return exists (
    select 1
    from public.user_role_assignments ura
    join public.role_definitions rd on rd.id = ura.role_definition_id and rd.is_active
    where ura.profile_id = v_uid
      and ura.aoc_id = v_aoc_id
      and ura.station_id = v_station_id
      and rd.code in ('sso', 'so', 'aso')
      and ura.revoked_at is null
      and (ura.starts_at is null or ura.starts_at <= now())
      and (ura.ends_at is null or ura.ends_at > now())
  );
end;
$function$;

revoke execute on function public.can_user_confirm_caterlink_receipt(text, uuid) from public, anon;
grant execute on function public.can_user_confirm_caterlink_receipt(text, uuid) to authenticated, service_role;

-- 4. the receipt RPC: authorize first, uniform denial, only final receipt fields change
create or replace function public.confirm_caterlink_destination_receipt_secure(
  p_transaction_id uuid,
  p_station_code text,
  p_signature_url text,
  p_remarks text default null
)
returns table (transaction_id uuid, status text)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_caller uuid := auth.uid();
  v_tx record;
  v_station_id uuid;
  v_officer_name text;
  v_officer_staff_no text;
begin
  if v_caller is null then
    raise exception 'Must be signed in.';
  end if;

  -- Authorization BEFORE any transaction lookup: nothing about the transaction is revealed to a caller who
  -- is not an eligible officer at this destination station.
  if not public.can_user_confirm_caterlink_receipt(p_station_code) then
    raise exception 'Not authorized to confirm CaterLink receipts at this station.';
  end if;

  select s.id into v_station_id from public.org_stations s where s.code = p_station_code and s.is_active = true;

  select * into v_tx from public.transactions t where t.id = p_transaction_id for update;

  -- One uniform answer for: not found, other AOC, or a different destination.
  if v_tx is null
     or not public.can_user_confirm_caterlink_receipt(p_station_code, v_tx.aoc_id)
     or (v_tx.route = 'HUB' and v_tx.hub_destination is not null and v_tx.hub_destination <> p_station_code)
  then
    raise exception 'Transaction is not available for receipt confirmation at this station.';
  end if;

  if v_tx.status = 'COMPLETED' then
    raise exception 'Transaction is already completed.';
  end if;

  if v_tx.status = 'ESCALATED' then
    raise exception 'Cannot confirm receipt on an escalated transaction with open incident.';
  end if;

  if v_tx.route = 'HUB' and v_tx.status <> 'INFLIGHT_POST_APPROVED' then
    raise exception 'HUB route movement requires In-flight Post approval before destination receipt.';
  end if;

  -- Sender cannot confirm own cross-station movement
  if v_tx.created_by = v_caller and v_tx.origin_station_id <> v_station_id then
    raise exception 'Sender cannot confirm destination receipt for their own cross-station movement.';
  end if;

  select name, staff_no into v_officer_name, v_officer_staff_no from public.profiles where id = v_caller;

  insert into public.caterlink_checkpoint_hub (
    transaction_id, confirmed_destination, hub_avsec_name, hub_avsec_staff_id, remarks, signature_url, completed_by
  ) values (
    p_transaction_id, p_station_code, coalesce(v_officer_name, 'AVSEC'), coalesce(v_officer_staff_no, 'OFFICER'),
    p_remarks, p_signature_url, v_caller
  )
  on conflict on constraint caterlink_checkpoint_hub_transaction_id_key do update set
    confirmed_destination = excluded.confirmed_destination,
    hub_avsec_name = excluded.hub_avsec_name,
    completed_at = now();

  -- Only the final receipt state fields change; transaction content is never edited here.
  update public.transactions
  set status = 'COMPLETED',
      completed_at = now(),
      destination_station_id = v_station_id,
      updated_at = now()
  where id = p_transaction_id;

  perform public.phase8_write_audit('caterlink_receipt_confirm', 'transaction', p_transaction_id,
    jsonb_build_object('destination_station', p_station_code, 'transaction_number', v_tx.transaction_number));

  perform public.notify(
    v_tx.created_by,
    'caterlink_movement_received',
    'caterlink_rcpt_' || p_transaction_id::text,
    null, null, null,
    jsonb_build_object('transaction_id', p_transaction_id, 'station', p_station_code)
  );

  return query select p_transaction_id, 'COMPLETED'::text;
end;
$function$;

revoke execute on function public.confirm_caterlink_destination_receipt_secure(uuid, text, text, text) from public, anon;
grant execute on function public.confirm_caterlink_destination_receipt_secure(uuid, text, text, text) to authenticated, service_role;
