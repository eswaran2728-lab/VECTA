-- GPS-denial fallback for duty check-in/checkout: when navigator.geolocation fails,
-- is denied, or times out, the officer can instead pick their zone manually from a
-- dropdown of the station's active duty_zones (see CheckInScreen.tsx). GPS remains the
-- default/preferred path — these columns exist purely for audit, so a manual check-in/
-- out can be distinguished from a GPS-verified one after the fact.
--
-- Additive only: no existing column, constraint, or the `status` check constraint is
-- touched. Symmetric pair, same pattern as add_duty_early_checkin_late_checkout_fields.sql.

alter table duty_records
  add column if not exists check_in_manual_zone boolean not null default false,
  add column if not exists check_out_manual_zone boolean not null default false;
