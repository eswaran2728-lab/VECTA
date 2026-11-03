-- Bay Board: close the manual-removal bypass (product owner direction, 2026-11-03).
--
-- Before: any station-visible user could UPDATE bay_board directly (the "Clear" button, or a crafted request) and make a required-search aircraft disappear as if
-- normally cleared. Now no client can write cleared_at, search state or any clearing column. An aircraft leaves the board only through the departure/search rules
-- (apply_departure_search_rules, review_aircraft_search_secure) or through ONE controlled, audited correction path for a genuinely incorrect entry:
--   * a required reason (10+ characters);
--   * supervisor authority: an SO, SSO or DSE of the station, or the Operation Manager;
--   * an entry whose search is still required and unconfirmed can only be corrected by a DSE of the station or the Operation Manager, and never by the officer
--     who created the entry;
--   * the entry is marked as a CORRECTION (never as a normal clear, never as a confirmed search), kept in bay_board_corrections, audited, and a required-but-
--     unconfirmed search additionally becomes an exception record in the aircraft search review queue.

alter table public.bay_board add column if not exists cleared_kind text;
alter table public.bay_board add column if not exists correction_reason text;
alter table public.bay_board add column if not exists corrected_by uuid references public.profiles(id);
alter table public.bay_board add column if not exists corrected_at timestamptz;
alter table public.bay_board add constraint bay_board_cleared_kind_check check (cleared_kind is null or cleared_kind in ('departure', 'search_confirmed', 'correction'));

create table if not exists public.bay_board_corrections (
  id uuid primary key default gen_random_uuid(),
  bay_board_id uuid not null references public.bay_board(id),
  station text not null,
  reg_no text not null,
  flight text,
  actor_id uuid not null references public.profiles(id),
  actor_role text not null,
  reason text not null,
  had_required_search boolean not null,
  search_state_at_time text not null,
  search_reasons text[] not null default '{}',
  created_at timestamptz not null default now()
);
create index if not exists bay_board_corrections_station_idx on public.bay_board_corrections (station, created_at desc);
alter table public.bay_board_corrections enable row level security;
revoke all on public.bay_board_corrections from public, anon, authenticated;
grant select on public.bay_board_corrections to authenticated;
grant all on public.bay_board_corrections to service_role;
create policy "bay_board_corrections station read" on public.bay_board_corrections for select to authenticated
  using (canon_station_visible(station));

create or replace function public.correct_bay_board_entry_secure(p_id uuid, p_reason text)
returns table (ok boolean, code text, message text)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_caller uuid := auth.uid();
  b record;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_role text;
  v_is_om boolean;
  v_required boolean;
  v_reasons text[];
  v_today date := (now() at time zone 'Asia/Kuala_Lumpur')::date;
  v_aoc uuid;
begin
  if v_caller is null then raise exception 'Must be signed in.'; end if;
  if not exists (select 1 from public.profiles where id = v_caller and status = 'approved') then raise exception 'Only an approved account may correct the Bay Board.'; end if;
  select * into b from public.bay_board where id = p_id for update;
  if b.id is null then return query select false, 'NOT_FOUND', 'Bay Board entry not found.'; return; end if;
  if b.cleared_at is not null then return query select false, 'ALREADY_CLEARED', 'This entry has already left the Bay Board.'; return; end if;
  if char_length(v_reason) < 10 then return query select false, 'REASON_REQUIRED', 'A reason of at least 10 characters is required to correct a Bay Board entry.'; return; end if;

  select id into v_aoc from public.aocs where code = 'MY';
  v_is_om := public.has_active_role_for_aoc('operation_manager', v_aoc);
  select rd.code into v_role
    from public.user_role_assignments ura join public.role_definitions rd on rd.id = ura.role_definition_id and rd.is_active and rd.code in ('so', 'sso', 'dse')
    join public.org_stations st on st.id = ura.station_id and st.code = b.station
   where ura.profile_id = v_caller and ura.revoked_at is null and ura.starts_at <= now() and (ura.ends_at is null or ura.ends_at > now())
   order by case rd.code when 'dse' then 0 when 'sso' then 1 else 2 end limit 1;
  if v_role is null and not v_is_om then
    perform public.phase8_write_audit('bay_board_correction_refused', 'bay_board', b.id, jsonb_build_object('code', 'NOT_AUTHORISED'));
    return query select false, 'NOT_AUTHORISED', 'Only an SO, SSO or DSE of this station, or the Operation Manager, may correct a Bay Board entry.'; return;
  end if;

  -- does this aircraft still owe a search? (any trigger present and no confirmed or not-required outcome)
  v_reasons := b.search_reasons;
  if b.towed_from_hangar and not ('towed_from_hangar' = any (v_reasons)) then v_reasons := array_append(v_reasons, 'towed_from_hangar'::text); end if;
  if now() - b.on_ground_since >= interval '4 hours' and not ('ground_4h' = any (v_reasons)) then v_reasons := array_append(v_reasons, 'ground_4h'::text); end if;
  if (b.on_ground_since at time zone 'Asia/Kuala_Lumpur')::date < v_today and not ('night_stop' = any (v_reasons)) then v_reasons := array_append(v_reasons, 'night_stop'::text); end if;
  v_required := coalesce(array_length(v_reasons, 1), 0) > 0 and b.search_state not in ('confirmed', 'not_required');

  if v_required then
    if not (v_is_om or v_role = 'dse') then
      perform public.phase8_write_audit('bay_board_correction_refused', 'bay_board', b.id, jsonb_build_object('code', 'NEEDS_DSE', 'role', v_role));
      return query select false, 'NEEDS_DSE', 'This aircraft still needs an aircraft search. Only a DSE of the station or the Operation Manager may correct the entry.'; return;
    end if;
    if b.created_by = v_caller then
      perform public.phase8_write_audit('bay_board_correction_refused', 'bay_board', b.id, jsonb_build_object('code', 'OWN_ENTRY'));
      return query select false, 'OWN_ENTRY', 'The officer who created the entry cannot correct it while a search is still required.'; return;
    end if;
  end if;

  update public.bay_board
     set cleared_at = clock_timestamp(), cleared_kind = 'correction', correction_reason = v_reason, corrected_by = v_caller, corrected_at = clock_timestamp(),
         cleared_by_report_id = null,
         search_state = case when v_required then 'exception' else search_state end
   where id = b.id;

  insert into public.bay_board_corrections (bay_board_id, station, reg_no, flight, actor_id, actor_role, reason, had_required_search, search_state_at_time, search_reasons)
  values (b.id, b.station, b.reg_no, b.flight, v_caller, coalesce(v_role, 'operation_manager'), v_reason, v_required, b.search_state, v_reasons);

  if v_required then
    insert into public.aircraft_search_records (kind, station, entity, flight, registration, aircraft_type, submitter_id, required_reasons, late_flag, late_reason, review_state, presence_status)
    values ('missing', b.station, coalesce(public.leave_submitter_entity(b.created_by), public.leave_submitter_entity(v_caller), ''), upper(coalesce(b.flight, '')), upper(b.reg_no), b.aircraft_type, v_caller,
            v_reasons, true, 'Bay Board correction while a search was still required: ' || v_reason, 'exception', 'unverified');
  end if;

  perform public.phase8_write_audit('bay_board_corrected', 'bay_board', b.id, jsonb_build_object('reg_no', b.reg_no, 'required_search', v_required, 'role', coalesce(v_role, 'operation_manager'), 'reason', v_reason));
  return query select true, 'OK', case when v_required then 'Entry corrected. The unconfirmed search was recorded as an exception for review.' else 'Entry corrected and recorded.' end;
end;
$function$;

revoke execute on function public.correct_bay_board_entry_secure(uuid, text) from public, anon;
grant execute on function public.correct_bay_board_entry_secure(uuid, text) to authenticated, service_role;

-- No client may write the clearing/search columns any more: UPDATE is withdrawn and INSERT is limited to the columns an entry legitimately starts with.
drop policy if exists "bay_board_scoped_update" on public.bay_board;
revoke update on public.bay_board from authenticated;
revoke insert on public.bay_board from authenticated;
grant insert (station, reg_no, aircraft_type, bay, flight, arrival_report_id, on_ground_since, is_manual, created_by, towed_from_hangar) on public.bay_board to authenticated;
