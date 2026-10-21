import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import child_process from "node:child_process";
// @ts-expect-error plain .mjs tooling modules
import * as R from "../scripts/staging/apply-hardening-migrations.mjs";
// @ts-expect-error plain .mjs tooling modules
import { environmentGates, APPROVED_REF, FORBIDDEN_REF, EXPECTED_REMOTE } from "../scripts/staging/lib/run-gates.mjs";

/** Behavioural tests of the REAL gate code of the guarded hardening runner. No network, no database, no hosted staging, no production. */
const sh = (cmd: string, cwd: string) => child_process.execSync(cmd, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function makeRepo() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "vecta-hd-gates-")));
  sh("git init -q", dir);
  sh('git config user.email "gates@example.test"', dir);
  sh('git config user.name "gates"', dir);
  sh("git config commit.gpgsign false", dir);
  sh(`git remote add origin https://github.com/${EXPECTED_REMOTE}.git`, dir);
  fs.writeFileSync(path.join(dir, "base.txt"), "base\n");
  sh("git add -A", dir);
  sh('git commit -q -m "pushed baseline"', dir);
  const base = sh("git rev-parse HEAD", dir);
  sh(`git checkout -q -B ${R.RUNNER_BRANCH}`, dir);
  fs.mkdirSync(path.join(dir, "scripts", "staging"), { recursive: true });
  fs.writeFileSync(path.join(dir, "scripts", "staging", "tool.txt"), "tooling\n");
  sh("git add -A", dir);
  sh('git commit -q -m "tooling-only change"', dir);
  return { dir, base, head: sh("git rev-parse HEAD", dir) };
}
function inRepo<T>(dir: string, fn: () => T): T {
  const prev = process.cwd();
  process.chdir(dir);
  try { return fn(); } finally { process.chdir(prev); }
}
const gate = (r: { dir: string; base: string; head: string }, over: Record<string, string> = {}) =>
  inRepo(r.dir, () => R.runnerGitGates({ expectedHead: over.expectedHead ?? r.head, repoPath: over.repoPath ?? r.dir, base: over.base ?? r.base }));
const cleanup = (r: { dir: string }) => fs.rmSync(r.dir, { recursive: true, force: true });

test("constants: pre-state 96 / 20261118000003, post-state 98 / 20261118000005, exact live phrase", () => {
  assert.equal(R.RUNNER_BRANCH, "ui/stitch-mobile-redesign");
  assert.equal(R.PRE_COUNT, 96);
  assert.equal(R.LAST_PRE, "20261118000003");
  assert.equal(R.POST_COUNT, 98);
  assert.equal(R.POST_LAST, "20261118000005");
  assert.deepEqual(R.MIGRATIONS.map((m: { version: string }) => m.version), ["20261118000004", "20261118000005"]);
  assert.match(R.LIVE_PHRASE, new RegExp(APPROVED_REF));
  assert.doesNotMatch(R.LIVE_PHRASE, new RegExp(FORBIDDEN_REF));
});

test("git gates: exact branch, head, ancestry, clean tree, origin and path are enforced", () => {
  const r = makeRepo();
  try {
    assert.equal(gate(r).head, r.head);
    for (const name of ["main", "dashboard/role-workspaces-adjustment", "fix/bay-board-flight-column"]) {
      sh(`git checkout -q -B ${name}`, r.dir);
      assert.throws(() => gate(r), /Branch mismatch/, name);
    }
    sh(`git checkout -q ${R.RUNNER_BRANCH}`, r.dir);
    sh(`git checkout -q --detach ${r.head}`, r.dir);
    assert.throws(() => gate(r), /Branch mismatch/);
    sh(`git checkout -q ${R.RUNNER_BRANCH}`, r.dir);
    assert.throws(() => gate(r, { expectedHead: r.head.slice(0, 12) }), /40-character/);
    assert.throws(() => gate(r, { expectedHead: r.base }), /HEAD is not the expected head/);
    assert.throws(() => gate(r, { base: "1".repeat(40) }), /does not descend from the pushed baseline|Command failed|bad object|not a valid/i);
    fs.writeFileSync(path.join(r.dir, "untracked.txt"), "u\n");
    assert.throws(() => gate(r), /Working tree is not clean/);
    fs.rmSync(path.join(r.dir, "untracked.txt"));
    sh("git remote set-url origin https://github.com/someone-else/other.git", r.dir);
    assert.throws(() => gate(r), /origin is not the expected VECTA repository/);
    sh(`git remote set-url origin https://github.com/${EXPECTED_REMOTE}.git`, r.dir);
    assert.throws(() => gate(r, { repoPath: path.join(r.dir, "..", "elsewhere") }), /not the expected VECTA checkout/);
  } finally { cleanup(r); }
});

function withEnv<T>(vars: Record<string, string>, fn: () => T): T {
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, vars);
  try { return fn(); } finally {
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

test("environment: staging only; production rejected in the environment, inherited variables and argv", () => {
  assert.equal(withEnv(goodEnv(), () => environmentGates().projectRef), APPROVED_REF);
  assert.throws(() => withEnv({ ...goodEnv(), NEXT_PUBLIC_SUPABASE_URL: `https://${FORBIDDEN_REF}.supabase.co` }, () => environmentGates()), /Forbidden production reference/);
  assert.throws(() => withEnv({ ...goodEnv(), INHERITED: `a-${FORBIDDEN_REF}-b` }, () => R.productionGate(process.env, [])), /production reference present/);
  assert.throws(() => R.productionGate(goodEnv(), ["node", "x", `--url=https://${FORBIDDEN_REF}.supabase.co`]), /production reference present/);
  assert.throws(() => withEnv({ ...goodEnv(), VECTA_APPROVED_STAGING_PROJECT_REF: "abcdefghijklmnopqrst" }, () => environmentGates()), /not the approved staging ref/);
});

const read = (f: string) => fs.readFileSync(`supabase/migrations/${f}`);
const toCrlf = (b: Buffer) => Buffer.from(b.toString("utf8").replace(/\r\n/g, "\n").replace(/\n/g, "\r\n"));

test("migrations: frozen SHA-256 (LF and CRLF), tampering and swaps rejected, canonical LF executed", () => {
  const ok = R.verifyFrozenMigrations(read);
  assert.equal(ok.length, 2);
  for (const m of ok) assert.ok(!/\r/.test(m.sql));
  assert.deepEqual(R.verifyFrozenMigrations((f: string) => toCrlf(read(f))).map((m: { sql: string }) => m.sql), ok.map((m: { sql: string }) => m.sql));
  const file = (m: { version: string; name: string }) => `${m.version}_${m.name}.sql`;
  assert.throws(() => R.verifyFrozenMigrations((f: string) => (f === file(R.MIGRATIONS[0]) ? Buffer.from(`${read(f).toString("utf8")}\n-- x\n`) : read(f))), /differs from the frozen/);
  assert.throws(() => R.verifyFrozenMigrations((f: string) => (f === file(R.MIGRATIONS[1]) ? read(file(R.MIGRATIONS[0])) : read(f))), /differs from the frozen/);
});

test("allow-list: the real migrations pass; any grant, policy, other function, trigger, storage, delete, truncate or legacy column is refused", () => {
  for (const m of R.verifyFrozenMigrations(read)) assert.equal(R.statementAudit(m.sql), null, m.file);
  const acl = R.verifyFrozenMigrations(read)[0].sql;
  for (const e of [
    "grant select on public.profiles to anon;", "grant truncate on public.profiles to authenticated;", "revoke select on public.profiles from authenticated;",
    "revoke update on public.profiles from authenticated;", "revoke all on public.report_sec013 from authenticated;", "revoke truncate on table public.not_in_the_set from authenticated;",
    "revoke execute on function public.approve_registration_request(uuid) from authenticated;", "revoke execute on function public.set_updated_at() from service_role;",
    "create policy p on public.profiles using (true);", "drop policy x on public.profiles;", "delete from public.profiles;", "truncate public.profiles;",
    "alter table public.profiles add column org_id uuid;", "alter default privileges in schema public grant all on tables to anon;", "insert into storage.objects (name) values ('x');",
  ]) assert.notEqual(R.statementAudit(`${acl}\n${e}`), null, e);
  const fn = R.verifyFrozenMigrations(read)[1].sql;
  for (const body of ["grant all on public.profiles to anon", "delete from public.profiles", "create policy p on public.profiles using (true)", "drop table public.profiles", "alter table public.profiles add column org_id uuid"]) {
    assert.notEqual(R.statementAudit(fn.replace("begin\n", `begin\n  ${body};\n`)), null, body);
  }
  assert.notEqual(R.statementAudit(`${fn}\ncreate or replace function public.other() returns int language sql as 'select 1';`), null);
});

test("ordering: exactly the two frozen migrations after 20261118000003", () => {
  const base = ["20261118000003_x.sql", ...R.MIGRATIONS.map((m: { version: string; name: string }) => `${m.version}_${m.name}.sql`)];
  assert.doesNotThrow(() => R.orderingGate(base));
  assert.throws(() => R.orderingGate([...base, "20261119000001_extra.sql"]), /other than the two frozen/);
  assert.throws(() => R.orderingGate([...base, "20261118000004_dup.sql"]), /duplicate migration versions/);
  assert.throws(() => R.orderingGate(base.filter((f) => !f.startsWith("20261118000005"))), /other than the two frozen/);
  assert.throws(() => R.orderingGate(base.filter((f) => !f.startsWith("20261118000003"))), /is not in the repository/);
});

function fakeClient(history: { version: string; name: string }[]) {
  const calls: string[] = [];
  return {
    calls,
    query: async (sql: string) => {
      calls.push(sql.trim().slice(0, 40));
      if (/schema_migrations order by version/.test(sql)) return { rows: history };
      return { rows: [], rowCount: 0 };
    },
  };
}
const hist = (n: number, last: string) => Array.from({ length: n }, (_, i) => ({ version: i === n - 1 ? last : String(20260000000000 + i), name: "m" }));
const ctxFor = () => ({ files: R.verifyFrozenMigrations(read), acct: () => "x", live: true, log: () => {}, preCount: R.PRE_COUNT, lastPre: R.LAST_PRE, hashes: R.PRE_STATE });

test("refusal: history at 98, a wrong count / last, an already-recorded version and a production reference are refused before anything is written", async () => {
  const done = [...hist(96, R.LAST_PRE), ...R.MIGRATIONS.map((m: { version: string; name: string }) => ({ version: m.version, name: m.name }))];
  const c = fakeClient(done);
  await assert.rejects(() => R.execute(c, ctxFor()), /history is not exactly 96/);
  assert.ok(!c.calls.some((s) => /^(begin|insert|update|delete|alter|create|revoke)/i.test(s)));
  await assert.rejects(() => R.execute(fakeClient(hist(95, R.LAST_PRE)), ctxFor()), /history is not exactly 96/);
  await assert.rejects(() => R.execute(fakeClient(hist(96, "20261118000002")), ctxFor()), /history is not exactly 96.*ending 20261118000003/);
  const withOne = hist(96, R.LAST_PRE); withOne[5] = { version: "20261118000005", name: "profile_guard_hosted_compatible" };
  await assert.rejects(() => R.execute(fakeClient(withOne), ctxFor()), /already recorded/);
  const withProd = hist(96, R.LAST_PRE); withProd[3] = { version: "20260000000003", name: `x_${FORBIDDEN_REF}` };
  await assert.rejects(() => R.execute(fakeClient(withProd), ctxFor()), /production reference/);
});

test("refusal: execute() refuses SQL that does not match the frozen hash or is outside the allow-list, before touching the database", async () => {
  const c = fakeClient(hist(96, R.LAST_PRE));
  const ctx = ctxFor();
  ctx.files[0] = { ...ctx.files[0], sql: `${ctx.files[0].sql}\n-- tampered` };
  await assert.rejects(() => R.execute(c, ctx), /does not match its frozen SHA-256/);
  const ctx2 = ctxFor();
  ctx2.files[1] = { ...ctx2.files[1], sql: `${ctx2.files[1].sql}\ngrant all on public.profiles to anon;`, sha256: undefined };
  await assert.rejects(() => R.execute(c, ctx2), /outside the reviewed allow-list/);
  assert.equal(c.calls.length, 0, "no query was issued");
});

test("the revoke sets are the exact frozen ones: authenticated only, and expectedRemovals never invents a privilege", () => {
  assert.equal(R.REVOKE_TABLE_NAMES.length, 48);
  assert.equal(R.REVOKE_VIEW_NAMES.length, 5);
  assert.equal(R.REVOKE_FUNCTION_NAMES.length, 30);
  assert.ok(R.REVOKE_VIEW_NAMES.every((v: string) => R.REVOKE_TABLE_NAMES.includes(v) && v.startsWith("v_")));
  const obs = { tablePrivs: ["profiles:authenticated:TRUNCATE", "profiles:authenticated:UPDATE", "profiles:service_role:TRUNCATE", "shift_handovers:authenticated:DELETE", "shifts:authenticated:DELETE"], fnExec: ["set_updated_at():authenticated", "set_updated_at():service_role", "approve_registration_request(uuid):authenticated"] };
  const { removed, fnRemoved } = R.expectedRemovals(obs);
  assert.deepEqual([...removed].sort(), ["profiles:authenticated:TRUNCATE", "shift_handovers:authenticated:DELETE"]);
  assert.deepEqual([...fnRemoved], ["set_updated_at():authenticated"]);
});
