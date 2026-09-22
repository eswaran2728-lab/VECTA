-- Roster integrity follow-up (2026-09-23), final step of the
-- team_rosters branch-isolation work (20260922000005). ops_group was
-- added nullable so the 152 pre-existing ambiguous demo rows could be
-- deleted without a NOT NULL violation. The table is now verified empty
-- (0 rows, checked immediately before this migration), so ops_group can
-- be safely made mandatory for every future row - no default value, so
-- Management/Admin must always explicitly choose a group; a DSE writer's
-- value is still auto-derived at the application layer
-- (lib/avsec/duty/roster-actions.ts resolveRosterOpsGroup()).
--
-- No CaterLink scanning/checkpoint policy, Hub scanning rule, report
-- acknowledgement, attendance/duty, leave/overtime, user/profile, or
-- existing report/transaction data is touched by this migration.

alter table public.team_rosters
  alter column ops_group set not null;
