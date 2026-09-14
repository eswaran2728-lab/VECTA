-- ============================================================================
-- VECTA — Link Approved Leave to Roster & Cancellation Workflow
-- Migration: 20260911000012_link_approved_leave_to_roster.sql
-- Updates absence_notices approval status check constraint to include
-- 'pending_cancellation' and 'cancelled', and adds cancellation audit columns.
-- ============================================================================

-- 1. Add cancellation metadata columns to public.absence_notices
ALTER TABLE public.absence_notices
  ADD COLUMN IF NOT EXISTS cancellation_reason text,
  ADD COLUMN IF NOT EXISTS cancel_requested_at timestamptz;

-- 2. Update check constraint for approval_status to support cancellation lifecycle
DO $$
BEGIN
  ALTER TABLE public.absence_notices
    DROP CONSTRAINT IF EXISTS absence_notices_approval_status_check;

  ALTER TABLE public.absence_notices
    ADD CONSTRAINT absence_notices_approval_status_check
    CHECK (approval_status IN (
      'pending',
      'approved',
      'rejected',
      'pending_cancellation',
      'cancelled'
    ));
END $$;

-- 3. Ensure staff can submit cancellation requests for their own records
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'absence_notices' AND policyname = 'absence_notices_owner_cancellation_request'
  ) THEN
    CREATE POLICY "absence_notices_owner_cancellation_request"
      ON public.absence_notices
      FOR UPDATE
      USING (user_id = auth.uid())
      WITH CHECK (user_id = auth.uid());
  END IF;
END $$;
