-- Vendor Part B signature: the database authorises the Storage write and the checkpoint binds to it (additive).
--
-- Defect: the application uploaded the signature to the shared `signatures` bucket BEFORE the database authorised the security check.
-- The legacy Storage policy lets ANY signed-in user write ANY path in that bucket, the checkpoint RPC accepted any text as the
-- signature path, and nothing removed the object when the save was refused: an unauthorised or rejected request left a permanent object.
--
-- Correction:
--   1. caterlink_vendor_check_upload_allowed(name): true only for vendor-part-b/<delivery uuid>/<uuid>.(png|jpg|webp) when the delivery
--      exists, is still CREATED, and the CALLER may security-check it (approved profile, station-operator assignment at the delivery's
--      station and AOC, station capability on, not Staff Profiling -- the same decision as the checkpoint itself).
--   2. A RESTRICTIVE Storage policy applies that function to every insert under vendor-part-b/ in the signatures bucket. Restrictive
--      policies are ANDed with the existing permissive upload policy, so no other prefix changes and the bucket stays private.
--   3. record_caterlink_vendor_security_check_secure() (same signature) now authorises BEFORE it discloses anything (one refusal for a
--      missing delivery or an unauthorised caller), requires the signature path to be bound to THIS delivery, requires the object to
--      exist in Storage and to be owned by the caller, and validates the hash. The delivery row lock + status check keep it single-shot.
--   4. list_orphan_vendor_signatures_secure(minutes): service-role only; lists vendor signature objects older than the threshold that no
--      checkpoint references, for durable reconciliation of objects whose save failed and whose immediate cleanup also failed.
-- Downloads are unchanged: caterlink_signature_visible() authorises them through the checkpoint row that references the path.

create or replace function public.caterlink_vendor_check_upload_allowed(p_name text)
returns boolean
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_m text[];
  v_d record;
begin
  if p_name is null then
    return false;
  end if;
  v_m := regexp_match(p_name, '^vendor-part-b/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp)$');
  if v_m is null then
    return false;
  end if;
  select d.station_id, d.aoc_id, d.status into v_d from public.caterlink_vendor_deliveries d where d.id = v_m[1]::uuid;
  if v_d.station_id is null or v_d.status is distinct from 'CREATED' then
    return false;
  end if;
  return coalesce(public.caterlink_can_check_vendor_station(v_d.station_id, v_d.aoc_id), false);
end;
$function$;
revoke execute on function public.caterlink_vendor_check_upload_allowed(text) from public, anon;
grant execute on function public.caterlink_vendor_check_upload_allowed(text) to authenticated, service_role;

drop policy if exists "signatures: vendor check upload is delivery-bound" on storage.objects;
create policy "signatures: vendor check upload is delivery-bound" on storage.objects
  as restrictive for insert to authenticated
  with check (
    bucket_id <> 'signatures'
    or name not like 'vendor-part-b/%'
    or public.caterlink_vendor_check_upload_allowed(name)
  );

create or replace function public.record_caterlink_vendor_security_check_secure(
  p_delivery_id uuid,
  p_signature_url text,
  p_signature_hash text default null,
  p_result text default 'PASS',
  p_remarks text default null,
  p_escalation_reason text default null,
  p_observed jsonb default null
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_caller uuid := auth.uid();
  v_d record;
  v_station_code text;
  v_profile record;
begin
  if v_caller is null then
    raise exception 'Must be signed in.';
  end if;
  select * into v_d from public.caterlink_vendor_deliveries where id = p_delivery_id for update;
  -- one refusal for a missing delivery and for an unauthorised caller: nothing about the delivery is disclosed
  if v_d.id is null or not coalesce(public.caterlink_can_check_vendor_station(v_d.station_id, v_d.aoc_id), false) then
    raise exception 'Not authorised to perform the security check at this station.';
  end if;
  select s.code into v_station_code from public.org_stations s where s.id = v_d.station_id;
  if v_d.status <> 'CREATED' then
    raise exception 'The security check is only available for a newly created delivery.';
  end if;
  if p_result not in ('PASS', 'ESCALATE') then
    raise exception 'Invalid result.';
  end if;
  if p_result = 'ESCALATE' and nullif(btrim(p_escalation_reason), '') is null then
    raise exception 'An escalation reason is required.';
  end if;
  -- the signature must be the server-derived path bound to THIS delivery, for an object the caller really uploaded
  if p_signature_url is null or p_signature_url !~ ('^vendor-part-b/' || p_delivery_id::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp)$') then
    raise exception 'A valid signature is required.';
  end if;
  if p_signature_hash is not null and p_signature_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'A valid signature is required.';
  end if;
  if not exists (select 1 from storage.objects o where o.bucket_id = 'signatures' and o.name = p_signature_url and o.owner = v_caller) then
    raise exception 'A valid signature is required.';
  end if;
  select p.name, p.staff_no into v_profile from public.profiles p where p.id = v_caller;

  insert into public.caterlink_vendor_checkpoints (
    delivery_id, stage, actor_id, actor_name, actor_staff_id, signature_url, signature_hash, result, remarks, escalation_reason, observed
  ) values (
    p_delivery_id, 'B', v_caller, coalesce(v_profile.name, ''), coalesce(v_profile.staff_no, ''), p_signature_url,
    p_signature_hash, p_result, p_remarks, p_escalation_reason, p_observed
  );
  update public.caterlink_vendor_deliveries
    set status = case when p_result = 'PASS' then 'SECURITY_VERIFIED' else 'ESCALATED' end
    where id = p_delivery_id;

  perform public.phase8_write_audit('caterlink_vendor_security_check', 'caterlink_vendor_delivery', p_delivery_id,
    jsonb_build_object('result', p_result, 'station', v_station_code));
end;
$function$;
revoke execute on function public.record_caterlink_vendor_security_check_secure(uuid, text, text, text, text, text, jsonb) from public, anon;
grant execute on function public.record_caterlink_vendor_security_check_secure(uuid, text, text, text, text, text, jsonb) to authenticated, service_role;

create or replace function public.list_orphan_vendor_signatures_secure(p_older_than_minutes integer default 30)
returns table (name text)
language sql
stable
security definer
set search_path to 'public'
as $function$
  select o.name
  from storage.objects o
  where o.bucket_id = 'signatures'
    and o.name like 'vendor-part-b/%'
    and o.created_at < now() - make_interval(mins => greatest(coalesce(p_older_than_minutes, 30), 5))
    and not exists (select 1 from public.caterlink_vendor_checkpoints c where c.signature_url = o.name)
  order by o.created_at
  limit 200;
$function$;
revoke all on function public.list_orphan_vendor_signatures_secure(integer) from public, anon, authenticated;
grant execute on function public.list_orphan_vendor_signatures_secure(integer) to service_role;
