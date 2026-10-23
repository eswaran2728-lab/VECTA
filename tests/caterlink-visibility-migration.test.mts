import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
// @ts-expect-error plain .mjs tooling module
import * as runner from "../scripts/staging/apply-caterlink-visibility-migration.mjs";

const migDir = path.join(process.cwd(), "supabase", "migrations");
const FILE = "20261119000001_caterlink_least_privilege_transaction_read.sql";
const SQL = fs.readFileSync(path.join(migDir, FILE), "utf8");
const RUNNER_SRC = fs.readFileSync("scripts/staging/apply-caterlink-visibility-migration.mjs", "utf8");

test("the migration is frozen: its normalised SHA-256 matches the runner, it uses only allow-listed statements and is the only migration after 20261118000005", () => {
  const files = runner.verifyFrozenMigrations((f: string) => fs.readFileSync(path.join(migDir, f)));
  assert.equal(files.length, 1);
  assert.equal(runner.statementAudit(SQL), null);
  const historicalFiles = fs.readdirSync(migDir).filter((f) => !/^\d{14}_/.test(f) || f.slice(0, 14) <= "20261119000001");
  assert.doesNotThrow(() => runner.orderingGate(historicalFiles));
  assert.equal(runner.MIGRATIONS[0].version, "20261119000001");
  assert.equal(runner.LAST_PRE, "20261118000005");
  assert.equal(runner.PRE_COUNT, 98);
  assert.equal(runner.POST_COUNT, 99);
});

test("CRLF checkout does not change the frozen hash (canonical LF hashing)", () => {
  const crlf = Buffer.from(SQL.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n"));
  assert.equal(runner.normalisedSha256(crlf), runner.MIGRATIONS[0].sha256);
});

test("the allow-list rejects anything else: extra grants, the old station-membership policy, destructive or privilege-changing function bodies, a second migration", () => {
  assert.match(String(runner.statementAudit(SQL + "\ngrant all on public.profiles to anon;")), /grant all/);
  const oldPolicy = SQL.replace("public.caterlink_can_read_transaction_at_stations(aoc_id, origin_station_id, destination_station_id, hub_destination)", "public.has_station_assignment_for_transaction(aoc_id, destination_station_id, origin_station_id)");
  assert.match(String(runner.statementAudit(oldPolicy)), /does not use the new function exclusively/);
  assert.match(String(runner.statementAudit(SQL.replace("return false;\n  end if;\n  if not exists", "delete from public.transactions; return false;\n  end if;\n  if not exists"))), /function body contains/);
  const historicalFiles = fs.readdirSync(migDir).filter((f) => !/^\d{14}_/.test(f) || f.slice(0, 14) <= "20261119000001");
  assert.throws(() => runner.orderingGate([...historicalFiles, "20261119000002_extra.sql"]), /other than the frozen one/);
  assert.throws(() => runner.orderingGate([...historicalFiles, FILE.replace("_caterlink", "_dup")]), /duplicate migration versions/);
});

test("production is rejected anywhere in env or argv; the live phrase names the exact version and the approved project", () => {
  assert.throws(() => runner.productionGate({ X: "https://zsxneokqulktgnccxgkz.supabase.co" }, ["node"]), /production reference/);
  assert.throws(() => runner.productionGate({}, ["node", "--url=zsxneokqulktgnccxgkz"]), /production reference/);
  assert.doesNotThrow(() => runner.productionGate({ X: "ddlctzbnqewubltcavkh" }, ["node"]));
  assert.equal(runner.LIVE_PHRASE, "APPLY 20261119000001 TO STAGING ddlctzbnqewubltcavkh");
});

test("git gate: a short or wrong head is refused before anything runs", () => {
  assert.throws(() => runner.runnerGitGates({ expectedHead: "abc", repoPath: process.cwd() }), /40-character/);
});

test("the required probe count equals the probes the runner actually performs", () => {
  const probeCalls = (RUNNER_SRC.match(/\n\s+probe\(/g) ?? []).length;
  assert.equal(runner.EXPECTED_PROBES, probeCalls);
});

test("authorization design: station membership alone grants nothing -- the policy and the function reuse the canonical capability model and exclude Staff Profiling", () => {
  assert.doesNotMatch(SQL.split("create policy")[1], /has_station_assignment_for_transaction/);
  assert.match(SQL, /public\.check_station_caterlink_capability\(p_aoc_id, v_origin, 'scan'\)/);
  assert.doesNotMatch(SQL.replace(/--.*$/gm, ""), /can_user_scan_caterlink/, "no other permission derives from the scan decision");
  assert.match(SQL, /public\.can_user_confirm_caterlink_receipt\(v_receiving, p_aoc_id\)/);
  assert.match(SQL, /public\.check_station_caterlink_capability\(p_aoc_id, v_origin, 'create'\)/);
  assert.match(SQL, /rd\.code in \('profiling_so', 'profiling_aso'\)/);
  assert.match(SQL, /p\.status = 'approved'/);
  assert.match(SQL, /security definer\s+set search_path to 'public'/);
  assert.match(SQL, /revoke execute on function public\.caterlink_can_read_transaction_at_stations\(uuid, uuid, uuid, text\) from public, anon/);
  assert.match(SQL, /grant execute on function public\.caterlink_can_read_transaction_at_stations\(uuid, uuid, uuid, text\) to authenticated, service_role/);
  // no role-name guessing beyond the canonical station-operator set already used by the capability functions
  const names = [...SQL.matchAll(/rd\.code in \(([^)]*)\)/g)].map((m) => m[1]);
  assert.deepEqual(names, ["'profiling_so', 'profiling_aso'", "'sso', 'so', 'aso', 'dse'", "'sso', 'so', 'aso'"]);
});

test("the legitimate branches of the policy are preserved: service_role, CaterLink Management, Operation Manager / Main Enforcement, the creator", () => {
  const policy = SQL.split("create policy")[1];
  for (const keep of ["current_user = 'service_role'", "has_active_role_for_aoc('caterlink_management'", "has_active_role_for_aoc('operation_manager'", "has_active_role_for_aoc('main_enforcement'", "created_by = auth.uid()"]) assert.ok(policy.includes(keep), keep);
  assert.match(policy, /for select to authenticated/);
});
