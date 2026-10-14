-- CaterLink Part B (In-flight Security Post / Post 2) -- the canonical checkpoint write path (additive; no existing function is replaced).
--
-- Authoritative sources (all in this repository):
--   * lib/icms/workflow.ts: Part B is the first outbound checkpoint (CREATED -> INFLIGHT_POST_APPROVED, every outbound route) and the
--     FINAL inbound checkpoint (AIRPORT_POST_APPROVED -> COMPLETED).
--   * lib/icms/actions/transactions.ts (legacy completeChecklistPart): vehicle + driver verified, every active seal's number AND colour
--     typed in and matched (mismatch => SEAL_MISMATCH / WRONG_SEAL_COLOR incident, transaction frozen), a secondary whitelist check of the
--     OBSERVED vehicle and driver (violation => WHITELIST_VIOLATION incident, frozen), signature, optional remarks, PASS | ESCALATE
--     (reason required), escalation freezes the transaction and notifies the administrators.
--   * lib/icms/auth.ts requireCheckpointRole: canonical authority = an active aso/so/sso/dse assignment at a single station that holds the
--     scan capability, not Staff Profiling, checked in for duty.
--   * 20261001000001 Phase 9: public.part_b_c (stage 'B' | 'C') is the canonical record; docs/dashboard-review/caterlink-legacy-to-
--     canonical-mapping.md names "no canonical write path" as the gap this closes. Parts C, D, REDQ and skip remain BLOCKED.
--
-- This migration adds: observed vehicle/driver + server-side checkpoint date/time columns, one Part B per transaction (unique), an
-- immutability trigger, the notification event type, and record_caterlink_part_b_secure() -- the only way a Part B is written.
-- The actor is always auth.uid(); officer name/staff number come from the profile; nothing client-supplied decides authorization.

alter table public.part_b_c add column if not exists observed_vehicle_number text;
alter table public.part_b_c add column if not exists observed_driver_name text;
alter table public.part_b_c add column if not exists observed_driver_id text;
alter table public.part_b_c add column if not exists checkpoint_date date;
alter table public.part_b_c add column if not exists checkpoint_time time;

create unique index if not exists part_b_c_one_per_stage on public.part_b_c (transaction_id, checkpoint_stage);

-- A recorded checkpoint is immutable (corrections are made through the incident process, never by editing the record).
create or replace function public.part_b_c_immutable()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
begin
  raise exception 'A recorded CaterLink checkpoint is immutable.';
end;
$function$;
revoke execute on function public.part_b_c_immutable() from public, anon, authenticated;
drop trigger if exists trg_part_b_c_immutable on public.part_b_c;
create trigger trg_part_b_c_immutable before update on public.part_b_c for each row execute function public.part_b_c_immutable();

-- Notification event type for an escalated checkpoint (extends the existing check; nothing is removed).
do $do$
declare
  v_def text;
begin
  select pg_get_constraintdef(c.oid) into v_def from pg_constraint c where c.conname = 'user_notifications_event_type_check' and c.conrelid = 'public.user_notifications'::regclass;
  if v_def is not null and v_def not like '%caterlink_checkpoint_escalated%' then
    v_def := regexp_replace(v_def, '\]\)\)\)\s*$', ',''caterlink_checkpoint_escalated''::text]))) ');
    alter table public.user_notifications drop constraint user_notifications_event_type_check;
    execute 'alter table public.user_notifications add constraint user_notifications_event_type_check ' || v_def;
  end if;
end
$do$;

-- Internal: freeze the transaction behind an incident, audit it and notify CaterLink Management / Operation Manager of the AOC.
create or replace function public.caterlink_checkpoint_escalate_internal(
  p_transaction_id uuid, p_actor uuid, p_incident_type text, p_description text, p_severity text, p_station_id uuid
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_tx record;
  v_inc uuid;
  v_rcpt record;
begin
  select * into v_tx from public.transactions where id = p_transaction_id;
  insert into public.caterlink_incidents (transaction_id, aoc_id, operating_entity_id, station_id, incident_type, severity, description, reported_by, status)
  values (p_transaction_id, v_tx.aoc_id, v_tx.operating_entity_id, p_station_id, p_incident_type, p_severity, p_description, p_actor, 'OPEN')
  returning id into v_inc;
  update public.transactions set status = 'ESCALATED', updated_at = now() where id = p_transaction_id;
  perform public.phase8_write_audit('caterlink_checkpoint_escalate', 'caterlink_incident', v_inc,
    jsonb_build_object('transaction_id', p_transaction_id, 'part', 'B', 'type', p_incident_type));
  for v_rcpt in
    select distinct ura.profile_id
    from public.user_role_assignments ura
    join public.role_definitions rd on rd.id = ura.role_definition_id and rd.is_active
    join public.profiles p on p.id = ura.profile_id and p.status = 'approved'
    where rd.code in ('caterlink_management', 'operation_manager')
      and ura.aoc_id = v_tx.aoc_id
      and ura.revoked_at is null and ura.starts_at <= now() and (ura.ends_at is null or ura.ends_at > now())
  loop
    perform public.notify(v_rcpt.profile_id, 'caterlink_checkpoint_escalated', 'cp_esc:' || p_transaction_id::text || ':' || v_inc::text || ':' || v_rcpt.profile_id::text,
      null, null, null, jsonb_build_object('transaction_id', p_transaction_id, 'incident_id', v_inc, 'part', 'B', 'type', p_incident_type));
  end loop;
  return v_inc;
end;
$function$;
revoke execute on function public.caterlink_checkpoint_escalate_internal(uuid, uuid, text, text, text, uuid) from public, anon, authenticated;

create or replace function public.record_caterlink_part_b_secure(
  p_transaction_id uuid,
  p_vehicle_verified boolean,
  p_driver_verified boolean,
  p_seal_entries jsonb,
  p_seal_colors jsonb,
  p_observed_vehicle text,
  p_observed_driver_name text,
  p_observed_driver_id text,
  p_signature_url text,
  p_signature_hash text,
  p_remarks text,
  p_result text,
  p_escalation_reason text
)
returns table (part_id uuid, outcome text, transaction_status text, is_new boolean)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_tx record;
  v_prof record;
  v_station uuid;
  v_station_code text;
  v_existing record;
  v_required text;
  v_next text;
  v_seal record;
  v_entry text;
  v_color text;
  v_num_bad text[] := '{}';
  v_col_bad text[] := '{}';
  v_seal_count integer := 0;
  v_new_id uuid;
  v_inc uuid;
  v_veh uuid;
  v_drv uuid;
  v_my timestamp := (now() at time zone 'Asia/Kuala_Lumpur');
begin
  if v_uid is null then raise exception 'Must be signed in.'; end if;
  select p.id, p.name, p.staff_no into v_prof from public.profiles p where p.id = v_uid and p.status = 'approved';
  if v_prof.id is null then raise exception 'Not available.'; end if;

  select * into v_tx from public.transactions t where t.id = p_transaction_id for update;
  -- ONE uniform refusal for: unknown transaction, another AOC, another station, no assignment, no capability.
  if v_tx.id is null then raise exception 'Checkpoint not available at your station.'; end if;

  -- Staff Profiling is excluded outright.
  if exists (select 1 from public.user_role_assignments a join public.role_definitions d on d.id = a.role_definition_id
             where a.profile_id = v_uid and d.code in ('profiling_so', 'profiling_aso') and a.revoked_at is null and a.starts_at <= now() and (a.ends_at is null or a.ends_at > now())) then
    raise exception 'Checkpoint not available at your station.';
  end if;
  -- An active station-operator assignment at the transaction's origin or destination station, in its AOC, holding the scan capability.
  select a.station_id, s.code into v_station, v_station_code
  from public.user_role_assignments a
  join public.role_definitions d on d.id = a.role_definition_id and d.is_active and d.code in ('sso', 'so', 'aso', 'dse')
  join public.org_stations s on s.id = a.station_id and s.is_active
  where a.profile_id = v_uid and a.aoc_id = v_tx.aoc_id and a.revoked_at is null and a.starts_at <= now() and (a.ends_at is null or a.ends_at > now())
    and (a.station_id = v_tx.origin_station_id or a.station_id = v_tx.destination_station_id)
  limit 1;
  if v_station is null or not public.check_station_caterlink_capability(v_tx.aoc_id, v_station_code, 'scan') then
    raise exception 'Checkpoint not available at your station.';
  end if;
  -- The rostered-actor model: an open duty check-in for the Malaysia operating date.
  if not exists (select 1 from public.duty_records r where r.profile_id = v_uid and r.duty_date = v_my::date and r.check_in_at is not null and r.check_out_at is null) then
    raise exception 'You must be checked in for duty to process this checkpoint.';
  end if;

  -- Idempotent: the same officer repeating a recorded Part B gets the existing record, never a second one.
  select * into v_existing from public.part_b_c b where b.transaction_id = p_transaction_id and b.checkpoint_stage = 'B';
  if v_existing.id is not null then
    if v_existing.completed_by = v_uid then
      return query select v_existing.id, 'ALREADY_RECORDED'::text, v_tx.status::text, false;
      return;
    end if;
    raise exception 'This checkpoint has already been recorded.';
  end if;

  -- Workflow state (mirrors lib/icms/workflow.ts): outbound B = CREATED -> INFLIGHT_POST_APPROVED; inbound B (final) = AIRPORT_POST_APPROVED -> COMPLETED.
  if v_tx.direction = 'INBOUND' then v_required := 'AIRPORT_POST_APPROVED'; v_next := 'COMPLETED';
  else v_required := 'CREATED'; v_next := 'INFLIGHT_POST_APPROVED'; end if;
  if v_tx.status = 'ESCALATED' then raise exception 'This transaction is escalated; the checkpoint is frozen.'; end if;
  if v_tx.status <> v_required then raise exception 'Out of order: this transaction is not waiting for Part B (status %).', v_tx.status; end if;

  if p_result is null or p_result not in ('PASS', 'ESCALATE') then raise exception 'Select Pass or Escalate.'; end if;
  if p_result = 'ESCALATE' and (p_escalation_reason is null or btrim(p_escalation_reason) = '') then raise exception 'An escalation reason is required.'; end if;
  if p_result = 'PASS' and not (coalesce(p_vehicle_verified, false) and coalesce(p_driver_verified, false)) then
    raise exception 'Vehicle and driver checks must pass; otherwise escalate.';
  end if;
  if p_observed_vehicle is null or btrim(p_observed_vehicle) = '' or p_observed_driver_name is null or btrim(p_observed_driver_name) = ''
     or p_observed_driver_id is null or btrim(p_observed_driver_id) = '' then
    raise exception 'The observed vehicle and driver details are required.';
  end if;
  if p_signature_url is null or p_signature_url !~ '^part-b/[A-Za-z0-9._-]{1,120}$' or p_signature_hash is null or p_signature_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'A valid signature is required.';
  end if;

  -- Officer chose to escalate: the record is kept, the transaction is frozen behind an incident, the administrators are notified.
  if p_result = 'ESCALATE' then
    insert into public.part_b_c (transaction_id, checkpoint_stage, avsec_name, avsec_staff_id, vehicle_verified, driver_verified, seal_verified, signature_url, signature_hash, remarks,
      result, escalation_reason, completed_by, observed_vehicle_number, observed_driver_name, observed_driver_id, checkpoint_date, checkpoint_time)
    values (p_transaction_id, 'B', coalesce(v_prof.name, 'AVSEC'), coalesce(v_prof.staff_no, 'OFFICER'), coalesce(p_vehicle_verified, false), coalesce(p_driver_verified, false), false,
      p_signature_url, p_signature_hash, nullif(btrim(p_remarks), ''), 'ESCALATE', btrim(p_escalation_reason), v_uid,
      upper(btrim(p_observed_vehicle)), btrim(p_observed_driver_name), btrim(p_observed_driver_id), v_my::date, v_my::time)
    returning id into v_new_id;
    v_inc := public.caterlink_checkpoint_escalate_internal(p_transaction_id, v_uid, 'OTHER', 'Part B escalated by the officer: ' || btrim(p_escalation_reason), 'medium', v_station);
    perform public.phase8_write_audit('caterlink_part_b_record', 'transaction', p_transaction_id, jsonb_build_object('result', 'ESCALATE', 'part_id', v_new_id));
    return query select v_new_id, 'ESCALATED'::text, 'ESCALATED'::text, true;
    return;
  end if;

  -- PASS 1: secondary whitelist check of what the officer physically observed.
  v_veh := public.resolve_usable_caterlink_vehicle(upper(btrim(p_observed_vehicle)), v_tx.aoc_id);
  v_drv := public.resolve_usable_caterlink_driver(btrim(p_observed_driver_id), v_tx.aoc_id);
  if v_veh is null or v_drv is null then
    perform public.caterlink_checkpoint_escalate_internal(p_transaction_id, v_uid, 'WHITELIST_VIOLATION',
      'Automatic escalation at Part B: the observed vehicle and/or driver is not on the active whitelist.', 'high', v_station);
    return query select null::uuid, 'WHITELIST_VIOLATION'::text, 'ESCALATED'::text, true;
    return;
  end if;

  -- PASS 2: every active seal's number AND colour must be entered and match the seals of record.
  for v_seal in select s.id, s.seal_number, s.seal_color from public.seals s where s.transaction_id = p_transaction_id and s.superseded_at is null order by s.id loop
    v_seal_count := v_seal_count + 1;
    v_entry := upper(btrim(coalesce(p_seal_entries ->> v_seal.id::text, '')));
    v_color := upper(btrim(coalesce(p_seal_colors ->> v_seal.id::text, '')));
    if v_entry = '' or v_color = '' then raise exception 'Seal number and colour are mandatory for every seal.'; end if;
  end loop;
  if v_seal_count = 0 then raise exception 'No seals on record for this transaction.'; end if;
  for v_seal in select s.id, s.seal_number, s.seal_color from public.seals s where s.transaction_id = p_transaction_id and s.superseded_at is null order by s.id loop
    v_entry := upper(btrim(p_seal_entries ->> v_seal.id::text));
    v_color := upper(btrim(p_seal_colors ->> v_seal.id::text));
    -- verified_by references the legacy public.users table, which canonical officers do not have: the verifier is recorded on part_b_c.completed_by
    -- and in the audit log instead.
    insert into public.seal_verifications (seal_id, checkpoint, entered_seal_number, matched, verified_by, observed_seal_color)
    values (v_seal.id, 'INFLIGHT_POST', v_entry, v_entry = upper(v_seal.seal_number) and v_color = upper(v_seal.seal_color), null,
            case when v_color in ('BLUE', 'GREEN') then v_color else 'OTHER' end);
    if v_entry <> upper(v_seal.seal_number) then v_num_bad := v_num_bad || v_entry;
    elsif v_color <> upper(v_seal.seal_color) then v_col_bad := v_col_bad || v_seal.seal_number; end if;
  end loop;
  if array_length(v_num_bad, 1) > 0 then
    perform public.caterlink_checkpoint_escalate_internal(p_transaction_id, v_uid, 'SEAL_MISMATCH',
      'Automatic escalation at Part B: an entered seal number did not match the seals applied at Part A.', 'high', v_station);
    return query select null::uuid, 'SEAL_MISMATCH'::text, 'ESCALATED'::text, true;
    return;
  end if;
  if array_length(v_col_bad, 1) > 0 then
    perform public.caterlink_checkpoint_escalate_internal(p_transaction_id, v_uid, 'WRONG_SEAL_COLOR',
      'Automatic escalation at Part B: a seal colour did not match the seals applied at Part A.', 'high', v_station);
    return query select null::uuid, 'WRONG_SEAL_COLOR'::text, 'ESCALATED'::text, true;
    return;
  end if;

  insert into public.part_b_c (transaction_id, checkpoint_stage, avsec_name, avsec_staff_id, vehicle_verified, driver_verified, seal_verified, signature_url, signature_hash, remarks,
    result, completed_by, observed_vehicle_number, observed_driver_name, observed_driver_id, checkpoint_date, checkpoint_time)
  values (p_transaction_id, 'B', coalesce(v_prof.name, 'AVSEC'), coalesce(v_prof.staff_no, 'OFFICER'), true, true, true, p_signature_url, p_signature_hash, nullif(btrim(p_remarks), ''),
    'PASS', v_uid, upper(btrim(p_observed_vehicle)), btrim(p_observed_driver_name), btrim(p_observed_driver_id), v_my::date, v_my::time)
  returning id into v_new_id;

  update public.transactions
  set status = v_next, updated_at = now(), completed_at = case when v_next = 'COMPLETED' then now() else completed_at end
  where id = p_transaction_id;

  perform public.phase8_write_audit('caterlink_part_b_record', 'transaction', p_transaction_id,
    jsonb_build_object('result', 'PASS', 'part_id', v_new_id, 'status', v_next));
  return query select v_new_id, case when v_next = 'COMPLETED' then 'COMPLETED' else 'APPROVED' end, v_next, true;
end;
$function$;

revoke execute on function public.record_caterlink_part_b_secure(uuid, boolean, boolean, jsonb, jsonb, text, text, text, text, text, text, text, text) from public, anon;
grant execute on function public.record_caterlink_part_b_secure(uuid, boolean, boolean, jsonb, jsonb, text, text, text, text, text, text, text, text) to authenticated, service_role;
