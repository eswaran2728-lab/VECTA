-- Roster branch-isolation fix (2026-09-22/23), part 2 of the investigation
-- that also fixed report acknowledgement (20260922000004). team_rosters
-- had no ops_group column at all, and "roster own team select" matched
-- purely on station+team - since team NAMES collide across branches
-- (both Operation and IFC AVSEC have a "Team ALPHA"), an ordinary
-- operational user could see the other branch's roster.
--
-- Read-only inventory (reported separately) found ALL 152 existing rows
-- are unattributable: every one was created by a Management-tier account
-- with its own ops_group = null, and duty_records shows both branches
-- genuinely operate under every shared team name - there is no safe
-- inference. Per the operator's explicit decision, those 152 rows are
-- exported (152 rows, exports/team_rosters_export_20260922T160409Z.csv,
-- outside the repo) and deleted in this same migration, NOT backfilled
-- with a guess. No replacement rows are created here.

alter table public.team_rosters
  add column if not exists ops_group text
    check (ops_group in ('operation_avsec', 'ifc_avsec', 'hub_avsec'));

-- The existing UNIQUE (station, team, roster_date) constraint predates
-- branch separation - it would let a second branch's roster for the same
-- team-name/date silently upsert-overwrite the first branch's row
-- instead of creating its own. Widen it to include ops_group, so
-- Operation ALPHA and IFC ALPHA can each have their own row for the same
-- date going forward.
alter table public.team_rosters
  drop constraint if exists team_rosters_station_team_roster_date_key;
alter table public.team_rosters
  add constraint team_rosters_station_team_roster_date_ops_group_key
  unique (station, team, roster_date, ops_group);

-- Delete only the 152 verified demo rows (KUL - MAA, ALPHA/BRAVO/CHARLIE/
-- DELTA, 2026-09-03 through 2026-10-10) - scoped explicitly by the exact
-- set verified before export, not a blanket "delete all" statement, so
-- this remains safe even if new legitimate rows are added between the
-- investigation and this migration running.
delete from public.team_rosters
where station = 'KUL - MAA'
  and team in ('ALPHA', 'BRAVO', 'CHARLIE', 'DELTA')
  and roster_date between '2026-09-03' and '2026-10-10';

-- "roster own team select": strict ops_group match added for ordinary
-- operational users. A row with ops_group is null (shouldn't exist after
-- the delete above, but defensively) never matches any real user's
-- ops_group, so it can't be seen by anyone through this policy.
drop policy if exists "roster own team select" on public.team_rosters;
create policy "roster own team select" on public.team_rosters
for select
using (
  station = current_station()
  and coalesce(team, '') = coalesce(current_team(), '')
  and ops_group = current_ops_group()
);

-- "roster org wide select" (rank-based, ENFORCEMENT+) and "roster admin
-- all" (ADMIN) are unchanged - Management/Admin/Enforcement org-wide
-- access is preserved exactly as before.

-- Second defect found examining this table's write side: "roster admin
-- all" is ADMIN-only (ALL commands) - there was NO write policy covering
-- MANAGEMENT at all, even though the application layer already allows
-- MANAGEMENT to call upsertRosterCell()/setTeamScheduleRange()
-- (requireRole(ADMIN_ROLES), which = [MANAGEMENT, ADMIN] -
-- lib/avsec/auth.ts). Same silent-no-op shape as the earlier
-- approveUser() defect (20260921000001/000002). Since preserving
-- Management's org-wide roster authority is required here, this adds a
-- matching org-wide write policy for MANAGEMENT (mirroring "roster admin
-- all"'s shape, not merged into it - ADMIN's policy stays untouched).
create policy "roster management manage" on public.team_rosters
for all
using (current_role_name() = 'MANAGEMENT')
with check (current_role_name() = 'MANAGEMENT');

-- The ops_group requirement for NEW rows (auto-derived for a DSE writer,
-- explicit selection required for Management) is enforced at the
-- application layer (lib/avsec/duty/roster-actions.ts) - RLS's job here
-- is only to gate WHO can write to team_rosters at all and WHO can read
-- which rows, not to validate the specific ops_group value chosen.
