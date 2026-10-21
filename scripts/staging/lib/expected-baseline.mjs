// Reviewed, explicit expectation of the hosted staging migration history: the nine security migrations (20261108000001..20261116000001) on top of the
// 83-row history (82 + the containment head) = 92, plus the SEC016 / Bay Board reconciliation 20261117000001 = 93, plus the three P0 compatibility migrations
// 20261118000001..3 = 96, plus the two security-hardening migrations 20261118000004..5 (ACL narrowing; repaired profile guard) = 98. Each rollout was a guarded live
// run on 2026-10-21, independently verified. Change ONLY together with a reviewed migration rollout; tests/uat-harness-reliability.test.mts ties
// EXPECTED_LATEST_MIGRATION to the last guarded runner's last frozen migration.
export const EXPECTED_MIGRATION_COUNT = 98;
export const EXPECTED_LATEST_MIGRATION = "20261118000005";
