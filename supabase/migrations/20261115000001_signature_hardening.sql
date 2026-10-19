-- Signature bucket hardening: single-use objects, a per-account quota, a paged orphan listing, bucket limits (additive).
--
-- Follows 20261113000001 (path-bound uploads and finalisation binding). An independent review of that implementation found no bypass; it
-- recorded these residual risks, closed here:
--   1. One object could be referenced by more than one parent row of the same actor (Part A / vendor creation are bound to the ACTOR, not
--      to a single parent). A unique registry now makes every signature object single-use, atomically: two concurrent inserts that reference
--      the same object cannot both commit.
--   2. Nothing bounded how many objects an authorised account could create under its own prefix, so orphan reconciliation (200 per run)
--      could be outpaced. The upload policy now also refuses an account that already has 30 UNREFERENCED signature objects created in the last
--      hour (leftovers only: objects that back a real checkpoint are valid work and never count, so a busy officer is not blocked). The check is
--      a bound, not an atomic gate: concurrent uploads at the limit can overshoot by the concurrency level.
--   3. list_orphan_signatures_secure() returned the same oldest 200 rows on every run, so a stuck head starved the rest. It now takes an
--      offset (the old one-argument form is replaced) and orders deterministically (created_at, name).
--   4. Object content was bounded only by the file name. The bucket now accepts at most 5 MB and image/png|jpeg|webp (where the platform
--      exposes those columns).
-- The ON CONFLICT DO UPDATE receipt retry can leave one unreferenced object; the application verifies the reference after every successful
-- call and removes an unreferenced object, and the scheduled reconciliation covers anything left.

-- 1. single-use registry (no client access at all)
create table if not exists public.caterlink_signature_refs (
  signature_url text primary key,
  created_at timestamptz not null default now()
);
alter table public.caterlink_signature_refs enable row level security;
revoke all on public.caterlink_signature_refs from public, anon, authenticated;
grant select, insert on public.caterlink_signature_refs to service_role;

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
  -- single use: the registry's primary key makes the claim atomic even when two transactions reference the same object at once
  begin
    insert into public.caterlink_signature_refs (signature_url) values (new.signature_url);
  exception when unique_violation then
    raise exception 'This signature has already been used.';
  end;
  return new;
end;
$function$;
revoke execute on function public.caterlink_signature_owner_guard() from public, anon, authenticated;

-- 2. per-account quota in the upload decision (the dispatcher otherwise unchanged)
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
  -- at most 30 UNREFERENCED signature objects per account in the last hour: bounds the leftovers one authorised account can create without ever
  -- counting valid, referenced work
  if (select count(*) from storage.objects o
       where o.bucket_id = 'signatures' and o.owner = v_uid and o.created_at > now() - interval '1 hour'
         and not public.caterlink_signature_referenced(o.name)) >= 30 then
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

-- 3. paged, deterministic orphan listing (service role only); replaces the one-argument form
drop function if exists public.list_orphan_signatures_secure(integer);
create or replace function public.list_orphan_signatures_secure(p_older_than_minutes integer default 30, p_offset integer default 0)
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
  order by o.created_at, o.name
  offset greatest(coalesce(p_offset, 0), 0)
  limit 200;
$function$;
revoke all on function public.list_orphan_signatures_secure(integer, integer) from public, anon, authenticated;
grant execute on function public.list_orphan_signatures_secure(integer, integer) to service_role;

-- 4. bucket limits, where the platform exposes the columns
do $limits$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'storage' and table_name = 'buckets' and column_name = 'file_size_limit')
     and exists (select 1 from information_schema.columns where table_schema = 'storage' and table_name = 'buckets' and column_name = 'allowed_mime_types') then
    update storage.buckets
       set file_size_limit = 5242880,
           allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp']
     where id = 'signatures';
  end if;
end;
$limits$;
