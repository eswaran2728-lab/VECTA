-- Durable rate limiting for the public self-registration endpoint (additive).
--
-- The endpoint is unauthenticated and runs on serverless instances that share no memory, so an in-process counter cannot bound abuse.
-- This is a fixed-window counter per HASHED key (the application hashes the client address and the email; no raw address or email is
-- stored), incremented atomically with INSERT .. ON CONFLICT. Only the service role may call it; clients cannot read or write the table.
-- Each call also deletes a small bounded batch of expired windows so the table cannot grow without limit.

create table if not exists public.registration_throttle (
  key_hash text not null check (key_hash ~ '^[0-9a-f]{64}$'),
  window_start timestamptz not null,
  hits integer not null default 0,
  primary key (key_hash, window_start)
);
alter table public.registration_throttle enable row level security;
revoke all on public.registration_throttle from public, anon, authenticated;
grant all on public.registration_throttle to service_role;

create or replace function public.registration_throttle_hit(p_key_hash text, p_limit integer, p_window_seconds integer)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_start timestamptz;
  v_hits integer;
begin
  if p_key_hash is null or p_key_hash !~ '^[0-9a-f]{64}$' or p_limit is null or p_limit < 1 or p_limit > 1000
     or p_window_seconds is null or p_window_seconds < 10 or p_window_seconds > 86400 then
    raise exception 'Invalid throttle request.';
  end if;
  v_start := to_timestamp(floor(extract(epoch from clock_timestamp()) / p_window_seconds) * p_window_seconds);

  delete from public.registration_throttle
  where ctid in (select t.ctid from public.registration_throttle t where t.window_start < now() - interval '2 days' limit 50);

  insert into public.registration_throttle as t (key_hash, window_start, hits)
  values (p_key_hash, v_start, 1)
  on conflict (key_hash, window_start) do update set hits = t.hits + 1
  returning t.hits into v_hits;

  return v_hits <= p_limit;
end;
$function$;
revoke all on function public.registration_throttle_hit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.registration_throttle_hit(text, integer, integer) to service_role;
