-- ============================================================
-- CSCS - Migration 3: Security hardening (from Supabase advisor)
-- ============================================================

-- Pin search_path on remaining trigger functions.
alter function public.block_mutation() set search_path = public;
alter function public.touch_updated_at() set search_path = public;
alter function public.guard_transaction_update() set search_path = public;

-- Trigger/internal functions must not be callable through the REST RPC API.
-- Triggers still fire (they run with owner privileges), but anon and
-- signed-in users can no longer invoke these directly.
revoke execute on function public.log_audit() from public, anon, authenticated;
revoke execute on function public.block_mutation() from public, anon, authenticated;
revoke execute on function public.touch_updated_at() from public, anon, authenticated;
revoke execute on function public.guard_transaction_update() from public, anon, authenticated;
revoke execute on function public.enforce_part_sequence() from public, anon, authenticated;
revoke execute on function public.escalate_on_incident() from public, anon, authenticated;
revoke execute on function public.next_transaction_number() from public, anon, authenticated;
revoke execute on function public.set_transaction_number() from public, anon, authenticated;

-- current_user_role() is used inside RLS policies, so authenticated users
-- must keep EXECUTE; anon has no business calling it.
revoke execute on function public.current_user_role() from public, anon;
grant execute on function public.current_user_role() to authenticated;
