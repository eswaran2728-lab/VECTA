-- ============================================================
-- ICMS Phase 3: Part D optional, manual seal color at every
-- checkpoint (no direction auto-lock), mandatory seal numbers.
-- Incremental only: no tables dropped, no data removed.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Part D becomes optional for outbound completion. A transaction
--    can now reach COMPLETED straight from AIRPORT_POST_APPROVED
--    without a part_d row, via the skip_part_d() function below.
--    The normal Part D flow (insert into part_d) is untouched and
--    still works exactly as before when it IS used.
-- ------------------------------------------------------------
alter table public.transactions
  add column if not exists part_d_skipped boolean not null default false,
  add column if not exists part_d_skip_reason text;

create or replace function public.skip_part_d(p_transaction_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := public.current_user_role();
  v_status text;
  v_direction text;
begin
  if v_role not in ('receiver', 'supervisor') then
    raise exception 'ICMS: only the receiver or an admin may complete a transaction without Part D / Hanya penerima atau admin boleh melengkapkan transaksi tanpa Bahagian D';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'ICMS: a reason is required to skip Part D / Sebab diperlukan untuk melangkau Bahagian D';
  end if;

  select status, direction into v_status, v_direction
  from transactions where id = p_transaction_id for update;

  if v_status is null then
    raise exception 'ICMS: transaction not found / transaksi tidak dijumpai';
  end if;
  if v_direction <> 'OUTBOUND' then
    raise exception 'ICMS: Part D only applies to outbound transactions / Bahagian D hanya terpakai untuk transaksi keluar';
  end if;
  if v_status <> 'AIRPORT_POST_APPROVED' then
    raise exception 'ICMS: out of order - completing without Part D requires status AIRPORT_POST_APPROVED, current % / tidak mengikut urutan, status semasa %', v_status, v_status;
  end if;

  update transactions
  set status = 'COMPLETED',
      completed_at = now(),
      part_d_skipped = true,
      part_d_skip_reason = p_reason
  where id = p_transaction_id;
end;
$$;

revoke execute on function public.skip_part_d(uuid, text) from public, anon;
grant execute on function public.skip_part_d(uuid, text) to authenticated;

-- ------------------------------------------------------------
-- 2. Manual seal colour at every checkpoint: drop the trigger
--    that auto-enforced truck-seal colour by direction. Colour
--    is now a free choice at Part A (Blue/Green/Other, per seal
--    type) and independently re-picked at every checkpoint.
-- ------------------------------------------------------------
drop trigger if exists trg_enforce_seal_color on public.seals;

-- Per-checkpoint observed colour, alongside the existing observed
-- seal number. Nullable for backward compatibility with rows
-- verified before this feature existed.
alter table public.seal_verifications
  add column if not exists observed_seal_color text
    check (observed_seal_color in ('BLUE', 'GREEN'));

-- ------------------------------------------------------------
-- 3. WRONG_SEAL_COLOR already exists in the incident_type check
--    constraint (added in an earlier phase) - no schema change
--    needed there, just confirming it's usable going forward.
-- ------------------------------------------------------------
