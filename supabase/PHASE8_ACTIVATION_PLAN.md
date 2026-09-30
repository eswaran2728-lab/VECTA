# Phase 8 Activation and Compatibility Plan

Status: **prepared, not executed**. No production data has been read, guessed, or modified to
produce this document. Every query below is a template to be run against the real production
database by someone with legitimate access, not a result already obtained.

This plan governs the transition from the current all-legacy-role production state to Phase 3
scoped role assignments for the workforce covered by Phase 8 (Operation, Investigation, SAT,
Profiling, Main Enforcement). It does not cover CaterLink station-access policy (Phase 9) or any
later phase.

## 1. Existing-account inventory (query template, not yet run)

Run against production, read-only, before any assignment is created:

```sql
-- Legacy role/station/team distribution today.
select role, station, team, ops_group, status, count(*) as staff_count
from public.profiles
group by role, station, team, ops_group, status
order by role, station, team;

-- Anyone already holding a Phase 3 assignment (expect zero rows in production today).
select count(*) as existing_phase3_assignments from public.user_role_assignments;
```

Expected output today: the second query returns `0` (confirmed structurally — Phase 3's own
migration seeds zero assignment rows, and no later migration inserts any). The first query's
actual result is unknown to this plan and must be captured from production before proceeding —
**do not assume the row counts belong here; run the query.**

## 2. Proposed role and scope mapping (requires human confirmation per group)

This is a *proposed mapping rule*, not a list of specific people. Each rule below must be
confirmed by someone with organizational authority before Part 5's activation order runs against
real accounts.

| Current signal | Proposed Phase 3 role | Scope needed | Confirmation required |
|---|---|---|---|
| `profile.role = 'DSE'` at station `KUL - MAA`, team X | `dse` | `department_id` (operation), `hub_id` (KUL hub), `station_id` (KUL - MAA), `team_id` (X) | Confirm this DSE is not also acting station-wide across multiple KUL teams (would need `hub_se` instead) |
| `profile.role = 'DSE'` at a non-KUL station | **No direct Phase 3 equivalent** | — | DSE is KUL-only per Phase 3's scope-shape rule; a non-KUL "DSE" in legacy data needs its actual current duties confirmed (likely `hub_se` for their hub, or `sso`/`so`/`aso`) |
| `profile.role = 'MANAGEMENT'` or `unified_role = 'management'`, Operation duties | `operation_manager` | `department_id` (operation) only | **Explicit confirmation required per person** — this is the single highest-blast-radius mapping (Malaysia-wide Operation authority); do not bulk-assign every legacy MANAGEMENT account this role |
| `profile.role = 'ENFORCEMENT'` or `unified_role` indicating Enforcement duties | `main_enforcement` | `department_id` (enforcement) only | **Explicit confirmation required per person**, same reason as above |
| Staff currently doing Investigation work (no clean legacy signal — Investigation had no dedicated `profiles.role` value before Phase 8) | `investigation_sso` / `investigation_so` / `investigation_aso` | `department_id` (enforcement), `unit_id` (investigation) | **Fully unresolved** — requires a named list from Enforcement leadership; nothing in `profiles` distinguishes an Investigation officer from any other Enforcement-tagged account today |
| Staff currently doing SAT work (KUL, 4 teams) | `sat_aso` | `department_id` (enforcement), `unit_id` (sat), `hub_id`/`station_id` (KUL), `team_id` (Alpha/Bravo/Charlie/Delta) | **Fully unresolved** — same gap as Investigation; also needs each person's specific team (Alpha/Bravo/Charlie/Delta) confirmed, since `sat_aso`'s scope-shape rule requires an exact team |
| Staff currently doing Profiling work | `profiling_so` / `profiling_aso` | `department_id` (enforcement), `unit_id` (profiling), `hub_id`/`station_id`/`team_id` | **Fully unresolved** — same gap; SO vs ASO rank must also be confirmed per person |
| A Hub SE-equivalent role at a non-KUL hub (Northern/Southern/Sarawak/Sabah) | `hub_se` | `department_id` (operation), `hub_id` (their hub) | Confirm who currently exercises hub-wide (not single-station) Operation authority at each hub — this may not map cleanly from any single existing `profiles` field |

**No row in this table authorizes assigning a specific named person to a role.** It is a mapping
*rule*; applying it to real names is a separate, human-approved step (Part 5).

## 3. Malaysia AOC activation order

Proposed sequence, each stage gated on the previous stage's validation queries (Part 6) passing
cleanly:

1. **Operation Manager** (1–2 people, Malaysia-wide Operation authority) — highest impact, lowest
   headcount, easiest to verify individually. Activate first and observe for a defined
   confirmation period before proceeding.
2. **Hub SE** (one person per hub: KUL is DSE-covered directly, so this is Northern/Southern-
   EastCoast/Sarawak/Sabah — up to 4 people).
3. **KUL DSE** (per KUL team — Alpha/Bravo/Charlie/Delta or however many currently exist).
4. **Main Enforcement** (1–2 people, Malaysia-wide Enforcement authority) — same caution as
   Operation Manager.
5. **Investigation SSO/SO/ASO** (Malaysia-wide within Investigation).
6. **SAT ASO** (KUL, 4 teams).
7. **Profiling SO/ASO**.

Rationale for this order: it activates the two highest-authority, lowest-headcount roles
(Operation Manager, Main Enforcement) first and individually, so any scope-resolution defect
surfaces on a small, closely-watched population before the larger DSE/Hub SE/unit-staff
population is activated behind them (leave/OT routing and Investigation/SAT/Profiling all depend
on Main Enforcement and Operation Manager already being correctly assigned).

## 4. Legacy compatibility period

- `reviewLeaveApplication()` ([absence-actions.ts](../lib/avsec/duty/absence-actions.ts)) routes
  through the concurrency-safe RPC only for a *reviewer* who already holds an active Phase 3
  assignment; a reviewer with zero active assignments keeps using the pre-Phase-8 path unchanged.
  This means the compatibility period is naturally per-person, not a single cutover date — as
  each reviewer is activated (Part 3), their own reviews immediately start going through the
  secure path, while not-yet-activated reviewers are entirely unaffected.
- `reviewOvertimeRequest()` ([overtime-actions.ts](../lib/avsec/duty/overtime-actions.ts)) follows
  the same shape: the app-layer gate now also accepts Phase 3 `hub_se`/`operation_manager`/
  `main_enforcement`, but a caller with none of those and no legacy DSE/Management rank is simply
  denied, exactly as before Phase 8.
- No Phase 8 migration removes, renames, or narrows any pre-Phase-8 column, table, RLS policy, or
  trigger branch. Every legacy path that worked before this phase continues to work for anyone not
  yet holding a Phase 3 assignment.

## 5. Phase 3 assignment activation sequence (per person, per the order in Part 3)

For each person being activated:

1. Confirm their target role + exact scope against Part 2's mapping rule and get explicit
   sign-off (not inferred from `profiles`).
2. If the target role is entity-administered (`dse`, `hub_se`, `investigation_*`, `sat_aso`,
   `profiling_*`, `sso`, `so`, `aso`), confirm they have (or create) an active row in
   `user_entity_memberships` first — Phase 4's trigger requires this before the role assignment
   will validate.
3. Insert the `user_role_assignments` row with `granted_by` set to the approving administrator
   (never the same as the assignee — the self-grant constraint already enforces this) and a
   `grant_reason` recording the approval (e.g. a ticket/reference number).
4. Immediately run the person-specific validation query (Part 6.1) for that one person before
   moving to the next.
5. Only after every person in a stage (Part 3) passes validation, proceed to the next stage.

## 6. Validation queries (run after each activation, not written in advance to assume results)

### 6.1 Per-person, immediately after their assignment is created

```sql
select public.get_my_active_role_assignments(); -- run AS that person, or via a service check
-- Confirms: exactly the intended role, exactly the intended scope, status active.
```

### 6.2 Per-stage, after every person in a stage is activated

```sql
select rd.code as role_code, count(*) as active_count
from public.user_role_assignments ura
join public.role_definitions rd on rd.id = ura.role_definition_id
where ura.revoked_at is null and ura.starts_at <= now() and (ura.ends_at is null or ura.ends_at > now())
group by rd.code
order by rd.code;
-- Compare against the expected count for that stage (Part 7) -- investigate any mismatch
-- before proceeding to the next stage.
```

### 6.3 Scope-shape and duplicate-assignment sanity check (should always return zero rows)

```sql
-- Any assignment that somehow violates Phase 3's own scope-shape trigger
-- would have been rejected at insert time -- this just re-confirms nothing
-- was inserted through a bypass (e.g. a future migration run as service_role
-- without going through the trigger).
select ura.id, rd.code, ura.department_id, ura.unit_id, ura.hub_id, ura.station_id, ura.team_id
from public.user_role_assignments ura
join public.role_definitions rd on rd.id = ura.role_definition_id
where rd.code = 'dse' and (ura.hub_id is null or ura.station_id is null or ura.team_id is null);
-- Repeat the analogous shape check for hub_se/investigation_*/sat_aso/profiling_*/sso/so/aso
-- per the scope-shape rules in 20260928000002_phase3_role_permission_foundation.sql.
```

### 6.4 Application-behavior spot check per stage

- Confirm the newly-activated Operation Manager sees the Malaysia-wide review queue at
  `/avsec/duty/absences` and `/avsec/duty/overtime`, and the duty-draw page at
  `/avsec/operation/duty-draw`.
- Confirm the newly-activated Main Enforcement sees `/avsec/enforcement/workforce`.
- Confirm a newly-activated DSE/Hub SE sees only their own team/hub, never a broader set.
- Confirm a newly-activated Investigation/SAT/Profiling account sees only their own
  workspace/team, never another team's.

## 7. Expected counts by role, department, unit, hub, station and team

**Not filled in.** This plan does not guess headcounts. Before Part 3 Stage 1 begins, populate
this table from Part 1's inventory query results plus the confirmed mapping from Part 2, and keep
it as the reference Part 6.2 compares against:

| Role | Department | Unit | Hub | Station | Team | Expected count | Confirmed by |
|---|---|---|---|---|---|---|---|
| operation_manager | operation | — | — | — | — | *(fill in)* | *(name/date)* |
| hub_se | operation | — | *(per hub)* | — | — | *(fill in)* | |
| dse | operation | — | KUL | KUL - MAA | *(per team)* | *(fill in)* | |
| main_enforcement | enforcement | — | — | — | — | *(fill in)* | |
| investigation_sso/so/aso | enforcement | investigation | — | — | — | *(fill in)* | |
| sat_aso | enforcement | sat | KUL | KUL - MAA | *(per team)* | *(fill in)* | |
| profiling_so/aso | enforcement | profiling | *(per hub/station)* | | *(per team)* | *(fill in)* | |

## 8. Rollback procedure

Because every Phase 8 migration is additive (Part L: no pre-Phase-8 object removed, renamed, or
narrowed), rollback of an *activation* (not of the migration itself) is a data-only operation:

1. To deactivate one person: `update public.user_role_assignments set revoked_at = now() where id = ?`
   (never a hard delete — the row's history stays for audit). They immediately fall back to
   whatever legacy behavior their `profiles.role` already grants, with zero code or schema change
   required.
2. To roll back an entire stage: revoke every assignment row created for that stage
   (`grant_reason` should reference a stage/batch identifier from Part 5 step 3 to make this a
   single `WHERE grant_reason = ?` update).
3. To roll back the whole Phase 8 activation: revoke every row in `user_role_assignments` that has
   a Phase 8-related `role_definition_id` (`operation_manager`, `hub_se`, `dse`,
   `main_enforcement`, `investigation_*`, `sat_aso`, `profiling_*` — the pre-existing `sso`/`so`/
   `aso` rows, if any were also created, follow the same rule). Every legacy account is unaffected
   throughout, since the legacy path was never removed.
4. Rolling back the *migration itself* (schema/RPCs) is out of scope for this activation plan —
   it would only be needed if a defect were found in the RPCs themselves, not in an individual
   activation decision, and would require its own reviewed migration, not a step taken here.

## 9. What this plan explicitly does not do

- It does not assign any real person to any real role.
- It does not run any of the queries above against production.
- It does not fill in Part 7's counts.
- It does not claim Investigation, SAT, or Profiling staff identities are known — Part 2 marks
  those mappings as fully unresolved, requiring a named list from the relevant leadership before
  Part 5 can begin for those roles.
