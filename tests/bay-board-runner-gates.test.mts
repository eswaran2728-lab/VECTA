import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import child_process from "node:child_process";
// @ts-expect-error plain .mjs tooling modules
import { RUNNER_BRANCH, CERTIFIED_BASE, MIGRATION, PRE_COUNT, LAST_PRE, runnerGitGates, verifyFrozenMigration, statementAudit } from "../scripts/staging/apply-bay-board-migration.mjs";
// @ts-expect-error plain .mjs tooling modules
import { environmentGates, APPROVED_REF, FORBIDDEN_REF, EXPECTED_REMOTE } from "../scripts/staging/lib/run-gates.mjs";

/**
 * Behavioural tests of the REAL gate code of the guarded Bay Board runner (not source-text matching): each case builds a throw-away git
 * repository, changes into it, and calls the exported gate. No network, no database, no hosted staging and no production is contacted.
 */
const sh = (cmd: string, cwd: string) => child_process.execSync(cmd, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function makeRepo() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "vecta-gates-")));
  sh("git init -q", dir);
  sh('git config user.email "gates@example.test"', dir);
  sh('git config user.name "gates"', dir);
  sh("git config commit.gpgsign false", dir);
  sh(`git remote add origin https://github.com/${EXPECTED_REMOTE}.git`, dir);
  fs.writeFileSync(path.join(dir, "base.txt"), "base\n");
  sh("git add -A", dir);
  sh('git commit -q -m "certified baseline"', dir);
  const base = sh("git rev-parse HEAD", dir);
  sh(`git checkout -q -B ${RUNNER_BRANCH}`, dir);
  fs.mkdirSync(path.join(dir, "scripts", "staging"), { recursive: true });
  fs.writeFileSync(path.join(dir, "scripts", "staging", "tool.txt"), "tooling\n");
  sh("git add -A", dir);
  sh('git commit -q -m "tooling-only change"', dir);
  const head = sh("git rev-parse HEAD", dir);
  return { dir, base, head };
}

function inRepo<T>(dir: string, fn: () => T): T {
  const prev = process.cwd();
  process.chdir(dir);
  try {
    return fn();
  } finally {
    process.chdir(prev);
  }
}

const gate = (r: { dir: string; base: string; head: string }, over: Record<string, string> = {}) =>
  inRepo(r.dir, () => runnerGitGates({ expectedHead: over.expectedHead ?? r.head, repoPath: r.dir, certifiedBase: over.certifiedBase ?? r.base }));

const cleanup = (r: { dir: string }) => fs.rmSync(r.dir, { recursive: true, force: true });

test("the runner's required branch is ui/stitch-mobile-redesign and the certified baseline is unchanged", () => {
  assert.equal(RUNNER_BRANCH, "ui/stitch-mobile-redesign");
  assert.equal(CERTIFIED_BASE, "ac91dd59a6ab066a48553084d2dc8b2942e8deb9");
});

test("accepted: ui/stitch-mobile-redesign at the exact expected head, clean, descending from the baseline, correct origin", () => {
  const r = makeRepo();
  try {
    const g = gate(r);
    assert.equal(g.branch, "ui/stitch-mobile-redesign");
    assert.equal(g.head, r.head);
  } finally {
    cleanup(r);
  }
});

test("rejected: the superseded repair branch fix/bay-board-flight-column", () => {
  const r = makeRepo();
  try {
    sh("git checkout -q -B fix/bay-board-flight-column", r.dir);
    assert.throws(() => gate(r), /Branch mismatch: fix\/bay-board-flight-column/);
  } finally {
    cleanup(r);
  }
});

test("rejected: dashboard/role-workspaces-adjustment and main", () => {
  const r = makeRepo();
  try {
    for (const name of ["dashboard/role-workspaces-adjustment", "main"]) {
      sh(`git checkout -q -B ${name}`, r.dir);
      assert.throws(() => gate(r), new RegExp(`Branch mismatch: ${name.replace("/", "\\/")}`), name);
    }
  } finally {
    cleanup(r);
  }
});

test("rejected: a detached HEAD (no branch) cannot pass the branch gate", () => {
  const r = makeRepo();
  try {
    sh(`git checkout -q --detach ${r.head}`, r.dir);
    assert.throws(() => gate(r), /Branch mismatch/);
  } finally {
    cleanup(r);
  }
});

test("rejected: a wrong commit (an ancestor that is not HEAD, an unknown SHA, or a commit that is not an ancestor)", () => {
  const r = makeRepo();
  try {
    // an older commit of the same branch: gitGates tolerates tooling-only drift, the runner's exact-head check must still refuse
    assert.throws(() => gate(r, { expectedHead: r.base }), /HEAD is not the expected head/);
    assert.throws(() => gate(r, { expectedHead: "0".repeat(40) }), /does not descend from the authorized base|HEAD is not the expected head/);
    // a sibling commit that HEAD does not descend from
    sh("git checkout -q -B sibling " + r.base, r.dir);
    fs.writeFileSync(path.join(r.dir, "other.txt"), "x\n");
    sh("git add -A", r.dir);
    sh('git commit -q -m "sibling"', r.dir);
    const sibling = sh("git rev-parse HEAD", r.dir);
    sh(`git checkout -q ${RUNNER_BRANCH}`, r.dir);
    assert.throws(() => gate(r, { expectedHead: sibling }), /does not descend from the authorized base/);
  } finally {
    cleanup(r);
  }
});

test("rejected: HEAD that does not descend from the certified baseline", () => {
  const r = makeRepo();
  try {
    // an orphan history on the right branch name and with the right head, but not descending from the baseline
    sh("git checkout -q --orphan orphan-tmp", r.dir);
    fs.writeFileSync(path.join(r.dir, "orphan.txt"), "o\n");
    sh("git add -A", r.dir);
    sh('git commit -q -m "orphan"', r.dir);
    sh(`git branch -q -M ${RUNNER_BRANCH}`, r.dir);
    const orphanHead = sh("git rev-parse HEAD", r.dir);
    assert.throws(() => gate(r, { expectedHead: orphanHead }), /does not descend from the certified baseline/);
  } finally {
    cleanup(r);
  }
});

test("rejected: a dirty working tree (modified tracked file, and an untracked file)", () => {
  const r = makeRepo();
  try {
    fs.writeFileSync(path.join(r.dir, "scripts", "staging", "tool.txt"), "changed\n");
    assert.throws(() => gate(r), /Working tree is not clean/);
    sh("git checkout -q -- .", r.dir);
    assert.doesNotThrow(() => gate(r));
    fs.writeFileSync(path.join(r.dir, "untracked.txt"), "u\n");
    assert.throws(() => gate(r), /Working tree is not clean/);
  } finally {
    cleanup(r);
  }
});

test("rejected: an origin that is not the VECTA repository, and a checkout that is not the expected path", () => {
  const r = makeRepo();
  try {
    sh("git remote set-url origin https://github.com/someone-else/other.git", r.dir);
    assert.throws(() => gate(r), /origin is not the expected VECTA repository/);
    sh(`git remote set-url origin https://github.com/${EXPECTED_REMOTE}.git`, r.dir);
    assert.throws(() => inRepo(r.dir, () => runnerGitGates({ expectedHead: r.head, repoPath: path.join(r.dir, "..", "elsewhere"), certifiedBase: r.base })), /not the expected VECTA checkout/);
  } finally {
    cleanup(r);
  }
});

function withEnv<T>(vars: Record<string, string>, fn: () => T): T {
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, vars);
  try {
    return fn();
  } finally {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}
const goodEnv = () => ({
  NEXT_PUBLIC_SUPABASE_URL: `https://${APPROVED_REF}.supabase.co`,
  VECTA_APPROVED_STAGING_PROJECT_REF: APPROVED_REF,
  STAGING_DATABASE_URL: `postgresql://postgres.${APPROVED_REF}:not-a-real-password@aws-0-test.pooler.supabase.com:5432/postgres`,
  SUPABASE_SECRET_KEY: "not-a-real-key",
  VECTA_BACKUP_PASSPHRASE: "not-a-real-passphrase",
});

test("environment: only the approved staging project is accepted; production is rejected in every form", () => {
  assert.equal(withEnv(goodEnv(), () => environmentGates().projectRef), APPROVED_REF);
  assert.throws(() => withEnv({ ...goodEnv(), NEXT_PUBLIC_SUPABASE_URL: `https://${FORBIDDEN_REF}.supabase.co` }, () => environmentGates()), /Forbidden production reference/);
  assert.throws(() => withEnv({ ...goodEnv(), STAGING_DATABASE_URL: `postgresql://postgres.${FORBIDDEN_REF}:x@h.supabase.com:5432/postgres` }, () => environmentGates()), /Forbidden production reference/);
  assert.throws(() => withEnv({ ...goodEnv(), SOME_OTHER_VARIABLE: `prefix-${FORBIDDEN_REF}-suffix` }, () => environmentGates()), /Forbidden production reference/, "the production ref anywhere in the environment aborts the run");
  assert.throws(() => withEnv({ ...goodEnv(), NEXT_PUBLIC_SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co" }, () => environmentGates()), /approved staging project/);
  assert.throws(() => withEnv({ ...goodEnv(), VECTA_APPROVED_STAGING_PROJECT_REF: "abcdefghijklmnopqrst" }, () => environmentGates()), /not the approved staging ref/);
  assert.throws(() => withEnv({ ...goodEnv(), STAGING_DATABASE_URL: "postgresql://postgres:x@db.example.com:5432/postgres" }, () => environmentGates()), /approved staging project/);
  assert.throws(() => withEnv({ ...goodEnv(), VECTA_BACKUP_PASSPHRASE: "" }, () => environmentGates()), /VECTA_BACKUP_PASSPHRASE/);
});

const MIG_FILE = `supabase/migrations/${MIGRATION.version}_${MIGRATION.name}.sql`;

test("migration file: the frozen SHA-256 passes (LF or CRLF); any altered byte is rejected before anything runs", () => {
  const buf = fs.readFileSync(MIG_FILE);
  assert.ok(verifyFrozenMigration(buf).length > 1000);
  assert.doesNotThrow(() => verifyFrozenMigration(Buffer.from(buf.toString("utf8").replace(/\r\n/g, "\n").replace(/\n/g, "\r\n"))), "line-ending normalised");
  assert.throws(() => verifyFrozenMigration(Buffer.from(`${buf.toString("utf8")}\n-- tampered\n`)), /differs from the frozen/);
  assert.throws(() => verifyFrozenMigration(Buffer.from(buf.toString("utf8").replace("flight text", "flight text, add column x int"))), /differs from the frozen/);
  assert.throws(() => verifyFrozenMigration(Buffer.from("")), /differs from the frozen/);
});

test("migration file: the statement allow-list still refuses grants to anon, new policies and deletes", () => {
  const sql = fs.readFileSync(MIG_FILE, "utf8");
  assert.equal(statementAudit(sql), null);
  for (const extra of ["grant select on public.bay_board to anon;", "create policy p on public.bay_board for select using (true);", "delete from public.bay_board;", "drop table public.bay_board;"]) {
    assert.notEqual(statementAudit(`${sql}\n${extra}`), null, extra);
  }
});

test("the runner's PRE-state stays 92 migrations ending at 20261116000001 (so it refuses a second apply), while the expected hosted baseline is now 93 / 20261117000001 (history mismatches are refused by execute(), proven in the runner-core verifier)", () => {
  assert.equal(PRE_COUNT, 92);
  assert.equal(LAST_PRE, "20261116000001");
  const base = fs.readFileSync("scripts/staging/lib/expected-baseline.mjs", "utf8");
  assert.match(base, /EXPECTED_MIGRATION_COUNT = 105;/);
  assert.match(base, /EXPECTED_LATEST_MIGRATION = "20261130000002";/);
  const core = fs.readFileSync("supabase/tests/integration/verify_bay_board_runner_core.mjs", "utf8");
  assert.match(core, /a wrong history count is refused/);
  assert.match(core, /a wrong last migration is refused/);
});
