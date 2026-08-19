-- ============================================================
-- ICMS Phase 5: staff self-registration + admin approval.
-- Incremental only: no tables dropped, no rows ever deleted.
--
-- Credentials stay in Supabase Auth (no second password store) — a
-- self-registered account gets a real auth.users row immediately, but
-- status='pending' blocks sign-in (enforced in the signIn server
-- action) until an admin approves it. Rejected accounts are kept for
-- history, never deleted, and stay permanently blocked from sign-in.
-- ============================================================

alter table public.users
  add column if not exists status text not null default 'active'
    check (status in ('pending', 'active', 'rejected'));
