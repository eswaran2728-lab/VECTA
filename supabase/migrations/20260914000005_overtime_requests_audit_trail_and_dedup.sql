-- Automatic OT production-safety fixes. Applied directly against
-- vecta-prod on 2026-09-14; recorded here for migration history.
--
-- 1. Audit-trail columns so a reviewer can see exactly what the auto-OT
--    calculation was based on (scheduled window + actual attendance)
--    without reconstructing it from duty_records separately.
-- 2. A category-scoped unique index enabling idempotent upsert of OT
--    records — one row per (linked_duty_id, category), so a retried
--    check-in/check-out can never create a duplicate, while an
--    early_arrival record and a late_departure/off_day_work record for
--    the SAME duty record are distinct categories and can coexist.

-- The existing category check constraint only allowed the original
-- manual-request categories — checkin-actions.ts now writes
-- 'early_arrival' and 'late_departure' to distinguish the two OT segments
-- a single duty record can produce, so the constraint must allow them too
-- (this would otherwise silently break every checkout, caught by a live
-- smoke-test insert before this migration was finalized).
ALTER TABLE public.overtime_requests DROP CONSTRAINT IF EXISTS overtime_requests_category_check;
ALTER TABLE public.overtime_requests ADD CONSTRAINT overtime_requests_category_check
  CHECK (category = ANY (ARRAY['flight_delay','manpower_shortage','event','off_day_work','adhoc','early_arrival','late_departure']::text[]));

ALTER TABLE public.overtime_requests
  ADD COLUMN IF NOT EXISTS actual_check_in timestamptz,
  ADD COLUMN IF NOT EXISTS actual_check_out timestamptz,
  ADD COLUMN IF NOT EXISTS scheduled_start timestamptz,
  ADD COLUMN IF NOT EXISTS scheduled_end timestamptz,
  ADD COLUMN IF NOT EXISTS calculated_at timestamptz NOT NULL DEFAULT now();

-- Deliberately NOT a partial index (no WHERE linked_duty_id IS NOT NULL):
-- Postgres only lets a bare `ON CONFLICT (columns)` infer a partial index
-- when the ON CONFLICT clause repeats the same predicate, which the
-- Supabase/PostgREST `.upsert(data, { onConflict: "linked_duty_id,category" })`
-- call used in checkin-actions.ts cannot express. A plain unique index
-- works with that upsert syntax directly, and NULLs never collide in a
-- standard unique index, so rows with no linked_duty_id are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS overtime_requests_duty_category_uniq
  ON public.overtime_requests (linked_duty_id, category);

-- Mark the legacy ot_requests table as deprecated (non-destructive — the
-- table itself is left in place pending explicit approval to drop it).
-- Verified: 0 rows, no views/triggers/functions/cron jobs/RLS policies
-- reference it, no incoming foreign keys, and no application code
-- references it (lib/avsec/duty/ot-actions.ts and its pages were removed
-- in a prior pass). SAFE TO DROP whenever approved.
COMMENT ON TABLE public.ot_requests IS 'DEPRECATED 2026-09-14: legacy manual OT-request flow, superseded by overtime_requests (automatic check-in/check-out based calculation). 0 rows, no policies, no code references. Verified SAFE TO DROP — pending explicit approval, not dropped by this change. Do not build new features against this table.';
