-- Upgrade 2: optional photo/PDF attachments on all 6 report forms.
-- Storage-backed (private bucket, signed URLs only), never mandatory, offline-capable
-- (client queues compressed blobs in IndexedDB and uploads after the report itself syncs).

create table report_attachments (
  id uuid primary key default gen_random_uuid(),
  report_type text not null check (report_type in ('sec016', 'sec014', 'sec029', 'sec018', 'sec033', 'sec013')),
  report_id uuid not null,
  storage_path text not null unique,
  file_name text not null,
  mime_type text not null,
  size_bytes integer not null,
  uploaded_by uuid not null references profiles (id),
  created_at timestamptz not null default now()
);

create index idx_report_attachments_lookup on report_attachments (report_type, report_id);

alter table report_attachments enable row level security;

-- Reuses the same submitter lookup already backing report_acknowledgements (0012/0013/0014),
-- and mirrors the exact rank + station/team visibility rule from the report tables' own
-- "rank select" policies — an attachment is visible to whoever can already see its report.
create or replace function can_view_report(p_report_type text, p_report_id uuid)
returns boolean as $$
declare
  sub record;
begin
  select * into sub from get_report_submitter(p_report_type, p_report_id);
  if sub is null then
    return false;
  end if;

  return sub.profile_id = auth.uid()
    or (
      current_role_rank() > submitter_role_rank(sub.profile_id)
      and (
        current_role_rank() >= role_rank('ENFORCEMENT')
        or (sub.station = current_station() and coalesce(sub.team, '') = coalesce(current_team(), ''))
      )
    );
end;
$$ language plpgsql stable security definer set search_path = public;

create policy "attachments select" on report_attachments for select
  using (can_view_report(report_type, report_id));

-- Only the report's own submitter can attach files to it, and only while a row for that
-- report actually exists (get_report_submitter returns null for a bogus/foreign id).
create policy "attachments insert" on report_attachments for insert
  with check (
    uploaded_by = auth.uid()
    and exists (
      select 1 from get_report_submitter(report_type, report_id) sub where sub.profile_id = auth.uid()
    )
  );

-- No update/delete policies: attachments are immutable once uploaded, same "no edit, only
-- amendment" philosophy already enforced on the report rows themselves.

-- Private bucket — every read goes through a short-lived signed URL, never a public one.
insert into storage.buckets (id, name, public)
values ('report-attachments', 'report-attachments', false)
on conflict (id) do nothing;

-- Object path convention: "<report_type>/<report_id>/<uuid>-<filename>", so
-- storage.foldername(name) = {report_type, report_id} and the same can_view_report /
-- get_report_submitter checks apply directly to storage.objects.
create policy "report attachments object select" on storage.objects for select
  using (
    bucket_id = 'report-attachments'
    and can_view_report((storage.foldername(name))[1], nullif((storage.foldername(name))[2], '')::uuid)
  );

create policy "report attachments object insert" on storage.objects for insert
  with check (
    bucket_id = 'report-attachments'
    and exists (
      select 1 from get_report_submitter((storage.foldername(name))[1], nullif((storage.foldername(name))[2], '')::uuid) sub
      where sub.profile_id = auth.uid()
    )
  );
