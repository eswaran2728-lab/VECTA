-- CSCS Phase 1.5: role handoff metadata and paper-form verification fields.
-- Incremental only: no tables or existing records are removed.

alter table public.transactions
  add column if not exists current_stage text,
  add column if not exists lifecycle_status text generated always as (
    case
      when status = 'COMPLETED' then 'completed'
      when status = 'ESCALATED' then 'escalated'
      else 'pending'
    end
  ) stored,
  add column if not exists escalation_reason text;

alter table public.transactions
  drop constraint if exists transactions_current_stage_check;

alter table public.transactions
  add constraint transactions_current_stage_check
  check (current_stage in ('A', 'B', 'C', 'D'));

create or replace function public.sync_transaction_stage()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.current_stage := case
    when new.status = 'CREATED' and new.direction = 'OUTBOUND' then 'B'
    when new.status = 'CREATED' and new.direction = 'INBOUND' then 'C'
    when new.status = 'INFLIGHT_POST_APPROVED' then 'C'
    when new.status = 'AIRPORT_POST_APPROVED' and new.direction = 'OUTBOUND' then 'D'
    when new.status = 'AIRPORT_POST_APPROVED' and new.direction = 'INBOUND' then 'B'
    when new.status = 'COMPLETED' and new.direction = 'OUTBOUND' then 'D'
    when new.status = 'COMPLETED' and new.direction = 'INBOUND' then 'B'
    else coalesce(old.current_stage, 'A')
  end;
  return new;
end;
$$;

drop trigger if exists trg_sync_transaction_stage on public.transactions;
create trigger trg_sync_transaction_stage
  before insert or update of status, direction on public.transactions
  for each row execute function public.sync_transaction_stage();

do $$
declare trigger_name text;
begin
  foreach trigger_name in array array[
    'trg_guard_transaction_update',
    'trg_transactions_touch',
    'trg_audit_transactions'
  ] loop
    if exists (
      select 1 from pg_trigger
      where tgrelid = 'public.transactions'::regclass
        and tgname = trigger_name
        and not tgisinternal
    ) then
      execute format('alter table public.transactions disable trigger %I', trigger_name);
    end if;
  end loop;
end $$;

update public.transactions
set current_stage = case
  when status = 'CREATED' and direction = 'OUTBOUND' then 'B'
  when status = 'CREATED' and direction = 'INBOUND' then 'C'
  when status = 'INFLIGHT_POST_APPROVED' then 'C'
  when status = 'AIRPORT_POST_APPROVED' and direction = 'OUTBOUND' then 'D'
  when status = 'AIRPORT_POST_APPROVED' and direction = 'INBOUND' then 'B'
  when status = 'COMPLETED' and direction = 'OUTBOUND' then 'D'
  when status = 'COMPLETED' and direction = 'INBOUND' then 'B'
  else coalesce(current_stage, 'A')
end;

do $$
declare trigger_name text;
begin
  foreach trigger_name in array array[
    'trg_guard_transaction_update',
    'trg_transactions_touch',
    'trg_audit_transactions'
  ] loop
    if exists (
      select 1 from pg_trigger
      where tgrelid = 'public.transactions'::regclass
        and tgname = trigger_name
        and not tgisinternal
    ) then
      execute format('alter table public.transactions enable trigger %I', trigger_name);
    end if;
  end loop;
end $$;

alter table public.transactions alter column current_stage set not null;

alter table public.part_b
  add column if not exists checkpoint_date date not null default ((now() at time zone 'Asia/Kuala_Lumpur')::date),
  add column if not exists checkpoint_time time not null default ((now() at time zone 'Asia/Kuala_Lumpur')::time),
  add column if not exists observed_vehicle_number text,
  add column if not exists observed_driver_name text,
  add column if not exists observed_driver_id text,
  add column if not exists result text not null default 'PASS',
  add column if not exists escalation_reason text;

alter table public.part_c
  add column if not exists checkpoint_date date not null default ((now() at time zone 'Asia/Kuala_Lumpur')::date),
  add column if not exists checkpoint_time time not null default ((now() at time zone 'Asia/Kuala_Lumpur')::time),
  add column if not exists observed_vehicle_number text,
  add column if not exists observed_driver_name text,
  add column if not exists observed_driver_id text,
  add column if not exists result text not null default 'PASS',
  add column if not exists escalation_reason text;

alter table public.part_d
  add column if not exists checkpoint_date date not null default ((now() at time zone 'Asia/Kuala_Lumpur')::date),
  add column if not exists checkpoint_time time not null default ((now() at time zone 'Asia/Kuala_Lumpur')::time),
  add column if not exists result text not null default 'PASS',
  add column if not exists escalation_reason text;

alter table public.part_b drop constraint if exists part_b_result_check;
alter table public.part_b add constraint part_b_result_check check (result in ('PASS', 'ESCALATE'));
alter table public.part_c drop constraint if exists part_c_result_check;
alter table public.part_c add constraint part_c_result_check check (result in ('PASS', 'ESCALATE'));
alter table public.part_d drop constraint if exists part_d_result_check;
alter table public.part_d add constraint part_d_result_check check (result in ('PASS', 'ESCALATE'));

create or replace function public.escalate_on_incident()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update transactions
  set status = 'ESCALATED', escalation_reason = new.description
  where id = new.transaction_id;
  return new;
end;
$$;

revoke execute on function public.sync_transaction_stage() from public, anon, authenticated;
