-- Generic server-side draft storage (one draft per user per report type per in-progress form).
-- Keeps the rigid report_sec0xx tables free of partially-valid data; drafts hold raw,
-- unvalidated form state as JSON and are deleted once the report is actually submitted.

create table if not exists report_drafts (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles (id) on delete cascade,
  report_type text not null check (report_type in ('sec016', 'sec014', 'sec029', 'sec018')),
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  unique (profile_id, report_type)
);

alter table report_drafts enable row level security;

create policy "report_drafts owner all" on report_drafts for all
  using (profile_id = auth.uid())
  with check (profile_id = auth.uid());

create trigger report_drafts_set_updated_at before update on report_drafts
  for each row execute function set_updated_at();
