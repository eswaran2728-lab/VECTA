-- ============================================================================
-- Migration: 20260912000001_announcements_photo_pop_and_parental_leave.sql
-- 1. Adds photo_url and is_pop to public.announcements
-- 2. Updates absence_notices_leave_type_check to include 'parental'
-- ============================================================================

-- 1. Add photo_url and is_pop to announcements table
ALTER TABLE public.announcements
  ADD COLUMN IF NOT EXISTS photo_url text,
  ADD COLUMN IF NOT EXISTS is_pop boolean NOT NULL DEFAULT false;

-- 2. Update absence_notices leave_type check constraint to include 'parental'
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'absence_notices_leave_type_check'
  ) THEN
    ALTER TABLE public.absence_notices DROP CONSTRAINT absence_notices_leave_type_check;
  END IF;

  ALTER TABLE public.absence_notices
    ADD CONSTRAINT absence_notices_leave_type_check
    CHECK (leave_type IN (
      'absent',
      'mc',
      'emergency',
      'annual',
      'compassionate',
      'hospitalization',
      'maternity_paternity',
      'parental',
      'unpaid',
      'representative'
    ));
END $$;
