-- ============================================================
-- CSCS v2 - PHASE 6: Audit + immutability hardening
-- (Write-once part tables, completed-transaction freeze and
--  insert-only audit_logs already exist since v1; this adds
--  device/IP capture and signature integrity hashes.)
-- ============================================================

alter table public.audit_logs
  add column if not exists device_info text,
  add column if not exists ip_address inet;

-- Helper: pull user-agent / client IP out of the PostgREST request
-- headers GUC (present for all API-originated writes; null otherwise).
create or replace function public.request_device_info()
returns text
language plpgsql
stable
as $$
declare
  v_headers json;
begin
  v_headers := nullif(current_setting('request.headers', true), '')::json;
  return left(v_headers ->> 'user-agent', 300);
exception when others then
  return null;
end;
$$;

create or replace function public.request_ip()
returns inet
language plpgsql
stable
as $$
declare
  v_headers json;
begin
  v_headers := nullif(current_setting('request.headers', true), '')::json;
  return split_part(v_headers ->> 'x-forwarded-for', ',', 1)::inet;
exception when others then
  return null;
end;
$$;

-- Re-create the audit writers to capture who / what / when / before /
-- after / device / IP on every state change.
create or replace function public.log_audit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_id uuid := auth.uid();
  v_actor text;
  v_tx uuid;
begin
  select name into v_actor from users where id = v_actor_id;
  if v_actor is null then
    v_actor := 'system';
  end if;

  if tg_table_name = 'transactions' then
    v_tx := coalesce(new.id, old.id);
  else
    v_tx := coalesce(new.transaction_id, old.transaction_id);
  end if;

  insert into audit_logs (
    transaction_id, action, performed_by, performed_by_id,
    old_values, new_values, device_info, ip_address
  )
  values (
    v_tx,
    tg_table_name || '.' || lower(tg_op),
    v_actor,
    v_actor_id,
    case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end,
    case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end,
    public.request_device_info(),
    public.request_ip()
  );

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create or replace function public.log_audit_admin()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_id uuid := auth.uid();
  v_actor text;
begin
  select name into v_actor from users where id = v_actor_id;
  insert into audit_logs (
    transaction_id, action, performed_by, performed_by_id,
    old_values, new_values, device_info, ip_address
  )
  values (
    null,
    tg_table_name || '.' || lower(tg_op),
    coalesce(v_actor, 'system'),
    v_actor_id,
    case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end,
    case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end,
    public.request_device_info(),
    public.request_ip()
  );
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

-- Signature integrity: SHA-256 of the signature PNG, computed at upload.
alter table public.part_a add column if not exists signature_hash text;
alter table public.part_b add column if not exists signature_hash text;
alter table public.part_c add column if not exists signature_hash text;
alter table public.part_d add column if not exists signature_hash text;

-- Part records stay write-once, with exactly one permitted change:
-- backfilling a NULL signature_hash (integrity hash for pre-Phase-6 rows).
-- Every business field remains physically immutable; DELETE stays blocked.
create or replace function public.guard_part_update()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'CSCS: % records are immutable (DELETE blocked)', tg_table_name;
  end if;
  if old.signature_hash is null
     and new.signature_hash is not null
     and (to_jsonb(new) - 'signature_hash') = (to_jsonb(old) - 'signature_hash') then
    return new;
  end if;
  raise exception 'CSCS: % records are immutable (UPDATE blocked)', tg_table_name;
end;
$$;

drop trigger if exists trg_part_a_immutable on public.part_a;
drop trigger if exists trg_part_b_immutable on public.part_b;
drop trigger if exists trg_part_c_immutable on public.part_c;
drop trigger if exists trg_part_d_immutable on public.part_d;

create trigger trg_part_a_immutable
  before update or delete on public.part_a
  for each row execute function public.guard_part_update();

create trigger trg_part_b_immutable
  before update or delete on public.part_b
  for each row execute function public.guard_part_update();

create trigger trg_part_c_immutable
  before update or delete on public.part_c
  for each row execute function public.guard_part_update();

create trigger trg_part_d_immutable
  before update or delete on public.part_d
  for each row execute function public.guard_part_update();
