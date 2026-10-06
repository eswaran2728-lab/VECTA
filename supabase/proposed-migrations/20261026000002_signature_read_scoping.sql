-- PROPOSED (not applied): scope reads (and listing) of the private "signatures" bucket.
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
