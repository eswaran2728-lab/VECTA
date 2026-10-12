-- Durable post-receipt PDF generation (additive; no existing function is replaced).
--
-- A BKI / KCH final receipt completes the movement, and the completed form must then be rendered into an authoritative, immutable PDF
-- version. Rendering and Storage happen outside the database, so they can fail after the receipt has committed. This migration records
-- the obligation ATOMICALLY with the completion and makes it recoverable:
--   * caterlink_pdf_jobs: one row per (transaction, receipt, source version); the idempotency key is unique, so a receipt can never
--     produce two jobs. Holds only status, attempt count, an error CATEGORY (never a message, URL or secret) and timestamps.
--   * trigger on transactions: when a movement becomes COMPLETED and its receipt row is a KCH / BKI final receipt, the job is inserted in
--     the SAME transaction as the receipt RPC. PEN / JHB / NILAI completion is untouched.
--   * service-role worker functions: claim (skip-locked, stale-lock reclaim), complete (records the version through
--     record_caterlink_receipt_pdf_version at most once per job; repeated calls return the existing version), fail (retryable with
--     exponential back-off, permanent after 6 attempts).
--   * authorised manual retry (CaterLink Management of the transaction's AOC only) and a management listing.
-- Previous PDF versions are never modified or deleted: only the recorder supersedes, as before.

create table if not exists public.caterlink_pdf_jobs (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references public.transactions(id) on delete cascade,
  receipt_id uuid not null references public.caterlink_checkpoint_hub(id) on delete cascade,
  source_version integer not null default 1 check (source_version >= 1),
  receiver uuid not null references public.profiles(id),
  idempotency_key text not null,
  status text not null default 'pending' check (status in ('pending', 'processing', 'failed_retryable', 'failed_permanent', 'succeeded')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  manual_retry_count integer not null default 0,
  last_error_category text check (last_error_category in ('render', 'storage', 'record', 'not_ready', 'unknown')),
  next_retry_at timestamptz not null default now(),
  locked_at timestamptz,
  pdf_id uuid references public.caterlink_transaction_pdfs(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint caterlink_pdf_jobs_idempotency_key_key unique (idempotency_key),
  constraint caterlink_pdf_jobs_succeeded_has_pdf check (status <> 'succeeded' or pdf_id is not null)
);
create index if not exists idx_caterlink_pdf_jobs_open on public.caterlink_pdf_jobs (status, next_retry_at) where status <> 'succeeded';
create index if not exists idx_caterlink_pdf_jobs_tx on public.caterlink_pdf_jobs (transaction_id);

alter table public.caterlink_pdf_jobs enable row level security;
revoke all on public.caterlink_pdf_jobs from public, anon, authenticated;
grant all on public.caterlink_pdf_jobs to service_role;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- Atomic creation with the receipt completion
-- ---------------------------------------------------------------------------------------------------------------------------------
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
    where h.transaction_id = new.id and h.confirmed_destination in ('KCH', 'BKI');
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

drop trigger if exists trg_enqueue_caterlink_receipt_pdf_job on public.transactions;
create trigger trg_enqueue_caterlink_receipt_pdf_job
  after update of status on public.transactions
  for each row execute function public.enqueue_caterlink_receipt_pdf_job();

-- ---------------------------------------------------------------------------------------------------------------------------------
-- Service-role worker
-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.claim_caterlink_pdf_jobs(p_limit integer default 5, p_transaction_id uuid default null)
returns table (job_id uuid, transaction_id uuid, receiver uuid, attempt_count integer)
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the server may claim PDF jobs.';
  end if;
  return query
  update public.caterlink_pdf_jobs j
  set status = 'processing', attempt_count = j.attempt_count + 1, locked_at = now(), updated_at = now()
  where j.id in (
    select c.id from public.caterlink_pdf_jobs c
    where ((c.status in ('pending', 'failed_retryable') and c.next_retry_at <= now())
        or (c.status = 'processing' and c.locked_at < now() - interval '10 minutes'))
      and (p_transaction_id is null or c.transaction_id = p_transaction_id)
    order by c.next_retry_at
    limit greatest(1, least(coalesce(p_limit, 5), 25))
    for update skip locked
  )
  returning j.id, j.transaction_id, j.receiver, j.attempt_count;
end;
$function$;
revoke execute on function public.claim_caterlink_pdf_jobs(integer, uuid) from public, anon, authenticated;
grant execute on function public.claim_caterlink_pdf_jobs(integer, uuid) to service_role;

create or replace function public.complete_caterlink_pdf_job(p_job_id uuid, p_storage_path text, p_content_hash text, p_size_bytes integer)
returns table (pdf_id uuid, version integer, is_new boolean)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_job record;
  v_rec record;
  v_pdf record;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the server may complete PDF jobs.';
  end if;
  select * into v_job from public.caterlink_pdf_jobs j where j.id = p_job_id for update;
  if v_job is null then raise exception 'PDF job not found.'; end if;

  -- One authoritative version per receipt: a finished job always answers with its existing version, whatever bytes were re-rendered.
  if v_job.status = 'succeeded' then
    select p.id, p.version into v_pdf from public.caterlink_transaction_pdfs p where p.id = v_job.pdf_id;
    return query select v_pdf.id, v_pdf.version, false;
    return;
  end if;
  if v_job.status <> 'processing' then raise exception 'PDF job is not being processed.'; end if;

  select * into v_rec from public.record_caterlink_receipt_pdf_version(v_job.transaction_id, p_storage_path, p_content_hash, p_size_bytes, v_job.receiver);

  update public.caterlink_pdf_jobs
  set status = 'succeeded', pdf_id = v_rec.id, completed_at = now(), updated_at = now(), locked_at = null, last_error_category = null
  where id = p_job_id;

  insert into public.phase8_audit_log (actor_id, action, entity_type, entity_id, detail)
  values (v_job.receiver, 'caterlink_pdf_job_succeeded', 'transaction_pdf', v_job.transaction_id,
          jsonb_build_object('job_id', p_job_id, 'version', v_rec.version, 'attempts', v_job.attempt_count));

  return query select v_rec.id, v_rec.version, v_rec.is_new;
end;
$function$;
revoke execute on function public.complete_caterlink_pdf_job(uuid, text, text, integer) from public, anon, authenticated;
grant execute on function public.complete_caterlink_pdf_job(uuid, text, text, integer) to service_role;

create or replace function public.fail_caterlink_pdf_job(p_job_id uuid, p_category text)
returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_job record;
  v_status text;
  v_cat text := case when p_category in ('render', 'storage', 'record', 'not_ready') then p_category else 'unknown' end;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the server may fail PDF jobs.';
  end if;
  select * into v_job from public.caterlink_pdf_jobs j where j.id = p_job_id for update;
  if v_job is null then raise exception 'PDF job not found.'; end if;
  if v_job.status <> 'processing' then return v_job.status; end if;  -- a finished or already-failed job is never overwritten
  v_status := case when v_job.attempt_count >= 6 then 'failed_permanent' else 'failed_retryable' end;
  update public.caterlink_pdf_jobs
  set status = v_status, last_error_category = v_cat, locked_at = null, updated_at = now(),
      next_retry_at = now() + least(power(2, v_job.attempt_count)::integer * interval '1 minute', interval '60 minutes')
  where id = p_job_id;
  return v_status;
end;
$function$;
revoke execute on function public.fail_caterlink_pdf_job(uuid, text) from public, anon, authenticated;
grant execute on function public.fail_caterlink_pdf_job(uuid, text) to service_role;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- Authorised surface: CaterLink Management of the transaction's AOC only
-- ---------------------------------------------------------------------------------------------------------------------------------
create or replace function public.retry_caterlink_pdf_job_secure(p_job_id uuid)
returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_job record;
  v_aoc uuid;
begin
  if auth.uid() is null then raise exception 'Must be signed in.'; end if;
  select * into v_job from public.caterlink_pdf_jobs j where j.id = p_job_id for update;
  select t.aoc_id into v_aoc from public.transactions t where t.id = v_job.transaction_id;
  -- one uniform answer for: unknown job, other AOC, not management
  if v_job is null or not public.has_active_role_for_aoc('caterlink_management', v_aoc) then
    raise exception 'PDF job not available.';
  end if;
  if v_job.status not in ('failed_retryable', 'failed_permanent') then
    raise exception 'Only a failed PDF job can be retried (current: %).', v_job.status;
  end if;
  update public.caterlink_pdf_jobs
  set status = 'pending', next_retry_at = now(), manual_retry_count = manual_retry_count + 1, updated_at = now()
  where id = p_job_id;
  perform public.phase8_write_audit('caterlink_pdf_job_manual_retry', 'transaction_pdf', v_job.transaction_id, jsonb_build_object('job_id', p_job_id));
  return 'pending';
end;
$function$;
revoke execute on function public.retry_caterlink_pdf_job_secure(uuid) from public, anon;
grant execute on function public.retry_caterlink_pdf_job_secure(uuid) to authenticated, service_role;

create or replace function public.list_caterlink_pdf_jobs_secure(p_only_open boolean default true)
returns table (job_id uuid, transaction_id uuid, transaction_number text, status text, attempt_count integer, last_error_category text,
               next_retry_at timestamptz, created_at timestamptz, updated_at timestamptz, completed_at timestamptz, pdf_version integer)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
begin
  if auth.uid() is null then raise exception 'Must be signed in.'; end if;
  return query
  select j.id, j.transaction_id, t.transaction_number, j.status, j.attempt_count, j.last_error_category,
         j.next_retry_at, j.created_at, j.updated_at, j.completed_at, p.version
  from public.caterlink_pdf_jobs j
  join public.transactions t on t.id = j.transaction_id
  left join public.caterlink_transaction_pdfs p on p.id = j.pdf_id
  where public.has_active_role_for_aoc('caterlink_management', t.aoc_id)
    and (not coalesce(p_only_open, true) or j.status <> 'succeeded')
  order by j.created_at desc
  limit 200;
end;
$function$;
revoke execute on function public.list_caterlink_pdf_jobs_secure(boolean) from public, anon;
grant execute on function public.list_caterlink_pdf_jobs_secure(boolean) to authenticated, service_role;

-- The receiving officer's own view of "is my final PDF ready?": only an authoritative version counts as ready.
create or replace function public.get_caterlink_pdf_state_secure(p_transaction_id uuid)
returns table (state text, version integer)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
begin
  if auth.uid() is null then raise exception 'Must be signed in.'; end if;
  if not public.can_download_caterlink_pdf(p_transaction_id) then raise exception 'Unauthorized to access the final PDF for this transaction.'; end if;
  return query
  select case when j.status = 'succeeded' then 'ready'
              when j.status in ('failed_retryable', 'failed_permanent') then 'failed'
              else 'pending' end,
         p.version
  from public.caterlink_pdf_jobs j
  left join public.caterlink_transaction_pdfs p on p.id = j.pdf_id
  where j.transaction_id = p_transaction_id
  order by j.created_at desc
  limit 1;
end;
$function$;
revoke execute on function public.get_caterlink_pdf_state_secure(uuid) from public, anon;
grant execute on function public.get_caterlink_pdf_state_secure(uuid) to authenticated, service_role;
