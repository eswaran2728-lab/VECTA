-- ============================================================
-- ICMS Phase 4: Admin role rename (display-label only — the DB
-- role value stays 'supervisor', see ROLE_LABELS in the app) +
-- weekly export/reset via an archive flag. Incremental only:
-- no tables dropped, no rows ever deleted.
-- ============================================================

alter table public.transactions
  add column if not exists archived boolean not null default false,
  add column if not exists archived_at timestamptz;

create index if not exists idx_transactions_archived on public.transactions (archived);

-- ------------------------------------------------------------
-- Archiving must be allowed on COMPLETED/ESCALATED transactions
-- (that's the whole point — a week's finished work gets archived)
-- without loosening the existing "completed records are immutable"
-- protection for every OTHER field. This carves out exactly one
-- exception: a change touching ONLY archived/archived_at passes;
-- anything else keeps going through the original checks.
-- ------------------------------------------------------------
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

-- ------------------------------------------------------------
-- Bulk archive: every not-yet-archived transaction becomes archived.
-- Nothing is deleted; status/completed_at/parts/signatures/seals are
-- all left exactly as they are — archived is purely a reporting flag
-- that the dashboard and transaction list filter on.
-- ------------------------------------------------------------
create or replace function public.archive_all_pending(p_reason text default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  if public.current_user_role() <> 'supervisor' then
    raise exception 'ICMS: only an admin may export & reset / Hanya admin boleh eksport & tetapkan semula';
  end if;

  update transactions
  set archived = true, archived_at = now()
  where archived = false;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke execute on function public.archive_all_pending(text) from public, anon;
grant execute on function public.archive_all_pending(text) to authenticated;
