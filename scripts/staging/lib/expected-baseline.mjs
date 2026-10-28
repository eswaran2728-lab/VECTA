// Reviewed, explicit expectation of the hosted staging migration history: the nine security migrations (20261108000001..20261116000001) on top of the
// 83-row history (82 + the containment head) = 92, plus the SEC016 / Bay Board reconciliation 20261117000001 = 93, plus the three P0 compatibility migrations
// 20261118000001..3 = 96, plus the two security-hardening migrations 20261118000004..5 (ACL narrowing; repaired profile guard) = 98,
// plus the CaterLink least-privilege visibility migration 20261119000001 = 99, plus the all-final-receipts PDF job migration
// 20261120000001 = 100, plus the standalone-Offload retirement migration 20261127000001 = 101, plus the DSE-leave / zone-write scoping migration 20261128000001 = 102,
// plus the Makeup and Breakup reports migration 20261129000001 = 103, plus the source-secure functions migration
// 20261130000001 = 104. Each rollout was guarded and independently verified on approved staging. Change ONLY with a reviewed
// migration rollout; tests/uat-harness-reliability.test.mts ties the latest version to the last guarded runner.
export const EXPECTED_MIGRATION_COUNT = 104;
export const EXPECTED_LATEST_MIGRATION = "20261130000001";

