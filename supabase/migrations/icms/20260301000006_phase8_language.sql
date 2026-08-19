-- ============================================================
-- CSCS v2 - PHASE 8: per-user language preference (EN / BM)
-- ============================================================

alter table public.users
  add column if not exists preferred_language text not null default 'en'
    check (preferred_language in ('en', 'ms'));

-- Users may update ONLY their own preferred_language. Column-level grants
-- prevent self-service changes to role/name/staff_id (privilege escalation);
-- those still go through the supervisor panel with the service role.
revoke update on public.users from authenticated, anon;
grant update (preferred_language) on public.users to authenticated;

create policy "users: own language preference"
  on public.users for update
  using (id = auth.uid())
  with check (id = auth.uid());
