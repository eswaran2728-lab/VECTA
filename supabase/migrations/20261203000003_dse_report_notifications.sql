-- In-app copies of submitted security reports for the correctly scoped DSE (product owner approval 2026-11-03).
--
-- Every SUBMITTED SEC013, SEC014, SEC016, SEC018, SEC029, SEC033, Makeup and Breakup report alerts each active, approved DSE whose assignment has the SAME operating
-- entity (the submitter's single active entity), station and team. The alert is idempotent (one per report per DSE). The submitter is never alerted. Delivery runs
-- AFTER the report row exists and can never undo or block the submission: any failure is recorded in report_notification_failures for technical monitoring and the
-- submission stands. Retired Offload is not included.

do $do$
declare
  v_def text;
begin
  select pg_get_constraintdef(c.oid) into v_def from pg_constraint c where c.conname = 'user_notifications_event_type_check' and c.conrelid = 'public.user_notifications'::regclass;
  if v_def is not null and v_def not like '%dse_report_submitted%' then
    v_def := regexp_replace(v_def, '\]\)\)\)\s*$', ',''dse_report_submitted''::text]))) ');
    alter table public.user_notifications drop constraint user_notifications_event_type_check;
    execute 'alter table public.user_notifications add constraint user_notifications_event_type_check ' || v_def;
  end if;
end
$do$;

create table if not exists public.report_notification_failures (
  id uuid primary key default gen_random_uuid(),
  source_table text not null,
  source_id uuid not null,
  recipient_profile_id uuid,
  error text not null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index if not exists report_notification_failures_open_idx on public.report_notification_failures (created_at) where resolved_at is null;
alter table public.report_notification_failures enable row level security;
revoke all on public.report_notification_failures from public, anon, authenticated;
grant select on public.report_notification_failures to authenticated;
grant all on public.report_notification_failures to service_role;
create policy "report_notification_failures monitoring read" on public.report_notification_failures for select to authenticated
  using (canon_has_role(array['super_admin', 'operation_manager']));

create or replace view public.v_report_notification_health with (security_invoker = true) as
  select count(*) filter (where resolved_at is null)::integer as open_failures,
         min(created_at) filter (where resolved_at is null) as oldest_open_failure,
         count(*)::integer as total_failures
  from public.report_notification_failures;
revoke all on public.v_report_notification_health from public, anon;
grant select on public.v_report_notification_health to authenticated, service_role;

-- Active DSEs of the same operating entity, station and team as the submitter.
create or replace function public.dse_report_recipients(p_station text, p_team text, p_submitter uuid)
returns table (profile_id uuid)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_entity text;
  v_entity_id uuid;
  v_station_id uuid;
  v_team_id uuid;
begin
  v_entity := public.leave_submitter_entity(p_submitter);
  if v_entity is null then
    raise exception 'The submitter has no single active operating entity.';
  end if;
  select id into v_entity_id from public.operating_entities where code = v_entity;
  select rs.station_id into v_station_id from public.resolve_legacy_station(p_station) rs;
  if v_station_id is null then
    raise exception 'The report station % does not resolve to a station.', p_station;
  end if;
  v_team_id := public.resolve_legacy_team(v_station_id, p_team);
  if v_team_id is null then
    raise exception 'The report team % does not resolve to a team of the station.', p_team;
  end if;
  return query
    select distinct ura.profile_id
    from public.user_role_assignments ura
    join public.role_definitions rd on rd.id = ura.role_definition_id and rd.is_active and rd.code = 'dse'
    join public.profiles p on p.id = ura.profile_id and p.status = 'approved'
    where ura.operating_entity_id = v_entity_id
      and ura.station_id = v_station_id
      and ura.team_id = v_team_id
      and ura.profile_id <> p_submitter
      and ura.revoked_at is null
      and ura.starts_at <= now()
      and (ura.ends_at is null or ura.ends_at > now());
end;
$function$;

-- Delivers the alerts. Never raises: every failure is recorded for monitoring. Returns the number of alerts offered (idempotent, so repeats add none).
create or replace function public.deliver_dse_report_notifications(p_source_table text, p_source_id uuid, p_station text, p_team text, p_submitter uuid, p_report_no text, p_flight text)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  r record;
  v_count integer := 0;
begin
  begin
    for r in select d.profile_id from public.dse_report_recipients(p_station, p_team, p_submitter) d loop
      begin
        perform public.notify(r.profile_id, 'dse_report_submitted', 'dse_report:' || p_source_table || ':' || p_source_id::text || ':' || r.profile_id::text,
          null, null, null,
          jsonb_build_object('source_table', p_source_table, 'source_id', p_source_id, 'report_no', p_report_no, 'flight', p_flight, 'station', p_station, 'team', p_team));
        v_count := v_count + 1;
      exception when others then
        insert into public.report_notification_failures (source_table, source_id, recipient_profile_id, error) values (p_source_table, p_source_id, r.profile_id, left(sqlerrm, 500));
      end;
    end loop;
  exception when others then
    begin
      insert into public.report_notification_failures (source_table, source_id, error) values (p_source_table, p_source_id, left(sqlerrm, 500));
    exception when others then
      null;
    end;
  end;
  return v_count;
end;
$function$;

create or replace function public.notify_dse_of_report()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  j jsonb := to_jsonb(new);
begin
  if (j ->> 'status') is distinct from 'submitted' or coalesce(j ->> 'team', '') = '' or coalesce(j ->> 'station', '') = '' then
    return new;
  end if;
  perform public.deliver_dse_report_notifications(tg_table_name, new.id, j ->> 'station', j ->> 'team', (j ->> 'profile_id')::uuid,
    j ->> 'report_no', coalesce(j ->> 'flight', j ->> 'flight_number'));
  return new;
exception when others then
  begin
    insert into public.report_notification_failures (source_table, source_id, error) values (tg_table_name, new.id, left(sqlerrm, 500));
  exception when others then
    null;
  end;
  return new;
end;
$function$;

revoke execute on function public.dse_report_recipients(text, text, uuid) from public, anon, authenticated;
revoke execute on function public.deliver_dse_report_notifications(text, uuid, text, text, uuid, text, text) from public, anon, authenticated;
revoke execute on function public.notify_dse_of_report() from public, anon, authenticated;
grant execute on function public.dse_report_recipients(text, text, uuid) to service_role;
grant execute on function public.deliver_dse_report_notifications(text, uuid, text, text, uuid, text, text) to service_role;

drop trigger if exists trg_notify_dse_of_report on public.report_sec013;
create trigger trg_notify_dse_of_report after insert on public.report_sec013 for each row execute function public.notify_dse_of_report();
drop trigger if exists trg_notify_dse_of_report on public.report_sec014;
create trigger trg_notify_dse_of_report after insert on public.report_sec014 for each row execute function public.notify_dse_of_report();
drop trigger if exists trg_notify_dse_of_report on public.report_sec016;
create trigger trg_notify_dse_of_report after insert on public.report_sec016 for each row execute function public.notify_dse_of_report();
drop trigger if exists trg_notify_dse_of_report on public.report_sec018;
create trigger trg_notify_dse_of_report after insert on public.report_sec018 for each row execute function public.notify_dse_of_report();
drop trigger if exists trg_notify_dse_of_report on public.report_sec029;
create trigger trg_notify_dse_of_report after insert on public.report_sec029 for each row execute function public.notify_dse_of_report();
drop trigger if exists trg_notify_dse_of_report on public.report_sec033;
create trigger trg_notify_dse_of_report after insert on public.report_sec033 for each row execute function public.notify_dse_of_report();
drop trigger if exists trg_notify_dse_of_report on public.report_makeup;
create trigger trg_notify_dse_of_report after insert on public.report_makeup for each row execute function public.notify_dse_of_report();
drop trigger if exists trg_notify_dse_of_report on public.report_breakup;
create trigger trg_notify_dse_of_report after insert on public.report_breakup for each row execute function public.notify_dse_of_report();
