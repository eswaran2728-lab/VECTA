import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildAccountPlan, NEGATIVE_LABELS } from "../scripts/staging/lib/team-plan.mjs";
import {
  emailFor, defaultCredentialsDir, assertOutsideRepo, assertPreWriteBaseline, EXPECTED_MIGRATIONS, FINAL_MIGRATION, APPROVED_REF, FORBIDDEN_REF,
} from "../scripts/staging/lib/run-gates.mjs";

const REPO = path.resolve(import.meta.dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");
const RUN = "dashboard-review-20261005";

test("the 36 planned account slugs are exactly the owner's matrix", () => {
  const labels = buildAccountPlan().map((a) => a.label);
  assert.equal(labels.length, 36);
  assert.deepEqual(labels.slice(0, 23), [
    "airasia_management", "ghod", "global_reporting_controller", "super_admin", "maa_boss", "maa_admin", "aax_boss", "aax_admin",
    "operation_manager", "main_enforcement", "compliance", "caterlink_management", "investigation_sso", "investigation_so", "investigation_aso",
    "sat_aso", "profiling_so", "profiling_aso", "hub_se", "dse", "sso", "so", "aso",
  ]);
  assert.deepEqual(labels.slice(23, 30), ["sso-kul", "so-kul", "aso-kul", "sso-jhb", "so-jhb", "aso-jhb", "aso-no-caterlink"]);
  assert.deepEqual(labels.slice(30), [
    "neg-pending-profile", "neg-rejected-profile", "neg-deactivated-profile", "neg-revoked-assignment", "neg-expired-assignment", "neg-future-assignment",
  ]);
  assert.equal(Object.keys(NEGATIVE_LABELS).length, 6);
  assert.ok(!labels.some((l) => /ifc|foreign/i.test(l)));
});

test("scopes match the owner's matrix for the station/hub specific roles", () => {
  const by = new Map(buildAccountPlan().map((a) => [a.label, a.scope]));
  const expect = (label: string, hub: string | null, station: string | null, team: string | null, unit: string | null = null) => {
    const s = by.get(label)!;
    assert.deepEqual([s.hub, s.station, s.team, s.unit], [hub, station, team, unit], label);
  };
  expect("sat_aso", "kul", "KUL - MAA", "ALPHA", "sat");
  expect("profiling_so", "northern", "PEN", "ALPHA", "profiling");
  expect("profiling_aso", "northern", "PEN", "ALPHA", "profiling");
  expect("hub_se", "northern", null, null);
  expect("dse", "kul", "KUL - MAA", "ALPHA");
  for (const r of ["sso", "so", "aso"]) expect(r, "northern", "PEN", "ALPHA");
  for (const r of ["sso", "so", "aso"]) expect(`${r}-kul`, "kul", "KUL - MAA", "ALPHA");
  for (const r of ["sso", "so", "aso"]) expect(`${r}-jhb`, "southern_east_coast", "JHB", "ALPHA");
  expect("aso-no-caterlink", "sarawak", "BTU", "ALPHA");
  for (const g of ["airasia_management", "ghod", "global_reporting_controller", "super_admin"]) {
    const s = by.get(g)!;
    assert.deepEqual([s.entity, s.department, s.unit, s.hub, s.station, s.team, s.membership], [null, null, null, null, null, null, null], g);
  }
  assert.equal(by.get("aax_boss")!.entity, "AAX");
  assert.equal(by.get("maa_admin")!.entity, "MAA");
});

test("email scheme is deterministic, uses the reserved domain and the run prefix", () => {
  assert.equal(emailFor(RUN, "aso-kul", "example.invalid"), "vecta.uat.dashboard-review-20261005.aso-kul@example.invalid");
  const all = buildAccountPlan().map((a) => emailFor(RUN, a.label, "example.invalid"));
  assert.equal(new Set(all).size, 36);
  assert.ok(all.every((e) => e.startsWith("vecta.uat.dashboard-review-20261005.") && e.endsWith("@example.invalid")));
});

test("credentials and manifest directory is under %TEMP%, outside the repository", () => {
  const dir = defaultCredentialsDir(RUN);
  assert.ok(dir.endsWith(path.join("vecta-staging-credentials", RUN)));
  assert.doesNotThrow(() => assertOutsideRepo(dir, REPO));
  assert.throws(() => assertOutsideRepo(path.join(REPO, "creds"), REPO));
});

test("baseline gate: exact migration history and counts; production reference rejected", () => {
  const ok = { migrations: EXPECTED_MIGRATIONS, lastMigration: FINAL_MIGRATION, finalMigrationCount: 1, prodInHistory: 0, authUsers: 16, profiles: 16, orgTeams: 16, buckets: 7, runAuthUsers: 0, runMetadataUsers: 0 };
  assert.doesNotThrow(() => assertPreWriteBaseline(ok, { allowExistingRun: false }));
  for (const bad of [
    { migrations: 59 }, { lastMigration: "20261016000001" }, { finalMigrationCount: 2 }, { prodInHistory: 1 }, { authUsers: 17 },
    { profiles: 15 }, { orgTeams: 15 }, { buckets: 6 }, { runAuthUsers: 1 },
  ]) assert.throws(() => assertPreWriteBaseline({ ...ok, ...bad }, { allowExistingRun: false }), /Baseline gate failed/);
  assert.equal(APPROVED_REF, "ddlctzbnqewubltcavkh");
  assert.equal(FORBIDDEN_REF, "zsxneokqulktgnccxgkz");
});

test("no tooling script prints, logs or commits a password, token or secret", () => {
  for (const f of ["scripts/staging/provision-test-accounts.mjs", "scripts/staging/verify-dashboard-review-accounts.mjs", "scripts/staging/teardown-test-accounts.mjs", "scripts/staging/lib/run-gates.mjs"]) {
    const src = read(f);
    for (const line of src.split("\n")) {
      if (/console\.(log|error|warn)\(/.test(line)) {
        assert.ok(!/\bpassword\b|SECRET|passphrase|access_token|refresh_token|\bsession\b/i.test(line.replace(/never displayed|passwords never|\(passwords/gi, "").replace(/Persist the password/g, "")), `${f}: potentially sensitive log: ${line.trim().slice(0, 90)}`);
      }
    }
  }
  const gi = read(".gitignore");
  assert.match(gi, /staging-credentials|credentials/i);
});

test("provisioning stops at the first failure, persists each password immediately, and never rotates an existing one", () => {
  const src = read("scripts/staging/provision-test-accounts.mjs");
  assert.match(src, /Persist the password IMMEDIATELY/);
  assert.match(src, /break; \/\/ stop at the first failure/);
  assert.ok(!/updateUserById|resetPasswordForEmail|admin\.generateLink/.test(src), "no password rotation path");
  assert.match(src, /email_confirm: true/);
  assert.ok(!/ops_group/.test(src), "ops_group is never written");
});

test("teardown is run-scoped, manifest-driven, dry-run by default and needs a separate confirmation to delete", () => {
  const src = read("scripts/staging/teardown-test-accounts.mjs");
  assert.match(src, /confirm-destructive/);
  assert.match(src, /vecta_staging_run_id/);
  assert.match(src, /REFUSED/);
  assert.ok(!/listUsers/.test(src), "never enumerates all users");
});

test("the migration gate accepts only tooling/tests/docs changes since the authorized base", () => {
  const src = read("scripts/staging/lib/run-gates.mjs");
  assert.match(src, /TOOLING_PATHS/);
  assert.match(src, /merge-base --is-ancestor/);
});
