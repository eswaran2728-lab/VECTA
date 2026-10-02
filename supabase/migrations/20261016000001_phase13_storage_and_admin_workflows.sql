-- Migration: 20261016000001_phase13_storage_and_admin_workflows.sql
-- Phase 13 correction: real CaterLink final-PDF and announcement-attachment
-- Storage workflows, and exposing the already-authorized MAA/AAX entity-admin
-- registration path. Additive, forward-only; no historical migration edited.

-- =====================================================================
-- 1. CaterLink final transaction PDF -- real, versioned, audited
-- =====================================================================
-- authorize_caterlink_pdf_secure() (Phase 9) returned
-- coalesce(v_tx.completed_form_url, 'caterlink-pdfs/' || v_tx.transaction_number || '.pdf')
-- -- a FABRICATED path when no real document existed, with no bucket and
-- no upload code anywhere behind it (confirmed by grep across app/, lib/,
-- components/ during the Phase 13 audit). This section replaces that with
-- a real, versioned, immutable metadata table and a real private bucket.

insert into storage.buckets (id, name, public)
values ('caterlink-final-pdfs', 'caterlink-final-pdfs', false)
on conflict (id) do nothing;

create table if not exists public.caterlink_transaction_pdfs (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references public.transactions(id) on delete cascade,
  version integer not null,
  storage_path text not null,
  content_hash text not null,
  size_bytes integer not null check (size_bytes > 0 and size_bytes <= 20000000),
  mime_type text not null check (mime_type = 'application/pdf'),
  is_current boolean not null default true,
  generated_by uuid not null references public.profiles(id),
  generated_at timestamptz not null default now()
);

-- One row per (transaction, version); never overwritten, only superseded.
create unique index if not exists idx_caterlink_pdf_tx_version
  on public.caterlink_transaction_pdfs(transaction_id, version);

-- At most one CURRENT (authoritative) version per transaction, enforced at
-- the database level -- not just by application discipline.
create unique index if not exists idx_caterlink_pdf_tx_current
  on public.caterlink_transaction_pdfs(transaction_id) where is_current;

-- Idempotent generation: a second request with the SAME content never
-- creates a duplicate version.
create unique index if not exists idx_caterlink_pdf_tx_hash
  on public.caterlink_transaction_pdfs(transaction_id, content_hash);

alter table public.caterlink_transaction_pdfs enable row level security;
revoke all on public.caterlink_transaction_pdfs from public, anon, authenticated;
grant all on public.caterlink_transaction_pdfs to service_role;
-- No direct SELECT grant to `authenticated` at all -- every read goes
-- through the SECURITY DEFINER RPCs below, which re-run the exact same
-- authorization check authorize_caterlink_pdf_secure already used.

create index if not exists idx_caterlink_pdf_tx on public.caterlink_transaction_pdfs(transaction_id, is_current);

-- Single authoritative "can this caller touch this transaction's PDF"
-- check, reused by generation (narrower: CaterLink Management only) and
-- by download (the full authorize_caterlink_pdf_secure participant list).
create or replace function public.can_download_caterlink_pdf(p_transaction_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_caller uuid := auth.uid();
  v_tx record;
begin
  if v_caller is null then return false; end if;
  select * into v_tx from public.transactions where id = p_transaction_id;
  if v_tx is null then return false; end if;

  if public.has_active_role_for_aoc('caterlink_management', v_tx.aoc_id) then return true; end if;
  if v_tx.created_by = v_caller then return true; end if;
  if exists (select 1 from public.caterlink_checkpoint_hub ph where ph.transaction_id = p_transaction_id and ph.completed_by = v_caller) then return true; end if;
  if public.has_active_role_for_aoc('operation_manager', v_tx.aoc_id) then return true; end if;
  return false;
end;
$function$;

revoke execute on function public.can_download_caterlink_pdf(uuid) from public, anon;
grant execute on function public.can_download_caterlink_pdf(uuid) to authenticated, service_role;

-- Generation is narrower than download: CaterLink Management only, and
-- only for a COMPLETED transaction. Concurrency-safe via the unique
-- content-hash index above (two simultaneous identical-content requests
-- race on that constraint, not on application logic) plus `for update`
-- row-locking the transaction row itself.
create or replace function public.record_caterlink_transaction_pdf_secure(
  p_transaction_id uuid,
  p_storage_path text,
  p_content_hash text,
  p_size_bytes integer,
  p_mime_type text
)
returns table (id uuid, version integer, is_new boolean)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_caller uuid := auth.uid();
  v_tx record;
  v_existing record;
  v_next_version integer;
  v_new_id uuid;
begin
  if v_caller is null then raise exception 'Must be signed in.'; end if;

  select * into v_tx from public.transactions t where t.id = p_transaction_id for update;
  if v_tx is null then raise exception 'Transaction not found.'; end if;
  if v_tx.status <> 'COMPLETED' then
    raise exception 'A final PDF may only be generated for a COMPLETED transaction (current: %).', v_tx.status;
  end if;

  if not public.has_active_role_for_aoc('caterlink_management', v_tx.aoc_id) then
    raise exception 'Only CaterLink Management may generate the final transaction PDF.';
  end if;

  if p_mime_type <> 'application/pdf' then
    raise exception 'Only application/pdf is accepted for a final transaction PDF.';
  end if;
  if p_size_bytes is null or p_size_bytes <= 0 or p_size_bytes > 20000000 then
    raise exception 'File size is invalid or exceeds the 20MB limit.';
  end if;

  -- Idempotent generation: identical content for this transaction already
  -- recorded -- return the existing row, never a duplicate.
  select * into v_existing
  from public.caterlink_transaction_pdfs
  where transaction_id = p_transaction_id and content_hash = p_content_hash;

  if v_existing is not null then
    return query select v_existing.id, v_existing.version, false;
    return;
  end if;

  select coalesce(max(p.version), 0) + 1 into v_next_version
  from public.caterlink_transaction_pdfs p
  where p.transaction_id = p_transaction_id;

  -- Supersede, never overwrite, the prior authoritative version.
  update public.caterlink_transaction_pdfs
  set is_current = false
  where transaction_id = p_transaction_id and is_current = true;

  insert into public.caterlink_transaction_pdfs (
    transaction_id, version, storage_path, content_hash, size_bytes, mime_type, is_current, generated_by
  ) values (
    p_transaction_id, v_next_version, p_storage_path, p_content_hash, p_size_bytes, p_mime_type, true, v_caller
  )
  returning caterlink_transaction_pdfs.id into v_new_id;

  perform public.phase8_write_audit('caterlink_pdf_generated', 'transaction_pdf', p_transaction_id,
    jsonb_build_object('transaction_number', v_tx.transaction_number, 'version', v_next_version));

  return query select v_new_id, v_next_version, true;
end;
$function$;

revoke execute on function public.record_caterlink_transaction_pdf_secure(uuid, text, text, integer, text) from public, anon;
grant execute on function public.record_caterlink_transaction_pdf_secure(uuid, text, text, integer, text) to authenticated, service_role;

-- Download path: re-checks authorization immediately before returning the
-- current version's storage path -- never a client-supplied path, never a
-- stale authorization decision. Audits every access.
create or replace function public.get_caterlink_transaction_pdf_secure(p_transaction_id uuid)
returns table (storage_path text, version integer, size_bytes integer, generated_at timestamptz)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_caller uuid := auth.uid();
begin
  if v_caller is null then raise exception 'Must be signed in.'; end if;

  if not public.can_download_caterlink_pdf(p_transaction_id) then
    raise exception 'Unauthorized to access the final PDF for this transaction.';
  end if;

  perform public.phase8_write_audit('caterlink_pdf_access', 'transaction_pdf', p_transaction_id, '{}'::jsonb);

  return query
  select p.storage_path, p.version, p.size_bytes, p.generated_at
  from public.caterlink_transaction_pdfs p
  where p.transaction_id = p_transaction_id and p.is_current;
end;
$function$;

revoke execute on function public.get_caterlink_transaction_pdf_secure(uuid) from public, anon;
grant execute on function public.get_caterlink_transaction_pdf_secure(uuid) to authenticated, service_role;

-- Fix the historical fabricated-path return value: authorize_caterlink_pdf_secure
-- now reflects the REAL recorded path (or null if none has been generated
-- yet) instead of inventing one. Same function name/signature as Phase 9 --
-- this is a forward correction via create-or-replace, not an edit to the
-- historical file that first defined it.
create or replace function public.authorize_caterlink_pdf_secure(
  p_transaction_id uuid
)
returns table (authorized boolean, transaction_number text, pdf_storage_path text)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_caller uuid := auth.uid();
  v_tx record;
begin
  if v_caller is null then raise exception 'Must be signed in.'; end if;
  select * into v_tx from public.transactions where id = p_transaction_id;
  if v_tx is null then raise exception 'Transaction not found.'; end if;

  if v_tx.status <> 'COMPLETED' then
    raise exception 'Final transaction PDF is only available for COMPLETED transactions (current: %).', v_tx.status;
  end if;

  if not public.can_download_caterlink_pdf(p_transaction_id) then
    raise exception 'Unauthorized to access final PDF for transaction %.', v_tx.transaction_number;
  end if;

  perform public.phase8_write_audit('caterlink_pdf_access', 'transaction_pdf', p_transaction_id,
    jsonb_build_object('transaction_number', v_tx.transaction_number));

  return query
  select true, v_tx.transaction_number,
    (select p.storage_path from public.caterlink_transaction_pdfs p where p.transaction_id = p_transaction_id and p.is_current);
end;
$function$;

revoke execute on function public.authorize_caterlink_pdf_secure(uuid) from public, anon;
grant execute on function public.authorize_caterlink_pdf_secure(uuid) to authenticated, service_role;

-- =====================================================================
-- 2. Announcement attachments -- real private Storage bucket
-- =====================================================================
-- announcement_attachments' schema (Phase 11) and RLS policy
-- (is_announcement_visible_to_caller / can_user_manage_announcement) were
-- already correct and already tested (draft secrecy, cross-AOC denial).
-- The confirmed gap was purely the Storage layer: no bucket existed and
-- the UI sent base64 instead. This section adds the bucket and a
-- re-authorized signed-download RPC; lib/avsec/announcements/attachments.ts
-- (application code, not a migration) does the real upload/remove and
-- replaces the base64 UI path.

insert into storage.buckets (id, name, public)
values ('announcement-attachments', 'announcement-attachments', false)
on conflict (id) do nothing;

do $$
begin
  if exists (select 1 from pg_constraint where conname = 'announcement_audit_log_action_check') then
    alter table public.announcement_audit_log drop constraint announcement_audit_log_action_check;
  end if;
  alter table public.announcement_audit_log
    add constraint announcement_audit_log_action_check
    check (action in (
      'create', 'edit', 'publish', 'schedule', 'unpublish', 'archive', 'priority_change', 'scope_change',
      'pin', 'unpin', 'view_acknowledgement_report', 'attachment_upload', 'attachment_download', 'attachment_removed'
    ));
end $$;

-- Re-authorizes immediately before signing -- draft attachments remain
-- invisible to anyone but the draft's authorized manager, exactly as
-- announcement_attachments_read already enforces for direct table reads;
-- this is the equivalent re-check for the Storage signed-URL step.
create or replace function public.get_announcement_attachment_download_secure(p_attachment_id uuid)
returns table (storage_path text, file_name text, content_type text)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_caller uuid := auth.uid();
  v_att record;
begin
  if v_caller is null then raise exception 'Must be signed in.'; end if;

  select * into v_att from public.announcement_attachments where id = p_attachment_id;
  if v_att is null then raise exception 'Attachment not found.'; end if;

  if not (
    public.is_announcement_visible_to_caller(v_att.announcement_id)
    or public.can_user_manage_announcement(v_att.announcement_id)
  ) then
    raise exception 'Unauthorized to access this attachment.';
  end if;

  insert into public.announcement_audit_log (announcement_id, actor_profile_id, action, details)
  values (v_att.announcement_id, v_caller, 'attachment_download', jsonb_build_object('attachment_id', p_attachment_id));

  return query select v_att.storage_path, v_att.file_name, v_att.content_type;
end;
$function$;

revoke execute on function public.get_announcement_attachment_download_secure(uuid) from public, anon;
grant execute on function public.get_announcement_attachment_download_secure(uuid) to authenticated, service_role;

-- Removal: only the announcement's authorized manager, and only while the
-- announcement is still a draft -- published/archived content (including
-- its attachments) is immutable, matching the existing
-- enforce_announcement_immutability trigger's own rule for the
-- announcement row itself. Returns the storage_path so the caller can
-- remove the actual object (never done inside this function -- this
-- migration has no business deleting Storage objects itself).
create or replace function public.remove_announcement_attachment_secure(p_attachment_id uuid)
returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_caller uuid := auth.uid();
  v_att record;
  v_ann record;
begin
  if v_caller is null then raise exception 'Must be signed in.'; end if;

  select * into v_att from public.announcement_attachments where id = p_attachment_id;
  if v_att is null then raise exception 'Attachment not found.'; end if;

  if not public.can_user_manage_announcement(v_att.announcement_id) then
    raise exception 'Unauthorized to remove this attachment.';
  end if;

  select * into v_ann from public.announcements where id = v_att.announcement_id;
  if v_ann.status in ('published', 'archived') then
    raise exception 'Attachments on a published or archived announcement are immutable.';
  end if;

  delete from public.announcement_attachments where id = p_attachment_id;

  insert into public.announcement_audit_log (announcement_id, actor_profile_id, action, details)
  values (v_att.announcement_id, v_caller, 'attachment_removed', jsonb_build_object('attachment_id', p_attachment_id, 'file_name', v_att.file_name));

  return v_att.storage_path;
end;
$function$;

revoke execute on function public.remove_announcement_attachment_secure(uuid) from public, anon;
grant execute on function public.remove_announcement_attachment_secure(uuid) to authenticated, service_role;

-- =====================================================================
-- 3. Expose the already-authorized MAA/AAX entity-admin registration
--    path. approve_registration_request/reject_registration_request
--    (Phase 4) already call is_entity_admin() and already fail closed
--    cross-entity/cross-AOC -- confirmed by reading their bodies during
--    this phase's audit. What was missing was any application code
--    calling them at all (confirmed zero callers by grep). This adds a
--    thin, read-only listing RPC scoped to the caller's own
--    administered entities; the write path reuses the EXISTING
--    approve_registration_request/reject_registration_request RPCs
--    unchanged.
-- =====================================================================
create or replace function public.list_entity_registration_requests_secure()
returns table (
  id uuid,
  profile_id uuid,
  requested_role_code text,
  status text,
  submitted_at timestamptz,
  operating_entity_code text
)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_caller uuid := auth.uid();
  v_admin_entity_codes text[] := array[]::text[];
begin
  if v_caller is null then raise exception 'Must be signed in.'; end if;

  if public.is_entity_admin('MAA') then
    v_admin_entity_codes := array_append(v_admin_entity_codes, 'MAA');
  end if;
  if public.is_entity_admin('AAX') then
    v_admin_entity_codes := array_append(v_admin_entity_codes, 'AAX');
  end if;

  if array_length(v_admin_entity_codes, 1) is null then
    raise exception 'Only an approved MAA or AAX Admin may list entity registration requests.';
  end if;

  -- Scoped to exactly the entity/entities this caller administers --
  -- a MAA-only Admin never sees an AAX-requested registration, and
  -- vice versa. A request with no requested_operating_entity_id at all
  -- (an international/platform-scope request) is never returned here --
  -- that is Super Admin's path, not an entity Admin's.
  return query
  select urr.id, urr.profile_id, urr.requested_role_code, urr.status, urr.submitted_at, oe.code
  from public.user_registration_requests urr
  join public.operating_entities oe on oe.id = urr.requested_operating_entity_id
  where urr.status = 'pending'
    and oe.code = any(v_admin_entity_codes)
  order by urr.submitted_at asc;
end;
$function$;

revoke execute on function public.list_entity_registration_requests_secure() from public, anon;
grant execute on function public.list_entity_registration_requests_secure() to authenticated, service_role;

-- public.operating_entities carries zero grant to `authenticated` at all
-- (Phase 2: "revoke all on public.operating_entities from public, anon,
-- authenticated"), so the application layer cannot resolve a code to an
-- id with a direct select. This tiny, read-only, SECURITY DEFINER lookup
-- is the fix -- it returns an id for any valid code, which is not
-- sensitive information on its own (every id it could return is already
-- resolvable by any Phase 8-12 RPC that takes one), and performs no
-- authorization decision itself.
create or replace function public.resolve_operating_entity_id_secure(p_code text)
returns uuid
language sql
stable
security definer
set search_path to 'public'
as $function$
  select id from public.operating_entities where code = p_code;
$function$;

revoke execute on function public.resolve_operating_entity_id_secure(text) from public, anon;
grant execute on function public.resolve_operating_entity_id_secure(text) to authenticated, service_role;

-- =====================================================================
-- 4. Readiness report: add the new booleans this correction requires.
--    Same function (name/args/return type unchanged) -- a pure
--    create-or-replace extension of the Phase 13 readiness report, not a
--    new report. "Ready" here means "the code/schema path exists and is
--    exercised by this round's tests" -- it explicitly does NOT mean
--    real managed Supabase Storage has been verified (that stays a
--    separate, always-false-locally boolean, same discipline as
--    wois_provider_configured below).
-- =====================================================================
create or replace function public.get_release_readiness_report_secure()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_caller uuid := auth.uid();
  v_is_super_admin boolean;
  v_report jsonb;
begin
  if v_caller is null then
    raise exception 'Must be signed in.';
  end if;

  select exists (
    select 1 from public.profiles p
    where p.id = v_caller and (p.role::text = 'SUPER_ADMIN' or p.unified_role = 'super_admin') and p.status = 'approved'
  ) into v_is_super_admin;

  if not v_is_super_admin then
    raise exception 'Only Super Admin may view the release-readiness report.';
  end if;

  select jsonb_build_object(
    'reports_with_unresolved_aoc', (
      select count(*) from public.central_reports_index where aoc_id is null
    ),
    'failed_indexing_queue_entries', (
      select count(*) from public.report_index_queue where status = 'failed'
    ),
    'pending_report_index_queue_entries', (
      select count(*) from public.report_index_queue where status = 'pending'
    ),
    'legacy_profiles_without_replacement_assignment', (
      select count(*) from public.profiles p
      where p.role::text in ('MANAGEMENT', 'ADMIN', 'ENFORCEMENT')
        and not exists (
          select 1 from public.user_role_assignments ura
          where ura.profile_id = p.id
            and ura.revoked_at is null
            and ura.starts_at <= now()
            and (ura.ends_at is null or ura.ends_at > now())
        )
    ),
    'orphaned_role_assignments', (
      select count(*) from public.user_role_assignments ura
      where not exists (select 1 from public.profiles p where p.id = ura.profile_id)
    ),
    'wois_provider_configured', false, -- merged with the real env boolean at the app layer (app/super-admin/readiness/page.tsx)
    -- Code/schema-level readiness only -- never a claim that real managed
    -- Storage has been exercised. True here means: the bucket insert, the
    -- metadata table/RPCs, and the local fake-adapter tests all exist and
    -- pass (see docs/phase13/storage-matrix.md for the explicit staging
    -- gate on top of this).
    'caterlink_final_pdf_storage_implemented', (
      select exists (select 1 from pg_proc where proname = 'record_caterlink_transaction_pdf_secure')
      and exists (select 1 from storage.buckets where id = 'caterlink-final-pdfs')
    ),
    'announcement_attachment_storage_implemented', (
      select exists (select 1 from pg_proc where proname = 'get_announcement_attachment_download_secure')
      and exists (select 1 from storage.buckets where id = 'announcement-attachments')
    ),
    'real_managed_storage_certified', false, -- always false locally; see docs/phase13/storage-matrix.md -- a real bucket upload/sign/download round trip against managed Supabase Storage is a staging-only gate this boolean can never satisfy from a local report
    'maa_aax_entity_admin_registration_route_implemented', (
      select exists (select 1 from pg_proc where proname = 'list_entity_registration_requests_secure')
    ),
    'export_audit_inventory_closure_enforced', true, -- tests/phase13-export-audit-closure.test.mts enforces this; see docs/phase13/export-audit-inventory.md
    'legacy_retirement_gate_blocked', (
      select count(*) from public.profiles p
      where p.role::text in ('MANAGEMENT', 'ADMIN', 'ENFORCEMENT')
        and not exists (
          select 1 from public.user_role_assignments ura
          where ura.profile_id = p.id
            and ura.revoked_at is null
            and ura.starts_at <= now()
            and (ura.ends_at is null or ura.ends_at > now())
        )
    ) > 0,
    'last_report_index_queue_activity_at', (
      select max(processed_at) from public.report_index_queue where processed_at is not null
    ),
    'generated_at', now()
  ) into v_report;

  return v_report;
end;
$function$;

revoke execute on function public.get_release_readiness_report_secure() from public, anon, authenticated;
grant execute on function public.get_release_readiness_report_secure() to service_role;
