-- AA/SEC/F/014 Rev.03 — patrol Location options and entry-count cap.
-- Applied directly against vecta-prod on 2026-09-14; recorded here for the migration
-- history / anyone rebuilding the schema from scratch.

-- Remove the 15-entry-per-shift cap — staff may log as many patrol entries as
-- actually happened.
ALTER TABLE public.report_sec014_patrols
  DROP CONSTRAINT report_sec014_patrols_entry_no_check;
ALTER TABLE public.report_sec014_patrols
  ADD CONSTRAINT report_sec014_patrols_entry_no_check CHECK (entry_no >= 1);

-- Location options become Apron/Terminal/Premises (previously Aircraft/Terminal/
-- Premises) — "Aircraft" is kept in the allowed set purely so historical rows that
-- already used it remain valid; new entries only ever write Apron/Terminal/Premises.
ALTER TABLE public.report_sec014_patrols
  DROP CONSTRAINT report_sec014_patrols_location_check;
ALTER TABLE public.report_sec014_patrols
  ADD CONSTRAINT report_sec014_patrols_location_check
  CHECK (location = ANY (ARRAY['Apron'::text, 'Terminal'::text, 'Premises'::text, 'Aircraft'::text]));
