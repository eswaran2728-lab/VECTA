-- MAA / AAX report separation, part 1: trusted flight classification and the single report-access decision.
--
-- Additive and forward-only. Nothing here rewrites or backfills existing rows; a hosted application must be separately authorised.
--
-- 1. normalize_flight_number() / classify_flight_operating_entity(): one server-side classifier. AK -> MAA, D7 -> AAX. Missing,
--    malformed, codeshare (several flight numbers), unknown-prefix and conflicting values are NEVER guessed: they classify as
--    NOT classified and are sent to a controlled review queue.
-- 2. derive_report_classification(): the existing trusted BEFORE INSERT classification. For the three flight-based report tables
--    (report_sec016, report_sec029, offload_records) the operating entity now comes from the validated flight prefix, never from
--    anything the client supplies; every other table keeps exactly its previous derivation from the submitter's assignment.
-- 3. report_classification_review_queue: reports whose flight cannot be classified (hidden from entity leadership until resolved).
-- 4. has_report_access(): the single authorization decision, now with MAA/AAX Admin branches (own entity only) and Boss/Admin
--    branches scoped to the report's own AOC. Every other branch is unchanged.

-- ---------------------------------------------------------------------------------------------
-- 1. Flight classification
-- ---------------------------------------------------------------------------------------------
create or replace function public.normalize_flight_number(p_flight text)
returns text
language sql
immutable
set search_path to 'public'
as $function$
  select nullif(regexp_replace(upper(coalesce(p_flight, '')), '[[:space:]_./-]+', '', 'g'), '');
$function$;
revoke execute on function public.normalize_flight_number(text) from public, anon;
grant execute on function public.normalize_flight_number(text) to authenticated, service_role;

-- status: classified | missing | malformed | unknown_prefix | conflict
create or replace function public.classify_flight_operating_entity(p_flight text)
returns table (status text, prefix text, entity_code text, normalized text)
language plpgsql
stable
set search_path to 'public'
as $function$
declare
  v_raw text := btrim(coalesce(p_flight, ''));
  v_norm text := public.normalize_flight_number(p_flight);
  v_prefix text;
  v_entity text;
begin
  if v_raw = '' or v_norm is null then
    return query select 'missing'::text, null::text, null::text, null::text;
    return;
  end if;
  -- several flight numbers in one value (codeshare / combined entries) are never guessed
  if v_raw ~ '[/,;+&]' or v_raw ~* '[[:space:]]+(or|and)[[:space:]]+'
     or upper(v_raw) ~ '[A-Z0-9]{2}[[:space:]-]*[0-9]{1,4}[A-Z]?[[:space:]]+[A-Z0-9]{2}[[:space:]-]*[0-9]{1,4}' then
    return query select 'conflict'::text, null::text, null::text, v_norm;
    return;
  end if;
  if v_norm ~ '^[A-Z0-9]{2}[0-9]{1,4}[A-Z]?$' then
    v_prefix := substr(v_norm, 1, 2);
    select oe.code into v_entity from public.operating_entities oe where oe.flight_prefix = v_prefix limit 1;
    if v_entity is not null then
      return query select 'classified'::text, v_prefix, v_entity, v_norm;
    else
      return query select 'unknown_prefix'::text, v_prefix, null::text, v_norm;
    end if;
    return;
  end if;
  return query select 'malformed'::text, null::text, null::text, v_norm;
end;
$function$;
revoke execute on function public.classify_flight_operating_entity(text) from public, anon;
grant execute on function public.classify_flight_operating_entity(text) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 3. Controlled review queue for reports whose entity cannot be classified
-- ---------------------------------------------------------------------------------------------
create table if not exists public.report_classification_review_queue (
  id uuid primary key default gen_random_uuid(),
  source_table text not null,
  source_id uuid not null,
  reason text not null check (reason in ('missing', 'malformed', 'unknown_prefix', 'conflict', 'cross_aoc_conflict')),
  flight_input text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references public.profiles(id),
  unique (source_table, source_id)
);
alter table public.report_classification_review_queue enable row level security;
revoke all on public.report_classification_review_queue from public, anon, authenticated;
grant all on public.report_classification_review_queue to service_role;

-- ---------------------------------------------------------------------------------------------
-- 2. Trusted classification trigger (replaces the Phase 5 function body; same name, same trigger wiring)
-- ---------------------------------------------------------------------------------------------
create or replace function public.derive_report_classification()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_match_count integer;
  v_flight text;
  v_flight_class record;
  v_entity record;
  v_assignment_aoc uuid;
begin
  if auth.role() <> 'service_role' then
    new.aoc_id := null;
    new.operating_entity_id := null;
    new.operating_entity_code := null;
    new.department_id := null;
    new.unit_id := null;
    new.hub_id := null;
    new.org_station_id := null;
    new.org_team_id := null;
    new.severity := null;
    new.flag_state := 'unflagged';
    new.flagged_by := null;
    new.flagged_reason := null;
    new.flagged_at := null;
    new.unflagged_by := null;
    new.unflagged_at := null;
  end if;

  select count(*) into v_match_count
  from public.user_role_assignments ura
  join public.role_definitions rd on rd.id = ura.role_definition_id
  where ura.profile_id = new.profile_id
    and rd.is_active
    and ura.revoked_at is null
    and ura.starts_at <= now()
    and (ura.ends_at is null or ura.ends_at > now())
    and ura.aoc_id is not null;

  if v_match_count = 1 then
    -- The entity is the assignment's own entity (Boss/Admin) or, for station/team staff whose assignment carries none, the entity of
    -- the ACTIVE membership that assignment belongs to (trusted database state; never a station name, e-mail or client value).
    select ura.aoc_id, coalesce(ura.operating_entity_id, uem.operating_entity_id), coalesce(oe.code, oem.code),
           ura.department_id, ura.unit_id, ura.hub_id, ura.station_id, ura.team_id
    into new.aoc_id, new.operating_entity_id, new.operating_entity_code, new.department_id, new.unit_id, new.hub_id, new.org_station_id, new.org_team_id
    from public.user_role_assignments ura
    left join public.operating_entities oe on oe.id = ura.operating_entity_id
    left join public.user_entity_memberships uem on uem.id = ura.entity_membership_id and uem.status = 'active'
      and uem.starts_at <= now() and (uem.ends_at is null or uem.ends_at > now())
    left join public.operating_entities oem on oem.id = uem.operating_entity_id
    where ura.profile_id = new.profile_id
      and ura.role_definition_id in (select id from public.role_definitions where is_active)
      and ura.revoked_at is null
      and ura.starts_at <= now()
      and (ura.ends_at is null or ura.ends_at > now())
      and ura.aoc_id is not null
    limit 1;

    -- Flight-based reports: the OPERATING ENTITY is the one whose flight prefix the validated flight number carries (AK -> MAA,
    -- D7 -> AAX). The submitter's own scope (hub / station / team / department) is kept; only the entity comes from the flight.
    -- An unclassifiable flight leaves the entity NULL (hidden from both entities' leadership) and the report is queued for review.
    v_flight := case tg_table_name
      when 'report_sec016' then to_jsonb(new) ->> 'flight'
      when 'report_sec029' then to_jsonb(new) ->> 'flight_no'
      when 'offload_records' then to_jsonb(new) ->> 'flight_no'
      else null
    end;
    if tg_table_name in ('report_sec016', 'report_sec029', 'offload_records') then
      v_assignment_aoc := new.aoc_id;
      select * into v_flight_class from public.classify_flight_operating_entity(v_flight);
      new.operating_entity_id := null;
      new.operating_entity_code := null;
      if v_flight_class.status = 'classified' then
        select oe.id, oe.code, oe.aoc_id into v_entity from public.operating_entities oe where oe.code = v_flight_class.entity_code limit 1;
        if v_entity.id is not null and v_entity.aoc_id is not distinct from v_assignment_aoc then
          new.operating_entity_id := v_entity.id;
          new.operating_entity_code := v_entity.code;
        end if;
      end if;
    end if;
  end if;
  -- v_match_count = 0 (legacy account / no active assignment) or > 1 (ambiguous): classification stays fully NULL. Never guessed.

  return new;
end;
$function$;

-- queue unclassified flight reports (AFTER INSERT: the row id is final)
create or replace function public.enqueue_unclassified_flight_report()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_flight text;
  v_class record;
  v_reason text;
begin
  if new.operating_entity_code is not null then
    return new;
  end if;
  v_flight := case tg_table_name
    when 'report_sec016' then to_jsonb(new) ->> 'flight'
    else to_jsonb(new) ->> 'flight_no'
  end;
  select * into v_class from public.classify_flight_operating_entity(v_flight);
  v_reason := case when v_class.status = 'classified' then 'cross_aoc_conflict' else v_class.status end;
  insert into public.report_classification_review_queue (source_table, source_id, reason, flight_input)
  values (tg_table_name, new.id, v_reason, left(v_flight, 40))
  on conflict (source_table, source_id) do nothing;
  return new;
end;
$function$;
revoke execute on function public.enqueue_unclassified_flight_report() from public, anon, authenticated;

drop trigger if exists trg_unclassified_flight_report on public.report_sec016;
create trigger trg_unclassified_flight_report after insert on public.report_sec016 for each row execute function public.enqueue_unclassified_flight_report();
drop trigger if exists trg_unclassified_flight_report on public.report_sec029;
create trigger trg_unclassified_flight_report after insert on public.report_sec029 for each row execute function public.enqueue_unclassified_flight_report();
drop trigger if exists trg_unclassified_flight_report on public.offload_records;
create trigger trg_unclassified_flight_report after insert on public.offload_records for each row execute function public.enqueue_unclassified_flight_report();

-- ---------------------------------------------------------------------------------------------
-- 4. The single report-access decision
-- ---------------------------------------------------------------------------------------------
create or replace function public.has_report_access(p_repository_report_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_report record;
begin
  select * into v_report from public.central_reports_index where id = p_repository_report_id;
  if v_report is null then
    return false;
  end if;

  -- Own submission.
  if v_report.submitter_profile_id = auth.uid() then
    return true;
  end if;

  -- Global Reporting Controller: repository-wide search authority.
  if public.has_active_role('global_reporting_controller') then
    return true;
  end if;

  -- GHOD: only while the report is actively flagged.
  if v_report.flag_state = 'flagged' and public.has_active_role('ghod') then
    return true;
  end if;

  -- MAA / AAX Boss AND Admin: ONLY their own entity's reports, and only inside the report's own AOC (trusted stored
  -- classification; never a flight prefix, station, email or client value). A report whose entity is NULL (unclassified) is
  -- visible to neither entity.
  if v_report.aoc_id is not null and v_report.operating_entity_code = 'MAA' and (
    public.has_role_in_scope('maa_boss', v_report.aoc_id) or public.has_role_in_scope('maa_admin', v_report.aoc_id)
  ) then
    return true;
  end if;
  if v_report.aoc_id is not null and v_report.operating_entity_code = 'AAX' and (
    public.has_role_in_scope('aax_boss', v_report.aoc_id) or public.has_role_in_scope('aax_admin', v_report.aoc_id)
  ) then
    return true;
  end if;

  -- Main Enforcement / Compliance: Malaysia-wide read, scoped to the report's own aoc_id.
  if v_report.aoc_id is not null and public.has_role_in_scope('main_enforcement', v_report.aoc_id) then
    return true;
  end if;
  if v_report.aoc_id is not null and public.has_role_in_scope('compliance', v_report.aoc_id) then
    return true;
  end if;

  -- Investigation: Malaysia-wide investigative read authority.
  if v_report.aoc_id is not null and (
    public.has_role_in_scope('investigation_sso', v_report.aoc_id)
    or public.has_role_in_scope('investigation_so', v_report.aoc_id)
    or public.has_role_in_scope('investigation_aso', v_report.aoc_id)
  ) then
    return true;
  end if;

  -- Operation Manager -- Malaysia AOC + Operation department, across all hubs/stations.
  if v_report.aoc_id is not null and v_report.department_id is not null
    and public.has_role_in_scope('operation_manager', v_report.aoc_id, null, v_report.department_id) then
    return true;
  end if;

  -- Hub SE -- own hub only.
  if v_report.aoc_id is not null and v_report.hub_id is not null
    and public.has_role_in_scope('hub_se', v_report.aoc_id, null, null, null, v_report.hub_id) then
    return true;
  end if;

  -- DSE -- own KUL team only.
  if v_report.aoc_id is not null and v_report.team_id is not null
    and public.has_role_in_scope('dse', v_report.aoc_id, null, null, null, null, null, v_report.team_id) then
    return true;
  end if;

  -- SSO / SO / ASO -- own station AND team together.
  if v_report.aoc_id is not null and v_report.station_id is not null and v_report.team_id is not null and (
    public.has_role_in_scope('sso', v_report.aoc_id, null, null, null, null, v_report.station_id, v_report.team_id)
    or public.has_role_in_scope('so', v_report.aoc_id, null, null, null, null, v_report.station_id, v_report.team_id)
    or public.has_role_in_scope('aso', v_report.aoc_id, null, null, null, null, v_report.station_id, v_report.team_id)
  ) then
    return true;
  end if;

  -- SAT ASO -- own unit (SAT) AND hub (KUL) together.
  if v_report.aoc_id is not null and v_report.unit_id is not null and v_report.hub_id is not null
    and public.has_role_in_scope('sat_aso', v_report.aoc_id, null, null, v_report.unit_id, v_report.hub_id) then
    return true;
  end if;

  -- Profiling SO / ASO -- own unit (Profiling), Malaysia-wide within it.
  if v_report.aoc_id is not null and v_report.unit_id is not null and (
    public.has_role_in_scope('profiling_so', v_report.aoc_id, null, null, v_report.unit_id)
    or public.has_role_in_scope('profiling_aso', v_report.aoc_id, null, null, v_report.unit_id)
  ) then
    return true;
  end if;

  -- Active, non-revoked, non-expired grant.
  if exists (
    select 1 from public.report_access_grants g
    where g.repository_report_id = p_repository_report_id
      and g.grantee_profile_id = auth.uid()
      and g.revoked_at is null
      and g.starts_at <= now()
      and (g.expires_at is null or g.expires_at > now())
  ) then
    return true;
  end if;

  return false;
end;
$function$;
