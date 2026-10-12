import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
// @ts-expect-error plain .mjs tooling module
import { MIGRATIONS, PRE_COUNT, LAST_PRE, LIVE_PHRASE, normalisedSha256 } from "../scripts/staging/apply-baseline-fixes.mjs";

const MIGRATION = MIGRATIONS[0];

const read = (p: string) => fs.readFileSync(p, "utf8");
const FILE = `supabase/migrations/${MIGRATION.version}_${MIGRATION.name}.sql`;
const SQL = read(FILE);
const CODE = SQL.replace(/--.*$/gm, "");

test("the queue-worker migration is frozen, sorts after the last applied migration and has no timestamp collision", () => {
  assert.equal(normalisedSha256(fs.readFileSync(FILE)), MIGRATION.sha256);
  const versions = fs.readdirSync("supabase/migrations").filter((f) => /^\d{14}_/.test(f)).map((f) => f.slice(0, 14)).sort();
  assert.equal(versions.filter((v) => v === MIGRATION.version).length, 1);
  assert.deepEqual(versions.filter((v) => v > LAST_PRE), MIGRATIONS.map((m) => m.version));
  assert.ok(MIGRATION.version > LAST_PRE);
  for (const m of MIGRATIONS) assert.equal(normalisedSha256(fs.readFileSync(`supabase/migrations/${m.version}_${m.name}.sql`)), m.sha256);
  assert.equal(PRE_COUNT, 80);
});

test("the worker keeps its signature, SECURITY DEFINER, search_path and service-role-only grants, and sets the transaction-local service-role claim", () => {
  assert.match(CODE, /create or replace function public\.process_report_index_queue\(p_batch_size integer default 50\)/);
  assert.match(CODE, /security definer\s+set search_path to 'public'/);
  assert.match(CODE, /perform set_config\('request\.jwt\.claims', json_build_object\('role', 'service_role'\)::text, true\);/);
  assert.ok(CODE.indexOf("set_config('request.jwt.claims'") < CODE.indexOf("for v_row in"), "the claim is set before any row is processed");
  assert.match(CODE, /revoke execute on function public\.process_report_index_queue\(integer\) from public, anon, authenticated;/);
  assert.match(CODE, /grant execute on function public\.process_report_index_queue\(integer\) to service_role;/);
  assert.doesNotMatch(CODE, /grant execute[^;]*(authenticated|anon)/i);
});

test("the body is otherwise the Phase 5 worker (same statements) and the repair touches only rows failed by this defect", () => {
  const old = read("supabase/migrations/20260928000004_phase5_report_classification_repository.sql");
  const body = (t: string) => t.slice(t.indexOf("create or replace function public.process_report_index_queue"), t.indexOf("revoke execute on function public.process_report_index_queue")).replace(/--.*$/gm, "").replace(/\s+/g, " ").replace("perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true); ", "");
  assert.equal(body(SQL), body(old));
  const repair = CODE.slice(CODE.indexOf("update public.report_index_queue"));
  assert.match(repair, /where status = 'permanently_failed' and last_error like 'Submitted reports are immutable and cannot be edited%'/);
  assert.doesNotMatch(CODE, /report_sec0|offload_records|central_reports_index/);
});

test("the guarded runner: dry run first, exact phrase, fresh backup, frozen hash, production refused, probe rolled back", () => {
  const src = read("scripts/staging/apply-baseline-fixes.mjs");
  assert.equal(LIVE_PHRASE, "APPLY 20261106000001+20261106000002 TO STAGING ddlctzbnqewubltcavkh");
  for (const needle of ["gitGates(", "environmentGates(", "backupGates(", "decryptBackupPayload(", "connectVerified(", "FORBIDDEN_REF", "older than 6 hours", "ROLLBACK TO SAVEPOINT probe", "the dry run left a change behind", "history is not exactly"]) assert.ok(src.includes(needle), needle);
  assert.ok(src.indexOf("await pass(false)") < src.indexOf("await pass(true)"));
  assert.doesNotMatch(src, /rejectUnauthorized:\s*false|sslmode=disable|console\.log\([^)]*(DATABASE_URL|SECRET|PASSPHRASE)/);
});

test("shift_handovers policies migration: canonical, authenticated-only, no legacy rank, no PUBLIC, nothing else touched", () => {
  const m = MIGRATIONS[1];
  const code = read(`supabase/migrations/${m.version}_${m.name}.sql`).replace(/--.*$/gm, "");
  assert.equal((code.match(/create policy/g) ?? []).length, 3);
  assert.equal((code.match(/to authenticated/g) ?? []).length, 3);
  assert.doesNotMatch(code, /current_role_rank|role_rank|is_monitor_or_above|to public|create (or replace )?function|alter table|grant |revoke /i);
  assert.match(code, /canon_has_role\(array\['operation_manager'::text, 'main_enforcement'::text\]\)/);
});
