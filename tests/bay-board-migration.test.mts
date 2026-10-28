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

test("the applied Bay Board migration keeps its unique version, and every later migration sorts after it", () => {
  assert.equal(files.filter((f) => f.startsWith("20261117000001")).length, 1);
  assert.ok(files.includes(FILE));
  assert.equal(new Set(files.map((f) => f.slice(0, 14))).size, files.length, "migration versions are unique");
  assert.ok(files.slice(files.indexOf(FILE) + 1).every((f) => f.slice(0, 14) > "20261117000001"), "everything after it sorts later");
});

test("the migration only adds what the application uses, idempotently, and never touches policies, RLS or table grants", () => {
  assert.doesNotMatch(code, /create policy|alter policy|drop policy|disable row level security|enable row level security|force row level security/i);
  assert.doesNotMatch(code, /grant\s+(select|insert|update|delete|all)/i);
  assert.doesNotMatch(code, /\bto\s+(anon|public)\b/i);
  assert.doesNotMatch(code, /drop table|truncate|delete from|drop column|org_id/i);
  for (const stmt of code.split(";").map((s) => s.trim()).filter((s) => /^alter table|^create index/i.test(s))) {
    assert.match(stmt, /if not exists|drop constraint if exists|drop not null/i, `idempotent: ${stmt.slice(0, 60)}`);
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
  assert.match(runner, /RUNNER_BRANCH = "ui\/stitch-mobile-redesign"/);
  assert.doesNotMatch(runner, /fix\/bay-board-flight-column/, "the superseded repair branch is no longer accepted anywhere in the runner");
  assert.match(runner, /expectedBranch: RUNNER_BRANCH/);
  assert.match(runner, /runnerGitGates\(\{ expectedHead, repoPath:/, "main() runs the exported, tested git gates");
  assert.match(runner, /verifyFrozenMigration\(buf, file\)/, "main() runs the exported, tested migration verification");
  assert.match(runner, /git\.head !== expectedHead/);
  assert.match(runner, /certifiedBase = CERTIFIED_BASE/);
  assert.match(runner, /merge-base --is-ancestor \$\{certifiedBase\}/);
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

test("the expected hosted baseline records the applied reconciliation: 93 migrations ending at 20261117000001 (set only after the guarded live apply was verified)", () => {
  const base = fs.readFileSync("scripts/staging/lib/expected-baseline.mjs", "utf8");
  assert.match(base, /EXPECTED_MIGRATION_COUNT = 103;/);
  assert.match(base, /EXPECTED_LATEST_MIGRATION = "20261129000001";/);
});

// ======================= revised reconciliation (SEC016 rev03 + ops_group + Bay Board) =======================
// @ts-expect-error plain .mjs tooling modules
import * as F from "../scripts/staging/lib/sec016-fixtures.mjs";
const rev03 = fs.readFileSync(`${DIR}/20260914000001_sec016_rev03_direction_fields.sql`, "utf8").replace(/\r\n/g, "\n");

test("revised migration: adds exactly the three rev03 columns (canonical text, nullable, no default) and the historical ops_group the application still writes", () => {
  for (const c of ["ramp_agents_baggage", "ramp_agents_cargo", "cabin_check", "ops_group"]) {
    assert.match(code, new RegExp(`add column if not exists ${c} text(?!\s+not null)`, "i"), `${c} text`);
  }
  // identical column definitions to the canonical rev03 migration
  for (const c of ["ramp_agents_baggage", "ramp_agents_cargo", "cabin_check"]) assert.match(rev03, new RegExp(`ADD COLUMN IF NOT EXISTS ${c} text`));
  assert.doesNotMatch(code, /org_id|organizations/i, "no multi-tenant scaffolding is added");
});

test("revised migration: relaxes precisely the sixteen NOT NULL constraints that the canonical rev03 migration relaxes, and nothing else", () => {
  const relaxed = [...code.matchAll(/alter column (\w+) drop not null/gi)].map((m) => m[1].toLowerCase()).sort();
  assert.deepEqual(relaxed, [...F.SEC016_LEGACY_NULLABLE].sort());
  assert.equal(relaxed.length, 16);
  assert.doesNotMatch(code, /set not null|alter column \w+ (type|set default|drop default)/i, "no other column change");
});

test("revised migration: keeps the reviewed Bay Board reconciliation, stays idempotent and adds no policy, grant, trigger or data change", () => {
  for (const frag of ["add column if not exists flight text", "add column if not exists is_manual boolean not null default false", "add column if not exists arrival_report_id uuid references public.report_sec016(id)", "add column if not exists departure_report_id uuid references public.report_sec016(id)", "drop constraint if exists bay_board_cleared_by_report_id_fkey", "create or replace function public.get_bay_board_secure"]) assert.ok(code.toLowerCase().includes(frag), frag);
  assert.doesNotMatch(code, /create trigger|drop trigger|insert into|update public\.|delete from|create policy|drop policy|grant\s+(select|insert|update|delete|all)/i);
});

test("revised migration: every statement is on the runner allow-list, and the allow-list refuses additions", async () => {
  // @ts-expect-error plain .mjs tooling module
  const r = await import("../scripts/staging/apply-bay-board-migration.mjs");
  assert.equal(r.statementAudit(sql), null);
  for (const extra of ["alter table public.report_sec016 add column org_id uuid;", "alter table public.report_sec016 alter column station drop not null;", "alter table public.report_sec016 alter column inbound_baggage set not null;", "drop table public.report_sec016;", "alter table public.report_sec016 add column if not exists cabin_check text not null;"]) {
    assert.notEqual(r.statementAudit(`${sql}\n${extra}`), null, extra);
  }
  // dropping a column that is NOT one of the sixteen is refused
  assert.notEqual(r.statementAudit(sql.replace("alter column ramp_staff_5 drop not null", "alter column station drop not null")), null);
});

test("runner: exact hosted pre-state is frozen (columns, indexes, constraints, policies, grants, triggers, function) and the sixteen legacy NOT NULL columns and eight absent columns are verified before anything is applied", () => {
  for (const k of ["constraintsMd5", "policiesMd5", "tableGrantsMd5", "triggersMd5", "legacyNotNull", "absentColumns"]) assert.match(runner, new RegExp(`${k}:`), `PRE_STATE.${k}`);
  assert.match(runner, /import \* as F from "\.\/lib\/sec016-fixtures\.mjs"/);
  assert.match(runner, /SEC016_LEGACY_NULLABLE/);
  assert.match(runner, /report_sec016 and bay_board hold rows|report_sec016 holds rows/);
});

test("runner: the transaction proves canonical columns, sixteen nullable columns, no unrelated column change, 93 history rows, the app-exact SEC016 submit, and refuses an incomplete probe run", () => {
  for (const needle of ["EXPECTED_PROBES", "SEC016_NEW_COLUMNS", "sec016AppPayload(", "ramp_agents_baggage", "all sixteen legacy columns are nullable", "recorded exactly once", "no unrelated column change", "incomplete probe execution", "ctx.expectedProbes"]) assert.ok(runner.includes(needle), needle);
  assert.match(runner, /export const EXPECTED_PROBES = \d+;/);
});

test("runner: still dry-run first, never converts to live without the exact phrase, and the live pass is unchanged", () => {
  assert.match(runner, /const LIVE = args\.includes\("--live"\)/);
  assert.match(runner, /argVal\("confirm"\) !== LIVE_PHRASE/);
  assert.match(runner, /await pass\(false\);[\s\S]*if \(ctx\.live\)/);
});
