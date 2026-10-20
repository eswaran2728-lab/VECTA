import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";

const DIR = "supabase/migrations";
const FILE = "20261117000001_bay_board_sec016_reconciliation.sql";
const raw = fs.readFileSync(`${DIR}/${FILE}`, "utf8");
const sql = raw.replace(/\r\n/g, "\n");
const code = sql.replace(/--.*$/gm, "");
const runner = fs.readFileSync("scripts/staging/apply-bay-board-migration.mjs", "utf8");
const gates = fs.readFileSync("scripts/staging/lib/run-gates.mjs", "utf8");
const files = fs.readdirSync(DIR).filter((f) => /^\d{14}_.*\.sql$/.test(f)).sort();

test("the Bay Board migration is the only one after the last applied staging migration and its version is unique", () => {
  assert.deepEqual(files.filter((f) => f.slice(0, 14) > "20261116000001"), [FILE]);
  assert.equal(files.filter((f) => f.startsWith("20261117000001")).length, 1);
});

test("the migration only adds what the application uses, idempotently, and never touches policies, RLS or table grants", () => {
  assert.doesNotMatch(code, /create policy|alter policy|drop policy|disable row level security|enable row level security|force row level security/i);
  assert.doesNotMatch(code, /grant\s+(select|insert|update|delete|all)/i);
  assert.doesNotMatch(code, /\bto\s+(anon|public)\b/i);
  assert.doesNotMatch(code, /drop table|truncate|delete from|drop column|org_id/i);
  for (const stmt of code.split(";").map((s) => s.trim()).filter((s) => /^alter table|^create index/i.test(s))) {
    assert.match(stmt, /if not exists|drop constraint if exists/i, `idempotent: ${stmt.slice(0, 60)}`);
  }
  assert.match(code, /revoke execute on function public\.get_bay_board_secure\(text, text\) from public, anon;/);
  assert.match(code, /grant execute on function public\.get_bay_board_secure\(text, text\) to authenticated, service_role;/);
});

test("get_bay_board_secure keeps SECURITY DEFINER, a fixed search_path, the caller check and the unchanged return shape", () => {
  const body = /create or replace function public\.get_bay_board_secure[\s\S]*?\$function\$[\s\S]*?\$function\$;/.exec(code)![0];
  assert.match(body, /security definer/);
  assert.match(body, /set search_path to 'public'/);
  assert.match(body, /v_aoc uuid := public\.caller_bay_board_aoc\(\)/);
  assert.match(body, /if v_aoc is null then\s+raise exception/);
  assert.match(body, /returns table \(id uuid, station text, reg_no text, aircraft_type text, bay text, flight text, on_ground_since timestamptz\)/);
  // identical to the body certified in 20261102000001
  const prior = fs.readFileSync(`${DIR}/20261102000001_role_workspace_support.sql`, "utf8").replace(/\r\n/g, "\n");
  const priorBody = /create or replace function public\.get_bay_board_secure[\s\S]*?\$function\$[\s\S]*?\$function\$;/.exec(prior)![0];
  assert.equal(body, priorBody, "function definition is byte-identical to the certified one");
});

test("the guarded runner pins the migration hash, the exact branch and commit, staging only, verified TLS and a rolled-back dry run first", () => {
  const m = /MIGRATION = \{ version: "(\d{14})", name: "([a-z0-9_]+)", sha256: "([0-9a-f]{64})" \}/.exec(runner)!;
  assert.equal(`${m[1]}_${m[2]}.sql`, FILE);
  assert.equal(crypto.createHash("sha256").update(sql).digest("hex"), m[3], "frozen SHA-256 matches the migration");
  assert.match(runner, /RUNNER_BRANCH = "fix\/bay-board-flight-column"/);
  assert.match(runner, /expectedBranch: RUNNER_BRANCH/);
  assert.match(runner, /git\.head !== expectedHead/);
  assert.match(runner, /merge-base --is-ancestor \$\{CERTIFIED_BASE\}/);
  assert.match(runner, /environmentGates\(\)/);
  assert.match(runner, /FORBIDDEN_REF/);
  assert.match(runner, /connectVerified\(\)/);
  assert.match(runner, /PRE_COUNT = 92/);
  assert.match(runner, /LAST_PRE = "20261116000001"/);
  assert.match(runner, /await pass\(false\);[\s\S]*staging is unchanged after the dry-run rollback[\s\S]*if \(ctx\.live\)/, "dry run, rollback proof, then (only if live) the commit pass");
  assert.match(runner, /const LIVE = args\.includes\("--live"\)/);
  assert.match(runner, /argVal\("confirm"\) !== LIVE_PHRASE/);
  assert.doesNotMatch(runner, /rejectUnauthorized:\s*false|sslmode=disable|NODE_TLS_REJECT_UNAUTHORIZED/);
  assert.doesNotMatch(runner, /zsxneokqulktgnccxgkz/, "the production ref is only ever the imported rejection constant");
});

test("gitGates keeps its default branch and only accepts a different one when a caller names it", () => {
  assert.match(gates, /expectedBranch = EXPECTED_BRANCH/);
  assert.match(gates, /if \(branch !== expectedBranch\) throw/);
});

test("the guarded-runner baseline expectation is untouched until the migration is actually applied", () => {
  const base = fs.readFileSync("scripts/staging/lib/expected-baseline.mjs", "utf8");
  assert.match(base, /EXPECTED_MIGRATION_COUNT = 92;/);
  assert.match(base, /EXPECTED_LATEST_MIGRATION = "20261116000001";/);
});
