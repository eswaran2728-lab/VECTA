-- A completed receipt at any supported HUB destination owes one durable PDF.
-- Replaces only the enqueue trigger function; the existing trigger and worker remain intact.
set local lock_timeout = '5s';

create or replace function public.enqueue_caterlink_receipt_pdf_job()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_hub record;
begin
  if new.status = 'COMPLETED' and old.status is distinct from 'COMPLETED' then
    select h.id, h.completed_by, h.confirmed_destination into v_hub
    from public.caterlink_checkpoint_hub h
    where h.transaction_id = new.id
      and h.confirmed_destination in ('PEN', 'JHB', 'NILAI', 'KCH', 'BKI');
    if v_hub.id is not null then
      insert into public.caterlink_pdf_jobs (transaction_id, receipt_id, source_version, receiver, idempotency_key)
      values (new.id, v_hub.id, 1, v_hub.completed_by, new.id::text || ':' || v_hub.id::text || ':1')
      on conflict on constraint caterlink_pdf_jobs_idempotency_key_key do nothing;
    end if;
  end if;
  return new;
end;
$function$;

revoke execute on function public.enqueue_caterlink_receipt_pdf_job() from public, anon, authenticated;
