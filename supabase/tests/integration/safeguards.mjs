// Security safeguards for local disposable database testing.
// Enforces that all native test runners and concurrency scripts only connect
// to verified local loopback hosts and only perform destructive operations
// (DROP/CREATE DATABASE) on explicitly whitelisted disposable database names.

export const ALLOWED_DISPOSABLE_DATABASES = new Set([
  'vecta_phase6_test',
  'vecta_phase6_harness_run',
  'vecta_phase6_export_isolation_run',
  'vecta_phase6_concurrency_run',
  'vecta_phase7_aggregates_run',
  'vecta_phase7_entity_run',
  'vecta_phase8_run',
  'vecta_phase8_leave_concurrency_run',
  'vecta_phase8_duty_draw_concurrency_run',
  'vecta_phase8_concurrency_round2_run',
  'vecta_phase8_multi_aoc_run',
  'vecta_phase9_caterlink_run',
  'vecta_phase9_whitelist_concurrency_run',
  'vecta_phase9_txn_concurrency_run',
  'vecta_phase9_legacy_collision_run',
  'vecta_phase10_discussion_run',
  'vecta_phase10_discussion_concurrency_run',
  'vecta_phase11_announcements_run',
  'vecta_phase11_announcements_concurrency_run',
  'vecta_phase12_wois_run',
]);

export function assertDisposableLocalTarget(config, ...dbNames) {
  const host = (config.host || '127.0.0.1').trim().toLowerCase();
  if (host !== '127.0.0.1' && host !== 'localhost') {
    throw new Error(
      `SECURITY SAFEGUARD: Refusing to run against non-local host "${config.host}". Native test setup is strictly restricted to local disposable instances (127.0.0.1 or localhost).`
    );
  }
  for (const db of dbNames) {
    if (!ALLOWED_DISPOSABLE_DATABASES.has(db)) {
      throw new Error(
        `SECURITY SAFEGUARD: Refusing destructive operation on non-whitelisted database "${db}". Allowed disposable databases: ${[...ALLOWED_DISPOSABLE_DATABASES].join(', ')}`
      );
    }
  }
}
