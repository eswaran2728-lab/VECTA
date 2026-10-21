// Reviewed, explicit expectation of the hosted staging migration history: the nine security migrations (20261108000001..20261116000001) on top of the
// 83-row history (82 + the containment head) = 92, plus the SEC016 / Bay Board reconciliation 20261117000001 (guarded live run 2026-10-21) = 93, plus the three
// P0 compatibility migrations 20261118000001..20261118000003 (guarded live run 2026-10-21, independently verified) = 96. Change ONLY together with a
// reviewed migration rollout; tests/uat-harness-reliability.test.mts ties EXPECTED_LATEST_MIGRATION to the guarded P0 runner's last frozen migration.
export const EXPECTED_MIGRATION_COUNT = 96;
export const EXPECTED_LATEST_MIGRATION = "20261118000003";
