-- Restore only fields still written by the current report actions. The legacy
-- organizations/org_id model remains retired; ops_group is nullable and is not
-- used for authorization.
set local lock_timeout = '5s';

alter table public.report_sec013 add column if not exists ops_group text;
alter table public.report_sec014 add column if not exists ops_group text;
alter table public.report_sec018 add column if not exists ops_group text;
alter table public.report_sec029 add column if not exists ops_group text;
alter table public.report_sec033 add column if not exists ops_group text;

alter table public.report_sec029
  add column if not exists flight_destination text,
  add column if not exists aircraft_type_other text;

-- AA/SEC/F/014 Rev.03 permits every recorded patrol entry and includes Apron.
-- Aircraft remains allowed for historical rows.
-- Any earlier single-column CHECK on these two columns is replaced whatever its
-- name, so a differently named legacy cap can never survive next to the new one.
do $$
declare
  c record;
begin
  for c in
    select k.conname
    from pg_constraint k
    join pg_attribute a on a.attrelid = k.conrelid and a.attnum = k.conkey[1]
    where k.conrelid = 'public.report_sec014_patrols'::regclass
      and k.contype = 'c'
      and array_length(k.conkey, 1) = 1
      and a.attname in ('entry_no', 'location')
  loop
    execute format('alter table public.report_sec014_patrols drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.report_sec014_patrols
  add constraint report_sec014_patrols_entry_no_check check (entry_no >= 1);
alter table public.report_sec014_patrols
  add constraint report_sec014_patrols_location_check
  check (location = any (array['Apron'::text, 'Terminal'::text, 'Premises'::text, 'Aircraft'::text]));

do $$
begin
  if (select count(*) from pg_constraint k
        join pg_attribute a on a.attrelid = k.conrelid and a.attnum = k.conkey[1]
       where k.conrelid = 'public.report_sec014_patrols'::regclass
         and k.contype = 'c' and array_length(k.conkey, 1) = 1
         and a.attname in ('entry_no', 'location')) <> 2 then
    raise exception 'report_sec014_patrols must carry exactly one CHECK on entry_no and one on location';
  end if;
end $$;
