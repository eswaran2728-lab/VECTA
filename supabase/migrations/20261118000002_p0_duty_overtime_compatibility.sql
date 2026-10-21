-- Restore only the compatibility fields still written by the current duty
-- actions. ops_group remains nullable and is not an authorization source.
set local lock_timeout = '5s';

-- Refuse early, with a readable message, if the unique index cannot be built
-- or an index of that name already exists with a different shape.
do $$
declare
  dup_groups integer;
  existing record;
begin
  if to_regclass('public.overtime_requests') is not null then
    select count(*) into dup_groups from (
      select 1 from public.overtime_requests
      group by linked_duty_id, category having count(*) > 1
    ) d;
    if dup_groups > 0 then
      raise exception 'duplicate overtime_requests rows share (linked_duty_id, category) in % group(s); resolve them before applying this migration', dup_groups;
    end if;
  end if;
  select i.indisunique, i.indpred is not null as partial, pg_get_indexdef(i.indexrelid) as def
    into existing
    from pg_index i
   where i.indexrelid = to_regclass('public.overtime_requests_duty_category_uniq');
  if found and (not existing.indisunique or existing.partial) then
    raise exception 'index overtime_requests_duty_category_uniq already exists but is not a plain unique index: %', existing.def;
  end if;
end $$;

alter table public.duty_records add column if not exists ops_group text;
alter table public.overtime_requests add column if not exists ops_group text;

alter table public.overtime_requests
  add column if not exists actual_check_in timestamptz,
  add column if not exists actual_check_out timestamptz,
  add column if not exists scheduled_start timestamptz,
  add column if not exists scheduled_end timestamptz,
  add column if not exists calculated_at timestamptz not null default now();

-- Replace any earlier single-column CHECK on category, whatever its name.
do $$
declare
  c record;
begin
  for c in
    select k.conname
    from pg_constraint k
    join pg_attribute a on a.attrelid = k.conrelid and a.attnum = k.conkey[1]
    where k.conrelid = 'public.overtime_requests'::regclass
      and k.contype = 'c'
      and array_length(k.conkey, 1) = 1
      and a.attname = 'category'
  loop
    execute format('alter table public.overtime_requests drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.overtime_requests
  add constraint overtime_requests_category_check
  check (category = any (array[
    'flight_delay', 'manpower_shortage', 'event', 'off_day_work', 'adhoc',
    'early_arrival', 'late_departure'
  ]::text[]));

-- A plain unique index is required for PostgREST's
-- onConflict: "linked_duty_id,category" upsert contract.
create unique index if not exists overtime_requests_duty_category_uniq
  on public.overtime_requests (linked_duty_id, category);

do $$
begin
  if (select count(*) from pg_constraint k
        join pg_attribute a on a.attrelid = k.conrelid and a.attnum = k.conkey[1]
       where k.conrelid = 'public.overtime_requests'::regclass
         and k.contype = 'c' and array_length(k.conkey, 1) = 1
         and a.attname = 'category') <> 1 then
    raise exception 'overtime_requests must carry exactly one CHECK on category';
  end if;
  if not exists (
    select 1 from pg_index i
     where i.indexrelid = 'public.overtime_requests_duty_category_uniq'::regclass
       and i.indisunique and i.indpred is null and i.indnatts = 2
  ) then
    raise exception 'overtime_requests_duty_category_uniq is not a plain two-column unique index';
  end if;
end $$;
