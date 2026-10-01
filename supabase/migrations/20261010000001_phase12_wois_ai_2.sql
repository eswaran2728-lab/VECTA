-- Migration: 20261010000001_phase12_wois_ai_2.sql
-- Phase 12: WOIS AI 2.0 -- Conversational, context-aware Malaysia AOC assistant.
--
-- Additive, forward-only. Extends the existing WOIS 1.0 schema
-- (20260911000008_wois_ai_knowledge_base.sql) rather than replacing it.
-- Activation is Malaysia-AOC-only in this phase; every function below is
-- written against a resolved AOC id rather than a hardcoded assumption, so a
-- future AOC only needs a policy decision, not a schema change.

-- =====================================================================
-- 1. Schema additions (additive only -- no existing column/table dropped)
-- =====================================================================

alter table public.wois_conversations
  add column if not exists aoc_id uuid references public.aocs(id),
  add column if not exists archived_at timestamptz,
  add column if not exists deleted_at timestamptz,
  add column if not exists provider text not null default 'rule_engine',
  add column if not exists model text not null default 'wois-rule-engine-v1';

alter table public.wois_messages
  add column if not exists tool_calls jsonb not null default '[]'::jsonb,
  add column if not exists tool_results jsonb not null default '[]'::jsonb;

-- Audit trail for WOIS AI 2.0 security-relevant events. Append-only from the
-- caller's point of view -- rows are written exclusively by the SECURITY
-- DEFINER functions below (never by a direct client insert), and a user may
-- only ever read their own rows (never another user's, regardless of role).
create table if not exists public.wois_audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_profile_id uuid not null references public.profiles(id) on delete cascade,
  conversation_id uuid references public.wois_conversations(id) on delete set null,
  event_type text not null check (event_type in (
    'conversation_created',
    'conversation_renamed',
    'conversation_deleted',
    'message_appended',
    'tool_invoked',
    'tool_denied',
    'authorization_denied',
    'rate_limited',
    'provider_failure',
    'malformed_tool_request'
  )),
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.wois_audit_log enable row level security;

drop policy if exists wois_audit_log_owner_read on public.wois_audit_log;
create policy wois_audit_log_owner_read on public.wois_audit_log
  for select to authenticated
  using (actor_profile_id = auth.uid());

-- No insert/update/delete policy for `authenticated` at all: every write
-- happens through record_wois_audit_event_secure(), which runs as the
-- function owner (SECURITY DEFINER), not as the caller.
revoke insert, update, delete on public.wois_audit_log from authenticated, anon, public;
grant select on public.wois_audit_log to authenticated;
grant all on public.wois_audit_log to service_role;

create index if not exists idx_wois_audit_actor on public.wois_audit_log(actor_profile_id, created_at desc);
create index if not exists idx_wois_conv_aoc on public.wois_conversations(aoc_id);

-- =====================================================================
-- 2. Eligibility: one authoritative, fail-closed decision function
-- =====================================================================
-- Reuses the Phase 8/9 authoritative active-assignment primitive
-- (has_any_active_assignment_in_aoc) rather than the legacy profiles.role
-- text column. A profile that is pending, rejected, deactivated, or whose
-- only assignments are revoked, expired, future-dated, or ended is NOT
-- eligible -- those states are exactly what has_any_active_assignment_in_aoc()
-- and p.status = 'approved' already exclude. Deliberately NOT OR'd with
-- has_active_entity_membership_in_aoc(): an entity membership's own status
-- is independent of the role assignment's revoked_at/starts_at/ends_at
-- lifecycle, so accepting it as an alternate path would let a revoked,
-- future-dated, or ended assignment holder remain "eligible" purely
-- because their unrelated entity membership row is still marked active --
-- exactly the gap the eligibility requirement exists to close.
create or replace function public.is_wois_eligible_secure()
returns boolean
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_caller uuid := auth.uid();
  v_my_aoc_id uuid;
  v_approved boolean;
begin
  if v_caller is null then
    return false;
  end if;

  select (p.status = 'approved') into v_approved
  from public.profiles p
  where p.id = v_caller;

  if v_approved is not true then
    return false;
  end if;

  select id into v_my_aoc_id from public.aocs where code = 'MY' and is_active;
  if v_my_aoc_id is null then
    return false;
  end if;

  return public.has_any_active_assignment_in_aoc(v_my_aoc_id);
end;
$function$;

revoke execute on function public.is_wois_eligible_secure() from public, anon;
grant execute on function public.is_wois_eligible_secure() to authenticated, service_role;

-- =====================================================================
-- 3. Audit helper -- the only way an authenticated client can insert
--    into wois_audit_log.
-- =====================================================================
create or replace function public.record_wois_audit_event_secure(
  p_event_type text,
  p_conversation_id uuid default null,
  p_details jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_caller uuid := auth.uid();
  v_id uuid;
begin
  if v_caller is null then
    raise exception 'Must be signed in.';
  end if;

  insert into public.wois_audit_log (actor_profile_id, conversation_id, event_type, details)
  values (v_caller, p_conversation_id, p_event_type, coalesce(p_details, '{}'::jsonb))
  returning id into v_id;

  return v_id;
end;
$function$;

revoke execute on function public.record_wois_audit_event_secure(text, uuid, jsonb) from public, anon;
grant execute on function public.record_wois_audit_event_secure(text, uuid, jsonb) to authenticated, service_role;

-- =====================================================================
-- 4. Conversation lifecycle RPCs -- ownership-checked, eligibility-gated
--    on write, fail closed on cross-user/cross-AOC access.
-- =====================================================================
create or replace function public.create_wois_conversation_secure(p_title text default 'New Chat')
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_caller uuid := auth.uid();
  v_my_aoc_id uuid;
  v_id uuid;
  v_title text;
begin
  if v_caller is null then
    raise exception 'Must be signed in.';
  end if;

  if not public.is_wois_eligible_secure() then
    perform public.record_wois_audit_event_secure('authorization_denied', null, jsonb_build_object('action', 'create_conversation'));
    raise exception 'Not authorized to use WOIS AI.';
  end if;

  select id into v_my_aoc_id from public.aocs where code = 'MY' and is_active;

  v_title := coalesce(trim(p_title), 'New Chat');
  if length(v_title) = 0 then v_title := 'New Chat'; end if;
  if length(v_title) > 120 then v_title := left(v_title, 120); end if;

  insert into public.wois_conversations (user_id, aoc_id, title, provider, model)
  values (v_caller, v_my_aoc_id, v_title, 'rule_engine', 'wois-rule-engine-v1')
  returning id into v_id;

  perform public.record_wois_audit_event_secure('conversation_created', v_id, '{}'::jsonb);

  return v_id;
end;
$function$;

revoke execute on function public.create_wois_conversation_secure(text) from public, anon;
grant execute on function public.create_wois_conversation_secure(text) to authenticated, service_role;

create or replace function public.rename_wois_conversation_secure(p_conversation_id uuid, p_title text)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_caller uuid := auth.uid();
  v_title text;
  v_owned boolean;
begin
  if v_caller is null then
    raise exception 'Must be signed in.';
  end if;

  select exists (
    select 1 from public.wois_conversations c
    where c.id = p_conversation_id and c.user_id = v_caller and c.deleted_at is null
  ) into v_owned;

  if not v_owned then
    perform public.record_wois_audit_event_secure('authorization_denied', p_conversation_id, jsonb_build_object('action', 'rename_conversation'));
    raise exception 'Conversation not found or not owned by caller.';
  end if;

  v_title := coalesce(trim(p_title), '');
  if length(v_title) = 0 then
    raise exception 'Title is required.';
  end if;
  if length(v_title) > 120 then v_title := left(v_title, 120); end if;

  update public.wois_conversations
  set title = v_title, updated_at = now()
  where id = p_conversation_id;

  perform public.record_wois_audit_event_secure('conversation_renamed', p_conversation_id, '{}'::jsonb);

  return true;
end;
$function$;

revoke execute on function public.rename_wois_conversation_secure(uuid, text) from public, anon;
grant execute on function public.rename_wois_conversation_secure(uuid, text) to authenticated, service_role;

-- Soft delete: deleted_at is set, not a hard DELETE. Semantics: a deleted
-- conversation disappears from the caller's own list and can no longer
-- receive new messages, but existing rows are retained for the retention
-- window and the owning user's own audit trail -- nobody else was ever
-- able to see it (RLS is owner-only with no admin bypass), so soft
-- deletion does not create new exposure.
create or replace function public.delete_wois_conversation_secure(p_conversation_id uuid)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_caller uuid := auth.uid();
  v_owned boolean;
begin
  if v_caller is null then
    raise exception 'Must be signed in.';
  end if;

  select exists (
    select 1 from public.wois_conversations c
    where c.id = p_conversation_id and c.user_id = v_caller and c.deleted_at is null
  ) into v_owned;

  if not v_owned then
    perform public.record_wois_audit_event_secure('authorization_denied', p_conversation_id, jsonb_build_object('action', 'delete_conversation'));
    raise exception 'Conversation not found or not owned by caller.';
  end if;

  update public.wois_conversations
  set deleted_at = now(), updated_at = now()
  where id = p_conversation_id;

  perform public.record_wois_audit_event_secure('conversation_deleted', p_conversation_id, '{}'::jsonb);

  return true;
end;
$function$;

revoke execute on function public.delete_wois_conversation_secure(uuid) from public, anon;
grant execute on function public.delete_wois_conversation_secure(uuid) to authenticated, service_role;

create or replace function public.list_wois_conversations_secure()
returns table (
  id uuid,
  title text,
  created_at timestamptz,
  updated_at timestamptz,
  archived_at timestamptz
)
language sql
stable
security definer
set search_path to 'public'
as $function$
  select c.id, c.title, c.created_at, c.updated_at, c.archived_at
  from public.wois_conversations c
  where c.user_id = auth.uid()
    and c.deleted_at is null
  order by c.updated_at desc;
$function$;

revoke execute on function public.list_wois_conversations_secure() from public, anon;
grant execute on function public.list_wois_conversations_secure() to authenticated, service_role;

create or replace function public.list_wois_messages_secure(p_conversation_id uuid)
returns table (
  id uuid,
  sender text,
  body text,
  confidence_tag text,
  source_type text,
  sources jsonb,
  tool_calls jsonb,
  tool_results jsonb,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_caller uuid := auth.uid();
  v_owned boolean;
begin
  if v_caller is null then
    raise exception 'Must be signed in.';
  end if;

  select exists (
    select 1 from public.wois_conversations c
    where c.id = p_conversation_id and c.user_id = v_caller
  ) into v_owned;

  if not v_owned then
    perform public.record_wois_audit_event_secure('authorization_denied', p_conversation_id, jsonb_build_object('action', 'list_messages'));
    raise exception 'Conversation not found or not owned by caller.';
  end if;

  return query
  select m.id, m.sender, m.body, m.confidence_tag, m.source_type, m.sources, m.tool_calls, m.tool_results, m.created_at
  from public.wois_messages m
  where m.conversation_id = p_conversation_id
  order by m.created_at asc;
end;
$function$;

revoke execute on function public.list_wois_messages_secure(uuid) from public, anon;
grant execute on function public.list_wois_messages_secure(uuid) to authenticated, service_role;

-- Appending a message re-checks eligibility for the whole call (not just
-- conversation ownership): a user who loses their active Malaysia
-- assignment between messages cannot keep extending a conversation, even
-- though their existing history remains visible to them.
create or replace function public.append_wois_message_secure(
  p_conversation_id uuid,
  p_sender text,
  p_body text,
  p_confidence_tag text default null,
  p_source_type text default null,
  p_sources jsonb default '[]'::jsonb,
  p_tool_calls jsonb default '[]'::jsonb,
  p_tool_results jsonb default '[]'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_caller uuid := auth.uid();
  v_owned boolean;
  v_id uuid;
  v_body text;
begin
  if v_caller is null then
    raise exception 'Must be signed in.';
  end if;

  if p_sender not in ('user', 'assistant') then
    raise exception 'Invalid sender.';
  end if;

  if not public.is_wois_eligible_secure() then
    perform public.record_wois_audit_event_secure('authorization_denied', p_conversation_id, jsonb_build_object('action', 'append_message'));
    raise exception 'Not authorized to use WOIS AI.';
  end if;

  select exists (
    select 1 from public.wois_conversations c
    where c.id = p_conversation_id and c.user_id = v_caller and c.deleted_at is null
  ) into v_owned;

  if not v_owned then
    perform public.record_wois_audit_event_secure('authorization_denied', p_conversation_id, jsonb_build_object('action', 'append_message'));
    raise exception 'Conversation not found or not owned by caller.';
  end if;

  v_body := p_body;
  if v_body is null or length(trim(v_body)) = 0 then
    raise exception 'Message body is required.';
  end if;
  -- Bounded input/output length -- matches the API-layer limit so a direct
  -- RPC call cannot bypass it.
  if length(v_body) > 8000 then
    v_body := left(v_body, 8000);
  end if;

  insert into public.wois_messages (
    conversation_id, sender, body, confidence_tag, source_type, sources, tool_calls, tool_results
  )
  values (
    p_conversation_id, p_sender, v_body, p_confidence_tag, p_source_type,
    coalesce(p_sources, '[]'::jsonb), coalesce(p_tool_calls, '[]'::jsonb), coalesce(p_tool_results, '[]'::jsonb)
  )
  returning id into v_id;

  update public.wois_conversations set updated_at = now() where id = p_conversation_id;

  perform public.record_wois_audit_event_secure('message_appended', p_conversation_id, jsonb_build_object('sender', p_sender));

  return v_id;
end;
$function$;

revoke execute on function public.append_wois_message_secure(uuid, text, text, text, text, jsonb, jsonb, jsonb) from public, anon;
grant execute on function public.append_wois_message_secure(uuid, text, text, text, text, jsonb, jsonb, jsonb) to authenticated, service_role;

-- =====================================================================
-- 5. Lock down direct table writes -- all writes must go through the
--    SECURITY DEFINER RPCs above, which carry the eligibility/ownership
--    checks and the audit trail. SELECT remains available to the owning
--    user (unchanged from Phase 11's WOIS 1.0 policies) so existing
--    history stays readable.
-- =====================================================================
revoke insert, update, delete on public.wois_conversations from authenticated;
revoke insert, update, delete on public.wois_messages from authenticated;

drop policy if exists wois_conversations_user_all on public.wois_conversations;
create policy wois_conversations_user_select on public.wois_conversations
  for select to authenticated
  using (user_id = auth.uid());

drop policy if exists wois_messages_user_all on public.wois_messages;
create policy wois_messages_user_select on public.wois_messages
  for select to authenticated
  using (
    exists (
      select 1 from public.wois_conversations c
      where c.id = wois_messages.conversation_id and c.user_id = auth.uid()
    )
  );
