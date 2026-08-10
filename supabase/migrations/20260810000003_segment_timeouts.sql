-- ============================================================
-- ICMS: per-segment checkpoint time limits, replacing the flat
-- 4-hour cscs_settings.timeout_hours window with direction-aware,
-- per-segment SLAs. cscs_settings.timeout_hours is left in place
-- (harmless, unread) rather than dropped — nothing else references it.
--
-- Clock: the spec frames this as "the updated_at timestamp of the
-- status transition", but public.transactions.updated_at is bumped by
-- trg_transactions_touch on ANY update — including ones unrelated to
-- status, like the weekly archive flag or linking the completed-form
-- PDF. Reusing updated_at directly would silently reset a transaction's
-- SLA clock the moment archive_all_pending() touches it. Instead this
-- adds a dedicated status_entered_at column, touched only when the
-- UPDATE actually sets status, so the segment clock reflects exactly
-- what the spec intends without inheriting that footgun.
-- ============================================================

alter table public.transactions
  add column if not exists status_entered_at timestamptz not null default now();

create or replace function public.touch_status_entered_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.status_entered_at := now();
  return new;
end;
$$;

drop trigger if exists trg_touch_status_entered_at on public.transactions;
create trigger trg_touch_status_entered_at
  before update of status on public.transactions
  for each row execute function public.touch_status_entered_at();

revoke execute on function public.touch_status_entered_at() from public, anon, authenticated;

-- ------------------------------------------------------------
-- Config table: one row per (direction, from_status) segment. A null
-- limit_minutes means "no limit" (Post 6 -> Receiver on outbound has
-- none per spec) — escalate_timeouts() skips those rows outright.
-- ------------------------------------------------------------
create table public.segment_timeouts (
  id uuid primary key default gen_random_uuid(),
  direction text not null check (direction in ('OUTBOUND', 'INBOUND')),
  from_status text not null check (from_status in ('CREATED', 'INFLIGHT_POST_APPROVED', 'AIRPORT_POST_APPROVED')),
  to_status text not null check (to_status in ('INFLIGHT_POST_APPROVED', 'AIRPORT_POST_APPROVED', 'COMPLETED')),
  limit_minutes integer,
  created_at timestamptz not null default now(),
  unique (direction, from_status)
);

insert into public.segment_timeouts (direction, from_status, to_status, limit_minutes) values
  ('OUTBOUND', 'CREATED', 'INFLIGHT_POST_APPROVED', 30),
  ('OUTBOUND', 'INFLIGHT_POST_APPROVED', 'AIRPORT_POST_APPROVED', 45),
  ('OUTBOUND', 'AIRPORT_POST_APPROVED', 'COMPLETED', null),
  ('INBOUND', 'CREATED', 'AIRPORT_POST_APPROVED', 30),
  ('INBOUND', 'AIRPORT_POST_APPROVED', 'COMPLETED', 45);

alter table public.segment_timeouts enable row level security;

create policy "segment_timeouts: authenticated read"
  on public.segment_timeouts for select
  using (public.current_user_role() is not null);

-- No insert/update/delete policy for any client role: limits are
-- configuration, changed only via a migration (same posture as
-- cscs_settings), and are never deleted.
create trigger trg_segment_timeouts_no_delete
  before delete on public.segment_timeouts
  for each row execute function public.block_mutation();

-- ------------------------------------------------------------
-- New incident type, distinct from the generic legacy TIMEOUT.
-- ------------------------------------------------------------
alter table public.incidents drop constraint incidents_incident_type_check;
alter table public.incidents
  add constraint incidents_incident_type_check
  check (incident_type in (
    'BROKEN_SEAL', 'SEAL_MISMATCH', 'UNAUTHORIZED_DRIVER', 'UNAUTHORIZED_VEHICLE',
    'EXPIRED_PASS', 'WRONG_SEAL_COLOR', 'TIMEOUT', 'OTHER', 'WHITELIST_VIOLATION', 'SEGMENT_TIMEOUT'
  ));

-- ------------------------------------------------------------
-- Rewritten monitor: still on pg_cron every 15 min (CREATE OR REPLACE
-- keeps the existing cron.schedule('cscs-timeout-monitor', ...) call
-- pointed at this same function name, so the schedule doesn't need to
-- be re-registered). Looks up each in-progress transaction's segment
-- limit by (direction, status), skips uncapped segments, and raises
-- SEGMENT_TIMEOUT (once per transaction) when status_entered_at is
-- older than the configured limit.
-- ------------------------------------------------------------
create or replace function public.escalate_timeouts()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int := 0;
  r record;
begin
  for r in
    select
      t.id,
      t.transaction_number,
      t.status,
      t.direction,
      t.status_entered_at,
      st.from_status,
      st.to_status,
      st.limit_minutes
    from transactions t
    join segment_timeouts st
      on st.direction = t.direction and st.from_status = t.status
    where t.status in ('CREATED', 'INFLIGHT_POST_APPROVED', 'AIRPORT_POST_APPROVED')
      and st.limit_minutes is not null
      and t.status_entered_at < now() - make_interval(mins => st.limit_minutes)
      and not exists (
        select 1 from incidents i
        where i.transaction_id = t.id and i.incident_type = 'SEGMENT_TIMEOUT'
      )
  loop
    insert into incidents (transaction_id, incident_type, description, reported_by, reported_by_id)
    values (
      r.id,
      'SEGMENT_TIMEOUT',
      format(
        'Automatic escalation: transaction %s (%s) exceeded the %s-minute limit for segment %s -> %s (still %s after %s minutes).',
        r.transaction_number, r.direction, r.limit_minutes, r.from_status, r.to_status, r.status,
        round(extract(epoch from (now() - r.status_entered_at)) / 60)
      ),
      'system (segment timeout monitor)',
      null
    );
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- ------------------------------------------------------------
-- Lighter incident lifecycle for SEGMENT_TIMEOUT: OPEN -> RESOLVED in
-- one step (admin writes a one-line reason), no forced UNDER_REVIEW /
-- CLOSED stages. Every other incident type keeps the existing
-- OPEN -> UNDER_REVIEW -> RESOLVED -> CLOSED lifecycle unchanged.
-- Keyed off incident_type so this is additive, not a behavior change
-- for security-type incidents.
-- ------------------------------------------------------------
create or replace function public.guard_incident_update()
returns trigger
language plpgsql
as $$
declare
  v_stages text[];
  v_rank_old int;
  v_rank_new int;
begin
  if new.transaction_id <> old.transaction_id
     or new.incident_type <> old.incident_type
     or new.description <> old.description
     or new.reported_by <> old.reported_by
     or coalesce(new.reported_by_id::text, '') <> coalesce(old.reported_by_id::text, '')
     or new.created_at <> old.created_at then
    raise exception 'CSCS: incident facts are immutable; only the resolution lifecycle may change';
  end if;

  v_stages := case
    when old.incident_type = 'SEGMENT_TIMEOUT' then array['OPEN', 'RESOLVED']
    else array['OPEN', 'UNDER_REVIEW', 'RESOLVED', 'CLOSED']
  end;

  if not (new.status = any (v_stages)) then
    raise exception 'ICMS: % incidents may only move through %', old.incident_type, array_to_string(v_stages, ' -> ');
  end if;

  v_rank_old := array_position(v_stages, old.status);
  v_rank_new := array_position(v_stages, new.status);
  if v_rank_new < v_rank_old then
    raise exception 'CSCS: incident status can only move forward (%)', array_to_string(v_stages, ' -> ');
  end if;
  if new.status = 'RESOLVED' or new.status = 'CLOSED' then
    if new.resolution_notes is null or new.resolution_notes = '' then
      raise exception 'CSCS: resolution notes are mandatory to resolve or close an incident';
    end if;
  end if;
  return new;
end;
$$;
