-- ============================================================================
-- VECTA — Preventive Health Check: Compound Indexes & Multi-Tenant RLS Hardening
-- Migration: 20260911000014_health_check_indexes_and_rls.sql
-- 1. Adds missing compound indexes for high-frequency queries.
-- 2. Hardens multi-tenant org_id isolation on absence_notices and recent tables.
-- ============================================================================

-- ============================================================================
-- Section 1: Performance Compound Indexes
-- ============================================================================

-- 1. absence_notices: used heavily by roster daily status join & team concurrency cap
CREATE INDEX IF NOT EXISTS idx_absence_notices_status_dates
  ON public.absence_notices (approval_status, start_date, end_date);

-- 2. overtime_requests: used heavily by date-filtered OT payroll & management dashboards
CREATE INDEX IF NOT EXISTS idx_overtime_requests_work_date_status
  ON public.overtime_requests (work_date, status);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'ot_requests') THEN
    CREATE INDEX IF NOT EXISTS idx_ot_requests_work_date_status
      ON public.ot_requests (work_date, status);
  END IF;
END $$;

-- 3. duty_records: used by roster & bay board cross-referencing
CREATE INDEX IF NOT EXISTS idx_duty_records_station_team_date
  ON public.duty_records (station, team, duty_date);


-- ============================================================================
-- Section 2: Multi-Tenant RLS Hardening for absence_notices
-- ============================================================================

-- Ensure default org_id and backfill
ALTER TABLE public.absence_notices
  ALTER COLUMN org_id SET DEFAULT '00000000-0000-0000-0000-000000000001'::uuid;

UPDATE public.absence_notices
SET org_id = '00000000-0000-0000-0000-000000000001'::uuid
WHERE org_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_absence_notices_org_id
  ON public.absence_notices (org_id);

-- Drop older policies to replace with org-scoped policies
DROP POLICY IF EXISTS "absence_notices_insert_own" ON public.absence_notices;
DROP POLICY IF EXISTS "absence_notices_select_own" ON public.absence_notices;
DROP POLICY IF EXISTS "absence_notices_select_elevated" ON public.absence_notices;
DROP POLICY IF EXISTS "absence_notices_dse_management_update" ON public.absence_notices;

-- Staff can insert their own leave/absence notice within their org
CREATE POLICY "absence_notices_insert_own" ON public.absence_notices
  FOR INSERT WITH CHECK (
    auth.uid() = user_id
    AND (org_id IS NULL OR org_id = current_org_id())
  );

-- Staff can view their own leave/absence notices within their org
CREATE POLICY "absence_notices_select_own" ON public.absence_notices
  FOR SELECT USING (
    auth.uid() = user_id
    AND (org_id IS NULL OR org_id = current_org_id())
  );

-- DSE, Enforcement, Management, and Super Admin can view absence notices in their org
CREATE POLICY "absence_notices_select_elevated" ON public.absence_notices
  FOR SELECT USING (
    (org_id IS NULL OR org_id = current_org_id())
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid()
        AND p.role IN ('DSE', 'ENFORCEMENT', 'MANAGEMENT', 'ADMIN', 'SUPER_ADMIN')
        AND (
          p.role IN ('MANAGEMENT', 'ADMIN', 'ENFORCEMENT', 'SUPER_ADMIN')
          OR (p.role = 'DSE' AND (p.station IS NULL OR p.station = absence_notices.station))
        )
    )
  );

-- DSE & Management can update / review leave notices in their org
CREATE POLICY "absence_notices_dse_management_update" ON public.absence_notices
  FOR UPDATE
  USING (
    (org_id IS NULL OR org_id = current_org_id())
    AND EXISTS (
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
    (org_id IS NULL OR org_id = current_org_id())
    AND EXISTS (
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
