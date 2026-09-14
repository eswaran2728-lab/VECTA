-- Cross-branch data isolation fix for overtime_requests. Applied directly
-- against vecta-prod on 2026-09-14; recorded here for migration history.
--
-- FOUND VIA LIVE BROWSER TESTING: Operation AVSEC and IFC AVSEC share
-- identical team names (ALPHA/BRAVO/CHARLIE/DELTA) at the same station
-- (e.g. KUL - MAA), differentiated only by profiles.ops_group. The
-- "overtime monitor select" and "overtime settle update" RLS policies
-- only matched on (station, team) — not ops_group — so IFC AVSEC's DSE
-- Alpha could see, and would have been able to endorse/approve/reject,
-- Operation AVSEC's Team ALPHA overtime records, and vice versa. Verified
-- live: before this fix, dse.ifc.alpha@vecta.local's OT queue showed an
-- Operation AVSEC ASO's overtime record; after, it correctly shows none.
--
-- NOTE: this same (station, team)-only pattern was found on other tables'
-- RLS (e.g. absence_notices, report_sec014) during this same audit pass —
-- flagged as a separate, broader remaining risk in the audit report, not
-- fixed here to keep this change narrowly scoped and verifiable.

CREATE OR REPLACE FUNCTION public.current_ops_group()
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select ops_group from profiles where id = auth.uid();
$function$;

ALTER TABLE public.overtime_requests ADD COLUMN IF NOT EXISTS ops_group text;

-- The one pre-existing row in this table was already APPROVED (settled)
-- before this migration, and a trigger (block_settled_overtime_mutation)
-- correctly refuses to let ANY column on a settled row be touched — so
-- that single historical/test record's ops_group could not be backfilled
-- and stays NULL. Its net effect: that one record is no longer visible to
-- any station/team-scoped monitor (it only matches the org-wide,
-- rank>=ENFORCEMENT branch of the policy). Every new record going forward
-- has ops_group populated at insert time by checkin-actions.ts.

DROP POLICY IF EXISTS "overtime monitor select" ON public.overtime_requests;
CREATE POLICY "overtime monitor select" ON public.overtime_requests
  FOR SELECT
  USING (
    (current_role_rank() > submitter_role_rank(profile_id))
    AND (
      (current_role_rank() >= role_rank('ENFORCEMENT'::user_role))
      OR (
        station = current_station()
        AND COALESCE(team, '') = COALESCE(current_team(), '')
        AND COALESCE(ops_group, '') = COALESCE(current_ops_group(), '')
      )
    )
  );

DROP POLICY IF EXISTS "overtime settle update" ON public.overtime_requests;
CREATE POLICY "overtime settle update" ON public.overtime_requests
  FOR UPDATE
  USING (
    (current_role_rank() > submitter_role_rank(profile_id))
    AND (
      (current_role_rank() >= role_rank('ENFORCEMENT'::user_role))
      OR (
        station = current_station()
        AND COALESCE(team, '') = COALESCE(current_team(), '')
        AND COALESCE(ops_group, '') = COALESCE(current_ops_group(), '')
      )
    )
  )
  WITH CHECK (
    (current_role_rank() > submitter_role_rank(profile_id))
    AND (
      (current_role_rank() >= role_rank('ENFORCEMENT'::user_role))
      OR (
        station = current_station()
        AND COALESCE(team, '') = COALESCE(current_team(), '')
        AND COALESCE(ops_group, '') = COALESCE(current_ops_group(), '')
      )
    )
  );
