-- Signature bucket: every upload is authorised by the database against a documented, bound path format (additive).
--
-- Defect: the historical policy "signatures: authenticated upload" (supabase/migrations/icms/20260101000002_rls.sql) allows ANY signed-in
-- account to create ANY object name anywhere in the `signatures` bucket. 20261111000001 bound only the `vendor-part-b/` prefix and let every
-- other name pass through, so arbitrary uploads (unknown prefixes, other parties' prefixes, path tricks) remained possible.
--
-- Correction:
--   1. The unrestricted policy is removed. One permissive INSERT policy for `authenticated` replaces it: the object must be owned by the
--      caller (storage `owner` = auth.uid()) and its name must be accepted by caterlink_signature_upload_allowed().
--   2. caterlink_signature_upload_allowed() recognises ONLY these fixed formats (lower-case hex uuids, extension png|jpg|webp, nothing else):
--        part-a/<caller uid>/<uuid>.<ext>                 an active CaterLink Driver (the movement does not exist yet)
--        part-b/<transaction uuid>-<uuid>.<ext>           the officer who may record Part B of that movement right now
--        receipt/<transaction uuid>/<uuid>.<ext>          an officer who may confirm receipt of that movement at its destination now
--        vendor-signatures/<caller uid>/<uuid>.<ext>      an active Third-Party Vendor (the delivery does not exist yet)
--        vendor-part-b/<delivery uuid>/<uuid>.<ext>       the officer who may security-check that delivery now (20261111000001, unchanged)
--        vendor-part-c/<delivery uuid>/<uuid>.<ext>       the owning Vendor of a security-verified delivery
--      Anything else -- unknown prefixes, flat legacy names, traversal, double separators, upper-case or other extensions, arbitrary file
--      names -- is refused at Storage RLS. There is no UPDATE or DELETE policy, so an object can be neither overwritten, moved nor removed
--      by a client; an upsert needs UPDATE and is refused.
--   3. The checkpoint tables already carry caterlink_signature_owner_guard() (20261026000002). It now also requires the stored reference to
--      match the path format for THAT table, bound to the row's own parent and actor, and to point at an object that exists, belongs to the
--      actor and is fresh (< 20 minutes, inside the 30-minute orphan floor). Part C/D/REDQ and the legacy dual signatures have no
--      recording workflow, so no signature reference is accepted for them (fail closed).
--   4. caterlink_signature_referenced() and list_orphan_signatures_secure() (service role only) let trusted server code verify a reference
--      before removing an object and reconcile objects whose save failed. Referenced objects are never listed.
-- Reads are unchanged ("signatures: scoped read"); historical objects keep their names and stay readable; the bucket stays private.

-- ---------------------------------------------------------------------------------------------
-- 1. workflow helpers (each verifies auth.uid(); fixed search_path; no PUBLIC/anon execute)
-- ---------------------------------------------------------------------------------------------
create or replace function public.caterlink_part_b_upload_allowed(p_transaction_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_tx record;
  v_required text;
  v_station uuid;
  v_station_code text;
begin
  if v_uid is null or p_transaction_id is null then
    return false;
  end if;
  if not exists (select 1 from public.profiles p where p.id = v_uid and p.status = 'approved') then
    return false;
  end if;
  select t.id, t.aoc_id, t.direction, t.status, t.origin_station_id, t.destination_station_id into v_tx
  from public.transactions t where t.id = p_transaction_id;
  if v_tx.id is null then
    return false;
  end if;
  -- Staff Profiling is excluded outright (same rule as record_caterlink_part_b_secure)
  if exists (select 1 from public.user_role_assignments a join public.role_definitions d on d.id = a.role_definition_id
             where a.profile_id = v_uid and d.code in ('profiling_so', 'profiling_aso') and a.revoked_at is null and a.starts_at <= now() and (a.ends_at is null or a.ends_at > now())) then
    return false;
  end if;
  -- The officer who ALREADY recorded Part B may submit again: the RPC answers ALREADY_RECORDED (idempotent) and the new object is discarded.
  -- Everyone else needs the movement to be waiting for Part B: outbound at CREATED, inbound (final) at AIRPORT_POST_APPROVED, never
  -- escalated, and no Part B recorded yet.
  if not exists (select 1 from public.part_b_c b where b.transaction_id = p_transaction_id and b.checkpoint_stage = 'B' and b.completed_by = v_uid) then
    v_required := case when v_tx.direction = 'INBOUND' then 'AIRPORT_POST_APPROVED' else 'CREATED' end;
    if v_tx.status is distinct from v_required then
      return false;
    end if;
    if exists (select 1 from public.part_b_c b where b.transaction_id = p_transaction_id and b.checkpoint_stage = 'B') then
      return false;
    end if;
  end if;
  select a.station_id, s.code into v_station, v_station_code
  from public.user_role_assignments a
  join public.role_definitions d on d.id = a.role_definition_id and d.is_active and d.code in ('sso', 'so', 'aso', 'dse')
  join public.org_stations s on s.id = a.station_id and s.is_active
  where a.profile_id = v_uid and a.aoc_id = v_tx.aoc_id and a.revoked_at is null and a.starts_at <= now() and (a.ends_at is null or a.ends_at > now())
    and (a.station_id = v_tx.origin_station_id or a.station_id = v_tx.destination_station_id)
  limit 1;
  if v_station is null or not public.check_station_caterlink_capability(v_tx.aoc_id, v_station_code, 'scan') then
    return false;
  end if;
  return exists (select 1 from public.duty_records r
                 where r.profile_id = v_uid and r.duty_date = (now() at time zone 'Asia/Kuala_Lumpur')::date and r.check_in_at is not null and r.check_out_at is null);
end;
$function$;
revoke execute on function public.caterlink_part_b_upload_allowed(uuid) from public, anon;
grant execute on function public.caterlink_part_b_upload_allowed(uuid) to authenticated, service_role;

create or replace function public.caterlink_receipt_upload_allowed(p_transaction_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_tx record;
  v_expected text;
  v_station_id uuid;
begin
  if v_uid is null or p_transaction_id is null then
    return false;
  end if;
  select t.id, t.aoc_id, t.direction, t.route, t.status, t.hub_destination, t.destination_station_id, t.origin_station_id, t.created_by into v_tx
  from public.transactions t where t.id = p_transaction_id;
  if v_tx.id is null then
    return false;
  end if;
  v_expected := public.caterlink_expected_receiving_station(v_tx.hub_destination, v_tx.destination_station_id);
  if v_expected is null or not coalesce(public.can_user_confirm_caterlink_receipt(v_expected, v_tx.aoc_id), false) then
    return false;
  end if;
  if not (v_tx.status = any (public.caterlink_receipt_ready_statuses(v_tx.direction, v_tx.route))) then
    return false;
  end if;
  select s.id into v_station_id from public.org_stations s where s.code = v_expected and s.is_active;
  -- the sender cannot confirm the receipt of their own cross-station movement
  if v_tx.created_by = v_uid and v_tx.origin_station_id is distinct from v_station_id then
    return false;
  end if;
  return true;
end;
$function$;
revoke execute on function public.caterlink_receipt_upload_allowed(uuid) from public, anon;
grant execute on function public.caterlink_receipt_upload_allowed(uuid) to authenticated, service_role;

create or replace function public.caterlink_vendor_complete_upload_allowed(p_delivery_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_d record;
begin
  if v_uid is null or p_delivery_id is null then
    return false;
  end if;
  if public.caterlink_external_role() is distinct from 'vendor' then
    return false;
  end if;
  select d.id, d.vendor_user_id, d.status into v_d from public.caterlink_vendor_deliveries d where d.id = p_delivery_id;
  if v_d.id is null or v_d.vendor_user_id is distinct from v_uid or v_d.status is distinct from 'SECURITY_VERIFIED' then
    return false;
  end if;
  return not exists (select 1 from public.caterlink_vendor_checkpoints c where c.delivery_id = p_delivery_id and c.stage = 'C');
end;
$function$;
revoke execute on function public.caterlink_vendor_complete_upload_allowed(uuid) from public, anon;
grant execute on function public.caterlink_vendor_complete_upload_allowed(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 2. the dispatcher: only fixed prefixes; everything else is refused
-- ---------------------------------------------------------------------------------------------
create or replace function public.caterlink_signature_upload_allowed(p_name text)
returns boolean
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_u constant text := '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  v_e constant text := '\.(png|jpg|webp)$';
  v_m text[];
begin
  if v_uid is null or p_name is null or length(p_name) > 200 then
    return false;
  end if;

  v_m := regexp_match(p_name, '^part-a/(' || v_u || ')/' || v_u || v_e);
  if v_m is not null then
    return v_m[1]::uuid = v_uid and public.caterlink_external_role() = 'warehouse_pic';
  end if;

  v_m := regexp_match(p_name, '^part-b/(' || v_u || ')-' || v_u || v_e);
  if v_m is not null then
    return coalesce(public.caterlink_part_b_upload_allowed(v_m[1]::uuid), false);
  end if;

  v_m := regexp_match(p_name, '^receipt/(' || v_u || ')/' || v_u || v_e);
  if v_m is not null then
    return coalesce(public.caterlink_receipt_upload_allowed(v_m[1]::uuid), false);
  end if;

  v_m := regexp_match(p_name, '^vendor-signatures/(' || v_u || ')/' || v_u || v_e);
  if v_m is not null then
    return v_m[1]::uuid = v_uid and public.caterlink_external_role() = 'vendor';
  end if;

  v_m := regexp_match(p_name, '^vendor-part-b/(' || v_u || ')/' || v_u || v_e);
  if v_m is not null then
    return coalesce(public.caterlink_vendor_check_upload_allowed(p_name), false);
  end if;

  v_m := regexp_match(p_name, '^vendor-part-c/(' || v_u || ')/' || v_u || v_e);
  if v_m is not null then
    return coalesce(public.caterlink_vendor_complete_upload_allowed(v_m[1]::uuid), false);
  end if;

  return false;
end;
$function$;
revoke execute on function public.caterlink_signature_upload_allowed(text) from public, anon;
grant execute on function public.caterlink_signature_upload_allowed(text) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 3. the policy: the unrestricted one is removed, one bound policy replaces it
-- ---------------------------------------------------------------------------------------------
drop policy if exists "signatures: authenticated upload" on storage.objects;
drop policy if exists "signatures: workflow upload" on storage.objects;
create policy "signatures: workflow upload" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'signatures'
    and owner = auth.uid()
    and public.caterlink_signature_upload_allowed(name)
  );

-- ---------------------------------------------------------------------------------------------
-- 4. finalisation: the stored reference must be the bound path for this table, row parent and actor, for a fresh object the actor owns
-- ---------------------------------------------------------------------------------------------
create or replace function public.caterlink_signature_owner_guard()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_row jsonb := to_jsonb(new);
  v_actor uuid := coalesce((v_row ->> 'completed_by')::uuid, (v_row ->> 'actor_id')::uuid);
  v_u constant text := '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  v_e constant text := '\.(png|jpg|webp)$';
  v_re text;
begin
  if new.signature_url is null then
    return new;
  end if;
  if tg_table_name = 'caterlink_checkpoint_part_a' then
    v_re := '^part-a/' || v_actor::text || '/' || v_u || v_e;
  elsif tg_table_name = 'part_b_c' and v_row ->> 'checkpoint_stage' = 'B' then
    v_re := '^part-b/' || (v_row ->> 'transaction_id') || '-' || v_u || v_e;
  elsif tg_table_name = 'caterlink_checkpoint_hub' then
    v_re := '^receipt/' || (v_row ->> 'transaction_id') || '/' || v_u || v_e;
  elsif tg_table_name = 'caterlink_vendor_checkpoints' and v_row ->> 'stage' = 'A' then
    v_re := '^vendor-signatures/' || v_actor::text || '/' || v_u || v_e;
  elsif tg_table_name = 'caterlink_vendor_checkpoints' and v_row ->> 'stage' = 'B' then
    v_re := '^vendor-part-b/' || (v_row ->> 'delivery_id') || '/' || v_u || v_e;
  elsif tg_table_name = 'caterlink_vendor_checkpoints' and v_row ->> 'stage' = 'C' then
    v_re := '^vendor-part-c/' || (v_row ->> 'delivery_id') || '/' || v_u || v_e;
  else
    -- Part C, Part D, REDQ and the legacy dual signatures have no recording workflow: no signature reference is accepted
    raise exception 'This checkpoint does not accept a signature.';
  end if;
  if new.signature_url !~ v_re then
    raise exception 'The signature is not the one uploaded for this record.';
  end if;
  if not exists (
    select 1 from storage.objects o
    where o.bucket_id = 'signatures' and o.name = new.signature_url
      and o.owner is not distinct from v_actor and o.owner is not null
      and o.created_at > now() - interval '20 minutes'
  ) then
    raise exception 'The signature object was not uploaded by this account for this record.';
  end if;
  return new;
end;
$function$;
revoke execute on function public.caterlink_signature_owner_guard() from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- 5. trusted server support (service role only): reference check and orphan listing across every approved prefix
-- ---------------------------------------------------------------------------------------------
create or replace function public.caterlink_signature_referenced(p_name text)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select exists (select 1 from public.caterlink_checkpoint_part_a c where c.signature_url = p_name)
      or exists (select 1 from public.part_b_c c where c.signature_url = p_name)
      or exists (select 1 from public.caterlink_checkpoint_part_d c where c.signature_url = p_name)
      or exists (select 1 from public.caterlink_checkpoint_hub c where c.signature_url = p_name)
      or exists (select 1 from public.caterlink_checkpoint_redq c where c.signature_url = p_name)
      or exists (select 1 from public.caterlink_vendor_checkpoints c where c.signature_url = p_name);
$function$;
revoke all on function public.caterlink_signature_referenced(text) from public, anon, authenticated;
grant execute on function public.caterlink_signature_referenced(text) to service_role;

create or replace function public.list_orphan_signatures_secure(p_older_than_minutes integer default 30)
returns table (name text)
language sql
stable
security definer
set search_path to 'public'
as $function$
  select o.name
  from storage.objects o
  where o.bucket_id = 'signatures'
    and (   o.name ~ '^(part-a|vendor-signatures)/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp)$'
         or o.name ~ '^part-b/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp)$'
         or o.name ~ '^(receipt|vendor-part-b|vendor-part-c)/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp)$')
    and o.created_at < now() - make_interval(mins => greatest(coalesce(p_older_than_minutes, 30), 5))
    and not public.caterlink_signature_referenced(o.name)
  order by o.created_at
  limit 200;
$function$;
revoke all on function public.list_orphan_signatures_secure(integer) from public, anon, authenticated;
grant execute on function public.list_orphan_signatures_secure(integer) to service_role;
