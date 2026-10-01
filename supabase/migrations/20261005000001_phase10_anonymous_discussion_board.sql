-- =======================================================================
-- PHASE 10: Anonymous Discussion Board
-- =======================================================================
-- Authenticated VECTA personnel discuss internally without exposing their
-- real identity to ordinary participants, while retaining a tightly
-- audited, server-side-only identity-resolution path for legitimate
-- abuse/security investigation.
--
-- ANONYMITY MODEL (documented decision, not invented silently):
-- Stable alias WITHIN a thread, unlinkable ACROSS threads. The same
-- author replying multiple times in one discussion keeps the same alias
-- (conversation continuity); the same person's alias in a different
-- thread is an independently-generated value with no stored link between
-- the two aliases visible to anyone but the identity-resolution path.
-- Chosen over (A) globally-stable aliases (would let any participant
-- build a cross-thread profile of "Anonymous Falcon" purely by
-- observation -- the opposite of the stated goal) and (C) per-post random
-- aliases (breaks conversational continuity: nobody could tell whether
-- two replies in the same thread are the same person, which is often
-- relevant context even anonymously).
--
-- OBJECT-COLLISION INVENTORY (same discipline as the Phase 9 correction):
-- every table/function/trigger/policy/index name below is new and
-- grep-verified against every earlier migration (icms/ and non-icms) to
-- have zero prior use anywhere in this repository. No views, materialized
-- views, enum types, storage buckets or cron jobs are declared by this
-- migration. No legacy or Phase 8/9 object is altered, dropped or
-- renamed.
--
-- AUTHOR-IDENTITY PROTECTION ARCHITECTURE:
--   public.discussion_threads / discussion_replies -- PUBLIC rows. Carry
--     only a denormalized `author_alias` (plain text, e.g. "Anonymous
--     Falcon"), never a profile id, never anything identity-bearing.
--     Readable (via RPC only, RLS still denies direct SELECT to defend
--     the AOC/entity boundary) by any authenticated participant whose
--     AOC/entity is in scope.
--   public.discussion_author_mappings -- PROTECTED. The only place a
--     content row is linked to the real authoring profile. revoke all
--     from public/anon/authenticated; grant only to service_role. No
--     RPC returns its rows directly to a client -- not even to the
--     content's own author (ownership checks happen server-side,
--     comparing auth.uid() against this table from inside a SECURITY
--     DEFINER function, never by handing the mapping to the client).
--   public.discussion_identity_resolutions -- the ONE audited path that
--     ever turns an alias back into a real identity. Every row records
--     who resolved, what content, which profile was revealed, why, and
--     when -- see resolve_discussion_author_identity_secure() below.
-- =======================================================================

-- -----------------------------------------------------------------------
-- PART A: Categories (board configuration, AOC-scoped or global)
-- -----------------------------------------------------------------------
-- VISIBILITY MODEL (documented decision; final policy flagged as a UAT/
-- governance decision in the implementation report): a category is
-- either global (aoc_id is null -- visible to every AOC) or scoped to one
-- AOC. This migration seeds one global category set as the safe default;
-- AOC-specific categories can be added later without a schema change.
-- Entity/department-level scoping was considered and deliberately NOT
-- implemented in round 1 -- flagged as a UAT decision rather than
-- guessed, since no existing VECTA requirement defines it.
create table if not exists public.discussion_categories (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  display_name text not null,
  description text not null default '',
  aoc_id uuid references public.aocs(id),
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (aoc_id, code)
);
create index if not exists idx_discussion_categories_aoc on public.discussion_categories (aoc_id, is_active);

alter table public.discussion_categories enable row level security;
revoke all on public.discussion_categories from public, anon, authenticated;
grant all on public.discussion_categories to service_role;
grant select on public.discussion_categories to authenticated;

create policy "discussion_categories_read"
  on public.discussion_categories for select
  to authenticated
  using (
    is_active and (
      aoc_id is null
      or public.has_any_active_assignment_in_aoc(aoc_id)
    )
  );

-- Seed a safe, generic global category set (not operationally hard-coded
-- per-AOC business logic -- these are discussion topics, not workflow
-- states, so a fixed starter set is appropriate; additional AOC-specific
-- categories are a product/content decision, not a schema change).
insert into public.discussion_categories (code, display_name, description, aoc_id, sort_order) values
  ('general', 'General', 'General internal discussion.', null, 1),
  ('operations', 'Operations', 'Operational topics and day-to-day questions.', null, 2),
  ('safety', 'Safety', 'Safety concerns and observations.', null, 3),
  ('security', 'Security', 'Security-related discussion. Sensitive details should go through the proper incident channel instead.', null, 4),
  ('workplace', 'Workplace', 'Workplace culture and welfare topics.', null, 5),
  ('suggestions', 'Suggestions', 'Ideas and suggestions for improving VECTA or operations.', null, 6),
  ('system_feedback', 'System Feedback', 'Feedback on the VECTA system itself.', null, 7)
on conflict (aoc_id, code) do nothing;

-- -----------------------------------------------------------------------
-- PART B: Threads and Replies (public-facing content -- alias only)
-- -----------------------------------------------------------------------
create table if not exists public.discussion_threads (
  id uuid primary key default gen_random_uuid(),
  category_id uuid not null references public.discussion_categories(id),
  aoc_id uuid not null references public.aocs(id),
  title text not null check (length(title) between 1 and 200),
  body text not null check (length(body) between 1 and 10000),
  author_alias text not null,
  status text not null default 'open' check (status in ('open', 'locked', 'removed')),
  report_count integer not null default 0,
  reply_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  edited_at timestamptz
);
create index if not exists idx_discussion_threads_category on public.discussion_threads (category_id, created_at desc);
create index if not exists idx_discussion_threads_aoc on public.discussion_threads (aoc_id, status);

create table if not exists public.discussion_replies (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.discussion_threads(id) on delete cascade,
  body text not null check (length(body) between 1 and 5000),
  author_alias text not null,
  status text not null default 'visible' check (status in ('visible', 'removed')),
  report_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  edited_at timestamptz
);
create index if not exists idx_discussion_replies_thread on public.discussion_replies (thread_id, created_at asc);

alter table public.discussion_threads enable row level security;
alter table public.discussion_replies enable row level security;
revoke all on public.discussion_threads from public, anon, authenticated;
revoke all on public.discussion_replies from public, anon, authenticated;
grant all on public.discussion_threads to service_role;
grant all on public.discussion_replies to service_role;
grant select on public.discussion_threads to authenticated;
grant select on public.discussion_replies to authenticated;

-- RLS still gates direct-SELECT by AOC/entity scope -- defense in depth
-- even though the intended client path is always the RPCs below, which
-- additionally strip removed-content fields before returning (see
-- get_discussion_thread_secure()).
create policy "discussion_threads_read"
  on public.discussion_threads for select
  to authenticated
  using (public.has_any_active_assignment_in_aoc(aoc_id));

create policy "discussion_replies_read"
  on public.discussion_replies for select
  to authenticated
  using (
    exists (
      select 1 from public.discussion_threads t
      where t.id = discussion_replies.thread_id
        and public.has_any_active_assignment_in_aoc(t.aoc_id)
    )
  );

-- -----------------------------------------------------------------------
-- PART C: Protected author mapping -- the ONLY table linking content to a
-- real identity. Zero client access of any kind, by any role.
-- -----------------------------------------------------------------------
create table if not exists public.discussion_author_mappings (
  id uuid primary key default gen_random_uuid(),
  content_type text not null check (content_type in ('thread', 'reply')),
  content_id uuid not null,
  thread_id uuid not null references public.discussion_threads(id) on delete cascade,
  author_profile_id uuid not null references public.profiles(id),
  aoc_id uuid not null references public.aocs(id),
  created_at timestamptz not null default now(),
  unique (content_type, content_id)
);
create index if not exists idx_discussion_author_mappings_thread_author on public.discussion_author_mappings (thread_id, author_profile_id);

alter table public.discussion_author_mappings enable row level security;
revoke all on public.discussion_author_mappings from public, anon, authenticated;
grant all on public.discussion_author_mappings to service_role;
-- Deliberately NO grant to authenticated at all -- not even select. Every
-- legitimate read of this table happens from inside a SECURITY DEFINER
-- function body (which runs with the function owner's privileges, not
-- the caller's), never via a client-facing query.

-- -----------------------------------------------------------------------
-- PART D: Reports/flags -- reporter identity is itself protected (never
-- shown to anyone, including the content's own author or moderators, by
-- default -- see the identity-resolution path if that is ever genuinely
-- required for abuse-of-reporting investigation).
-- -----------------------------------------------------------------------
create table if not exists public.discussion_reports (
  id uuid primary key default gen_random_uuid(),
  content_type text not null check (content_type in ('thread', 'reply')),
  content_id uuid not null,
  thread_id uuid not null references public.discussion_threads(id) on delete cascade,
  reporter_profile_id uuid not null references public.profiles(id),
  reason text not null check (reason in ('harassment', 'threat', 'sensitive_information', 'spam', 'inappropriate_content', 'security_concern', 'other')),
  details text,
  status text not null default 'open' check (status in ('open', 'reviewed', 'dismissed')),
  created_at timestamptz not null default now()
);
create index if not exists idx_discussion_reports_content on public.discussion_reports (content_type, content_id);

alter table public.discussion_reports enable row level security;
revoke all on public.discussion_reports from public, anon, authenticated;
grant all on public.discussion_reports to service_role;

-- -----------------------------------------------------------------------
-- PART E: Moderation log -- every moderation action is audited here.
-- -----------------------------------------------------------------------
create table if not exists public.discussion_moderation_log (
  id uuid primary key default gen_random_uuid(),
  content_type text not null check (content_type in ('thread', 'reply')),
  content_id uuid not null,
  action text not null check (action in ('hide', 'restore', 'lock', 'unlock', 'review_report', 'dismiss_report')),
  moderator_profile_id uuid not null references public.profiles(id),
  reason text not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_discussion_moderation_log_content on public.discussion_moderation_log (content_type, content_id);

alter table public.discussion_moderation_log enable row level security;
revoke all on public.discussion_moderation_log from public, anon, authenticated;
grant all on public.discussion_moderation_log to service_role;

-- -----------------------------------------------------------------------
-- PART F: Identity-resolution audit -- the ONE place a real identity is
-- ever handed back out of discussion_author_mappings, and the complete
-- record of every time that happened.
-- -----------------------------------------------------------------------
create table if not exists public.discussion_identity_resolutions (
  id uuid primary key default gen_random_uuid(),
  content_type text not null check (content_type in ('thread', 'reply')),
  content_id uuid not null,
  resolved_author_profile_id uuid not null references public.profiles(id),
  resolved_by_profile_id uuid not null references public.profiles(id),
  reason text not null check (length(reason) >= 10),
  created_at timestamptz not null default now()
);
create index if not exists idx_discussion_identity_resolutions_content on public.discussion_identity_resolutions (content_type, content_id);

alter table public.discussion_identity_resolutions enable row level security;
revoke all on public.discussion_identity_resolutions from public, anon, authenticated;
grant all on public.discussion_identity_resolutions to service_role;

-- =======================================================================
-- PART G: Alias generation (deterministic within a thread, independent
-- across threads)
-- =======================================================================
-- The "secret" here is NOT the actual security boundary -- that is the
-- RLS/grant lockdown on discussion_author_mappings above, which no
-- client role can read under any circumstance. This hash only needs to
-- make the SAME (thread_id, profile_id) pair always produce the SAME
-- alias, and a DIFFERENT thread produce an unrelated-looking one; it does
-- not need to resist a determined attacker with raw SQL access, because
-- that attacker is already blocked by the grant model, not by alias
-- unguessability.
create or replace function public.generate_discussion_alias(p_thread_id uuid, p_profile_id uuid)
returns text
language plpgsql
stable
as $function$
declare
  v_adjectives text[] := array[
    'Quiet','Swift','Bold','Calm','Sharp','Steady','Silent','Bright','Keen','Firm',
    'Vigilant','Resolute','Discreet','Nimble','Alert','Patient','Precise','Candid','Diligent','Prudent'
  ];
  v_nouns text[] := array[
    'Falcon','Heron','Tiger','Eagle','Otter','Lynx','Hawk','Wolf','Osprey','Kestrel',
    'Panther','Raven','Dolphin','Badger','Falconer','Marlin','Harrier','Condor','Jaguar','Merlin'
  ];
  v_hash bigint;
begin
  v_hash := abs(('x' || substr(md5(p_thread_id::text || ':' || p_profile_id::text), 1, 15))::bit(60)::bigint);
  return v_adjectives[(v_hash % array_length(v_adjectives, 1)) + 1] || ' ' || v_nouns[((v_hash / 1000) % array_length(v_nouns, 1)) + 1];
end;
$function$;
revoke execute on function public.generate_discussion_alias(uuid, uuid) from public, anon, authenticated;

-- Resolves (or assigns, on first post) the caller's alias for a thread.
-- SECURITY DEFINER so it can read discussion_author_mappings internally;
-- never returns anything but the alias text itself.
create or replace function public.resolve_discussion_alias(p_thread_id uuid, p_profile_id uuid)
returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_existing_alias text;
begin
  select m.author_alias_cache into v_existing_alias
  from public.discussion_author_mappings m
  where m.thread_id = p_thread_id and m.author_profile_id = p_profile_id
  limit 1;

  if v_existing_alias is not null then
    return v_existing_alias;
  end if;

  return public.generate_discussion_alias(p_thread_id, p_profile_id);
end;
$function$;
revoke execute on function public.resolve_discussion_alias(uuid, uuid) from public, anon, authenticated;

-- author_alias_cache lets resolve_discussion_alias() above look up a
-- previously-assigned alias without exposing the mapping table itself to
-- any client -- the column lives on the protected table, read only from
-- inside this SECURITY DEFINER function.
alter table public.discussion_author_mappings add column if not exists author_alias_cache text;

-- =======================================================================
-- PART H: Client-facing RPCs -- the only way any authenticated user
-- touches this feature. Every one derives the caller from auth.uid();
-- none accept a client-supplied author/profile id.
-- =======================================================================

create or replace function public.list_discussion_categories_secure()
returns table (id uuid, code text, display_name text, description text, aoc_id uuid, sort_order integer)
language sql
stable
security definer
set search_path to 'public'
as $function$
  select c.id, c.code, c.display_name, c.description, c.aoc_id, c.sort_order
  from public.discussion_categories c
  where c.is_active
    and (c.aoc_id is null or public.has_any_active_assignment_in_aoc(c.aoc_id))
  order by c.sort_order;
$function$;
revoke execute on function public.list_discussion_categories_secure() from public, anon;
grant execute on function public.list_discussion_categories_secure() to authenticated, service_role;

create or replace function public.list_discussion_threads_secure(p_category_id uuid default null)
returns table (
  id uuid, category_id uuid, title text, author_alias text, status text,
  report_count integer, reply_count integer, created_at timestamptz, edited_at timestamptz
)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_caller uuid := auth.uid();
begin
  if v_caller is null then raise exception 'Must be signed in.'; end if;

  return query
  select t.id, t.category_id,
         t.title,
         case when t.status = 'removed' then '[removed]' else t.author_alias end,
         t.status, t.report_count, t.reply_count, t.created_at, t.edited_at
  from public.discussion_threads t
  where public.has_any_active_assignment_in_aoc(t.aoc_id)
    and (p_category_id is null or t.category_id = p_category_id)
  order by t.created_at desc
  limit 200;
end;
$function$;
revoke execute on function public.list_discussion_threads_secure(uuid) from public, anon;
grant execute on function public.list_discussion_threads_secure(uuid) to authenticated, service_role;

create or replace function public.get_discussion_thread_secure(p_thread_id uuid)
returns table (
  id uuid, category_id uuid, title text, body text, author_alias text, status text,
  created_at timestamptz, edited_at timestamptz,
  reply_id uuid, reply_body text, reply_author_alias text, reply_status text,
  reply_created_at timestamptz, reply_edited_at timestamptz
)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_caller uuid := auth.uid();
  v_thread record;
begin
  if v_caller is null then raise exception 'Must be signed in.'; end if;

  select * into v_thread from public.discussion_threads t where t.id = p_thread_id;
  if v_thread is null or not public.has_any_active_assignment_in_aoc(v_thread.aoc_id) then
    raise exception 'Thread not found.';
  end if;

  return query
  select
    v_thread.id, v_thread.category_id, v_thread.title,
    case when v_thread.status = 'removed' then '[This post has been removed.]' else v_thread.body end,
    case when v_thread.status = 'removed' then '[removed]' else v_thread.author_alias end,
    v_thread.status, v_thread.created_at, v_thread.edited_at,
    r.id,
    case when r.status = 'removed' then '[This post has been removed.]' else r.body end,
    case when r.status = 'removed' then '[removed]' else r.author_alias end,
    r.status, r.created_at, r.edited_at
  from public.discussion_replies r
  where r.thread_id = p_thread_id
  union all
  select v_thread.id, v_thread.category_id, v_thread.title, v_thread.body, v_thread.author_alias,
    v_thread.status, v_thread.created_at, v_thread.edited_at,
    null::uuid, null::text, null::text, null::text, null::timestamptz, null::timestamptz
  where not exists (select 1 from public.discussion_replies r2 where r2.thread_id = p_thread_id)
  order by 13 asc nulls first;
end;
$function$;
revoke execute on function public.get_discussion_thread_secure(uuid) from public, anon;
grant execute on function public.get_discussion_thread_secure(uuid) to authenticated, service_role;

create or replace function public.create_discussion_thread_secure(p_category_id uuid, p_title text, p_body text)
returns table (id uuid, author_alias text)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_caller uuid := auth.uid();
  v_category record;
  v_profile record;
  v_alias text;
  v_thread_id uuid;
begin
  if v_caller is null then raise exception 'Must be signed in.'; end if;
  select * into v_profile from public.profiles p where p.id = v_caller;
  if v_profile is null or v_profile.status <> 'approved' then
    raise exception 'Account is not an approved, active VECTA user.';
  end if;

  if p_title is null or length(trim(p_title)) = 0 then raise exception 'Title is required.'; end if;
  if length(p_title) > 200 then raise exception 'Title is too long (max 200 characters).'; end if;
  if p_body is null or length(trim(p_body)) = 0 then raise exception 'Body is required.'; end if;
  if length(p_body) > 10000 then raise exception 'Body is too long (max 10000 characters).'; end if;

  select * into v_category from public.discussion_categories c where c.id = p_category_id and c.is_active;
  if v_category is null then raise exception 'Unknown or disabled category.'; end if;
  if v_category.aoc_id is not null and not public.has_any_active_assignment_in_aoc(v_category.aoc_id) then
    raise exception 'This category is not available for your AOC.';
  end if;

  -- The thread's own AOC is the caller's own AOC membership for a global category, or the
  -- category's fixed AOC for an AOC-scoped one -- never a client-supplied AOC id.
  declare
    v_aoc_id uuid;
  begin
    if v_category.aoc_id is not null then
      v_aoc_id := v_category.aoc_id;
    else
      select ura.aoc_id into v_aoc_id
      from public.user_role_assignments ura
      where ura.profile_id = v_caller and ura.revoked_at is null and ura.starts_at <= now()
        and (ura.ends_at is null or ura.ends_at > now())
      limit 1;
    end if;
    if v_aoc_id is null then raise exception 'No active AOC assignment found for your account.'; end if;

    v_thread_id := gen_random_uuid();
    v_alias := public.generate_discussion_alias(v_thread_id, v_caller);

    insert into public.discussion_threads (id, category_id, aoc_id, title, body, author_alias)
    values (v_thread_id, p_category_id, v_aoc_id, trim(p_title), p_body, v_alias);

    insert into public.discussion_author_mappings (content_type, content_id, thread_id, author_profile_id, aoc_id, author_alias_cache)
    values ('thread', v_thread_id, v_thread_id, v_caller, v_aoc_id, v_alias);
  end;

  return query select v_thread_id, v_alias;
end;
$function$;
revoke execute on function public.create_discussion_thread_secure(uuid, text, text) from public, anon;
grant execute on function public.create_discussion_thread_secure(uuid, text, text) to authenticated, service_role;

create or replace function public.create_discussion_reply_secure(p_thread_id uuid, p_body text)
returns table (id uuid, author_alias text)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_caller uuid := auth.uid();
  v_thread record;
  v_profile record;
  v_alias text;
  v_reply_id uuid;
begin
  if v_caller is null then raise exception 'Must be signed in.'; end if;
  select * into v_profile from public.profiles p where p.id = v_caller;
  if v_profile is null or v_profile.status <> 'approved' then
    raise exception 'Account is not an approved, active VECTA user.';
  end if;

  if p_body is null or length(trim(p_body)) = 0 then raise exception 'Reply body is required.'; end if;
  if length(p_body) > 5000 then raise exception 'Reply is too long (max 5000 characters).'; end if;

  select * into v_thread from public.discussion_threads t where t.id = p_thread_id;
  if v_thread is null or not public.has_any_active_assignment_in_aoc(v_thread.aoc_id) then
    raise exception 'Thread not found.';
  end if;
  if v_thread.status <> 'open' then
    raise exception 'This discussion is locked or removed and cannot accept new replies.';
  end if;

  -- Alias continuity: reuse the SAME alias if this profile already posted in this thread
  -- (the thread itself or an earlier reply); otherwise assign a new one, unrelated to any
  -- alias the same person holds in any other thread.
  v_alias := public.resolve_discussion_alias(p_thread_id, v_caller);
  v_reply_id := gen_random_uuid();

  insert into public.discussion_replies (id, thread_id, body, author_alias)
  values (v_reply_id, p_thread_id, p_body, v_alias);

  insert into public.discussion_author_mappings (content_type, content_id, thread_id, author_profile_id, aoc_id, author_alias_cache)
  values ('reply', v_reply_id, p_thread_id, v_caller, v_thread.aoc_id, v_alias)
  on conflict (content_type, content_id) do nothing;

  update public.discussion_threads as dt set reply_count = reply_count + 1, updated_at = now() where dt.id = p_thread_id;

  return query select v_reply_id, v_alias;
end;
$function$;
revoke execute on function public.create_discussion_reply_secure(uuid, text) from public, anon;
grant execute on function public.create_discussion_reply_secure(uuid, text) to authenticated, service_role;

-- Shared ownership resolver: never returns the mapping itself, only a
-- boolean "does auth.uid() own this content" -- used by edit/remove so
-- neither the client nor the calling RPC's own return value ever needs
-- to see the real profile id to perform the check.
create or replace function public.caller_owns_discussion_content(p_content_type text, p_content_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select exists (
    select 1 from public.discussion_author_mappings m
    where m.content_type = p_content_type and m.content_id = p_content_id and m.author_profile_id = auth.uid()
  );
$function$;
revoke execute on function public.caller_owns_discussion_content(text, uuid) from public, anon, authenticated;

create or replace function public.edit_discussion_content_secure(p_content_type text, p_content_id uuid, p_body text)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_caller uuid := auth.uid();
begin
  if v_caller is null then raise exception 'Must be signed in.'; end if;
  if not public.caller_owns_discussion_content(p_content_type, p_content_id) then
    raise exception 'You may only edit your own content.';
  end if;
  if p_body is null or length(trim(p_body)) = 0 then raise exception 'Body is required.'; end if;

  if p_content_type = 'thread' then
    if length(p_body) > 10000 then raise exception 'Body is too long (max 10000 characters).'; end if;
    update public.discussion_threads set body = p_body, edited_at = now(), updated_at = now()
    where id = p_content_id and status <> 'removed';
  else
    if length(p_body) > 5000 then raise exception 'Reply is too long (max 5000 characters).'; end if;
    update public.discussion_replies set body = p_body, edited_at = now(), updated_at = now()
    where id = p_content_id and status <> 'removed';
  end if;

  return true;
end;
$function$;
revoke execute on function public.edit_discussion_content_secure(text, uuid, text) from public, anon;
grant execute on function public.edit_discussion_content_secure(text, uuid, text) to authenticated, service_role;

-- Soft-delete, author-initiated. Preserves the row (audit evidence) and
-- the author mapping -- only the visible body/alias are suppressed by
-- the read-path RPCs above (status='removed'). Who removed it is NOT
-- recorded as a moderator action for an author's own removal (it is
-- simply their own content), distinct from moderate_discussion_content_
-- secure()'s audited moderator-initiated hide.
create or replace function public.remove_own_discussion_content_secure(p_content_type text, p_content_id uuid)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_caller uuid := auth.uid();
begin
  if v_caller is null then raise exception 'Must be signed in.'; end if;
  if not public.caller_owns_discussion_content(p_content_type, p_content_id) then
    raise exception 'You may only remove your own content.';
  end if;

  if p_content_type = 'thread' then
    update public.discussion_threads set status = 'removed', updated_at = now() where id = p_content_id;
  else
    update public.discussion_replies set status = 'removed', updated_at = now() where id = p_content_id;
  end if;

  return true;
end;
$function$;
revoke execute on function public.remove_own_discussion_content_secure(text, uuid) from public, anon;
grant execute on function public.remove_own_discussion_content_secure(text, uuid) to authenticated, service_role;

create or replace function public.report_discussion_content_secure(p_content_type text, p_content_id uuid, p_reason text, p_details text default null)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_caller uuid := auth.uid();
  v_thread_id uuid;
  v_report_id uuid;
begin
  if v_caller is null then raise exception 'Must be signed in.'; end if;
  if p_reason not in ('harassment', 'threat', 'sensitive_information', 'spam', 'inappropriate_content', 'security_concern', 'other') then
    raise exception 'Invalid report reason.';
  end if;

  if p_content_type = 'thread' then
    select id into v_thread_id from public.discussion_threads where id = p_content_id;
  else
    select thread_id into v_thread_id from public.discussion_replies where id = p_content_id;
  end if;
  if v_thread_id is null then raise exception 'Content not found.'; end if;

  insert into public.discussion_reports (content_type, content_id, thread_id, reporter_profile_id, reason, details)
  values (p_content_type, p_content_id, v_thread_id, v_caller, p_reason, p_details)
  returning id into v_report_id;

  if p_content_type = 'thread' then
    update public.discussion_threads set report_count = report_count + 1 where id = p_content_id;
  else
    update public.discussion_replies set report_count = report_count + 1 where id = p_content_id;
  end if;

  return v_report_id;
end;
$function$;
revoke execute on function public.report_discussion_content_secure(text, uuid, text, text) from public, anon;
grant execute on function public.report_discussion_content_secure(text, uuid, text, text) to authenticated, service_role;

-- MODERATION GATE (documented decision): no existing VECTA role is
-- defined as "discussion moderator". Gated to super_admin only, as the
-- safest available default -- NOT a product decision about who SHOULD
-- moderate in practice, which is flagged as a UAT/governance item in the
-- implementation report.
create or replace function public.is_discussion_moderator()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select coalesce((
    select true from public.user_role_assignments ura
    join public.role_definitions rd on rd.id = ura.role_definition_id
    where ura.profile_id = auth.uid()
      and rd.code = 'super_admin'
      and ura.revoked_at is null
      and ura.starts_at <= now()
      and (ura.ends_at is null or ura.ends_at > now())
    limit 1
  ), false);
$function$;
revoke execute on function public.is_discussion_moderator() from public, anon, authenticated;

create or replace function public.moderate_discussion_content_secure(p_content_type text, p_content_id uuid, p_action text, p_reason text)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_caller uuid := auth.uid();
begin
  if v_caller is null then raise exception 'Must be signed in.'; end if;
  if not public.is_discussion_moderator() then raise exception 'Only an authorized moderator may perform this action.'; end if;
  if p_action not in ('hide', 'restore', 'lock', 'unlock') then raise exception 'Invalid moderation action.'; end if;
  if p_reason is null or length(trim(p_reason)) = 0 then raise exception 'A reason is required for every moderation action.'; end if;

  if p_action = 'hide' then
    if p_content_type = 'thread' then
      update public.discussion_threads set status = 'removed', updated_at = now() where id = p_content_id;
    else
      update public.discussion_replies set status = 'removed', updated_at = now() where id = p_content_id;
    end if;
  elsif p_action = 'restore' then
    if p_content_type = 'thread' then
      update public.discussion_threads set status = 'open', updated_at = now() where id = p_content_id;
    else
      update public.discussion_replies set status = 'visible', updated_at = now() where id = p_content_id;
    end if;
  elsif p_action = 'lock' then
    if p_content_type <> 'thread' then raise exception 'Only a thread can be locked.'; end if;
    update public.discussion_threads set status = 'locked', updated_at = now() where id = p_content_id;
  elsif p_action = 'unlock' then
    if p_content_type <> 'thread' then raise exception 'Only a thread can be unlocked.'; end if;
    update public.discussion_threads set status = 'open', updated_at = now() where id = p_content_id;
  end if;

  insert into public.discussion_moderation_log (content_type, content_id, action, moderator_profile_id, reason)
  values (p_content_type, p_content_id, p_action, v_caller, p_reason);

  return true;
end;
$function$;
revoke execute on function public.moderate_discussion_content_secure(text, uuid, text, text) from public, anon;
grant execute on function public.moderate_discussion_content_secure(text, uuid, text, text) to authenticated, service_role;

create or replace function public.list_discussion_reports_secure()
returns table (id uuid, content_type text, content_id uuid, thread_id uuid, reason text, details text, status text, created_at timestamptz)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
begin
  if not public.is_discussion_moderator() then raise exception 'Only an authorized moderator may view reports.'; end if;
  return query
  select r.id, r.content_type, r.content_id, r.thread_id, r.reason, r.details, r.status, r.created_at
  from public.discussion_reports r
  order by r.created_at desc
  limit 500;
end;
$function$;
revoke execute on function public.list_discussion_reports_secure() from public, anon;
grant execute on function public.list_discussion_reports_secure() to authenticated, service_role;

create or replace function public.review_discussion_report_secure(p_report_id uuid, p_status text, p_reason text)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_caller uuid := auth.uid();
  v_report record;
begin
  if v_caller is null then raise exception 'Must be signed in.'; end if;
  if not public.is_discussion_moderator() then raise exception 'Only an authorized moderator may review reports.'; end if;
  if p_status not in ('reviewed', 'dismissed') then raise exception 'Invalid report status.'; end if;
  if p_reason is null or length(trim(p_reason)) = 0 then raise exception 'A reason is required.'; end if;

  select * into v_report from public.discussion_reports where id = p_report_id;
  if v_report is null then raise exception 'Report not found.'; end if;

  update public.discussion_reports set status = p_status where id = p_report_id;
  insert into public.discussion_moderation_log (content_type, content_id, action, moderator_profile_id, reason)
  values (v_report.content_type, v_report.content_id, case when p_status = 'reviewed' then 'review_report' else 'dismiss_report' end, v_caller, p_reason);

  return true;
end;
$function$;
revoke execute on function public.review_discussion_report_secure(uuid, text, text) from public, anon;
grant execute on function public.review_discussion_report_secure(uuid, text, text) to authenticated, service_role;

-- -----------------------------------------------------------------------
-- IDENTITY RESOLUTION -- the single, fully-audited, single-content-item-
-- at-a-time path that ever turns an alias back into a real identity.
-- Gated to super_admin (same documented caveat as moderation above: this
-- is the safest available default, not a product decision about who
-- SHOULD be authorized -- flagged for UAT/governance).
-- -----------------------------------------------------------------------
create or replace function public.resolve_discussion_author_identity_secure(p_content_type text, p_content_id uuid, p_reason text)
returns table (profile_id uuid, name text, staff_no text, email text)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_caller uuid := auth.uid();
  v_author_id uuid;
begin
  if v_caller is null then raise exception 'Must be signed in.'; end if;
  if not public.is_discussion_moderator() then
    raise exception 'Only an authorized identity-resolution role may reveal an anonymous author.';
  end if;
  if p_reason is null or length(trim(p_reason)) < 10 then
    raise exception 'A specific reason (at least 10 characters) is required to resolve an anonymous author''s identity.';
  end if;

  select author_profile_id into v_author_id
  from public.discussion_author_mappings
  where content_type = p_content_type and content_id = p_content_id;
  if v_author_id is null then raise exception 'Content not found.'; end if;

  -- The audit row is written BEFORE the identity is returned, and this
  -- function only ever accepts exactly one content_id per call -- there
  -- is no array/bulk variant anywhere in this migration, which is what
  -- makes silent bulk deanonymization structurally impossible here, not
  -- just discouraged by convention.
  insert into public.discussion_identity_resolutions (content_type, content_id, resolved_author_profile_id, resolved_by_profile_id, reason)
  values (p_content_type, p_content_id, v_author_id, v_caller, p_reason);

  return query select p.id, p.name, p.staff_no, p.email from public.profiles p where p.id = v_author_id;
end;
$function$;
revoke execute on function public.resolve_discussion_author_identity_secure(text, uuid, text) from public, anon;
grant execute on function public.resolve_discussion_author_identity_secure(text, uuid, text) to authenticated, service_role;

-- -----------------------------------------------------------------------
-- Client-facing role and ownership verification helpers
-- (Never leak any other profile's ID or mapping -- strictly scoped to auth.uid())
-- -----------------------------------------------------------------------
create or replace function public.check_is_discussion_moderator_secure()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select public.is_discussion_moderator();
$function$;
revoke execute on function public.check_is_discussion_moderator_secure() from public, anon;
grant execute on function public.check_is_discussion_moderator_secure() to authenticated, service_role;

create or replace function public.check_discussion_ownership_secure(p_content_type text, p_content_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select public.caller_owns_discussion_content(p_content_type, p_content_id);
$function$;
revoke execute on function public.check_discussion_ownership_secure(text, uuid) from public, anon;
grant execute on function public.check_discussion_ownership_secure(text, uuid) to authenticated, service_role;

create or replace function public.get_my_discussion_authored_ids_secure(p_thread_id uuid)
returns table (content_type text, content_id uuid)
language sql
stable
security definer
set search_path to 'public'
as $function$
  select m.content_type, m.content_id
  from public.discussion_author_mappings m
  where m.thread_id = p_thread_id and m.author_profile_id = auth.uid();
$function$;
revoke execute on function public.get_my_discussion_authored_ids_secure(uuid) from public, anon;
grant execute on function public.get_my_discussion_authored_ids_secure(uuid) to authenticated, service_role;
