-- STORAGE REPAIR 2: scope reads (and listing) of the private "signatures" bucket.
--
-- Finding (2026-10-06): the policy "signatures: authenticated read" allows ANY authenticated user to read AND list EVERY
-- object in the bucket (bucket_id = 'signatures' and auth.role() = 'authenticated'). A CaterLink Driver or Vendor
-- account can therefore enumerate and download other parties' signatures; paths are only protected by being hard to guess,
-- and listing removes even that. The same pattern exists for the incident-photos and completed-forms buckets (documented,
-- not changed here).
--
-- Minimum safe correction: an authenticated user may read a signature object only if (a) it is their own upload, or
-- (b) a checkpoint row that references it is visible to them. The check is SECURITY INVOKER on purpose: it queries the
-- checkpoint tables as the caller, so the row-level security added in 20261025000001 (parent-transaction / delivery
-- visibility) decides, and nothing new has to be maintained. Upload is unchanged.
--
-- Compatibility: every consumer of the bucket (transaction and vendor detail pages, archive export, final PDFs,
-- receipt confirmation) reads a signature through a checkpoint row the same caller can already see, so those workflows are
-- unaffected. A user listing the bucket now sees only their own uploads and signatures of records they may see.

create or replace function public.caterlink_signature_visible(p_object_name text)
returns boolean
language sql
stable
security invoker
set search_path to 'public'
as $function$
  select exists (select 1 from public.caterlink_checkpoint_part_a c where c.signature_url = p_object_name)
      or exists (select 1 from public.part_b_c c where c.signature_url = p_object_name)
      or exists (select 1 from public.caterlink_checkpoint_part_d c where c.signature_url = p_object_name)
      or exists (select 1 from public.caterlink_checkpoint_hub c where c.signature_url = p_object_name)
      or exists (select 1 from public.caterlink_checkpoint_redq c where c.signature_url = p_object_name)
      or exists (select 1 from public.caterlink_vendor_checkpoints c where c.signature_url = p_object_name);
$function$;
revoke execute on function public.caterlink_signature_visible(text) from public, anon;
grant execute on function public.caterlink_signature_visible(text) to authenticated, service_role;

drop policy if exists "signatures: authenticated read" on storage.objects;
drop policy if exists "signatures: scoped read" on storage.objects;
create policy "signatures: scoped read" on storage.objects for select
  to authenticated
  using (
    bucket_id = 'signatures'
    and (owner = auth.uid() or public.caterlink_signature_visible(name))
  );

-- Read authorization must not hinge on knowing or guessing an object path. Without a write-side guard a signed-in user could
-- create a checkpoint row that merely REFERENCES another account's signature path, making it "visible" to them. This guard
-- refuses a checkpoint row whose signature object exists and was uploaded by a different account (storage.objects.owner is
-- the authenticated uploader). It runs on the checkpoint tables only; no workflow function is redefined. An object with an
-- unknown owner (null) or no object yet is not rejected.
create or replace function public.caterlink_signature_owner_guard()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_actor uuid := coalesce((to_jsonb(new) ->> 'completed_by')::uuid, (to_jsonb(new) ->> 'actor_id')::uuid);
begin
  if new.signature_url is not null and exists (
    select 1 from storage.objects o
    where o.bucket_id = 'signatures' and o.name = new.signature_url
      and o.owner is not null and o.owner is distinct from v_actor
  ) then
    raise exception 'The signature object was uploaded by a different account.';
  end if;
  return new;
end;
$function$;
revoke execute on function public.caterlink_signature_owner_guard() from public, anon, authenticated;

drop trigger if exists trg_cl_sig_owner_part_a on public.caterlink_checkpoint_part_a;
create trigger trg_cl_sig_owner_part_a before insert on public.caterlink_checkpoint_part_a for each row execute function public.caterlink_signature_owner_guard();
drop trigger if exists trg_cl_sig_owner_part_bc on public.part_b_c;
create trigger trg_cl_sig_owner_part_bc before insert on public.part_b_c for each row execute function public.caterlink_signature_owner_guard();
drop trigger if exists trg_cl_sig_owner_part_d on public.caterlink_checkpoint_part_d;
create trigger trg_cl_sig_owner_part_d before insert on public.caterlink_checkpoint_part_d for each row execute function public.caterlink_signature_owner_guard();
drop trigger if exists trg_cl_sig_owner_hub on public.caterlink_checkpoint_hub;
create trigger trg_cl_sig_owner_hub before insert on public.caterlink_checkpoint_hub for each row execute function public.caterlink_signature_owner_guard();
drop trigger if exists trg_cl_sig_owner_redq on public.caterlink_checkpoint_redq;
create trigger trg_cl_sig_owner_redq before insert on public.caterlink_checkpoint_redq for each row execute function public.caterlink_signature_owner_guard();
drop trigger if exists trg_cl_sig_owner_vendor on public.caterlink_vendor_checkpoints;
create trigger trg_cl_sig_owner_vendor before insert on public.caterlink_vendor_checkpoints for each row execute function public.caterlink_signature_owner_guard();
