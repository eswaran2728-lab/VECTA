# Rollout Runbook

Ordering is fixed; do not reorder. "Command/action category" deliberately
never embeds a secret — real credentials/keys are handled per the
organization's existing secret-management process, referenced only by
name here.

| # | Step | Owner | Prerequisite | Action category | Evidence to collect | Stop condition | Rollback trigger | Rollback action | Recovery verification |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Take backup, verify restore capability | ICT / DB admin | Staging (or production) database access | Platform-native backup + a real restore-to-scratch-database drill | Restore completes; row counts match pre-backup snapshot | Restore fails or row counts mismatch | n/a (this step gates everything after it) | n/a | Restored scratch DB passes a basic smoke query |
| 2 | Record current migration/schema/extension state | ICT / DB admin | Step 1 complete | Query the platform's migration-tracking table/mechanism; list installed extensions | A dated snapshot file of both | Tracking table is missing/corrupted | Investigate before proceeding | n/a | Snapshot is diffable against the repo's manifest (`migration-deployment-manifest.md`) |
| 3 | Deploy application compatibility code where required | App deploy owner | Step 2's snapshot reviewed | Standard app deployment (Vercel or equivalent) of a build that does NOT yet depend on any pending migration's new objects | Deployment succeeds; app serves existing traffic unaffected | Build fails, or the deployed code calls an RPC that doesn't exist yet | Immediate | Redeploy the previous known-good build | Smoke test existing (pre-Phase-13) functionality |
| 4 | Apply reviewed pending forward migrations | DB admin | Step 3 live; migrations reviewed against this repo's manifest, in filename order, ONLY the ones the target doesn't already have | Platform migration-apply mechanism, one reviewed batch at a time — never "replay everything" | Each migration's own postcondition check (see `migration-deployment-manifest.md` per-phase table) | Any postcondition check fails | Depends on the specific migration; most here are additive (`create table/function if not exists`) and safe to leave applied while investigating; a failed mid-migration transaction rolls back automatically (every migration here is a single transactional file) | Restore from step 1's backup only if a migration partially applied in a non-transactional way (none identified in this repo) | Re-run the postcondition check |
| 5 | Run read-only preflights | DB admin / App owner | Step 4 complete | Run each backfill's read-only preflight query (see `backfill-readiness.md`) | Affected-row counts + ambiguity lists, saved | Any preflight shows an unexpectedly large ambiguity list | n/a (read-only) | n/a | Preflight is re-runnable any time |
| 6 | Activate/map approved replacement assignments | ICT + role owner | Step 5's role-assignment preflight reviewed | Manual, reviewed, per-account `user_role_assignments` insert | `view_legacy_role_mapping_report_secure()` shows the mapped account's `has_replacement_assignment = true` | An account's intended replacement role is ambiguous | Leave unmapped, flag for manual review | `revoked_at` on a wrongly-assigned replacement | Re-run the legacy mapping report |
| 7 | Execute controlled backfills | DB admin | Step 6's role mappings in place (where a backfill depends on them) | Run the specific backfill script for ONE domain at a time (see `backfill-readiness.md`), never all at once | Reconciliation output (rows affected, quarantined, skipped) | Quarantine list is non-trivial, or affected-row count diverges from preflight | Depends on the domain; every backfill here is additive/upsert-shaped | Re-run is safe (idempotent by design) | Re-run the domain's preflight; count should now be 0 |
| 8 | Verify reconciliation | DB admin + App owner | Step 7 complete for the domain | Compare pre/post state against the preflight's affected-row count | Match | Mismatch | Investigate before touching another domain | n/a | n/a |
| 9 | Verify real managed RLS/grants/storage/cron | DB admin / ICT | Steps 4-8 complete | Exercise one real request per role tier against the real managed Supabase project (not PGlite/native) — RLS read/write, a real signed-URL round trip per bucket in `storage-matrix.md`, confirm each `cron.schedule()` job is registered and has fired at least once | Logs/screenshots per check | Any check fails | Depends on which check; most are read-only verification | n/a | Repeat the specific check |
| 10 | Enable feature slices gradually | App owner | Step 9 complete | Flip the relevant environment/config value for ONE feature at a time (see `feature-activation-controls.md`) | Health signal for that feature turns green | Health signal doesn't turn green within a defined window | Immediate | Revert that one config value | Health signal confirmed green again |
| 11 | Configure Gemini only in staging encrypted environment | App owner + ICT | Step 10 reached WOIS AI in the slice order | Set `WOIS_AI_PROVIDER=gemini` + `GEMINI_API_KEY` (+ optional overrides) in staging's encrypted env config ONLY — see `docs/wois-ai-provider.md` | A real staging conversation succeeds; a deliberately-short-timeout test confirms fallback still engages | Any Gemini call errors unexpectedly, or fallback doesn't engage on a forced timeout | Unset `WOIS_AI_PROVIDER` | Immediate (env var change + restart) | Confirm `view_release_readiness_report_secure`'s merged `wois_provider_configured` boolean (see `feature-activation-controls.md`) reflects the change |
| 12 | Run authenticated staging certification | QA / App owner | Steps 1-11 complete | Full regression pass against the real staging deployment with real authenticated sessions (not the local PGlite/native harness) | Pass/fail report per area | Any area fails | Depends on severity | Fix forward or revert the specific feature slice | Re-run |
| 13 | Run role-by-role UAT | Each role's real user + App owner | Step 12 passed | Each role listed in `dashboard-adjustment-inventory.md` exercises their own real workflows | Signed-off UAT checklist per role | Any role's UAT fails | Depends on severity | Fix forward or hold that role's feature slice | Re-run that role's UAT |
| 14 | Run Malaysia controlled trial | Operations + ICT | Step 13 passed for all Malaysia roles | Limited real-time operational use, monitored | Trial log, issue list | A safety- or data-integrity-relevant issue appears | Immediate rollback of the specific feature | Revert feature slice / config | Confirm issue resolved before resuming trial |
| 15 | Remediate trial findings | App owner | Step 14's issue list | Standard fix-forward development cycle | Fixed issues re-verified against the original trial scenario | n/a | n/a | n/a | n/a |
| 16 | Configure remaining AOCs while Malaysia trial continues | ICT + App owner | Step 14 stable | Repeat Phase 2's org-foundation seeding for each new AOC (resolve-by-code, never hardcoded) | New AOC's data appears correctly isolated from Malaysia's | Any cross-AOC leak | Immediate | Disable the new AOC's role assignments | Re-run multi-AOC isolation checks |
| 17 | Run each AOC's UAT/trial | Each AOC's real users | Step 16 per AOC | Same as steps 13-14, per AOC | Same as steps 13-14 | Same as steps 13-14 | Same as steps 13-14 | Same as steps 13-14 | Same as steps 13-14 |
| 18 | Obtain final ICT acceptance | ICT | Steps 1-17 complete, including backup/restore/monitoring/operational acceptance | Formal sign-off per the organization's existing acceptance process | Signed acceptance record | ICT withholds acceptance | Address ICT's findings | n/a | n/a |
| 19 | Only then, consider legacy-role cleanup and production completion | ICT + App owner | Step 18 AND every condition in `legacy-transition-inventory.md`'s retirement gate | The future cleanup sequence documented there | `view_legacy_role_mapping_report_secure()` shows zero unmapped legacy accounts | Any condition in the retirement gate is unmet | Do not proceed | n/a | n/a |

## Standing rules

- **Never** apply a disposable-test-platform stub or synthetic fixture to
  staging or production — those exist only for this repo's own local
  PGlite/native harness (see `migration-deployment-manifest.md`'s
  "Disposable-test-platform-only adaptations" row).
- This is the authoritative sequence AFTER Phase 13 (restated from the
  Phase 13 authorization message, unchanged): push the reviewed Phase 13
  branch → consolidated dashboard/UI adjustment → staging deployment and
  certification → Malaysia role-by-role UAT → Malaysia controlled
  real-time operational trial → fix issues → prepare/configure remaining
  AOCs during the Malaysia trial → UAT/trial per additional AOC →
  security/backup/restore/monitoring/operational acceptance → ICT
  handover → ICT assumes Super Admin/technical ownership → only then,
  retire temporary legacy access.
- No step in this table was executed in Phase 13. This is a plan, not a
  log.
