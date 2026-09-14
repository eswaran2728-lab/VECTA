-- ============================================================================
-- VECTA — Consolidated Leave System ("Apply Leave")
-- Migration: 20260911000011_consolidated_leave_system.sql
-- Extends public.absence_notices with leave types, multi-day date ranges,
-- and DSE/Management in-app approval workflow.
-- ============================================================================

-- 1. Add new columns to public.absence_notices if they don't already exist
ALTER TABLE public.absence_notices
  ADD COLUMN IF NOT EXISTS leave_type text NOT NULL DEFAULT 'absent',
  ADD COLUMN IF NOT EXISTS start_date date NOT NULL DEFAULT CURRENT_DATE,
  ADD COLUMN IF NOT EXISTS end_date date NOT NULL DEFAULT CURRENT_DATE,
  ADD COLUMN IF NOT EXISTS approval_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS reviewed_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS review_notes text;

-- 2. Make gap_minutes and status nullable (future-dated leave has no same-day gap calculation)
ALTER TABLE public.absence_notices
  ALTER COLUMN gap_minutes DROP NOT NULL,
  ALTER COLUMN status DROP NOT NULL;

-- 3. Add check constraints for valid leave types and approval status
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'absence_notices_leave_type_check'
  ) THEN
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
        'unpaid',
        'representative'
      ));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'absence_notices_approval_status_check'
  ) THEN
    ALTER TABLE public.absence_notices
      ADD CONSTRAINT absence_notices_approval_status_check
      CHECK (approval_status IN ('pending', 'approved', 'rejected'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'absence_notices_date_range_check'
  ) THEN
    ALTER TABLE public.absence_notices
      ADD CONSTRAINT absence_notices_date_range_check
      CHECK (end_date >= start_date);
  END IF;
END $$;

-- 4. Create indices for fast lookup by station/team/approval_status and user date range
CREATE INDEX IF NOT EXISTS idx_absence_notices_station_team_status
  ON public.absence_notices(station, team, approval_status);

CREATE INDEX IF NOT EXISTS idx_absence_notices_user_dates
  ON public.absence_notices(user_id, start_date, end_date);

CREATE INDEX IF NOT EXISTS idx_absence_notices_leave_type
  ON public.absence_notices(leave_type);

-- 5. RLS policies for DSE and Management approval updates
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'absence_notices' AND policyname = 'absence_notices_dse_management_update'
  ) THEN
    CREATE POLICY "absence_notices_dse_management_update"
      ON public.absence_notices
      FOR UPDATE
      USING (
        EXISTS (
          SELECT 1 FROM public.profiles p
          WHERE p.id = auth.uid()
            AND (
              p.role IN ('MANAGEMENT', 'ADMIN', 'SUPER_ADMIN')
              OR (
                p.role = 'DSE'
                AND (
                  absence_notices.station = p.station
                  OR absence_notices.station IS NULL
                )
              )
            )
        )
      )
      WITH CHECK (
        EXISTS (
          SELECT 1 FROM public.profiles p
          WHERE p.id = auth.uid()
            AND (
              p.role IN ('MANAGEMENT', 'ADMIN', 'SUPER_ADMIN')
              OR (
                p.role = 'DSE'
                AND (
                  absence_notices.station = p.station
                  OR absence_notices.station IS NULL
                )
              )
            )
        )
      );
  END IF;
END $$;
