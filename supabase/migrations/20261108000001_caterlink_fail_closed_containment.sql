-- CaterLink fail-closed security containment (additive; no earlier migration is edited).
--
-- Findings on staging (rolled-back probes):
--   1. skip_part_d(uuid, text) was executable by every authenticated user and its role gate failed open
--      (current_user_role() is NULL for canonical accounts and NULL NOT IN (...) is not true).
--   2. raise_caterlink_incident_secure(...) let ANY account holding ANY AOC role assignment -- including a pending profile -- freeze
--      (ESCALATE) any movement in the AOC.
--   3. confirm_caterlink_destination_receipt_secure(...) completed a movement from CREATED (or any non-terminal state) on every
--      route except HUB, bypassing every checkpoint.
--
-- Containment (nothing is deleted; incident history is untouched):
--   * skip_part_d and raise_caterlink_incident_secure are replaced by fail-closed stubs (same signatures, they only raise) and EVERY
--     role -- PUBLIC, anon, authenticated and service_role -- loses EXECUTE. No verified internal process calls either function: the
--     Part B automatic escalation uses caterlink_checkpoint_escalate_internal(), which writes the incident, freezes the movement,
--     audits and notifies by itself and never calls the raise RPC. A future, owner-approved actor matrix will bring a new function.
--   * The destination receipt now locks the transaction row and then accepts it only when the existing state machine
--     (lib/icms/workflow.ts) is waiting on its FINAL step:
--         OUTBOUND HUB / MAINTENANCE  ->  INFLIGHT_POST_APPROVED   (Part Hub / Part C finalise)
--         OUTBOUND AIRCRAFT / REDQ    ->  AIRPORT_POST_APPROVED    (Part D finalises)
--         INBOUND                     ->  AIRPORT_POST_APPROVED    (Part B finalises)
--     POST6_APPROVED is the Phase 9 canonical name of "airport post approved" (it is in the transactions status CHECK and is the state
--     the certified receipt verifiers use), so it is accepted wherever AIRPORT_POST_APPROVED is. No new transition is introduced.
--     A denied receipt raises before anything is written: no hub checkpoint, no audit row, no notification, no PDF job (the PDF job
--     trigger only fires on the status update).
--   * DESTINATION BINDING. The receiving station is read from the movement itself, never from the caller: the expected station is
--     transactions.hub_destination and/or the code of transactions.destination_station_id (when both are set they must agree). The
--     caller-supplied station code must equal it exactly, for every route and direction, before any checkpoint, audit, notification, PDF
--     job or transaction write. A movement with no trusted destination, or whose destination data disagree, is received by nobody. The
--     receipt never rewrites destination_station_id. Nonexistent, foreign-AOC and wrong-destination movements get one identical denial.
--   * The pending-receipt list applies the same rules, so an officer is never offered a movement that cannot be received.

-- 1. skip_part_d: fail closed, nobody may execute
create or replace function public.skip_part_d(p_transaction_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  raise exception 'Not available.';
end;
$function$;
revoke all on function public.skip_part_d(uuid, text) from public, anon, authenticated, service_role;

-- 2. raise_caterlink_incident_secure: fail closed, nobody may execute directly
create or replace function public.raise_caterlink_incident_secure(
  p_transaction_id uuid,
  p_incident_type text,
  p_description text,
  p_severity text default 'medium',
  p_photo_url text default null
)
returns table (incident_id uuid, transaction_status text)
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  raise exception 'Not available.';
end;
$function$;
revoke all on function public.raise_caterlink_incident_secure(uuid, text, text, text, text) from public, anon, authenticated, service_role;

-- 3. the states in which the destination receipt may complete a movement
create or replace function public.caterlink_receipt_ready_statuses(p_direction text, p_route text)
returns text[]
language sql
immutable
set search_path to 'public'
as $function$
  select case
    when p_direction = 'OUTBOUND' and p_route in ('HUB', 'MAINTENANCE') then array['INFLIGHT_POST_APPROVED']::text[]
    when p_direction in ('OUTBOUND', 'INBOUND') then array['AIRPORT_POST_APPROVED', 'POST6_APPROVED']::text[]
    else array[]::text[]
  end;
$function$;
revoke all on function public.caterlink_receipt_ready_statuses(text, text) from public, anon;
grant execute on function public.caterlink_receipt_ready_statuses(text, text) to authenticated, service_role;

-- 3b. the trusted expected receiving station of a movement (NULL when there is none or the data disagree)
create or replace function public.caterlink_expected_receiving_station(p_hub_destination text, p_destination_station_id uuid)
returns text
language sql
stable
security definer
set search_path to 'public'
as $function$
  select case
    when p_hub_destination is not null and p_destination_station_id is not null
      then (select s.code from public.org_stations s where s.id = p_destination_station_id and s.code = p_hub_destination and s.is_active)
    when p_hub_destination is not null then p_hub_destination
    when p_destination_station_id is not null
      then (select s.code from public.org_stations s where s.id = p_destination_station_id and s.is_active)
    else null
  end;
$function$;
revoke all on function public.caterlink_expected_receiving_station(text, uuid) from public, anon, authenticated;

-- 4. destination receipt: bind the destination, lock, then check the state, then write
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
  v_expected text;
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
  v_expected := public.caterlink_expected_receiving_station(v_tx.hub_destination, v_tx.destination_station_id);

  -- One uniform answer for: not found, other AOC, no trusted destination, or a different destination. The destination is the
  -- movement's own; the caller's station code must equal it exactly, for every route and direction.
  if v_tx is null
     or v_tx.id is null
     or not public.can_user_confirm_caterlink_receipt(p_station_code, v_tx.aoc_id)
     or v_expected is null
     or v_expected <> p_station_code
  then
    raise exception 'Transaction is not available for receipt confirmation at this station.';
  end if;

  if v_tx.status = 'COMPLETED' then
    raise exception 'Transaction is already completed.';
  end if;

  if v_tx.status = 'ESCALATED' then
    raise exception 'Cannot confirm receipt on an escalated transaction with open incident.';
  end if;

  -- The row is locked: the state checked here is the state that is advanced. Receipt completes a movement only once the existing
  -- state machine is waiting on its final step; it never skips a checkpoint.
  if not (v_tx.status = any (public.caterlink_receipt_ready_statuses(v_tx.direction, v_tx.route))) then
    if v_tx.route = 'HUB' then
      raise exception 'HUB route movement requires In-flight Post approval before destination receipt.';
    end if;
    raise exception 'Transaction is not ready for receipt: the earlier checkpoints are not complete.';
  end if;

  -- Sender cannot confirm own cross-station movement
  -- NULL-safe: a movement with no origin station (or an unresolved station) is still separated from its own sender
  if v_tx.created_by = v_caller and v_tx.origin_station_id is distinct from v_station_id then
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

  -- Only the final receipt state fields change; transaction content (including its destination) is never edited here.
  update public.transactions
  set status = 'COMPLETED',
      completed_at = now(),
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

-- 5. the pending list offers only what can actually be received
create or replace function public.list_caterlink_pending_receipts_secure(p_station_code text)
returns table (
  id uuid, transaction_number text, direction text, route text, status text, vehicle_number text, driver_name text, seal_number text,
  flight_number text, aircraft_registration text, trolley_count integer, origin_station text, destination_station text, created_at timestamptz
)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
begin
  if not public.can_user_confirm_caterlink_receipt(p_station_code) then
    raise exception 'Not authorized to confirm CaterLink receipts at this station.';
  end if;
  return query
  select t.id, t.transaction_number, t.direction, t.route, t.status, t.vehicle_number, t.driver_name, t.seal_number, t.flight_number,
         t.aircraft_registration, t.trolley_count, os.code, ds.code, t.created_at
  from public.transactions t
  left join public.org_stations os on os.id = t.origin_station_id
  left join public.org_stations ds on ds.id = t.destination_station_id
  where coalesce(t.archived, false) = false
    and t.status = any (public.caterlink_receipt_ready_statuses(t.direction, t.route))
    and public.caterlink_expected_receiving_station(t.hub_destination, t.destination_station_id) = p_station_code
    and public.can_user_confirm_caterlink_receipt(p_station_code, t.aoc_id)
  order by t.created_at desc
  limit 100;
end;
$function$;
revoke execute on function public.list_caterlink_pending_receipts_secure(text) from public, anon;
grant execute on function public.list_caterlink_pending_receipts_secure(text) to authenticated, service_role;
