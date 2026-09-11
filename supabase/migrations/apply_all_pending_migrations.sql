-- ============================================================================
-- VECTA — Consolidated Pending Database Migrations
-- Generated: 2026-09-12
-- Target Project: zsxneokqulktgnccxgkz (Supabase)
-- 
-- Includes in exact sequence:
-- 1. 20260911000001_multi_tenant_scaffolding.sql
-- 2. 20260911000002_merge_admin_into_management.sql
-- 3. 20260911000003_enforce_report_filing_scope.sql
-- 4. 20260911000004_ot_requests.sql
-- 5. 20260911000005_sec016_arrival_departure_bay_board.sql
-- 6. 20260911000006_anonymous_staff_feedback.sql
-- 7. 20260911000007_management_announcements.sql
-- 8. 20260911000008_wois_ai_knowledge_base.sql
-- 9. 20260911000009_purge_legacy_admin_role.sql
-- 10. 20260911000010_absence_late_notice_tracker.sql
-- 11. 20260911000011_consolidated_leave_system.sql
-- 12. 20260911000012_link_approved_leave_to_roster.sql
-- 13. 20260911000014_health_check_indexes_and_rls.sql
-- 14. 20260912000001_announcements_photo_pop_and_parental_leave.sql
-- 15. PostgREST Schema Cache Reload
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1. Multi-Tenant Scaffolding & Organizations
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  code text UNIQUE,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'suspended')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;

INSERT INTO public.organizations (id, name, code, status)
VALUES ('00000000-0000-0000-0000-000000000001', 'AirAsia', 'AIRASIA', 'active')
ON CONFLICT (id) DO UPDATE SET name = 'AirAsia', code = 'AIRASIA', status = 'active';

CREATE OR REPLACE FUNCTION current_org_id()
RETURNS uuid AS $$
  SELECT coalesce(
    (SELECT org_id FROM public.profiles WHERE id = auth.uid()),
    (SELECT org_id FROM public.users WHERE id = auth.uid()),
    '00000000-0000-0000-0000-000000000001'::uuid
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

DO $$
DECLARE
  v_default_org uuid := '00000000-0000-0000-0000-000000000001'::uuid;
  v_table text;
  v_tables text[] := array[
    'profiles', 'stations', 'teams', 'aircraft_types', 'station_teams',
    'report_sec016', 'report_sec014', 'report_sec014_patrols',
    'report_sec029', 'report_sec029_items', 'report_sec018',
    'report_sec018_patrols', 'report_sec033', 'report_sec033_hold_checks',
    'report_sec013', 'report_sec013_profiling_duties', 'offload_records',
    'offload_items', 'bay_board', 'report_acknowledgements', 'duty_zones',
    'duty_records', 'overtime_requests', 'duty_audit_log', 'report_counters',
    'shifts', 'report_drafts', 'users', 'transactions', 'transaction_counters',
    'part_a', 'part_b', 'part_c', 'part_d', 'part_hub', 'part_redq',
    'incidents', 'incident_photos', 'notifications', 'audit_logs',
    'segment_timeouts', 'vendor_transactions', 'vendor_transaction_counters',
    'vendor_part_a', 'vendor_part_b', 'vendor_part_c', 'seals',
    'seal_verifications', 'catering_companies', 'vehicles', 'drivers',
    'cscs_settings'
  ];
BEGIN
  FOREACH v_table IN array v_tables LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = v_table) THEN
      EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS org_id uuid REFERENCES public.organizations(id) DEFAULT %L', v_table, v_default_org);
      EXECUTE format('UPDATE public.%I SET org_id = %L WHERE org_id IS NULL', v_table, v_default_org);
      EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON public.%I(org_id)', 'idx_' || v_table || '_org_id', v_table);
    END IF;
  END LOOP;
END $$;


-- ============================================================================
-- 2. Merge Admin + Management -> Single "Management" Role
-- ============================================================================
ALTER TABLE public.profiles DISABLE TRIGGER USER;

UPDATE public.profiles
SET role = 'MANAGEMENT', unified_role = 'management'
WHERE role = 'ADMIN' OR unified_role = 'admin';

ALTER TABLE public.profiles ENABLE TRIGGER USER;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'users') THEN
    UPDATE public.users
    SET unified_role = 'management'
    WHERE unified_role = 'admin' OR role = 'supervisor';
  END IF;
END $$;

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_unified_role_check;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_unified_role_check
  CHECK (unified_role IN ('super_admin', 'management', 'enforcement', 'dse', 'so', 'aso', 'vendor'));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'users') THEN
    ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_unified_role_check;
    ALTER TABLE public.users
      ADD CONSTRAINT users_unified_role_check
      CHECK (unified_role IN ('super_admin', 'management', 'enforcement', 'dse', 'so', 'aso', 'vendor'));
  END IF;
END $$;


-- ============================================================================
-- 3. SEC Report Scope Enforcement & Acknowledgements
-- ============================================================================
CREATE OR REPLACE FUNCTION public.can_file_report(p_form_type text, p_profile_id uuid)
RETURNS boolean AS $$
DECLARE
  v_role user_role;
  v_ops_group text;
BEGIN
  SELECT role, ops_group INTO v_role, v_ops_group
  FROM public.profiles
  WHERE id = p_profile_id;

  IF v_role IS NULL THEN
    RETURN false;
  END IF;

  IF p_form_type = 'sec014' THEN
    RETURN v_role IN ('ASO', 'SO', 'DSE');
  END IF;

  IF p_form_type IN ('sec016', 'sec029', 'sec018', 'sec033', 'sec013', 'offload') THEN
    RETURN v_role = 'ASO' AND v_ops_group IN ('operation_avsec', 'hub_avsec');
  END IF;

  RETURN false;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;


-- ============================================================================
-- 4. OT (Overtime) Requests Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.ot_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations (id) DEFAULT '00000000-0000-0000-0000-000000000001'::uuid,
  requester_id uuid NOT NULL REFERENCES public.profiles (id),
  branch text NOT NULL CHECK (branch IN ('operation_avsec', 'ifc_avsec', 'hub_avsec')),
  work_date date NOT NULL,
  hours numeric NOT NULL CHECK (hours > 0),
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by uuid REFERENCES public.profiles (id),
  reviewed_at timestamptz,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.ot_requests ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_ot_requests_org_id ON public.ot_requests (org_id);
CREATE INDEX IF NOT EXISTS idx_ot_requests_requester ON public.ot_requests (requester_id, status);
CREATE INDEX IF NOT EXISTS idx_ot_requests_branch_status ON public.ot_requests (branch, status);


-- ============================================================================
-- 5. SEC016 Flight Type Toggle & Bay Board Auto-Link
-- ============================================================================
ALTER TABLE public.report_sec016
  ADD COLUMN IF NOT EXISTS flight_type text NOT NULL DEFAULT 'arrival' CHECK (flight_type IN ('arrival', 'departure')),
  ADD COLUMN IF NOT EXISTS aircraft_search_completed boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS search_overdue_flag boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS search_remark text;

CREATE INDEX IF NOT EXISTS idx_report_sec016_flight_type ON public.report_sec016 (flight_type);
CREATE INDEX IF NOT EXISTS idx_report_sec016_station_reg ON public.report_sec016 (station, reg_no);

ALTER TABLE public.bay_board DROP CONSTRAINT IF EXISTS bay_board_cleared_by_report_id_fkey;

ALTER TABLE public.bay_board
  ADD COLUMN IF NOT EXISTS flight text,
  ADD COLUMN IF NOT EXISTS is_manual boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS arrival_report_id uuid REFERENCES public.report_sec016(id),
  ADD COLUMN IF NOT EXISTS departure_report_id uuid REFERENCES public.report_sec016(id);

CREATE INDEX IF NOT EXISTS idx_bay_board_match ON public.bay_board (station, reg_no, cleared_at);
CREATE INDEX IF NOT EXISTS idx_bay_board_arrival_report ON public.bay_board (arrival_report_id);


-- ============================================================================
-- 6. Anonymous Staff Feedback Tables & Views
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.feedback_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
  submitter_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  category text NOT NULL CHECK (category IN ('safety_concern', 'complaint', 'suggestion', 'other')),
  status text NOT NULL CHECK (status IN ('open', 'closed')) DEFAULT 'open',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_feedback_threads_submitter ON public.feedback_threads(submitter_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feedback_threads_org_status ON public.feedback_threads(org_id, status, category);

CREATE TABLE IF NOT EXISTS public.feedback_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id uuid NOT NULL REFERENCES public.feedback_threads(id) ON DELETE CASCADE,
  sender_role text NOT NULL CHECK (sender_role IN ('submitter', 'management')),
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_feedback_messages_thread ON public.feedback_messages(thread_id, created_at ASC);

CREATE OR REPLACE VIEW public.feedback_threads_management_view AS
SELECT
  id,
  org_id,
  category,
  status,
  created_at,
  updated_at
FROM public.feedback_threads;

ALTER TABLE public.feedback_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feedback_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "feedback_threads_submitter_select" ON public.feedback_threads;
CREATE POLICY "feedback_threads_submitter_select"
  ON public.feedback_threads FOR SELECT
  USING (submitter_id = auth.uid());

DROP POLICY IF EXISTS "feedback_threads_submitter_insert" ON public.feedback_threads;
CREATE POLICY "feedback_threads_submitter_insert"
  ON public.feedback_threads FOR INSERT
  WITH CHECK (submitter_id = auth.uid());

DROP POLICY IF EXISTS "feedback_threads_management_select" ON public.feedback_threads;
CREATE POLICY "feedback_threads_management_select"
  ON public.feedback_threads FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid()
      AND role IN ('MANAGEMENT', 'ADMIN')
    )
  );

DROP POLICY IF EXISTS "feedback_threads_management_update" ON public.feedback_threads;
CREATE POLICY "feedback_threads_management_update"
  ON public.feedback_threads FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid()
      AND role IN ('MANAGEMENT', 'ADMIN')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid()
      AND role IN ('MANAGEMENT', 'ADMIN')
    )
  );

DROP POLICY IF EXISTS "feedback_messages_submitter_select" ON public.feedback_messages;
CREATE POLICY "feedback_messages_submitter_select"
  ON public.feedback_messages FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.feedback_threads
      WHERE id = feedback_messages.thread_id
      AND submitter_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "feedback_messages_submitter_insert" ON public.feedback_messages;
CREATE POLICY "feedback_messages_submitter_insert"
  ON public.feedback_messages FOR INSERT
  WITH CHECK (
    sender_role = 'submitter'
    AND EXISTS (
      SELECT 1 FROM public.feedback_threads
      WHERE id = feedback_messages.thread_id
      AND submitter_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "feedback_messages_management_select" ON public.feedback_messages;
CREATE POLICY "feedback_messages_management_select"
  ON public.feedback_messages FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid()
      AND role IN ('MANAGEMENT', 'ADMIN')
    )
  );

DROP POLICY IF EXISTS "feedback_messages_management_insert" ON public.feedback_messages;
CREATE POLICY "feedback_messages_management_insert"
  ON public.feedback_messages FOR INSERT
  WITH CHECK (
    sender_role = 'management'
    AND EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid()
      AND role IN ('MANAGEMENT', 'ADMIN')
    )
  );


-- ============================================================================
-- 7. Management Announcements & Targeting
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.announcements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  title text NOT NULL,
  body text NOT NULL,
  photo_url text,
  is_pop boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_announcements_org ON public.announcements(org_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.announcement_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  announcement_id uuid NOT NULL REFERENCES public.announcements(id) ON DELETE CASCADE,
  branch text CHECK (branch IN ('operation_avsec', 'ifc_avsec', 'hub_avsec')),
  station text,
  team text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_announcement_targets_match ON public.announcement_targets(announcement_id, branch, station, team);

CREATE TABLE IF NOT EXISTS public.announcement_acknowledgements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  announcement_id uuid NOT NULL REFERENCES public.announcements(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  acknowledged_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(announcement_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_announcement_acks_user ON public.announcement_acknowledgements(user_id, announcement_id);

ALTER TABLE public.announcements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.announcement_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.announcement_acknowledgements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "announcements_management_all" ON public.announcements;
CREATE POLICY "announcements_management_all"
  ON public.announcements FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid()
      AND role IN ('MANAGEMENT', 'ADMIN', 'SUPER_ADMIN')
    )
  );

DROP POLICY IF EXISTS "announcements_staff_select" ON public.announcements;
CREATE POLICY "announcements_staff_select"
  ON public.announcements FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      LEFT JOIN public.announcement_targets t ON t.announcement_id = announcements.id
      WHERE p.id = auth.uid()
      AND (
        t.id IS NULL
        OR (
          (t.branch IS NULL OR t.branch = p.ops_group)
          AND (t.station IS NULL OR t.station = p.station)
          AND (t.team IS NULL OR t.team = p.team)
        )
      )
    )
  );

DROP POLICY IF EXISTS "announcement_targets_management_all" ON public.announcement_targets;
CREATE POLICY "announcement_targets_management_all"
  ON public.announcement_targets FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid()
      AND role IN ('MANAGEMENT', 'ADMIN', 'SUPER_ADMIN')
    )
  );

DROP POLICY IF EXISTS "announcement_targets_staff_select" ON public.announcement_targets;
CREATE POLICY "announcement_targets_staff_select"
  ON public.announcement_targets FOR SELECT
  USING (true);

DROP POLICY IF EXISTS "announcement_acks_user_select" ON public.announcement_acknowledgements;
CREATE POLICY "announcement_acks_user_select"
  ON public.announcement_acknowledgements FOR SELECT
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "announcement_acks_user_insert" ON public.announcement_acknowledgements;
CREATE POLICY "announcement_acks_user_insert"
  ON public.announcement_acknowledgements FOR INSERT
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "announcement_acks_management_select" ON public.announcement_acknowledgements;
CREATE POLICY "announcement_acks_management_select"
  ON public.announcement_acknowledgements FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid()
      AND role IN ('MANAGEMENT', 'ADMIN', 'SUPER_ADMIN')
    )
  );


-- ============================================================================
-- 8. W.O.I.S AI Knowledge Base & Chat Tables
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.kb_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('sop', 'regulatory', 'app_help')),
  version TEXT NOT NULL DEFAULT '1.0',
  content TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.kb_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID REFERENCES public.kb_documents(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  section_title TEXT NOT NULL,
  content TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('sop', 'regulatory', 'app_help')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.wois_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT 'New Chat',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.wois_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES public.wois_conversations(id) ON DELETE CASCADE,
  sender TEXT NOT NULL CHECK (sender IN ('user', 'assistant')),
  body TEXT NOT NULL,
  confidence_tag TEXT CHECK (confidence_tag IN ('VERIFIED', 'GENERAL_KNOWLEDGE', 'REQUIRES_SOP', 'UNCERTAIN', 'ESCALATE')),
  source_type TEXT CHECK (source_type IN ('sop', 'regulatory', 'app_help', 'general')),
  sources JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.kb_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kb_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wois_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wois_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS kb_documents_read_auth ON public.kb_documents;
CREATE POLICY kb_documents_read_auth ON public.kb_documents
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS kb_chunks_read_auth ON public.kb_chunks;
CREATE POLICY kb_chunks_read_auth ON public.kb_chunks
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS wois_conversations_user_all ON public.wois_conversations;
CREATE POLICY wois_conversations_user_all ON public.wois_conversations
  FOR ALL TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS wois_messages_user_all ON public.wois_messages;
CREATE POLICY wois_messages_user_all ON public.wois_messages
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.wois_conversations c
      WHERE c.id = wois_messages.conversation_id AND c.user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.wois_conversations c
      WHERE c.id = wois_messages.conversation_id AND c.user_id = auth.uid()
    )
  );

CREATE INDEX IF NOT EXISTS idx_kb_chunks_doc ON public.kb_chunks(document_id);
CREATE INDEX IF NOT EXISTS idx_kb_chunks_source ON public.kb_chunks(source_type);
CREATE INDEX IF NOT EXISTS idx_wois_conv_user ON public.wois_conversations(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_wois_msg_conv ON public.wois_messages(conversation_id, created_at ASC);


-- ============================================================================
-- 9 & 10 & 11 & 12 & 13 & 14: Absence Notices & Consolidated Leave System
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.absence_notices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid DEFAULT '00000000-0000-0000-0000-000000000001'::uuid REFERENCES public.organizations(id),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  staff_name text NOT NULL,
  staff_id text,
  role text NOT NULL,
  station text,
  team text,
  ops_group text,
  shift_code text,
  duty_date date NOT NULL,
  leave_type text NOT NULL DEFAULT 'absent',
  start_date date NOT NULL DEFAULT CURRENT_DATE,
  end_date date NOT NULL DEFAULT CURRENT_DATE,
  shift_start_time timestamptz NOT NULL,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  gap_minutes integer,
  status text CHECK (status IN ('green', 'red')),
  approval_status text NOT NULL DEFAULT 'pending',
  reviewed_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  review_notes text,
  cancellation_reason text,
  cancel_requested_at timestamptz,
  remarks text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Ensure all columns exist if table was already created
ALTER TABLE public.absence_notices
  ADD COLUMN IF NOT EXISTS org_id uuid DEFAULT '00000000-0000-0000-0000-000000000001'::uuid,
  ADD COLUMN IF NOT EXISTS leave_type text NOT NULL DEFAULT 'absent',
  ADD COLUMN IF NOT EXISTS start_date date NOT NULL DEFAULT CURRENT_DATE,
  ADD COLUMN IF NOT EXISTS end_date date NOT NULL DEFAULT CURRENT_DATE,
  ADD COLUMN IF NOT EXISTS approval_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS reviewed_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS review_notes text,
  ADD COLUMN IF NOT EXISTS cancellation_reason text,
  ADD COLUMN IF NOT EXISTS cancel_requested_at timestamptz;

ALTER TABLE public.absence_notices
  ALTER COLUMN gap_minutes DROP NOT NULL,
  ALTER COLUMN status DROP NOT NULL;

-- Check constraints for absence_notices
DO $$
BEGIN
  ALTER TABLE public.absence_notices DROP CONSTRAINT IF EXISTS absence_notices_leave_type_check;
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

  ALTER TABLE public.absence_notices DROP CONSTRAINT IF EXISTS absence_notices_approval_status_check;
  ALTER TABLE public.absence_notices
    ADD CONSTRAINT absence_notices_approval_status_check
    CHECK (approval_status IN (
      'pending',
      'approved',
      'rejected',
      'pending_cancellation',
      'cancelled'
    ));

  ALTER TABLE public.absence_notices DROP CONSTRAINT IF EXISTS absence_notices_date_range_check;
  ALTER TABLE public.absence_notices
    ADD CONSTRAINT absence_notices_date_range_check
    CHECK (end_date >= start_date);
END $$;

-- Indices on absence_notices
CREATE INDEX IF NOT EXISTS idx_absence_notices_user_id ON public.absence_notices(user_id);
CREATE INDEX IF NOT EXISTS idx_absence_notices_duty_date ON public.absence_notices(duty_date desc);
CREATE INDEX IF NOT EXISTS idx_absence_notices_station_team ON public.absence_notices(station, team);
CREATE INDEX IF NOT EXISTS idx_absence_notices_ops_group ON public.absence_notices(ops_group);
CREATE INDEX IF NOT EXISTS idx_absence_notices_status ON public.absence_notices(status);
CREATE INDEX IF NOT EXISTS idx_absence_notices_station_team_status ON public.absence_notices(station, team, approval_status);
CREATE INDEX IF NOT EXISTS idx_absence_notices_user_dates ON public.absence_notices(user_id, start_date, end_date);
CREATE INDEX IF NOT EXISTS idx_absence_notices_leave_type ON public.absence_notices(leave_type);
CREATE INDEX IF NOT EXISTS idx_absence_notices_status_dates ON public.absence_notices(approval_status, start_date, end_date);
CREATE INDEX IF NOT EXISTS idx_absence_notices_org_id ON public.absence_notices(org_id);

-- Performance Compound Indices
CREATE INDEX IF NOT EXISTS idx_overtime_requests_work_date_status ON public.overtime_requests(work_date, status);
CREATE INDEX IF NOT EXISTS idx_duty_records_station_team_date ON public.duty_records(station, team, duty_date);

-- Enable RLS on absence_notices
ALTER TABLE public.absence_notices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "absence_notices_insert_own" ON public.absence_notices;
CREATE POLICY "absence_notices_insert_own" ON public.absence_notices
  FOR INSERT WITH CHECK (
    auth.uid() = user_id
    AND (org_id IS NULL OR org_id = current_org_id())
  );

DROP POLICY IF EXISTS "absence_notices_select_own" ON public.absence_notices;
CREATE POLICY "absence_notices_select_own" ON public.absence_notices
  FOR SELECT USING (
    auth.uid() = user_id
    AND (org_id IS NULL OR org_id = current_org_id())
  );

DROP POLICY IF EXISTS "absence_notices_select_elevated" ON public.absence_notices;
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

DROP POLICY IF EXISTS "absence_notices_dse_management_update" ON public.absence_notices;
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

DROP POLICY IF EXISTS "absence_notices_owner_cancellation_request" ON public.absence_notices;
CREATE POLICY "absence_notices_owner_cancellation_request" ON public.absence_notices
  FOR UPDATE
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

COMMIT;

-- ============================================================================
-- Reload PostgREST Schema Cache
-- ============================================================================
NOTIFY pgrst, 'reload schema';
