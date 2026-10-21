-- Restore only the compatibility fields still written by the current duty
-- actions. ops_group remains nullable and is not an authorization source.
alter table public.duty_records add column if not exists ops_group text;
alter table public.overtime_requests add column if not exists ops_group text;

alter table public.overtime_requests
  add column if not exists actual_check_in timestamptz,
  add column if not exists actual_check_out timestamptz,
  add column if not exists scheduled_start timestamptz,
  add column if not exists scheduled_end timestamptz,
  add column if not exists calculated_at timestamptz not null default now();

alter table public.overtime_requests
  drop constraint if exists overtime_requests_category_check;
alter table public.overtime_requests
  add constraint overtime_requests_category_check
  check (category = any (array[
    'flight_delay', 'manpower_shortage', 'event', 'off_day_work', 'adhoc',
    'early_arrival', 'late_departure'
  ]::text[]));

-- A plain unique index is required for PostgREST's
-- onConflict: "linked_duty_id,category" upsert contract.
create unique index if not exists overtime_requests_duty_category_uniq
  on public.overtime_requests (linked_duty_id, category);
