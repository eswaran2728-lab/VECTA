import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  MIGRATIONS, PRE_COUNT, LAST_PRE, POST_COUNT, POST_LAST, LIVE_PHRASE, PUSHED_BASE, EXPECTED_PROBES, PRE_STATE,
  statementAudit, verifyFrozenMigrations, orderingGate, normalisedSha256, productionGate,
} from "../scripts/staging/apply-offload-retirement-migration.mjs";
import { EXPECTED_MIGRATION_COUNT, EXPECTED_LATEST_MIGRATION } from "../scripts/staging/lib/expected-baseline.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const MIG_DIR = path.join(ROOT, "supabase", "migrations");
const RUNNER = fs.readFileSync(path.join(ROOT, "scripts/staging/apply-offload-retirement-migration.mjs"), "utf8").replace(/\r\n/g, "\n");
const MIGRATION_FILE = `${MIGRATIONS[0].version}_${MIGRATIONS[0].name}.sql`;

test("offload-retirement runner: the frozen migration matches its SHA-256 and the statement allow-list", () => {
  const files = verifyFrozenMigrations((f) => fs.readFileSync(path.join(MIG_DIR, f)));
  assert.equal(files.length, 1);
  assert.equal(normalisedSha256(fs.readFileSync(path.join(MIG_DIR, MIGRATION_FILE))), MIGRATIONS[0].sha256);
});

test("offload-retirement runner: the SHA is line-ending independent (LF-canonical, like every guarded runner)", () => {
  const lf = fs.readFileSync(path.join(MIG_DIR, MIGRATION_FILE), "utf8").replace(/\r\n/g, "\n");
  assert.equal(normalisedSha256(lf), normalisedSha256(lf.replace(/\n/g, "\r\n")));
});

test("offload-retirement runner: anything beyond the reviewed statements is rejected before it can run", () => {
  const good = fs.readFileSync(path.join(MIG_DIR, MIGRATION_FILE), "utf8");
  assert.equal(statementAudit(good), null);
  assert.match(String(statementAudit(`${good}\ndelete from public.offload_records;`)), /delete from/);
  assert.match(String(statementAudit(`${good}\ndrop table public.offload_items;`)), /drop table/);
  assert.match(String(statementAudit(`${good}\nupdate public.report_form_assignments set revoked_at = now();`)), /report_form_assignments/);
  assert.match(String(statementAudit(good.replace("select p_form <> 'offload'", "select (select count(*) from public.offload_records) >= 0"))), /offload_records/);
  assert.match(String(statementAudit(`${good}\ntruncate public.report_form_assignments;`)), /truncate/);
});

test("offload-retirement runner: ordering, counts, live phrase and baseline tie-in", () => {
  orderingGate(fs.readdirSync(MIG_DIR));
  assert.equal(PRE_COUNT, EXPECTED_MIGRATION_COUNT, "the runner's pre-state is the certified staging baseline");
  assert.equal(LAST_PRE, EXPECTED_LATEST_MIGRATION);
  assert.equal(POST_COUNT, PRE_COUNT + 1);
  assert.equal(POST_LAST, "20261127000001");
  assert.equal(LIVE_PHRASE, "APPLY 20261127000001 TO STAGING ddlctzbnqewubltcavkh");
  assert.match(PUSHED_BASE, /^[0-9a-f]{40}$/);
  assert.ok(Object.values(PRE_STATE).every((v) => v !== undefined && v !== ""));
  assert.equal(EXPECTED_PROBES, 14);
});

test("offload-retirement runner: production is refused, TLS is verified, live needs the exact phrase, dry run always comes first", () => {
  assert.throws(() => productionGate({ X: "zsxneokqulktgnccxgkz" }, []), /production reference/);
  assert.throws(() => productionGate({}, ["--ref=zsxneokqulktgnccxgkz"]), /production reference/);
  assert.match(RUNNER, /connectVerified\(\)/);
  assert.match(RUNNER, /if \(LIVE && argVal\("confirm"\) !== LIVE_PHRASE\) fail\("the live phase needs the exact confirmation phrase"\)/);
  assert.match(RUNNER, /await pass\(false\);\n  log\("dry run rolled back"\);/);
  assert.match(RUNNER, /fresh backup is older than 6 hours/);
  assert.match(RUNNER, /fresh backup is inside the repository/);
  assert.match(RUNNER, /decryptBackupPayload\(fs\.readFileSync\(freshBackup/);
});

test("offload-retirement runner: probes cover creation refusal, kept forms, kept assignments and preserved history; no secrets are printed", () => {
  for (const needle of [
    "a standalone offload_records insert by a real ASO session is refused by the database",
    "no persona can create or list a standalone Offload report any more",
    "ASO (PEN and JHB) keep SEC016, SEC014, SEC029, SEC018 and SEC033",
    "Profiling ASO keeps SEC013 only",
    "offload assignment rows are kept and revoked",
    "historical Offload is untouched",
    "still renders identically",
    "removed exactly",
    "every unrelated fingerprint is unchanged",
  ]) assert.ok(RUNNER.includes(needle), needle);
  assert.doesNotMatch(RUNNER, /console\.log\([^)]*(PASSWORD|SECRET|TOKEN|STAGING_DATABASE_URL)/i);
});
