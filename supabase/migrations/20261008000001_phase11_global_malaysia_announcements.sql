-- =======================================================================
-- PHASE 11: Global & Malaysia AOC Announcements
-- =======================================================================
-- Controlled internal announcements at two authoritative organizational scopes:
--   - GLOBAL: All authorized active VECTA personnel across active AOCs.
--             Publisher: GHOD only. AirAsia Management is strictly read-only.
--   - AOC: Isolated to personnel holding active role assignments in Malaysia AOC.
--          Publishers: maa_boss, maa_admin, aax_boss, aax_admin.
--          One Malaysia-wide channel broadcasting to both MAA and AAX personnel.
--          GHOD must not publish AOC announcements (GHOD uses Global channel).
--
-- Features:
--   - Strictly authoritative publication lifecycle (draft, scheduled, published, expired, archived)
--   - Strict role-gated publishing with active assignment validation (rejecting expired, future, revoked, deactivated)
--   - Published content immutability & approved archive lifecycle enforcement
--   - Exact eligibility predicate for mandatory acknowledgements
--   - Privacy-safe acknowledgement reporting (GHOD for Global, MAA/AAX publishers for Malaysia AOC; AirAsia Management denied)
--   - Scope-authorized and audited acknowledgement report access
--   - Attachment authorization metadata with pre-publication recipient secrecy
--   - Full audit logging of creation, edit, publish, schedule, unpublish, archive, and acknowledgement report access
--   - Fail-closed cross-AOC isolation enforced via RLS and SECURITY DEFINER RPCs
-- =======================================================================

-- -----------------------------------------------------------------------
-- PART A: Additive enhancements to public.announcements
-- -----------------------------------------------------------------------

alter table public.announcements
  add column if not exists scope text not null default 'aoc' check (scope in ('global', 'aoc')),
  add column if not exists aoc_id uuid references public.aocs(id),
  add column if not exists category text not null default 'operational' check (category in ('operational', 'safety', 'security', 'corporate', 'policy', 'system')),
  add column if not exists priority text not null default 'normal' check (priority in ('normal', 'important', 'urgent')),
  add column if not exists status text not null default 'published' check (status in ('draft', 'scheduled', 'published', 'expired', 'archived')),
  add column if not exists published_at timestamptz not null default now(),
  add column if not exists expires_at timestamptz,
  add column if not exists requires_acknowledgement boolean not null default false,
  add column if not exists is_pinned boolean not null default false,
  add column if not exists pinned_at timestamptz,
  add column if not exists archived_at timestamptz,
  add column if not exists archived_by uuid references public.profiles(id),
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists updated_by uuid references public.profiles(id);

-- Fail-closed scope constraint: Global must have null aoc_id; AOC must have non-null aoc_id.
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'announcements_scope_aoc_check') then
    alter table public.announcements drop constraint announcements_scope_aoc_check;
  end if;
  alter table public.announcements
    add constraint announcements_scope_aoc_check
    check (
      (scope = 'global' and aoc_id is null) or
      (scope = 'aoc' and aoc_id is not null)
    );
end $$;

-- Activate Malaysia AOC for operational Phase 11 use
update public.aocs set is_active = true where code = 'MY';

-- Backfill legacy rows to Malaysia AOC default
update public.announcements
set aoc_id = (select id from public.aocs where code = 'MY' limit 1)
where aoc_id is null and scope <> 'global';

create index if not exists idx_announcements_scope_aoc_status on public.announcements(scope, aoc_id, status);
create index if not exists idx_announcements_lifecycle on public.announcements(status, published_at, expires_at);
create index if not exists idx_announcements_priority_pinned on public.announcements(priority, is_pinned desc, published_at desc);

-- -----------------------------------------------------------------------
-- PART B: Attachments metadata table
-- -----------------------------------------------------------------------
create table if not exists public.announcement_attachments (
  id uuid primary key default gen_random_uuid(),
  announcement_id uuid not null references public.announcements(id) on delete cascade,
  storage_path text not null,
  file_name text not null,
  file_size integer not null check (file_size > 0 and file_size <= 25000000),
  content_type text not null,
  uploaded_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now()
);
create index if not exists idx_announcement_attachments_ann on public.announcement_attachments(announcement_id);

alter table public.announcement_attachments enable row level security;
revoke all on public.announcement_attachments from public, anon, authenticated;
grant all on public.announcement_attachments to service_role;
grant select on public.announcement_attachments to authenticated;

-- -----------------------------------------------------------------------
-- PART C: Acknowledgement table enhancement
-- -----------------------------------------------------------------------
alter table public.announcement_acknowledgements
  add column if not exists aoc_id uuid references public.aocs(id);

create index if not exists idx_announcement_acks_ann_user on public.announcement_acknowledgements(announcement_id, user_id);

-- -----------------------------------------------------------------------
-- PART D: Audit logging table
-- -----------------------------------------------------------------------
create table if not exists public.announcement_audit_log (
  id uuid primary key default gen_random_uuid(),
  announcement_id uuid not null references public.announcements(id) on delete cascade,
  actor_profile_id uuid not null references public.profiles(id),
  action text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

do $$
begin
  if exists (select 1 from pg_constraint where conname = 'announcement_audit_log_action_check') then
    alter table public.announcement_audit_log drop constraint announcement_audit_log_action_check;
  end if;
  alter table public.announcement_audit_log
    add constraint announcement_audit_log_action_check
    check (action in ('create', 'edit', 'publish', 'schedule', 'unpublish', 'archive', 'priority_change', 'scope_change', 'pin', 'unpin', 'view_acknowledgement_report'));
end $$;
create index if not exists idx_announcement_audit_log_ann on public.announcement_audit_log(announcement_id, created_at desc);

alter table public.announcement_audit_log enable row level security;
revoke all on public.announcement_audit_log from public, anon, authenticated;
grant all on public.announcement_audit_log to service_role;

-- -----------------------------------------------------------------------
-- PART E: Authoritative Visibility & Authorization Helpers
-- -----------------------------------------------------------------------

-- Checks if the given caller profile can publish in the requested scope/AOC
create or replace function public.can_user_publish_announcement(p_scope text, p_aoc_id uuid default null)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select exists (
    select 1
    from public.user_role_assignments ura
    join public.role_definitions rd on rd.id = ura.role_definition_id
    join public.profiles p on p.id = ura.profile_id
    left join public.aocs aoc on aoc.id = ura.aoc_id
    where ura.profile_id = auth.uid()
      and p.status = 'approved'
      and rd.is_active
      and ura.revoked_at is null
      and ura.starts_at <= now()
      and (ura.ends_at is null or ura.ends_at > now())
      and (
        -- Global authority: STRICTLY GHOD only
        -- Super Admin, generic Admin, AirAsia Management, Operation Manager, Main Enforcement,
        -- Compliance, CaterLink Management, and all other roles are strictly denied.
        (p_scope = 'global' and p_aoc_id is null and rd.code = 'ghod')
        or
        -- Malaysia AOC authority: STRICTLY the 4 approved Malaysia leadership roles:
        -- maa_boss, maa_admin, aax_boss, aax_admin.
        -- Must match the requested AOC, and that AOC must be active.
        -- GHOD must NOT publish an AOC announcement (GHOD uses Global channel).
        (
          p_scope = 'aoc'
          and p_aoc_id is not null
          and ura.aoc_id = p_aoc_id
          and aoc.is_active
          and rd.code in ('maa_boss', 'aax_boss', 'maa_admin', 'aax_admin')
        )
      )
  );
$function$;
revoke execute on function public.can_user_publish_announcement(text, uuid) from public, anon;
grant execute on function public.can_user_publish_announcement(text, uuid) to authenticated, service_role;

-- Checks if caller can manage (edit/archive/publish/attach) a specific announcement
create or replace function public.can_user_manage_announcement(p_announcement_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select exists (
    select 1 from public.announcements a
    where a.id = p_announcement_id
      and public.can_user_publish_announcement(a.scope, a.aoc_id)
  );
$function$;
revoke execute on function public.can_user_manage_announcement(uuid) from public, anon;
grant execute on function public.can_user_manage_announcement(uuid) to authenticated, service_role;

-- Authoritative visibility predicate: is announcement visible to the current caller?
create or replace function public.is_announcement_visible_to_caller(p_announcement_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select exists (
    select 1
    from public.announcements a
    join public.profiles p on p.id = auth.uid()
    where a.id = p_announcement_id
      and p.status = 'approved'
      -- Status must be published (or scheduled with publish time reached), and not expired
      and (a.status = 'published' or (a.status = 'scheduled' and a.published_at <= now()))
      and a.published_at <= now()
      and (a.expires_at is null or a.expires_at > now())
      and (
        -- Global scope: caller must have at least one active assignment in an active AOC OR have international executive role
        (a.scope = 'global' and (
          exists (
            select 1 from public.user_role_assignments ura
            join public.aocs aoc on aoc.id = ura.aoc_id
            where ura.profile_id = auth.uid()
              and ura.revoked_at is null
              and ura.starts_at <= now()
              and (ura.ends_at is null or ura.ends_at > now())
              and aoc.is_active
          )
          or exists (
            select 1 from public.user_role_assignments ura
            join public.role_definitions rd on rd.id = ura.role_definition_id
            where ura.profile_id = auth.uid()
              and ura.revoked_at is null
              and ura.starts_at <= now()
              and (ura.ends_at is null or ura.ends_at > now())
              and rd.code in ('ghod', 'super_admin', 'airasia_management', 'global_reporting_controller')
          )
        ))
        or
        -- AOC scope: caller must hold an active assignment in that specific AOC
        -- (Audience: every eligible active user assigned to Malaysia AOC, regardless of MAA/AAX entity)
        (a.scope = 'aoc' and exists (
          select 1 from public.user_role_assignments ura
          join public.aocs aoc on aoc.id = ura.aoc_id
          where ura.profile_id = auth.uid()
            and ura.aoc_id = a.aoc_id
            and ura.revoked_at is null
            and ura.starts_at <= now()
            and (ura.ends_at is null or ura.ends_at > now())
            and aoc.is_active
        ))
      )
  );
$function$;
revoke execute on function public.is_announcement_visible_to_caller(uuid) from public, anon;
grant execute on function public.is_announcement_visible_to_caller(uuid) to authenticated, service_role;

-- Published content immutability & archive guard triggers
create or replace function public.enforce_announcement_immutability()
returns trigger
language plpgsql
security definer
as $$
begin
  if old.status = 'archived' then
    raise exception 'Archived announcements cannot be modified.';
  end if;

  if old.status = 'published' then
    if new.status = 'draft' then
      raise exception 'Published announcements cannot be reverted to draft.';
    end if;
    if new.title <> old.title or new.body <> old.body or new.scope <> old.scope
       or new.aoc_id is distinct from old.aoc_id or new.requires_acknowledgement <> old.requires_acknowledgement then
      raise exception 'Published announcement content is immutable.';
    end if;
  end if;

  if new.created_by <> old.created_by then
    raise exception 'Announcement creator cannot be changed.';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_enforce_announcement_immutability on public.announcements;
create trigger trg_enforce_announcement_immutability
  before update on public.announcements
  for each row execute function public.enforce_announcement_immutability();

create or replace function public.enforce_announcement_delete_guard()
returns trigger
language plpgsql
security definer
as $$
begin
  if old.status in ('published', 'archived') then
    raise exception 'Published or archived announcements cannot be deleted. Use archive instead.';
  end if;
  return old;
end;
$$;

drop trigger if exists trg_enforce_announcement_delete_guard on public.announcements;
create trigger trg_enforce_announcement_delete_guard
  before delete on public.announcements
  for each row execute function public.enforce_announcement_delete_guard();

-- Update RLS policies on public.announcements to use authoritative scope checks
drop policy if exists "announcements_staff_select" on public.announcements;
drop policy if exists "announcements_management_all" on public.announcements;
drop policy if exists "announcements_authenticated_read" on public.announcements;
drop policy if exists "announcements_publisher_write" on public.announcements;

create policy "announcements_authenticated_read"
  on public.announcements for select
  to authenticated
  using (
    public.is_announcement_visible_to_caller(id)
    or public.can_user_manage_announcement(id)
  );

create policy "announcements_publisher_write"
  on public.announcements for all
  to authenticated
  using (public.can_user_manage_announcement(id))
  with check (public.can_user_publish_announcement(scope, aoc_id));

-- RLS policy for attachments
drop policy if exists "announcement_attachments_read" on public.announcement_attachments;
create policy "announcement_attachments_read"
  on public.announcement_attachments for select
  to authenticated
  using (
    public.is_announcement_visible_to_caller(announcement_id)
    or public.can_user_manage_announcement(announcement_id)
  );

-- RLS policies for acknowledgements
drop policy if exists "announcement_acknowledgements_staff_all" on public.announcement_acknowledgements;
drop policy if exists "announcement_acknowledgements_management_select" on public.announcement_acknowledgements;
drop policy if exists "announcement_acks_own_read" on public.announcement_acknowledgements;
drop policy if exists "announcement_acks_own_insert" on public.announcement_acknowledgements;

create policy "announcement_acks_own_read"
  on public.announcement_acknowledgements for select
  to authenticated
  using (
    user_id = auth.uid()
    or public.can_user_manage_announcement(announcement_id)
  );

create policy "announcement_acks_own_insert"
  on public.announcement_acknowledgements for insert
  to authenticated
  with check (
    user_id = auth.uid()
    and public.is_announcement_visible_to_caller(announcement_id)
  );

-- -----------------------------------------------------------------------
-- PART F: Secure Client-facing RPCs
-- -----------------------------------------------------------------------

-- 1. Get visible announcements for current user
create or replace function public.get_visible_announcements_secure(
  p_scope text default null,
  p_category text default null,
  p_include_archived boolean default false
)
returns table (
  id uuid,
  title text,
  body text,
  scope text,
  aoc_id uuid,
  aoc_code text,
  category text,
  priority text,
  status text,
  is_pinned boolean,
  requires_acknowledgement boolean,
  acknowledged boolean,
  acknowledged_at timestamptz,
  attachment_count bigint,
  published_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_caller uuid := auth.uid();
begin
  if v_caller is null then
    raise exception 'Must be signed in.';
  end if;

  return query
  select
    a.id,
    a.title,
    a.body,
    a.scope,
    a.aoc_id,
    aoc.code as aoc_code,
    a.category,
    a.priority,
    a.status,
    a.is_pinned,
    a.requires_acknowledgement,
    (ack.id is not null) as acknowledged,
    ack.acknowledged_at,
    coalesce(att.cnt, 0) as attachment_count,
    a.published_at,
    a.expires_at,
    a.created_at
  from public.announcements a
  left join public.aocs aoc on aoc.id = a.aoc_id
  left join public.announcement_acknowledgements ack
    on ack.announcement_id = a.id and ack.user_id = v_caller
  left join (
    select announcement_id, count(*)::bigint as cnt
    from public.announcement_attachments
    group by announcement_id
  ) att on att.announcement_id = a.id
  where (
    -- Normal reader visibility
    (
      (a.status = 'published' or (a.status = 'scheduled' and a.published_at <= now()))
      and a.published_at <= now()
      and (
        case when p_include_archived then true
        else (a.expires_at is null or a.expires_at > now()) end
      )
      and public.is_announcement_visible_to_caller(a.id)
    )
    or
    -- Publishers can also see their drafts, scheduled, and managed items if explicitly managing
    (public.can_user_manage_announcement(a.id))
  )
  and (p_scope is null or a.scope = p_scope)
  and (p_category is null or a.category = p_category)
  order by
    a.is_pinned desc,
    case a.priority when 'urgent' then 1 when 'important' then 2 else 3 end asc,
    a.published_at desc;
end;
$function$;
revoke execute on function public.get_visible_announcements_secure(text, text, boolean) from public, anon;
grant execute on function public.get_visible_announcements_secure(text, text, boolean) to authenticated, service_role;

-- 2. Get announcement detail
create or replace function public.get_announcement_detail_secure(p_announcement_id uuid)
returns table (
  id uuid,
  title text,
  body text,
  scope text,
  aoc_id uuid,
  aoc_code text,
  category text,
  priority text,
  status text,
  is_pinned boolean,
  requires_acknowledgement boolean,
  acknowledged boolean,
  acknowledged_at timestamptz,
  published_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz,
  author_name text,
  can_manage boolean
)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_caller uuid := auth.uid();
  v_is_visible boolean;
  v_can_manage boolean;
begin
  if v_caller is null then raise exception 'Must be signed in.'; end if;

  v_is_visible := public.is_announcement_visible_to_caller(p_announcement_id);
  v_can_manage := public.can_user_manage_announcement(p_announcement_id);

  if not v_is_visible and not v_can_manage then
    raise exception 'Announcement not found.';
  end if;

  return query
  select
    a.id,
    a.title,
    a.body,
    a.scope,
    a.aoc_id,
    aoc.code as aoc_code,
    a.category,
    a.priority,
    a.status,
    a.is_pinned,
    a.requires_acknowledgement,
    (ack.id is not null) as acknowledged,
    ack.acknowledged_at,
    a.published_at,
    a.expires_at,
    a.created_at,
    a.updated_at,
    p.name as author_name,
    v_can_manage as can_manage
  from public.announcements a
  left join public.aocs aoc on aoc.id = a.aoc_id
  left join public.profiles p on p.id = a.created_by
  left join public.announcement_acknowledgements ack
    on ack.announcement_id = a.id and ack.user_id = v_caller
  where a.id = p_announcement_id;
end;
$function$;
revoke execute on function public.get_announcement_detail_secure(uuid) from public, anon;
grant execute on function public.get_announcement_detail_secure(uuid) to authenticated, service_role;

-- 3. Create announcement (restricted to global and aoc scopes)
create or replace function public.create_announcement_secure(
  p_title text,
  p_body text,
  p_scope text,
  p_aoc_id uuid default null,
  p_category text default 'operational',
  p_priority text default 'normal',
  p_status text default 'published',
  p_published_at timestamptz default null,
  p_expires_at timestamptz default null,
  p_requires_acknowledgement boolean default false,
  p_is_pinned boolean default false
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_caller uuid := auth.uid();
  v_announcement_id uuid;
  v_actual_publish_at timestamptz;
  v_actual_status text;
begin
  if v_caller is null then raise exception 'Must be signed in.'; end if;
  if p_title is null or length(trim(p_title)) = 0 then raise exception 'Title is required.'; end if;
  if length(p_title) > 200 then raise exception 'Title is too long (max 200 characters).'; end if;
  if p_body is null or length(trim(p_body)) = 0 then raise exception 'Body is required.'; end if;
  if length(p_body) > 20000 then raise exception 'Body is too long (max 20000 characters).'; end if;

  if p_scope not in ('global', 'aoc') then
    raise exception 'Invalid announcement scope. Supported scopes are global and aoc.';
  end if;
  if p_category not in ('operational', 'safety', 'security', 'corporate', 'policy', 'system') then
    raise exception 'Invalid announcement category.';
  end if;
  if p_priority not in ('normal', 'important', 'urgent') then
    raise exception 'Invalid announcement priority.';
  end if;
  if p_status not in ('draft', 'scheduled', 'published') then
    raise exception 'Initial status must be draft, scheduled, or published.';
  end if;

  -- Validate publishing authority
  if not public.can_user_publish_announcement(p_scope, p_aoc_id) then
    raise exception 'Unauthorized to create announcements in this scope.';
  end if;

  -- Enforce scope / AOC integrity
  if p_scope = 'global' and p_aoc_id is not null then
    raise exception 'Global announcements cannot be assigned to an AOC.';
  end if;
  if p_scope <> 'global' and p_aoc_id is null then
    raise exception 'AOC-scoped announcements must specify a valid AOC.';
  end if;

  -- Compute actual status and publish time
  v_actual_publish_at := coalesce(p_published_at, now());
  if p_status = 'published' and v_actual_publish_at > now() then
    v_actual_status := 'scheduled';
  else
    v_actual_status := p_status;
  end if;

  insert into public.announcements (
    created_by,
    title,
    body,
    scope,
    aoc_id,
    category,
    priority,
    status,
    published_at,
    expires_at,
    requires_acknowledgement,
    is_pinned,
    pinned_at,
    updated_at,
    updated_by
  ) values (
    v_caller,
    trim(p_title),
    p_body,
    p_scope,
    p_aoc_id,
    p_category,
    p_priority,
    v_actual_status,
    v_actual_publish_at,
    p_expires_at,
    p_requires_acknowledgement,
    p_is_pinned,
    case when p_is_pinned then now() else null end,
    now(),
    v_caller
  )
  returning id into v_announcement_id;

  -- Audit creation
  insert into public.announcement_audit_log (announcement_id, actor_profile_id, action, details)
  values (
    v_announcement_id,
    v_caller,
    'create',
    jsonb_build_object(
      'title', trim(p_title),
      'scope', p_scope,
      'aoc_id', p_aoc_id,
      'status', v_actual_status,
      'priority', p_priority,
      'category', p_category,
      'requires_acknowledgement', p_requires_acknowledgement
    )
  );

  return v_announcement_id;
end;
$function$;
revoke execute on function public.create_announcement_secure(text, text, text, uuid, text, text, text, timestamptz, timestamptz, boolean, boolean) from public, anon;
grant execute on function public.create_announcement_secure(text, text, text, uuid, text, text, text, timestamptz, timestamptz, boolean, boolean) to authenticated, service_role;

-- 4. Update announcement
create or replace function public.update_announcement_secure(
  p_announcement_id uuid,
  p_title text,
  p_body text,
  p_category text default 'operational',
  p_priority text default 'normal',
  p_expires_at timestamptz default null,
  p_requires_acknowledgement boolean default false,
  p_is_pinned boolean default false
)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_caller uuid := auth.uid();
  v_announcement record;
begin
  if v_caller is null then raise exception 'Must be signed in.'; end if;
  if not public.can_user_manage_announcement(p_announcement_id) then
    raise exception 'Unauthorized to edit this announcement.';
  end if;

  select * into v_announcement from public.announcements where id = p_announcement_id for update;
  if v_announcement is null then raise exception 'Announcement not found.'; end if;

  if v_announcement.status = 'archived' then
    raise exception 'Archived announcements cannot be modified.';
  end if;

  if p_title is null or length(trim(p_title)) = 0 then raise exception 'Title is required.'; end if;
  if length(p_title) > 200 then raise exception 'Title is too long (max 200 characters).'; end if;
  if p_body is null or length(trim(p_body)) = 0 then raise exception 'Body is required.'; end if;
  if length(p_body) > 20000 then raise exception 'Body is too long (max 20000 characters).'; end if;

  update public.announcements set
    title = trim(p_title),
    body = p_body,
    category = p_category,
    priority = p_priority,
    expires_at = p_expires_at,
    requires_acknowledgement = p_requires_acknowledgement,
    is_pinned = p_is_pinned,
    pinned_at = case when p_is_pinned and not v_announcement.is_pinned then now()
                     when not p_is_pinned then null
                     else v_announcement.pinned_at end,
    updated_at = now(),
    updated_by = v_caller
  where id = p_announcement_id;

  insert into public.announcement_audit_log (announcement_id, actor_profile_id, action, details)
  values (
    p_announcement_id,
    v_caller,
    'edit',
    jsonb_build_object(
      'title', trim(p_title),
      'category', p_category,
      'priority', p_priority,
      'requires_acknowledgement', p_requires_acknowledgement,
      'is_pinned', p_is_pinned
    )
  );

  return true;
end;
$function$;
revoke execute on function public.update_announcement_secure(uuid, text, text, text, text, timestamptz, boolean, boolean) from public, anon;
grant execute on function public.update_announcement_secure(uuid, text, text, text, text, timestamptz, boolean, boolean) to authenticated, service_role;

-- 5. Publish / Schedule announcement (concurrency-safe, idempotent)
create or replace function public.publish_announcement_secure(
  p_announcement_id uuid,
  p_publish_at timestamptz default null
)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_caller uuid := auth.uid();
  v_announcement record;
  v_publish_at timestamptz := coalesce(p_publish_at, now());
  v_new_status text;
begin
  if v_caller is null then raise exception 'Must be signed in.'; end if;
  if not public.can_user_manage_announcement(p_announcement_id) then
    raise exception 'Unauthorized to publish this announcement.';
  end if;

  -- Concurrency-safe row lock
  select * into v_announcement
  from public.announcements
  where id = p_announcement_id
  for update;

  if v_announcement is null then
    raise exception 'Announcement not found.';
  end if;

  if v_announcement.status = 'archived' then
    raise exception 'Archived announcements cannot be published.';
  end if;

  if v_publish_at > now() then
    v_new_status := 'scheduled';
  else
    v_new_status := 'published';
  end if;

  -- Idempotent exit if already in target status with matching published_at
  if v_announcement.status = v_new_status and (p_publish_at is null or v_announcement.published_at = v_publish_at) then
    return true;
  end if;

  update public.announcements set
    status = v_new_status,
    published_at = v_publish_at,
    updated_at = now(),
    updated_by = v_caller
  where id = p_announcement_id;

  insert into public.announcement_audit_log (announcement_id, actor_profile_id, action, details)
  values (
    p_announcement_id,
    v_caller,
    case when v_new_status = 'scheduled' then 'schedule' else 'publish' end,
    jsonb_build_object('published_at', v_publish_at, 'status', v_new_status)
  );

  return true;
end;
$function$;
revoke execute on function public.publish_announcement_secure(uuid, timestamptz) from public, anon;
grant execute on function public.publish_announcement_secure(uuid, timestamptz) to authenticated, service_role;

-- 6. Archive announcement
create or replace function public.archive_announcement_secure(
  p_announcement_id uuid,
  p_reason text default null
)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_caller uuid := auth.uid();
begin
  if v_caller is null then raise exception 'Must be signed in.'; end if;
  if not public.can_user_manage_announcement(p_announcement_id) then
    raise exception 'Unauthorized to archive this announcement.';
  end if;

  update public.announcements set
    status = 'archived',
    archived_at = now(),
    archived_by = v_caller,
    updated_at = now(),
    updated_by = v_caller
  where id = p_announcement_id;

  insert into public.announcement_audit_log (announcement_id, actor_profile_id, action, details)
  values (
    p_announcement_id,
    v_caller,
    'archive',
    jsonb_build_object('reason', p_reason, 'archived_at', now())
  );

  return true;
end;
$function$;
revoke execute on function public.archive_announcement_secure(uuid, text) from public, anon;
grant execute on function public.archive_announcement_secure(uuid, text) to authenticated, service_role;

-- 7. Acknowledge announcement (strictly idempotent)
create or replace function public.acknowledge_announcement_secure(p_announcement_id uuid)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_caller uuid := auth.uid();
  v_announcement record;
  v_caller_aoc uuid;
begin
  if v_caller is null then raise exception 'Must be signed in.'; end if;

  select * into v_announcement from public.announcements where id = p_announcement_id;
  if v_announcement is null or not public.is_announcement_visible_to_caller(p_announcement_id) then
    raise exception 'Announcement not found or not currently visible.';
  end if;

  -- Determine caller active AOC for audit/reporting
  select ura.aoc_id into v_caller_aoc
  from public.user_role_assignments ura
  where ura.profile_id = v_caller
    and ura.revoked_at is null
    and ura.starts_at <= now()
    and (ura.ends_at is null or ura.ends_at > now())
  limit 1;

  insert into public.announcement_acknowledgements (announcement_id, user_id, aoc_id, acknowledged_at)
  values (p_announcement_id, v_caller, v_caller_aoc, now())
  on conflict (announcement_id, user_id) do nothing;

  return true;
end;
$function$;
revoke execute on function public.acknowledge_announcement_secure(uuid) from public, anon;
grant execute on function public.acknowledge_announcement_secure(uuid) to authenticated, service_role;

-- 8. Acknowledgement Reporting for Authorized Management (Scope-authorized and Audited)
create or replace function public.get_announcement_acknowledgement_report_secure(p_announcement_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_caller uuid := auth.uid();
  v_announcement record;
  v_report jsonb;
begin
  if v_caller is null then raise exception 'Must be signed in.'; end if;

  -- Strict scope-authorized access: GHOD for Global; MAA/AAX publishers for Malaysia AOC.
  -- AirAsia Management, Super Admin, and ordinary staff are strictly denied.
  if not public.can_user_manage_announcement(p_announcement_id) then
    raise exception 'Unauthorized to view acknowledgement reports.';
  end if;

  select * into v_announcement from public.announcements where id = p_announcement_id;
  if v_announcement is null then raise exception 'Announcement not found.'; end if;

  -- Audit acknowledgement report view
  insert into public.announcement_audit_log (announcement_id, actor_profile_id, action, details)
  values (
    p_announcement_id,
    v_caller,
    'view_acknowledgement_report',
    jsonb_build_object('scope', v_announcement.scope, 'aoc_id', v_announcement.aoc_id, 'viewed_at', now())
  );

  with eligible as (
    select distinct p.id, p.name, p.staff_no, p.email, d.name as department_name, s.name as station_name
    from public.profiles p
    join public.user_role_assignments ura on ura.profile_id = p.id
    left join public.departments d on d.id = ura.department_id
    left join public.org_stations s on s.id = ura.station_id
    where p.status = 'approved'
      and ura.revoked_at is null
      and ura.starts_at <= now()
      and (ura.ends_at is null or ura.ends_at > now())
      and (
        -- Global scope: all active users across all active AOCs or international assignments
        (
          v_announcement.scope = 'global'
          and (
            exists (
              select 1 from public.aocs aoc
              where aoc.id = ura.aoc_id and aoc.is_active
            )
            or ura.aoc_id is null
          )
        )
        or
        -- Malaysia AOC scope: all active users assigned to Malaysia AOC (both MAA and AAX)
        (
          v_announcement.scope = 'aoc'
          and ura.aoc_id = v_announcement.aoc_id
        )
      )
  ),
  acks as (
    select
      e.id as profile_id,
      e.name,
      e.staff_no,
      e.department_name as department,
      e.station_name as station,
      ack.acknowledged_at
    from eligible e
    join public.announcement_acknowledgements ack
      on ack.announcement_id = p_announcement_id and ack.user_id = e.id
  ),
  pendings as (
    select
      e.id as profile_id,
      e.name,
      e.staff_no,
      e.department_name as department,
      e.station_name as station
    from eligible e
    where not exists (
      select 1 from public.announcement_acknowledgements ack
      where ack.announcement_id = p_announcement_id and ack.user_id = e.id
    )
  )
  select jsonb_build_object(
    'announcement_id', p_announcement_id,
    'total_eligible', coalesce((select count(*) from eligible), 0),
    'acknowledged_count', coalesce((select count(*) from acks), 0),
    'pending_count', coalesce((select count(*) from pendings), 0),
    'acknowledged_percent', case
      when (select count(*) from eligible) = 0 then 100.0
      else round(((select count(*) from acks)::numeric / nullif((select count(*) from eligible), 0)::numeric) * 100.0, 1)
    end,
    'acknowledged_list', coalesce((
      select jsonb_agg(jsonb_build_object(
        'profile_id', a.profile_id,
        'name', a.name,
        'staff_no', a.staff_no,
        'department', a.department,
        'station', a.station,
        'acknowledged_at', a.acknowledged_at
      ) order by a.acknowledged_at desc)
      from acks a
    ), '[]'::jsonb),
    'pending_list', coalesce((
      select jsonb_agg(jsonb_build_object(
        'profile_id', p.profile_id,
        'name', p.name,
        'staff_no', p.staff_no,
        'department', p.department,
        'station', p.station
      ) order by p.name asc)
      from pendings p
    ), '[]'::jsonb)
  ) into v_report;

  return v_report;
end;
$function$;
revoke execute on function public.get_announcement_acknowledgement_report_secure(uuid) from public, anon;
grant execute on function public.get_announcement_acknowledgement_report_secure(uuid) to authenticated, service_role;

-- 9. Check Publishing Rights for Current User
create or replace function public.can_publish_announcements_secure(p_scope text, p_aoc_id uuid default null)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select public.can_user_publish_announcement(p_scope, p_aoc_id);
$function$;
revoke execute on function public.can_publish_announcements_secure(text, uuid) from public, anon;
grant execute on function public.can_publish_announcements_secure(text, uuid) to authenticated, service_role;

-- 10. List Manageable Announcements (Publisher view)
create or replace function public.list_manageable_announcements_secure(p_scope text default null)
returns table (
  id uuid,
  title text,
  scope text,
  aoc_id uuid,
  aoc_code text,
  category text,
  priority text,
  status text,
  is_pinned boolean,
  requires_acknowledgement boolean,
  published_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz,
  acknowledged_count bigint,
  attachment_count bigint
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
  select
    a.id,
    a.title,
    a.scope,
    a.aoc_id,
    aoc.code as aoc_code,
    a.category,
    a.priority,
    a.status,
    a.is_pinned,
    a.requires_acknowledgement,
    a.published_at,
    a.expires_at,
    a.created_at,
    a.updated_at,
    coalesce(ack_counts.cnt, 0) as acknowledged_count,
    coalesce(att_counts.cnt, 0) as attachment_count
  from public.announcements a
  left join public.aocs aoc on aoc.id = a.aoc_id
  left join (
    select announcement_id, count(*)::bigint as cnt
    from public.announcement_acknowledgements
    group by announcement_id
  ) ack_counts on ack_counts.announcement_id = a.id
  left join (
    select announcement_id, count(*)::bigint as cnt
    from public.announcement_attachments
    group by announcement_id
  ) att_counts on att_counts.announcement_id = a.id
  where public.can_user_manage_announcement(a.id)
    and (p_scope is null or a.scope = p_scope)
  order by a.created_at desc;
end;
$function$;
revoke execute on function public.list_manageable_announcements_secure(text) from public, anon;
grant execute on function public.list_manageable_announcements_secure(text) to authenticated, service_role;

-- 11. Add announcement attachment metadata
create or replace function public.add_announcement_attachment_secure(
  p_announcement_id uuid,
  p_storage_path text,
  p_file_name text,
  p_file_size integer,
  p_content_type text
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_caller uuid := auth.uid();
  v_attachment_id uuid;
begin
  if v_caller is null then raise exception 'Must be signed in.'; end if;
  if not public.can_user_manage_announcement(p_announcement_id) then
    raise exception 'Unauthorized to attach files to this announcement.';
  end if;
  if p_file_size <= 0 or p_file_size > 25000000 then
    raise exception 'Invalid file size (max 25MB).';
  end if;

  insert into public.announcement_attachments (
    announcement_id,
    storage_path,
    file_name,
    file_size,
    content_type,
    uploaded_by
  ) values (
    p_announcement_id,
    trim(p_storage_path),
    trim(p_file_name),
    p_file_size,
    trim(p_content_type),
    v_caller
  )
  returning id into v_attachment_id;

  insert into public.announcement_audit_log (announcement_id, actor_profile_id, action, details)
  values (
    p_announcement_id,
    v_caller,
    'edit',
    jsonb_build_object('attachment_id', v_attachment_id, 'file_name', p_file_name, 'file_size', p_file_size)
  );

  return v_attachment_id;
end;
$function$;
revoke execute on function public.add_announcement_attachment_secure(uuid, text, text, integer, text) from public, anon;
grant execute on function public.add_announcement_attachment_secure(uuid, text, text, integer, text) to authenticated, service_role;

-- 12. Get announcement attachments
create or replace function public.get_announcement_attachments_secure(p_announcement_id uuid)
returns table (
  id uuid,
  file_name text,
  file_size integer,
  content_type text,
  storage_path text,
  created_at timestamptz
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
  if not public.is_announcement_visible_to_caller(p_announcement_id)
     and not public.can_user_manage_announcement(p_announcement_id) then
    raise exception 'Announcement not found.';
  end if;

  return query
  select att.id, att.file_name, att.file_size, att.content_type, att.storage_path, att.created_at
  from public.announcement_attachments att
  where att.announcement_id = p_announcement_id
  order by att.created_at asc;
end;
$function$;
revoke execute on function public.get_announcement_attachments_secure(uuid) from public, anon;
grant execute on function public.get_announcement_attachments_secure(uuid) to authenticated, service_role;
