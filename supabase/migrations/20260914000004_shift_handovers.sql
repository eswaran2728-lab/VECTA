-- Shift Handover Summary (Workflow Upgrades item 6).
-- Applied directly against vecta-prod on 2026-09-14; recorded here for the
-- migration history / anyone rebuilding the schema from scratch.

CREATE TABLE public.shift_handovers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid,
  outgoing_profile_id uuid not null references public.profiles(id),
  station text not null,
  team text,
  staff_name text not null,
  staff_id text not null,
  place_category text not null check (place_category in ('Bay','Premises','Terminal')),
  place_detail text not null,
  flight_number text,
  handover_notes text not null,
  unfinished_work_summary jsonb not null default '[]'::jsonb,
  acknowledged_by uuid references public.profiles(id),
  acknowledged_at timestamptz,
  acknowledgment_notes text,
  created_at timestamptz not null default now()
);

CREATE INDEX shift_handovers_station_team_idx ON public.shift_handovers (station, team, created_at desc);
CREATE INDEX shift_handovers_flight_idx ON public.shift_handovers (station, flight_number, created_at desc) WHERE flight_number IS NOT NULL;

ALTER TABLE public.shift_handovers ENABLE ROW LEVEL SECURITY;

-- Outgoing staff create their own handover record.
CREATE POLICY "shift_handovers own insert" ON public.shift_handovers
  FOR INSERT
  WITH CHECK (outgoing_profile_id = auth.uid() AND current_status() = 'approved'::profile_status);

-- Visible to the outgoing staff member, anyone on the same station+team
-- (the incoming shift), or org-wide roles (Enforcement/Management/Admin) —
-- same station/team/rank helper functions used by overtime_requests.
CREATE POLICY "shift_handovers team select" ON public.shift_handovers
  FOR SELECT
  USING (
    outgoing_profile_id = auth.uid()
    OR current_role_rank() >= role_rank('ENFORCEMENT'::user_role)
    OR (station = current_station() AND COALESCE(team, '') = COALESCE(current_team(), ''))
  );

-- Only an unacknowledged record can be acknowledged, only by someone on the
-- same station+team (or org-wide), and only by setting themselves as the
-- acknowledger — this is the responsibility-transfer record.
CREATE POLICY "shift_handovers team acknowledge" ON public.shift_handovers
  FOR UPDATE
  USING (
    acknowledged_at IS NULL
    AND (
      current_role_rank() >= role_rank('ENFORCEMENT'::user_role)
      OR (station = current_station() AND COALESCE(team, '') = COALESCE(current_team(), ''))
    )
  )
  WITH CHECK (
    acknowledged_by = auth.uid()
  );
