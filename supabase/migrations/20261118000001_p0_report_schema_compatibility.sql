-- Restore only fields still written by the current report actions. The legacy
-- organizations/org_id model remains retired; ops_group is nullable and is not
-- used for authorization.
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
alter table public.report_sec014_patrols
  drop constraint if exists report_sec014_patrols_entry_no_check;
alter table public.report_sec014_patrols
  add constraint report_sec014_patrols_entry_no_check check (entry_no >= 1);

alter table public.report_sec014_patrols
  drop constraint if exists report_sec014_patrols_location_check;
alter table public.report_sec014_patrols
  add constraint report_sec014_patrols_location_check
  check (location = any (array['Apron'::text, 'Terminal'::text, 'Premises'::text, 'Aircraft'::text]));
