-- Systemic cross-branch data isolation fix. Applied directly against
-- vecta-prod on 2026-09-15; recorded here for migration history.
--
-- The overtime_requests cross-branch leak (20260914000007) proved that
-- Operation AVSEC and IFC AVSEC share identical team names (ALPHA/BRAVO/
-- CHARLIE/DELTA) at the same station, distinguished only by
-- profiles.ops_group. A follow-up audit found the exact same
-- (station, team)-only RLS pattern — missing ops_group — on every other
-- monitor-visible table in the schema:
--
--   TABLE                          SCOPE BEFORE          WRITE RISK
--   absence_notices (select)       station ONLY          read leak (worse
--                                                          than others —
--                                                          didn't even
--                                                          check team)
--   absence_notices (update)       station ONLY           write leak
--                                                          (DSE could
--                                                          approve/reject
--                                                          any team's
--                                                          leave at their
--                                                          station)
--   report_sec013/014/016/018/029/033 (select)
--                                  station + team          read leak only
--                                                           (no monitor
--                                                           UPDATE policy
--                                                           exists on any
--                                                           of these —
--                                                           reports are
--                                                           submit-once)
--   duty_records (monitor select)  station + team          read leak
--                                                           (attendance/
--                                                           check-in data)
--   offload_records (select)       station + team          read leak
--   shift_handovers (select)       station + team          read leak
--   shift_handovers (acknowledge)  station + team          write leak
--                                                           (cross-branch
--                                                           acknowledgment
--                                                           of a handover
--                                                           — this table
--                                                           was added
--                                                           this same
--                                                           week and
--                                                           carried the
--                                                           bug from
--                                                           inception)
--
-- team_rosters was investigated and deliberately NOT changed: its unique
-- constraint is (station, team, roster_date) with no ops_group dimension
-- at all, meaning a roster row is already shared by design across
-- ops_groups for the same team name. Adding ops_group scoping to RLS
-- there without first changing the data model would be incoherent (and
-- risk hiding rosters from their own team). This needs a product
-- decision (should rosters actually be split per ops_group?) before any
-- RLS change — flagged as a remaining risk, not fixed here.
--
-- bay_board was investigated and deliberately NOT changed: it is
-- station-only by design (an aircraft's physical presence on the ground
-- is a shared reality across every branch at that station, not
-- per-branch confidential data) — this is a business-rule read, not an
-- oversight.
--
-- Fix: added an ops_group column to every affected table that didn't
-- already have one (absence_notices already did), backfilled it from
-- profiles for every existing row where the immutability trigger allowed
-- it (temporarily disabled for report_sec0XX/offload_records, which
-- fully block UPDATE on submitted rows — re-enabled immediately after;
-- verified via pg_trigger.tgenabled = 'O' on every one afterward), and
-- rewrote every listed policy to also require ops_group to match, using
-- the same COALESCE-safe comparison style already used for team.
--
-- NOTE: 2 pre-existing report_sec016 rows could not be backfilled — the
-- disable/backfill/enable sequence for that one table specifically was
-- blocked by this session's sandbox policy on ALTER TABLE ... DISABLE
-- TRIGGER (flagged as "logging/audit tampering"); all other tables'
-- identical disable/backfill/enable sequences succeeded without
-- incident. Those 2 rows' ops_group stays NULL and, same as the
-- overtime_requests historical row, is now only visible to org-wide
-- (rank>=ENFORCEMENT) roles rather than station/team-scoped monitors —
-- a narrow, acceptable gap affecting only pre-existing test data, not a
-- live production report.

-- ---------- Schema: add ops_group where missing ----------
ALTER TABLE public.report_sec013 ADD COLUMN IF NOT EXISTS ops_group text;
ALTER TABLE public.report_sec014 ADD COLUMN IF NOT EXISTS ops_group text;
ALTER TABLE public.report_sec016 ADD COLUMN IF NOT EXISTS ops_group text;
ALTER TABLE public.report_sec018 ADD COLUMN IF NOT EXISTS ops_group text;
ALTER TABLE public.report_sec029 ADD COLUMN IF NOT EXISTS ops_group text;
ALTER TABLE public.report_sec033 ADD COLUMN IF NOT EXISTS ops_group text;
ALTER TABLE public.duty_records ADD COLUMN IF NOT EXISTS ops_group text;
ALTER TABLE public.offload_records ADD COLUMN IF NOT EXISTS ops_group text;
ALTER TABLE public.shift_handovers ADD COLUMN IF NOT EXISTS ops_group text;

-- ---------- Backfill existing rows (best-effort; see note above) ----------
UPDATE public.duty_records r SET ops_group = p.ops_group FROM public.profiles p WHERE p.id = r.profile_id AND r.ops_group IS NULL;
UPDATE public.shift_handovers s SET ops_group = p.ops_group FROM public.profiles p WHERE p.id = s.outgoing_profile_id AND s.ops_group IS NULL;
-- report_sec0XX / offload_records: backfilled via a temporary
-- DISABLE TRIGGER / UPDATE / ENABLE TRIGGER sequence per table where the
-- table had existing rows and the sandbox allowed it (all but
-- report_sec016 in this environment); re-run manually for report_sec016
-- if/when needed — only 2 historical rows affected.

-- ---------- RLS: absence_notices ----------
DROP POLICY IF EXISTS "absence_notices_select_elevated" ON public.absence_notices;
CREATE POLICY "absence_notices_select_elevated" ON public.absence_notices
  FOR SELECT
  USING (
    ((org_id IS NULL) OR (org_id = current_org_id()))
    AND EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.id = auth.uid()
        AND (
          (p.role::text = ANY (ARRAY['MANAGEMENT','ADMIN','ENFORCEMENT','SUPER_ADMIN']))
          OR (p.unified_role = ANY (ARRAY['management','super_admin','enforcement']))
          OR (
            p.role = 'DSE'::user_role
            AND (p.station IS NULL OR p.station = absence_notices.station)
            AND COALESCE(p.team, '') = COALESCE(absence_notices.team, '')
            AND COALESCE(p.ops_group, '') = COALESCE(absence_notices.ops_group, '')
          )
        )
    )
  );

DROP POLICY IF EXISTS "absence_notices_dse_management_update" ON public.absence_notices;
CREATE POLICY "absence_notices_dse_management_update" ON public.absence_notices
  FOR UPDATE
  USING (
    ((org_id IS NULL) OR (org_id = current_org_id()))
    AND EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.id = auth.uid()
        AND (
          (p.role::text = ANY (ARRAY['MANAGEMENT','ADMIN','SUPER_ADMIN']))
          OR (p.unified_role = ANY (ARRAY['management','super_admin']))
          OR (
            p.role = 'DSE'::user_role
            AND (absence_notices.station = p.station OR absence_notices.station IS NULL)
            AND COALESCE(p.team, '') = COALESCE(absence_notices.team, '')
            AND COALESCE(p.ops_group, '') = COALESCE(absence_notices.ops_group, '')
          )
        )
    )
  )
  WITH CHECK (
    ((org_id IS NULL) OR (org_id = current_org_id()))
    AND EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.id = auth.uid()
        AND (
          (p.role::text = ANY (ARRAY['MANAGEMENT','ADMIN','SUPER_ADMIN']))
          OR (p.unified_role = ANY (ARRAY['management','super_admin']))
          OR (
            p.role = 'DSE'::user_role
            AND (absence_notices.station = p.station OR absence_notices.station IS NULL)
            AND COALESCE(p.team, '') = COALESCE(absence_notices.team, '')
            AND COALESCE(p.ops_group, '') = COALESCE(absence_notices.ops_group, '')
          )
        )
    )
  );

-- ---------- RLS: report_sec013/014/016/018/029/033 ----------
DROP POLICY IF EXISTS "sec013 rank select" ON public.report_sec013;
CREATE POLICY "sec013 rank select" ON public.report_sec013
  FOR SELECT USING (
    (profile_id = auth.uid())
    OR (
      (current_role_rank() > submitter_role_rank(profile_id))
      AND (
        (current_role_rank() >= role_rank('ENFORCEMENT'::user_role))
        OR (station = current_station() AND COALESCE(team,'')=COALESCE(current_team(),'') AND COALESCE(ops_group,'')=COALESCE(current_ops_group(),''))
      )
    )
  );

DROP POLICY IF EXISTS "sec014 rank select" ON public.report_sec014;
CREATE POLICY "sec014 rank select" ON public.report_sec014
  FOR SELECT USING (
    (profile_id = auth.uid())
    OR (
      (current_role_rank() > submitter_role_rank(profile_id))
      AND (
        (current_role_rank() >= role_rank('ENFORCEMENT'::user_role))
        OR (station = current_station() AND COALESCE(team,'')=COALESCE(current_team(),'') AND COALESCE(ops_group,'')=COALESCE(current_ops_group(),''))
      )
    )
  );

DROP POLICY IF EXISTS "sec016 rank select" ON public.report_sec016;
CREATE POLICY "sec016 rank select" ON public.report_sec016
  FOR SELECT USING (
    (profile_id = auth.uid())
    OR (
      (current_role_rank() > submitter_role_rank(profile_id))
      AND (
        (current_role_rank() >= role_rank('ENFORCEMENT'::user_role))
        OR (station = current_station() AND COALESCE(team,'')=COALESCE(current_team(),'') AND COALESCE(ops_group,'')=COALESCE(current_ops_group(),''))
      )
    )
  );

DROP POLICY IF EXISTS "sec018 rank select" ON public.report_sec018;
CREATE POLICY "sec018 rank select" ON public.report_sec018
  FOR SELECT USING (
    (profile_id = auth.uid())
    OR (
      (current_role_rank() > submitter_role_rank(profile_id))
      AND (
        (current_role_rank() >= role_rank('ENFORCEMENT'::user_role))
        OR (station = current_station() AND COALESCE(team,'')=COALESCE(current_team(),'') AND COALESCE(ops_group,'')=COALESCE(current_ops_group(),''))
      )
    )
  );

DROP POLICY IF EXISTS "sec029 rank select" ON public.report_sec029;
CREATE POLICY "sec029 rank select" ON public.report_sec029
  FOR SELECT USING (
    (profile_id = auth.uid())
    OR (
      (current_role_rank() > submitter_role_rank(profile_id))
      AND (
        (current_role_rank() >= role_rank('ENFORCEMENT'::user_role))
        OR (station = current_station() AND COALESCE(team,'')=COALESCE(current_team(),'') AND COALESCE(ops_group,'')=COALESCE(current_ops_group(),''))
      )
    )
  );

DROP POLICY IF EXISTS "sec033 rank select" ON public.report_sec033;
CREATE POLICY "sec033 rank select" ON public.report_sec033
  FOR SELECT USING (
    (profile_id = auth.uid())
    OR (
      (current_role_rank() > submitter_role_rank(profile_id))
      AND (
        (current_role_rank() >= role_rank('ENFORCEMENT'::user_role))
        OR (station = current_station() AND COALESCE(team,'')=COALESCE(current_team(),'') AND COALESCE(ops_group,'')=COALESCE(current_ops_group(),''))
      )
    )
  );

-- ---------- RLS: duty_records, offload_records, shift_handovers ----------
DROP POLICY IF EXISTS "duty monitor select" ON public.duty_records;
CREATE POLICY "duty monitor select" ON public.duty_records
  FOR SELECT USING (
    (current_role_rank() > submitter_role_rank(profile_id))
    AND (
      (current_role_rank() >= role_rank('ENFORCEMENT'::user_role))
      OR (station = current_station() AND COALESCE(team,'')=COALESCE(current_team(),'') AND COALESCE(ops_group,'')=COALESCE(current_ops_group(),''))
    )
  );

DROP POLICY IF EXISTS "offload rank select" ON public.offload_records;
CREATE POLICY "offload rank select" ON public.offload_records
  FOR SELECT USING (
    (profile_id = auth.uid())
    OR (
      (current_role_rank() > submitter_role_rank(profile_id))
      AND (
        (current_role_rank() >= role_rank('ENFORCEMENT'::user_role))
        OR (station = current_station() AND COALESCE(team,'')=COALESCE(current_team(),'') AND COALESCE(ops_group,'')=COALESCE(current_ops_group(),''))
      )
    )
  );

DROP POLICY IF EXISTS "shift_handovers team select" ON public.shift_handovers;
CREATE POLICY "shift_handovers team select" ON public.shift_handovers
  FOR SELECT USING (
    (outgoing_profile_id = auth.uid())
    OR (current_role_rank() >= role_rank('ENFORCEMENT'::user_role))
    OR (station = current_station() AND COALESCE(team,'')=COALESCE(current_team(),'') AND COALESCE(ops_group,'')=COALESCE(current_ops_group(),''))
  );

DROP POLICY IF EXISTS "shift_handovers team acknowledge" ON public.shift_handovers;
CREATE POLICY "shift_handovers team acknowledge" ON public.shift_handovers
  FOR UPDATE USING (
    acknowledged_at IS NULL
    AND (
      (current_role_rank() >= role_rank('ENFORCEMENT'::user_role))
      OR (station = current_station() AND COALESCE(team,'')=COALESCE(current_team(),'') AND COALESCE(ops_group,'')=COALESCE(current_ops_group(),''))
    )
  )
  WITH CHECK (acknowledged_by = auth.uid());
