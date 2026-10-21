import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import child_process from "node:child_process";
// @ts-expect-error plain .mjs tooling modules
import * as R from "../scripts/staging/apply-p0-migrations.mjs";
// @ts-expect-error plain .mjs tooling modules
import { environmentGates, APPROVED_REF, FORBIDDEN_REF, EXPECTED_REMOTE } from "../scripts/staging/lib/run-gates.mjs";

/**
 * Behavioural tests of the REAL gate code of the guarded P0 runner (not source-text matching): git gates run in throw-away repositories, the
 * environment gates run against swapped process environments, and the migration / ordering / pre-state gates run on the real exported functions.
 * No network, no database, no hosted staging and no production is contacted.
 */
const sh = (cmd: string, cwd: string) => child_process.execSync(cmd, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function makeRepo() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "vecta-p0-gates-")));
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

test("constants: branch, pushed baseline, pre-state 93 / 20261117000001, post-state 96 / 20261118000003", () => {
  assert.equal(R.RUNNER_BRANCH, "ui/stitch-mobile-redesign");
  assert.equal(R.PUSHED_BASE, "3a3eeb79883e5d37c2a44c87913fc5f696f83803");
  assert.equal(R.PRE_COUNT, 93);
  assert.equal(R.LAST_PRE, "20261117000001");
  assert.equal(R.POST_COUNT, 96);
  assert.equal(R.POST_LAST, "20261118000003");
  assert.deepEqual(R.MIGRATIONS.map((m: { version: string }) => m.version), ["20261118000001", "20261118000002", "20261118000003"]);
  assert.match(R.LIVE_PHRASE, new RegExp(APPROVED_REF));
  assert.doesNotMatch(R.LIVE_PHRASE, new RegExp(FORBIDDEN_REF));
});

test("git: accepted at the exact expected head on the exact branch, clean, descending from the baseline", () => {
  const r = makeRepo();
  try { assert.equal(gate(r).head, r.head); } finally { cleanup(r); }
});

test("git: wrong branches (main, dashboard, the superseded repair branch, detached HEAD) are rejected", () => {
  const r = makeRepo();
  try {
    for (const name of ["main", "dashboard/role-workspaces-adjustment", "fix/bay-board-flight-column"]) {
      sh(`git checkout -q -B ${name}`, r.dir);
      assert.throws(() => gate(r), /Branch mismatch/, name);
    }
    sh(`git checkout -q --detach ${r.head}`, r.dir);
    assert.throws(() => gate(r), /Branch mismatch/);
  } finally { cleanup(r); }
});

test("git: a missing, short, ancestor, unknown or non-ancestor expected head is rejected", () => {
  const r = makeRepo();
  try {
    assert.throws(() => gate(r, { expectedHead: "" }), /40-character/);
    assert.throws(() => gate(r, { expectedHead: r.head.slice(0, 12) }), /40-character/);
    assert.throws(() => gate(r, { expectedHead: r.base }), /HEAD is not the expected head/);
    assert.throws(() => gate(r, { expectedHead: "0".repeat(40) }), /does not descend|not the expected head/);
  } finally { cleanup(r); }
});

test("git: HEAD that does not descend from the pushed baseline, a dirty tree, a wrong origin and a wrong checkout path are rejected", () => {
  const r = makeRepo();
  try {
    assert.throws(() => gate(r, { base: "1".repeat(40) }), /does not descend from the pushed baseline|Command failed|bad object|not a valid/i);
    fs.writeFileSync(path.join(r.dir, "scripts", "staging", "tool.txt"), "changed\n");
    assert.throws(() => gate(r), /Working tree is not clean/);
    sh("git checkout -q -- .", r.dir);
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

test("environment: only the approved staging project passes; production is rejected in every form, including inherited variables and argv", () => {
  assert.equal(withEnv(goodEnv(), () => environmentGates().projectRef), APPROVED_REF);
  assert.doesNotThrow(() => withEnv(goodEnv(), () => R.productionGate(process.env, ["node", "x"])));
  assert.throws(() => withEnv({ ...goodEnv(), NEXT_PUBLIC_SUPABASE_URL: `https://${FORBIDDEN_REF}.supabase.co` }, () => environmentGates()), /Forbidden production reference/);
  assert.throws(() => withEnv({ ...goodEnv(), STAGING_DATABASE_URL: `postgresql://postgres.${FORBIDDEN_REF}:x@h.supabase.com:5432/postgres` }, () => environmentGates()), /Forbidden production reference/);
  assert.throws(() => withEnv({ ...goodEnv(), INHERITED: `a-${FORBIDDEN_REF}-b` }, () => R.productionGate(process.env, [])), /production reference present/);
  assert.throws(() => R.productionGate(goodEnv(), ["node", "x", `--url=https://${FORBIDDEN_REF}.supabase.co`]), /production reference present/);
  assert.throws(() => withEnv({ ...goodEnv(), NEXT_PUBLIC_SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co" }, () => environmentGates()), /approved staging project/);
  assert.throws(() => withEnv({ ...goodEnv(), VECTA_APPROVED_STAGING_PROJECT_REF: "abcdefghijklmnopqrst" }, () => environmentGates()), /not the approved staging ref/);
  assert.throws(() => withEnv({ ...goodEnv(), STAGING_DATABASE_URL: "postgresql://postgres:x@db.example.com:5432/postgres" }, () => environmentGates()), /approved staging project/);
});

const read = (f: string) => fs.readFileSync(`supabase/migrations/${f}`);
const toCrlf = (b: Buffer) => Buffer.from(b.toString("utf8").replace(/\r\n/g, "\n").replace(/\n/g, "\r\n"));

test("migrations: the frozen SHA-256 of all three passes for LF and CRLF checkouts and the executed string is the canonical LF text", () => {
  const ok = R.verifyFrozenMigrations(read);
  assert.equal(ok.length, 3);
  for (const m of ok) assert.ok(!/\r/.test(m.sql), "no CR is ever executed");
  const crlf = R.verifyFrozenMigrations((f: string) => toCrlf(read(f)));
  assert.deepEqual(crlf.map((m: { sql: string }) => m.sql), ok.map((m: { sql: string }) => m.sql));
});

test("migrations: any altered byte, appended statement, missing file or swapped order is rejected before anything runs", () => {
  const first = R.MIGRATIONS[0];
  const fileOf = (m: { version: string; name: string }) => `${m.version}_${m.name}.sql`;
  for (const mutate of [(s: string) => `${s}\n-- tampered\n`, (s: string) => s.replace("ops_group text", "ops_group text, add column x int"), () => ""]) {
    assert.throws(() => R.verifyFrozenMigrations((f: string) => (f === fileOf(first) ? Buffer.from(mutate(read(f).toString("utf8"))) : read(f))), /differs from the frozen/);
  }
  assert.throws(() => R.verifyFrozenMigrations((f: string) => (f === fileOf(R.MIGRATIONS[1]) ? read(fileOf(R.MIGRATIONS[2])) : read(f))), /differs from the frozen/);
  assert.throws(() => R.verifyFrozenMigrations(() => { throw new Error("ENOENT"); }), /ENOENT/);
});

test("allow-list: the real migrations pass; every unexpected DDL/DML/policy/grant/function/trigger/storage/delete/truncate/drop/legacy statement is refused", () => {
  for (const m of R.verifyFrozenMigrations(read)) assert.equal(R.statementAudit(m.sql), null, m.file);
  const sql = R.verifyFrozenMigrations(read)[1].sql;
  const extras = [
    "grant select on public.overtime_requests to anon;", "revoke all on public.overtime_requests from authenticated;",
    "create policy p on public.overtime_requests for select using (true);", "alter policy p on public.overtime_requests using (true);",
    "create function public.f() returns int language sql as 'select 1';", "create or replace function public.g() returns int language sql as 'select 1';",
    "create trigger t before insert on public.overtime_requests for each row execute function public.f();",
    "insert into storage.objects (name) values ('x');", "update public.profiles set status = 'approved';", "delete from public.duty_records;",
    "truncate public.overtime_requests;", "drop table public.overtime_requests;", "drop index public.overtime_requests_pkey;",
    "alter table public.profiles add column org_id uuid;", "alter table public.profiles add column unified_role text;", "alter table public.profiles add column duty_post text;",
    "alter table public.profiles add column ops_group text;", "alter table public.duty_records disable row level security;", "alter table public.duty_records rename to d;",
    "alter table public.duty_records add column if not exists extra int;", "create table public.org_stations2 (id int);", "alter table public.report_sec016 add column if not exists ops_group text;",
    "create extension pgcrypto;", "alter default privileges in schema public grant all on tables to anon;",
  ];
  for (const e of extras) assert.notEqual(R.statementAudit(`${sql}\n${e}`), null, e);
  // statements hidden inside a dollar-quoted body are audited too
  for (const body of ["grant all on public.profiles to anon", "delete from public.profiles", "create policy p on public.profiles using (true)", "alter table public.profiles add column org_id uuid", "execute 'drop table public.profiles'", "drop table public.profiles"]) {
    assert.notEqual(R.statementAudit(`${sql}\ndo $x$ begin ${body}; end $x$;`), null, body);
  }
  // comment-wrapped statements are comments, not statements
  assert.equal(R.statementAudit(`${sql}\n-- grant all on public.profiles to anon;`), null);
});

test("ordering: exactly the three frozen migrations after 20261117000001, unique and ordered", () => {
  const base = ["20261116000001_x.sql", "20261117000001_bay_board_sec016_reconciliation.sql", ...R.MIGRATIONS.map((m: { version: string; name: string }) => `${m.version}_${m.name}.sql`)];
  assert.doesNotThrow(() => R.orderingGate(base));
  assert.throws(() => R.orderingGate([...base, "20261119000001_extra.sql"]), /other than the three frozen/);
  assert.throws(() => R.orderingGate([...base, "20261118000001_duplicate_version.sql"]), /duplicate migration versions/);
  assert.throws(() => R.orderingGate(base.filter((f) => !f.startsWith("20261118000002"))), /other than the three frozen/);
  assert.throws(() => R.orderingGate(base.filter((f) => !f.startsWith("20261117000001"))), /is not in the repository/);
  assert.throws(() => R.orderingGate([...base, "20261117500000_between.sql"]), /other than the three frozen/);
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
const hist = (n: number, lastVersion: string) => Array.from({ length: n }, (_, i) => ({ version: i === n - 1 ? lastVersion : String(20260000000000 + i), name: "m" }));
const ctxFor = () => ({ files: R.verifyFrozenMigrations(read), acct: () => "x", live: true, log: () => {}, preCount: R.PRE_COUNT, lastPre: R.LAST_PRE, hashes: R.PRE_STATE });

test("refusal: a second application is refused once history has reached 96, and nothing is written", async () => {
  const history = [...hist(93, R.LAST_PRE), ...R.MIGRATIONS.map((m: { version: string; name: string }) => ({ version: m.version, name: m.name }))];
  const c = fakeClient(history);
  await assert.rejects(() => R.execute(c, ctxFor()), /history is not exactly 93/);
  assert.ok(!c.calls.some((s) => /^(begin|insert|update|delete|alter|create)/i.test(s)), "nothing was written or even begun");
});

test("refusal: wrong history count, wrong last migration, an already-recorded P0 version and a production reference in history are refused", async () => {
  await assert.rejects(() => R.execute(fakeClient(hist(92, R.LAST_PRE)), ctxFor()), /history is not exactly 93/);
  await assert.rejects(() => R.execute(fakeClient(hist(93, "20261116000001")), ctxFor()), /history is not exactly 93.*ending 20261117000001/);
  const withP0 = hist(93, R.LAST_PRE); withP0[10] = { version: "20261118000002", name: "p0_duty_overtime_compatibility" };
  await assert.rejects(() => R.execute(fakeClient(withP0), ctxFor()), /already recorded/);
  const withProd = hist(93, R.LAST_PRE); withProd[3] = { version: "20260000000003", name: `x_${FORBIDDEN_REF}` };
  await assert.rejects(() => R.execute(fakeClient(withProd), ctxFor()), /production reference/);
});

test("refusal: execute() refuses SQL that does not match the frozen hash or is outside the allow-list, before touching the database", async () => {
  const c = fakeClient(hist(93, R.LAST_PRE));
  const ctx = ctxFor();
  ctx.files[0] = { ...ctx.files[0], sql: `${ctx.files[0].sql}\n-- tampered` };
  await assert.rejects(() => R.execute(c, ctx), /does not match its frozen SHA-256/);
  const ctx2 = ctxFor();
  const bad = `${ctx2.files[2].sql}\ngrant all on public.profiles to anon;`;
  ctx2.files[2] = { ...ctx2.files[2], sql: bad, sha256: undefined };
  await assert.rejects(() => R.execute(c, ctx2), /outside the reviewed allow-list/);
  assert.equal(c.calls.length, 0, "no query was issued");
});

test("the live phrase is exact and is the only way to commit (main() requires it; execute() commits only with ctx.live)", () => {
  const src = fs.readFileSync("scripts/staging/apply-p0-migrations.mjs", "utf8");
  assert.match(src, /argVal\("confirm"\) !== LIVE_PHRASE/);
  assert.match(src, /if \(ctx\.live\) \{/);
  assert.match(src, /--verify-applied/);
});
