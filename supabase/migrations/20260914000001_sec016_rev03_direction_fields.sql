-- AA/SEC/F/016 Rev.03 — direction-specific field rework.
-- Applied directly against vecta-prod on 2026-09-14; recorded here for the migration
-- history / anyone rebuilding the schema from scratch.

ALTER TABLE public.report_sec016
  ADD COLUMN IF NOT EXISTS ramp_agents_baggage text,
  ADD COLUMN IF NOT EXISTS ramp_agents_cargo text,
  ADD COLUMN IF NOT EXISTS cabin_check text;

-- These fields are now only collected for one flight direction (or, for the removed
-- ramp_staff_1..5 / offload_flight_no / offload_destination / offload_total_baggage,
-- no longer collected at all) — relaxed to nullable so new submissions can omit them
-- while historical rows (which already have values) are untouched.
ALTER TABLE public.report_sec016
  ALTER COLUMN outbound_baggage DROP NOT NULL,
  ALTER COLUMN outbound_cargo DROP NOT NULL,
  ALTER COLUMN outbound_co_mail DROP NOT NULL,
  ALTER COLUMN inbound_baggage DROP NOT NULL,
  ALTER COLUMN inbound_cargo DROP NOT NULL,
  ALTER COLUMN inbound_co_mail DROP NOT NULL,
  ALTER COLUMN ramp_staff_1 DROP NOT NULL,
  ALTER COLUMN ramp_staff_2 DROP NOT NULL,
  ALTER COLUMN ramp_staff_3 DROP NOT NULL,
  ALTER COLUMN ramp_staff_4 DROP NOT NULL,
  ALTER COLUMN ramp_staff_5 DROP NOT NULL,
  ALTER COLUMN offload_flight_no DROP NOT NULL,
  ALTER COLUMN offload_destination DROP NOT NULL,
  ALTER COLUMN offload_total_baggage DROP NOT NULL,
  ALTER COLUMN offload_baggage_tag_no DROP NOT NULL,
  ALTER COLUMN offload_remark DROP NOT NULL;
