-- ============================================================
-- ICMS: auto-generated completed-form PDF, saved for admin reference.
-- When a transaction finishes (Part D pass, Part D skip, or the inbound
-- final Part B), the server generates a filled IFCSF-style PDF and
-- writes its storage path back onto the transaction in the same
-- request. Extends guard_transaction_update() with a narrow carve-out
-- (mirrors the archived/archived_at exception) so that one write is
-- allowed even though the row is already COMPLETED — nothing else about
-- a completed record can change. Incremental only.
-- ============================================================

alter table public.transactions
  add column if not exists completed_form_url text;

create or replace function public.guard_transaction_update()
returns trigger
language plpgsql
as $$
begin
  if new.archived is distinct from old.archived
     or new.archived_at is distinct from old.archived_at then
    if new.status <> old.status
       or new.transaction_number <> old.transaction_number
       or new.created_by <> old.created_by
       or new.created_at <> old.created_at
       or new.completed_at is distinct from old.completed_at then
      raise exception 'ICMS: archiving cannot change any other field';
    end if;
    return new;
  end if;

  if new.completed_form_url is distinct from old.completed_form_url then
    if new.status <> old.status
       or new.transaction_number <> old.transaction_number
       or new.created_by <> old.created_by
       or new.created_at <> old.created_at
       or new.completed_at is distinct from old.completed_at then
      raise exception 'ICMS: setting the completed form cannot change any other field';
    end if;
    return new;
  end if;

  if old.status = 'COMPLETED' and new.status <> 'ESCALATED' then
    raise exception 'ICMS: completed transactions cannot be modified';
  end if;
  if old.status = 'ESCALATED' and new.status <> old.status then
    raise exception 'ICMS: escalated transactions are frozen pending admin review';
  end if;
  if new.transaction_number <> old.transaction_number
     or new.created_by <> old.created_by
     or new.created_at <> old.created_at then
    raise exception 'ICMS: transaction identity fields are immutable';
  end if;
  return new;
end;
$$;

insert into storage.buckets (id, name, public)
values ('completed-forms', 'completed-forms', false)
on conflict (id) do nothing;

create policy "completed forms: authenticated upload"
  on storage.objects for insert
  with check (bucket_id = 'completed-forms' and auth.role() = 'authenticated');

create policy "completed forms: authenticated read"
  on storage.objects for select
  using (bucket_id = 'completed-forms' and auth.role() = 'authenticated');
