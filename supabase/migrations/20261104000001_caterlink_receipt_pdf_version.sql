-- Final PDF re-versioned after a BKI / KCH final receipt (additive; no existing function is replaced).
--
-- A HUB-route form gains its receipt part when the destination station confirms receipt, so the final PDF must be regenerated. The
-- existing record_caterlink_transaction_pdf_secure() is CaterLink-Management-only (correct for manual generation) and cannot be used
-- by the receiving officer. This function is the SERVICE-ROLE-ONLY recorder the server calls right after the receipt RPC committed:
--   * the transaction must be COMPLETED and carry a final-receipt row completed by the named receiver (nothing else can be recorded);
--   * identical content (same SHA-256) is returned as the existing version (idempotent);
--   * otherwise the previous current version is superseded -- never overwritten or deleted -- and a new version becomes current;
--   * the action is audited with the receiver as the actor.
-- The receiving officer can already download the result: can_download_caterlink_pdf() admits the officer who completed the hub step.

create or replace function public.record_caterlink_receipt_pdf_version(
  p_transaction_id uuid,
  p_storage_path text,
  p_content_hash text,
  p_size_bytes integer,
  p_receiver uuid
)
returns table (id uuid, version integer, is_new boolean)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_tx record;
  v_existing record;
  v_next integer;
  v_new_id uuid;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the server may record a post-receipt PDF version.';
  end if;
  select * into v_tx from public.transactions t where t.id = p_transaction_id for update;
  if v_tx is null or v_tx.status <> 'COMPLETED' then
    raise exception 'A final PDF may only be recorded for a COMPLETED transaction.';
  end if;
  if not exists (select 1 from public.caterlink_checkpoint_hub h where h.transaction_id = p_transaction_id and h.completed_by = p_receiver) then
    raise exception 'No final receipt by this officer exists for the transaction.';
  end if;
  if p_size_bytes is null or p_size_bytes <= 0 or p_size_bytes > 20000000 or p_content_hash is null or length(p_content_hash) <> 64 then
    raise exception 'Invalid PDF metadata.';
  end if;

  select * into v_existing from public.caterlink_transaction_pdfs p where p.transaction_id = p_transaction_id and p.content_hash = p_content_hash;
  if v_existing is not null then
    return query select v_existing.id, v_existing.version, false;
    return;
  end if;

  select coalesce(max(p.version), 0) + 1 into v_next from public.caterlink_transaction_pdfs p where p.transaction_id = p_transaction_id;
  update public.caterlink_transaction_pdfs set is_current = false where transaction_id = p_transaction_id and is_current = true;
  insert into public.caterlink_transaction_pdfs (transaction_id, version, storage_path, content_hash, size_bytes, mime_type, is_current, generated_by)
  values (p_transaction_id, v_next, p_storage_path, p_content_hash, p_size_bytes, 'application/pdf', true, p_receiver)
  returning caterlink_transaction_pdfs.id into v_new_id;

  insert into public.phase8_audit_log (actor_id, action, entity_type, entity_id, detail)
  values (p_receiver, 'caterlink_pdf_generated_after_receipt', 'transaction_pdf', p_transaction_id,
          jsonb_build_object('transaction_number', v_tx.transaction_number, 'version', v_next));

  return query select v_new_id, v_next, true;
end;
$function$;
revoke execute on function public.record_caterlink_receipt_pdf_version(uuid, text, text, integer, uuid) from public, anon, authenticated;
grant execute on function public.record_caterlink_receipt_pdf_version(uuid, text, text, integer, uuid) to service_role;
