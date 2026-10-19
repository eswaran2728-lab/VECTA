// Reviewed, explicit expectation of the hosted staging migration history after the nine security migrations
// (20261108000001..20261116000001) were applied on top of the 83-row history (82 + the containment head). Change ONLY together with a
// reviewed migration rollout; tests/uat-harness-reliability.test.mts ties EXPECTED_LATEST_MIGRATION to the guarded runner's last frozen migration.
export const EXPECTED_MIGRATION_COUNT = 92;
export const EXPECTED_LATEST_MIGRATION = "20261116000001";
