-- Minimal Supabase-PLATFORM compatibility stubs for PGlite (a real,
-- embedded Postgres engine, not a reimplementation). These stub ONLY
-- generic Supabase platform primitives that migrations reference as a
-- side effect of running on Supabase (auth.*, storage.*, cron.*,
-- net.*, and the anon/authenticated/service_role roles) -- NEVER any
-- application or authorization logic. Nothing in this file stubs,
-- replaces, or weakens any Phase 6 function, RLS policy, grant, or
-- trigger under test -- every one of those runs as the real,
-- unmodified migration SQL against these platform primitives.

create role anon;
create role authenticated;
create role service_role bypassrls;
-- "postgres" already exists as PGlite's default superuser role.
-- Real Supabase grants service_role broad table/sequence privileges
-- across the public schema by default (it also carries BYPASSRLS,
-- above) -- mirrored here via ALTER DEFAULT PRIVILEGES so every table/
-- sequence created by ANY later migration (not just ones already
-- applied) is automatically covered, matching the real platform
-- default rather than needing a fixed table list.
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant all on sequences to service_role;
alter default privileges in schema public grant all on functions to service_role;

-- Real Supabase also auto-grants anon/authenticated broad table-level
-- CRUD privilege by default on every table in the public schema the
-- moment it's created (a platform default, not something any migration
-- in this repo explicitly GRANTs for most tables) -- RLS is what
-- actually restricts rows/columns from there, and Phase 6's own later,
-- deliberate REVOKEs (e.g. closing direct source-table SELECT) still
-- apply normally afterward, in migration-file order, correctly
-- narrowing this default down exactly as they do against the real
-- platform.
alter default privileges in schema public grant select, insert, update, delete on tables to anon, authenticated;
alter default privileges in schema public grant usage, select on sequences to anon, authenticated;
grant usage on schema public to anon, authenticated, service_role;

-- auth schema: auth.users (minimal columns actually referenced by any
-- migration: id, email, banned_until, confirmed_at, raw_user_meta_data)
-- and auth.uid()/auth.role()/auth.jwt() reading the same
-- request.jwt.claims GUC convention Supabase's real auth schema uses.
create schema auth;
create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  encrypted_password text,
  raw_user_meta_data jsonb default '{}'::jsonb,
  banned_until timestamptz,
  confirmed_at timestamptz default now(),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create or replace function auth.uid() returns uuid
language sql stable
as $$
  select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid;
$$;

create or replace function auth.role() returns text
language sql stable
as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', current_setting('role', true));
$$;

create or replace function auth.jwt() returns jsonb
language sql stable
as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb);
$$;

create or replace function auth.email() returns text
language sql stable
as $$
  select nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email';
$$;

grant usage on schema auth to anon, authenticated, service_role;
grant all on auth.users to service_role;

-- storage schema: real migrations create the report-attachments bucket
-- and RLS policies on storage.objects -- minimal real tables so those
-- statements execute as written, unmodified.
create schema storage;
create table storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null default false,
  created_at timestamptz default now()
);
create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id),
  name text,
  owner uuid,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  metadata jsonb
);
alter table storage.objects enable row level security;

create or replace function storage.foldername(name text) returns text[]
language sql immutable
as $$
  select string_to_array(name, '/');
$$;

grant usage on schema storage to anon, authenticated, service_role;
grant select, insert, update, delete on storage.objects to authenticated, service_role;
grant select on storage.buckets to authenticated, service_role;

-- cron schema: pg_cron is not available in PGlite. cron.schedule() is
-- called directly (not inside a function body) by three migrations
-- (Phase 5's indexing job, sheets-sync, attendance-anomaly flagging) --
-- none are exercised by the Phase 6 scenarios below, but the statement
-- itself must not fail the migration apply. A no-op stub that just
-- records the call (never actually schedules anything, since there is
-- no background worker in this environment) is accurate: it does NOT
-- pretend to run the job periodically, it only lets migration apply
-- succeed.
create schema cron;
create table cron.job (jobid bigserial primary key, jobname text unique, schedule text, command text, active boolean default true);
create table cron.job_run_details (jobid bigint, runid bigserial primary key, status text, return_message text, start_time timestamptz, end_time timestamptz);

create or replace function cron.schedule(job_name text, schedule text, command text) returns bigint
language plpgsql
as $$
declare
  v_id bigint;
begin
  insert into cron.job (jobname, schedule, command) values (job_name, schedule, command)
  on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command
  returning jobid into v_id;
  return v_id;
end;
$$;

create or replace function cron.unschedule(job_name text) returns boolean
language plpgsql
as $$
begin
  delete from cron.job where jobname = job_name;
  return true;
end;
$$;

-- net schema: pg_net is not available. net.http_post() is only called
-- from inside a function body (avsec/0023_sheet_sync_queue.sql, a
-- Google-Sheets sync trigger unrelated to Phase 6) -- never invoked at
-- migration-apply time and never exercised by any Phase 6 scenario.
-- Stubbed anyway, for completeness, as a no-op returning a plausible
-- shape so the sheet-sync function itself remains callable if anything
-- unexpected does invoke it.
create schema net;
create or replace function net.http_post(url text, body jsonb default null, params jsonb default null, headers jsonb default null, timeout_milliseconds integer default 5000)
returns bigint
language sql
as $$
  select 0::bigint;
$$;

grant usage on schema cron, net to postgres, service_role;

-- Supabase Realtime: several migrations run
-- `alter publication supabase_realtime add table ...` to opt a table
-- into realtime change broadcast -- a platform feature with no runtime
-- effect in this disposable database (nothing subscribes to it here).
-- A real, empty publication lets those statements execute unmodified.
create publication supabase_realtime;
