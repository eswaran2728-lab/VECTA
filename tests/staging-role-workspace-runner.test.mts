import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
// @ts-expect-error plain .mjs tooling module
import { MIGRATIONS, START_LAST, START_COUNT, LIVE_PHRASE, verifyFrozenFiles, normalisedSha256 } from "../scripts/staging/apply-role-workspace-migrations.mjs";

const ROOT = process.cwd();
const SRC = fs.readFileSync("scripts/staging/apply-role-workspace-migrations.mjs", "utf8");

test("the frozen set is the reviewed order, strictly ascending, and matches the repository byte-for-byte (LF-normalised)", () => {
  assert.deepEqual(MIGRATIONS.map((m: { version: string }) => m.version), [
    "20261027000002", "20261101000001", "20261101000002", "20261101000003", "20261101000004", "20261101000005",
    "20261102000001", "20261102000002", "20261103000001", "20261104000001", "20261105000001",
  ]);
  assert.equal(START_LAST, "20261027000001");
  assert.equal(START_COUNT, 68);
  const files = verifyFrozenFiles(ROOT);
  assert.equal(files.length, 11);
  for (const m of MIGRATIONS) assert.match(m.sha256, /^[0-9a-f]{64}$/);
});

test("hashing is independent of line endings", () => {
  assert.equal(normalisedSha256(Buffer.from("a\r\nb\r\n")), normalisedSha256(Buffer.from("a\nb\n")));
});

function sandbox(mutate: (dir: string) => void) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vecta-frozen-"));
  const dir = path.join(tmp, "supabase", "migrations");
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync("supabase/migrations").filter((x) => /^\d{14}_.*\.sql$/.test(x))) fs.copyFileSync(path.join("supabase/migrations", f), path.join(dir, f));
  mutate(dir);
  return tmp;
}
const first = () => `${MIGRATIONS[0].version}_${MIGRATIONS[0].name}.sql`;

test("a modified, missing or extra migration is rejected", () => {
  assert.throws(() => verifyFrozenFiles(sandbox((d) => fs.appendFileSync(path.join(d, first()), "\n-- tampered\n"))), /differs from the frozen/);
  assert.throws(() => verifyFrozenFiles(sandbox((d) => fs.rmSync(path.join(d, first())))), /differ from the frozen list/);
  assert.throws(() => verifyFrozenFiles(sandbox((d) => fs.writeFileSync(path.join(d, "20261106000001_extra.sql"), "select 1;"))), /differ from the frozen list/);
  assert.throws(() => verifyFrozenFiles(sandbox((d) => fs.writeFileSync(path.join(d, "20261027000009_inserted_before.sql"), "select 1;"))), /differ from the frozen list/);
});

const run = (extra: string[]) => {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/STAGING|SUPABASE|VECTA_/.test(k)) delete env[k];
  return spawnSync(process.execPath, ["scripts/staging/apply-role-workspace-migrations.mjs", ...extra], { cwd: ROOT, env, encoding: "utf8", timeout: 60000 });
};

test("--print-plan and --print-recovery run offline and list every migration with its recovery", () => {
  const plan = run(["--print-plan"]);
  assert.equal(plan.status, 0);
  assert.equal((plan.stdout.match(/sha256=/g) ?? []).length, 11);
  const rec = run(["--print-recovery"]);
  assert.equal((rec.stdout.match(/RECOVERY:/g) ?? []).length, 11);
});

test("the runner refuses to start without a phase, head, backup, or (live) the exact phrase and a dry-run receipt", () => {
  assert.equal(run([]).status, 1);
  assert.match(run(["--phase=dry-run"]).stderr, /--expected-head and --backup are required/);
  assert.match(run(["--phase=apply", "--expected-head=x", "--backup=y"]).stderr, /exact confirmation phrase/);
  assert.match(run(["--phase=apply", "--expected-head=x", "--backup=y", `--confirm=${LIVE_PHRASE}`]).stderr, /--dry-run-receipt is required/);
  // gates run before any connection: with no staging environment nothing can reach a database
  const r = run(["--phase=dry-run", "--expected-head=0000000000000000000000000000000000000000", "--backup=nope"]);
  assert.equal(r.status, 1);
  assert.doesNotMatch(r.stdout + r.stderr, /postgres(ql)?:\/\/|password|passphrase\s*=/i);
});

test("importing the runner never executes it", () => {
  const r = spawnSync(process.execPath, ["-e", "import('./scripts/staging/apply-role-workspace-migrations.mjs').then(m=>console.log(Object.keys(m).length))"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.match(r.stdout.trim(), /^\d+$/);
});

test("runner safety properties are present in the source", () => {
  for (const needle of [
    "gitGates(", "environmentGates(", "backupGates(", "connectVerified(", "decryptBackupPayload(",   // repo / env / backups / verified TLS
    "FORBIDDEN_REF", "APPROVED_REF",                                                                    // production refused, exact staging ref
    "LIVE_PHRASE", "dry-run-receipt", "await client.query(\"BEGIN\")", "await client.query(\"ROLLBACK\")", // dry run first, rolled back; live gated
    "verifyAndProbe(", "recovery:", "older than 6 hours",                                               // verification, recovery, fresh backup
    "already recorded", "history entry is not exactly one",                                             // recorded exactly once
  ]) assert.ok(SRC.includes(needle), needle);
  assert.ok(SRC.indexOf('log("dry run rolled back') < SRC.indexOf("LIVE: the receipt must match"), "dry run completes before any live statement");
  assert.doesNotMatch(SRC, /console\.log\([^)]*(DATABASE_URL|SECRET|PASSPHRASE|connectionString)/);
  assert.doesNotMatch(SRC, /ssl:\s*false|rejectUnauthorized:\s*false|sslmode=disable/);
});
