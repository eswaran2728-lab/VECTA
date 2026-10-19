-- Incident-photos bucket: remove the unrestricted upload and read policies (additive).
--
-- Defect: supabase/migrations/icms/20260101000002_rls.sql created, for role public,
--   "incident photos: authenticated upload"  (insert, bucket_id = 'incident-photos' and auth.role() = 'authenticated')
--   "incident photos: authenticated read"    (select, same condition)
-- so ANY signed-in account (Driver, Vendor, an officer at any station, any AOC) could upload any object into the bucket and read and list
-- every object in it. 20261026000002 documented the same pattern for this bucket and left it unchanged.
--
-- Inventory (application code and staging, 2026-10): no application code uploads to or reads from this bucket (uploadDataUrl is never called
-- with it; the only writer of caterlink_incidents.photo_url, raise_caterlink_incident_secure(), is a closed fail-closed stub since
-- 20261108000001; incidents are created by checkpoint escalation, which carries no photo). Staging holds 0 objects, the legacy incident_photos
-- table is absent, and caterlink_incidents.photo_url is empty. There is therefore no producer to preserve and no historical object to strand.
--
-- Correction (least privilege, fail closed):
--   * both historical policies are removed;
--   * NO client INSERT/UPDATE/DELETE policy is created: an incident-photo upload workflow does not exist and must not be invented here -- when
--     the process owner defines one it needs its own bound path format, reporter/state rules and tests (do not copy the signature rules);
--     the trusted service role is unaffected;
--   * reads are scoped: an authenticated user may read an object only if (a) they uploaded it, or (b) a caterlink_incidents row that references
--     it as photo_url is visible to them. The check is SECURITY INVOKER on purpose, so the existing row-level security on caterlink_incidents
--     ("caterlink_incidents_read": CaterLink Management / Operation Manager / Main Enforcement of the incident's AOC, the reporter, the
--     assignee) decides, exactly as for signatures.
-- The bucket stays private. Nothing is deleted.

create or replace function public.caterlink_incident_photo_visible(p_object_name text)
returns boolean
language sql
stable
security invoker
set search_path to 'public'
as $function$
  select exists (select 1 from public.caterlink_incidents i where i.photo_url = p_object_name);
$function$;
revoke execute on function public.caterlink_incident_photo_visible(text) from public, anon;
grant execute on function public.caterlink_incident_photo_visible(text) to authenticated, service_role;

drop policy if exists "incident photos: authenticated upload" on storage.objects;
drop policy if exists "incident photos: authenticated read" on storage.objects;
drop policy if exists "incident photos: scoped read" on storage.objects;
create policy "incident photos: scoped read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'incident-photos'
    and (owner = auth.uid() or public.caterlink_incident_photo_visible(name))
  );
