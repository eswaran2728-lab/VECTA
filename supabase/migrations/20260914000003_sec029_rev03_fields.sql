-- AA/SEC/F/029 Rev.03 — Flight Destination and "Others" aircraft type free-text.
-- Applied directly against vecta-prod on 2026-09-14; recorded here for the migration
-- history / anyone rebuilding the schema from scratch.

ALTER TABLE public.report_sec029
  ADD COLUMN IF NOT EXISTS flight_destination text,
  ADD COLUMN IF NOT EXISTS aircraft_type_other text;
