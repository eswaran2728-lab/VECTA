-- Upgrade 5: one-way, read-only mirror of every submitted report into Google Sheets.
-- Flow: report insert -> AFTER INSERT trigger enqueues a row here -> pg_cron calls the
-- sheets-sync Edge Function every 2 minutes -> it claims up to 50 pending rows, POSTs them
-- (batched) to a Google Apps Script Web App, and marks each sent/failed. Nothing here ever
-- reads back from Sheets — Sheets is a mirror, never a source of truth.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Singleton config row Admin edits from /admin/sheet-sync — kept in the DB (not a migration
-- constant) so the Apps Script Web App URL and shared secret can be set up and rotated
-- without a new deploy. The same secret authenticates both legs: pg_cron -> Edge Function,
-- and Edge Function -> Apps Script.
create table sheet_sync_config (
  id boolean primary key default true check (id),
  webhook_url text,
  webhook_secret text,
  enabled boolean not null default false,
  updated_at timestamptz not null default now()
);
insert into sheet_sync_config (id) values (true);

alter table sheet_sync_config enable row level security;
create policy "sheet sync config admin all" on sheet_sync_config for all
  using (current_role_name() = 'ADMIN')
  with check (current_role_name() = 'ADMIN');

create table sheet_sync_queue (
  id uuid primary key default gen_random_uuid(),
  report_type text not null,
  report_id uuid not null,
  report_no text,
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  attempts int not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

create index sheet_sync_queue_status_idx on sheet_sync_queue (status, created_at);

alter table sheet_sync_queue enable row level security;
create policy "sheet sync queue admin select" on sheet_sync_queue for select
  using (current_role_name() = 'ADMIN');
create policy "sheet sync queue admin update" on sheet_sync_queue for update
  using (current_role_name() = 'ADMIN')
  with check (current_role_name() = 'ADMIN');
-- No insert policy for `authenticated` — every row is written by the trigger below, which
-- runs as the (RLS-bypassing) function owner, same as report_counters / enforcement_search_log.

-- One shared trigger function for all 7 report tables — the report_type is passed as a
-- trigger argument so this doesn't need to be duplicated per table.
create or replace function enqueue_sheet_sync()
returns trigger as $$
begin
  insert into sheet_sync_queue (report_type, report_id, report_no)
  values (TG_ARGV[0], new.id, new.report_no);
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger trg_enqueue_sheet_sync after insert on report_sec016
  for each row execute function enqueue_sheet_sync('sec016');
create trigger trg_enqueue_sheet_sync after insert on report_sec014
  for each row execute function enqueue_sheet_sync('sec014');
create trigger trg_enqueue_sheet_sync after insert on report_sec029
  for each row execute function enqueue_sheet_sync('sec029');
create trigger trg_enqueue_sheet_sync after insert on report_sec018
  for each row execute function enqueue_sheet_sync('sec018');
create trigger trg_enqueue_sheet_sync after insert on report_sec033
  for each row execute function enqueue_sheet_sync('sec033');
create trigger trg_enqueue_sheet_sync after insert on report_sec013
  for each row execute function enqueue_sheet_sync('sec013');
create trigger trg_enqueue_sheet_sync after insert on offload_records
  for each row execute function enqueue_sheet_sync('offload');

-- pg_cron only runs SQL, so the scheduled job calls this tiny wrapper, which reads the
-- webhook secret from config and fires an async HTTP POST (via pg_net) at the Edge
-- Function — the Edge Function does all the real work (claiming rows, calling Apps Script,
-- marking sent/failed). A no-op when sync is disabled or unconfigured.
create or replace function trigger_sheets_sync()
returns void as $$
declare
  cfg record;
  fn_url text;
begin
  select * into cfg from sheet_sync_config where id = true;
  if cfg is null or not cfg.enabled or cfg.webhook_secret is null or cfg.webhook_secret = '' then
    return;
  end if;

  fn_url := 'https://ddlctzbnqewubltcavkh.supabase.co/functions/v1/sheets-sync';

  perform net.http_post(
    url := fn_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'X-Sync-Secret', cfg.webhook_secret),
    body := '{}'::jsonb
  );
end;
$$ language plpgsql security definer set search_path = public;

select cron.schedule('sheets-sync-every-2-min', '*/2 * * * *', 'select trigger_sheets_sync();');
