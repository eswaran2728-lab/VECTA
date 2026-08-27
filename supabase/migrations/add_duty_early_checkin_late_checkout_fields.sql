-- Project owner request: extend duty check-in/checkout with two more explained-variance
-- fields, symmetric with the existing late-checkin / early-checkout pair already on
-- duty_records (see supabase/migrations/avsec/0016_duty_module_schema.sql):
--
-- 1. Early check-in (checking in well before the scheduled shift start) now needs an
--    explanation, same as checking in late already does.
-- 2. Late checkout (leaving well after the scheduled shift end) now needs an explanation
--    too — it already auto-creates an overtime request via submitDutyCheckOut(), but
--    never asked the officer for a remark until now.
--
-- Additive only: no existing column, constraint, or the `status` check constraint is
-- touched.

alter table duty_records
  add column if not exists early_in_minutes integer not null default 0,
  add column if not exists early_in_remark text,
  add column if not exists late_out_minutes integer not null default 0,
  add column if not exists late_out_remark text;
