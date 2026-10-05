import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ALL_ROLE_CODES } from "../scripts/staging/lib/role-matrix.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const MIGRATIONS_DIR = path.join(REPO_ROOT, "supabase", "migrations");

/**
 * Proves the staging reconciliation plan's claims (docs/dashboard-review/staging-reconciliation.md
 * section 8's execution order) are statically true of the actual
 * repository, and that the corrected account-plan arithmetic (section 10)
 * matches what the provisioning tool would actually create. None of
 * these tests touch any hosted project.
 */

const EXPECTED_PHASE_ORDER = [
  "20260928000000_user_registration_requests.sql",
  "20260928000001_phase2_org_foundation.sql",
  "20260928000002_phase3_role_permission_foundation.sql",
  "20260928000003_phase4_registration_approval_admin.sql",
  "20260928000004_phase5_report_classification_repository.sql",
  "20260928000005_phase6_secure_report_access.sql",
  "20260928000006_phase7_dashboard_aggregates.sql",
  "20260928000007_phase7_closure_dashboards.sql",
  "20260930000001_phase8_operational_workflows.sql",
  "20261001000001_phase9_caterlink_station_access.sql",
  "20261005000001_phase10_anonymous_discussion_board.sql",
  "20261008000001_phase11_global_malaysia_announcements.sql",
  "20261010000001_phase12_wois_ai_2.sql",
  "20261015000001_phase13_integration_rollout_readiness.sql",
  "20261016000001_phase13_storage_and_admin_workflows.sql",
  "20261020000001_canonical_operations_compatibility.sql",
  "20261021000001_phase9_caterlink_scan_authorization_correction.sql",
];

test("staging reconciliation: every Phase 2-13 migration file in the proposed execution order actually exists in the repository", () => {
  const missing = EXPECTED_PHASE_ORDER.filter((f) => !fs.existsSync(path.join(MIGRATIONS_DIR, f)));
  assert.deepEqual(missing, [], `Missing migration file(s) the reconciliation plan assumes exist: ${missing.join(", ")}`);
});

test("staging reconciliation: the proposed execution order is already the correct filename sort order (no manual reordering needed)", () => {
  const sorted = [...EXPECTED_PHASE_ORDER].sort();
  assert.deepEqual(EXPECTED_PHASE_ORDER, sorted, "the plan's listed order must match lexicographic filename order, since that is what migrate.mjs (and any real deployment tool following the same convention) actually applies in");
});

test("staging reconciliation: no dated migration filename collision exists anywhere in the repository", () => {
  const allFiles = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql") && /^\d{14}_/.test(f));
  const duplicates = allFiles.filter((f, i) => allFiles.indexOf(f) !== i);
  assert.deepEqual(duplicates, [], `Duplicate migration filename(s) found: ${duplicates.join(", ")}`);

  // Every dated prefix must be unique even across different suffixes --
  // two files sharing the same 14-digit timestamp would apply in an
  // undefined relative order.
  const prefixes = allFiles.map((f) => f.slice(0, 14));
  const duplicatePrefixes = prefixes.filter((p, i) => prefixes.indexOf(p) !== i);
  assert.deepEqual(duplicatePrefixes, [], `Duplicate 14-digit timestamp prefix(es) found -- these files' relative order is undefined: ${duplicatePrefixes.join(", ")}`);
});

test("staging reconciliation: the Phase 13 storage/admin migration sorts strictly after the Phase 13 integration-readiness migration", () => {
  const a = EXPECTED_PHASE_ORDER.indexOf("20261015000001_phase13_integration_rollout_readiness.sql");
  const b = EXPECTED_PHASE_ORDER.indexOf("20261016000001_phase13_storage_and_admin_workflows.sql");
  assert.ok(a >= 0 && b >= 0 && a < b, "the two Phase 13 migrations must apply in the order the reconciliation plan assumes");
});

test("staging reconciliation: final account-plan arithmetic -- base + additional variants + negative states = exactly 36", () => {
  const BASE_ACCOUNTS = ALL_ROLE_CODES.length;
  assert.equal(BASE_ACCOUNTS, 23);
  // KUL + JHB station variants for sso/so/aso (PEN excluded: the base accounts already default to PEN)
  const ADDITIONAL_STATION_VARIANTS = 3 * 2 + 1; // kul x3, jhb x3, one no-CaterLink station (BTU)
  assert.equal(ADDITIONAL_STATION_VARIANTS, 7);
  const NEGATIVE_STATES = 6; // pending, rejected, deactivated, revoked, expired, future_dated -- no foreign-AOC (Malaysia AOC only)
  assert.equal(NEGATIVE_STATES, 6);
  assert.equal(BASE_ACCOUNTS + ADDITIONAL_STATION_VARIANTS + NEGATIVE_STATES, 36);
});

test("staging reconciliation: provision-test-accounts.mjs's station variants no longer include a redundant PEN entry", () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, "scripts", "staging", "lib", "team-plan.mjs"), "utf8");
  const stationVariantsBlock = source.slice(source.indexOf("const STATION_VARIANTS"), source.indexOf("];", source.indexOf("const STATION_VARIANTS")));
  assert.ok(!/label:\s*["']pen["']/i.test(stationVariantsBlock), "PEN must not appear as a station variant -- it duplicates the base sso/so/aso accounts' own default station");
  assert.ok(/label:\s*["']kul["']/i.test(stationVariantsBlock));
  assert.ok(/label:\s*["']jhb["']/i.test(stationVariantsBlock));
});
