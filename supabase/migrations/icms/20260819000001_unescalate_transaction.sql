-- ============================================================
-- ICMS: Un-escalate / Release action for escalated transactions
-- When an incident is resolved or closed, Admin / Enforcement / Management
-- can release the transaction back to its active checkpoint progression.
-- ============================================================

-- 1. Update guard_transaction_update() to permit transitioning from
--    ESCALATED when done by authorized admin/enforcement roles or via RPC.
create or replace function public.guard_transaction_update()
returns trigger
language plpgsql
as $$
declare
  v_role text := public.current_user_role();
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
    if v_role is not null and v_role not in ('supervisor', 'enforcement', 'management') then
      raise exception 'ICMS: only admin, enforcement, or management may release escalated transactions';
    end if;
  end if;

  if new.transaction_number <> old.transaction_number
     or new.created_by <> old.created_by
     or new.created_at <> old.created_at then
    raise exception 'ICMS: transaction identity fields are immutable';
  end if;

  return new;
end;
$$;

-- 2. Stored procedure to safely un-escalate and restore transaction state
create or replace function public.unescalate_transaction(
  p_transaction_id uuid,
  p_notes text default null
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := public.current_user_role();
  v_user record;
  v_tx record;
  v_open_incidents integer;
  v_b_pass boolean := false;
  v_c_pass boolean := false;
  v_d_pass boolean := false;
  v_hub_pass boolean := false;
  v_redq_pass boolean := false;
  v_restored_status text;
begin
  if v_role not in ('supervisor', 'enforcement', 'management') then
    raise exception 'ICMS: only supervisor, enforcement, or management may release escalated transactions';
  end if;

  select * into v_tx
  from transactions
  where id = p_transaction_id
  for update;

  if v_tx.id is null then
    raise exception 'ICMS: transaction not found';
  end if;

  if v_tx.status <> 'ESCALATED' then
    raise exception 'ICMS: transaction is not escalated (current status: %)', v_tx.status;
  end if;

  -- Ensure any linked incidents are resolved or closed
  select count(*) into v_open_incidents
  from incidents
  where transaction_id = p_transaction_id
    and status not in ('RESOLVED', 'CLOSED');

  if v_open_incidents > 0 then
    raise exception 'ICMS: cannot release transaction while linked incidents are still open or under review';
  end if;

  -- Check existing checkpoint parts
  select (count(*) > 0) into v_b_pass
  from part_b
  where transaction_id = p_transaction_id
    and (result is null or result = 'PASS');

  select (count(*) > 0) into v_c_pass
  from part_c
  where transaction_id = p_transaction_id
    and (result is null or result = 'PASS');

  select (count(*) > 0) into v_d_pass
  from part_d
  where transaction_id = p_transaction_id
    and (result is null or result = 'PASS');

  if coalesce(v_tx.part_d_skipped, false) = true then
    v_d_pass := true;
  end if;

  select (count(*) > 0) into v_hub_pass
  from part_hub
  where transaction_id = p_transaction_id
    and (result is null or result = 'PASS');

  select (count(*) > 0) into v_redq_pass
  from part_redq
  where transaction_id = p_transaction_id
    and (result is null or result = 'PASS');

  -- Derive target restored status based on direction and route
  if v_tx.direction = 'INBOUND' then
    if v_b_pass then
      v_restored_status := 'COMPLETED';
    elsif v_c_pass then
      v_restored_status := 'AIRPORT_POST_APPROVED';
    else
      v_restored_status := 'CREATED';
    end if;
  else
    -- OUTBOUND
    if v_tx.route = 'HUB' then
      if v_hub_pass then
        v_restored_status := 'COMPLETED';
      elsif v_b_pass then
        v_restored_status := 'INFLIGHT_POST_APPROVED';
      else
        v_restored_status := 'CREATED';
      end if;
    elsif v_tx.route = 'MAINTENANCE' then
      if v_c_pass then
        v_restored_status := 'COMPLETED';
      elsif v_b_pass then
        v_restored_status := 'INFLIGHT_POST_APPROVED';
      else
        v_restored_status := 'CREATED';
      end if;
    elsif v_tx.route = 'REDQ' then
      if v_d_pass then
        v_restored_status := 'COMPLETED';
      elsif v_c_pass then
        v_restored_status := 'AIRPORT_POST_APPROVED';
      elsif v_redq_pass then
        v_restored_status := 'REDQ_RESEALED';
      elsif v_b_pass then
        v_restored_status := 'INFLIGHT_POST_APPROVED';
      else
        v_restored_status := 'CREATED';
      end if;
    else
      -- AIRCRAFT
      if v_d_pass then
        v_restored_status := 'COMPLETED';
      elsif v_c_pass then
        v_restored_status := 'AIRPORT_POST_APPROVED';
      elsif v_b_pass then
        v_restored_status := 'INFLIGHT_POST_APPROVED';
      else
        v_restored_status := 'CREATED';
      end if;
    end if;
  end if;

  -- Get current acting user info
  select name, staff_id into v_user
  from users
  where id = auth.uid();

  -- Update transaction
  update transactions
  set status = v_restored_status,
      escalation_reason = null,
      status_entered_at = now(),
      completed_at = case
        when v_restored_status = 'COMPLETED' then coalesce(v_tx.completed_at, now())
        else null
      end
  where id = p_transaction_id;

  -- Insert audit log record
  insert into audit_logs (
    transaction_id,
    action,
    performed_by,
    performed_by_id,
    old_values,
    new_values
  ) values (
    p_transaction_id,
    'UNESCALATE',
    coalesce(v_user.name || ' (' || v_user.staff_id || ')', 'Admin'),
    auth.uid(),
    jsonb_build_object('status', 'ESCALATED', 'escalation_reason', v_tx.escalation_reason),
    jsonb_build_object('status', v_restored_status, 'notes', coalesce(p_notes, 'Released after incident resolution'))
  );

  return v_restored_status;
end;
$$;

revoke execute on function public.unescalate_transaction(uuid, text) from public, anon;
grant execute on function public.unescalate_transaction(uuid, text) to authenticated;
