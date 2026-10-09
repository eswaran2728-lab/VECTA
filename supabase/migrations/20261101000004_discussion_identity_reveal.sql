-- MAA / AAX Boss audited reveal of an anonymous discussion author. Additive and forward-only.
--
-- Discussions stay anonymous by default; no list/search/detail response ever carries an identity. This adds ONE narrow RPC:
--   * callable only by an approved MAA Boss or AAX Boss (Admins, AirAsia Management and everyone else are refused);
--   * only for content in the caller's own AOC (Malaysia AOC discussion), one exact content id per call (no bulk, no array form);
--   * a specific reason (>= 10 characters) is required;
--   * the reveal is audited BEFORE anything is returned (discussion_identity_resolutions + phase8_audit_log: actor, time, reason, target);
--   * a per-caller hourly ceiling prevents a sequence of calls becoming a bulk disclosure;
--   * only staff number and name come back (never e-mail or any contact detail);
--   * a kill switch (platform_feature_flags.discussion_identity_reveal) can disable it without a deployment.
-- No notification is sent to the revealed sender: the owner's sender-notification policy is unresolved (documented, not invented).

create table if not exists public.platform_feature_flags (
  flag text primary key,
  enabled boolean not null,
  updated_at timestamptz not null default now()
);
alter table public.platform_feature_flags enable row level security;
revoke all on public.platform_feature_flags from public, anon, authenticated;
grant all on public.platform_feature_flags to service_role;
insert into public.platform_feature_flags (flag, enabled) values ('discussion_identity_reveal', true) on conflict (flag) do nothing;

create or replace function public.reveal_discussion_author_identity_secure(p_content_type text, p_content_id uuid, p_reason text)
returns table (staff_no text, staff_name text)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_caller uuid := auth.uid();
  v_aoc uuid;
  v_map record;
  v_recent integer;
begin
  if v_caller is null then
    raise exception 'Must be signed in.';
  end if;
  if not coalesce((select f.enabled from public.platform_feature_flags f where f.flag = 'discussion_identity_reveal'), false) then
    raise exception 'Identity reveal is not enabled.';
  end if;
  if not (public.has_active_role('maa_boss') or public.has_active_role('aax_boss')) then
    raise exception 'Only an approved MAA or AAX Boss may request an identity reveal.';
  end if;
  v_aoc := public.caller_entity_leadership_aoc();
  if v_aoc is null then
    raise exception 'Only an approved MAA or AAX Boss may request an identity reveal.';
  end if;
  if p_content_type is null or p_content_type not in ('thread', 'reply') then
    raise exception 'Unsupported content type.';
  end if;
  if p_reason is null or length(btrim(p_reason)) < 10 then
    raise exception 'A specific reason (at least 10 characters) is required.';
  end if;

  select m.author_profile_id, m.aoc_id into v_map
  from public.discussion_author_mappings m
  where m.content_type = p_content_type and m.content_id = p_content_id;
  -- missing content and content from another AOC are indistinguishable
  if v_map.author_profile_id is null or v_map.aoc_id is distinct from v_aoc then
    raise exception 'Content not found.';
  end if;

  select count(*) into v_recent
  from public.discussion_identity_resolutions r
  where r.resolved_by_profile_id = v_caller and r.created_at > now() - interval '1 hour';
  if v_recent >= 10 then
    raise exception 'Identity reveal limit reached for this hour.';
  end if;

  -- audit first, then disclose
  insert into public.discussion_identity_resolutions (content_type, content_id, resolved_author_profile_id, resolved_by_profile_id, reason)
  values (p_content_type, p_content_id, v_map.author_profile_id, v_caller, btrim(p_reason));
  perform public.phase8_write_audit('discussion_identity_reveal', 'discussion_content', p_content_id,
    jsonb_build_object('content_type', p_content_type, 'aoc_id', v_aoc));

  return query select p.staff_no, p.name from public.profiles p where p.id = v_map.author_profile_id;
end;
$function$;
revoke execute on function public.reveal_discussion_author_identity_secure(text, uuid, text) from public, anon;
grant execute on function public.reveal_discussion_author_identity_secure(text, uuid, text) to authenticated, service_role;
