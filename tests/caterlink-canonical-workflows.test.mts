import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { isModuleMissing } from "../lib/icms/module-state.ts";

// Static guards for the option-B reconciliation: the CaterLink pages and actions read the canonical
// Phase 9 model plus the proposed external-workflow migration, never the legacy ICMS workflow tables.
// The database behaviour itself is proven by supabase/tests/integration/verify_caterlink_external_workflows.mjs.

const REPO = path.resolve(import.meta.dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");
const MIGRATION = "supabase/migrations/20261025000001_caterlink_external_workflows.sql";
const strip = (sql: string) => sql.replace(/--[^\n]*/g, "");

const LEGACY_TABLES = [
  "incidents", "part_a", "part_b", "part_c", "part_d", "part_hub", "part_redq", "audit_logs",
  "segment_timeouts", "incident_photos", "vendor_transactions", "vendor_part_a", "vendor_part_b", "vendor_part_c",
];
const legacyRead = (src: string) =>
  LEGACY_TABLES.filter((t) => new RegExp(`\\.from\\(\\s*["']${t}["']`).test(src));

const CANONICAL_FILES = [
  "lib/icms/actions/vendor-transactions.ts",
  "lib/icms/actions/incidents.ts",
  "lib/icms/actions/archive.ts",
  "app/(icms)/icms/vendor-transactions/page.tsx",
  "app/(icms)/icms/vendor-transactions/[id]/page.tsx",
  "app/(icms)/icms/vendor-transactions/[id]/part-b/page.tsx",
  "app/(icms)/icms/vendor-transactions/[id]/part-c/page.tsx",
  "app/(icms)/icms/transactions/new/page.tsx",
  "app/(icms)/icms/transactions/[id]/page.tsx",
  "app/(icms)/icms/incidents/page.tsx",
  "app/(icms)/icms/reports/page.tsx",
  "app/(icms)/icms/dashboard/page.tsx",
  "app/(icms)/icms/admin/audit/page.tsx",
];

test("the CaterLink pages and actions read no legacy ICMS workflow table", () => {
  for (const f of CANONICAL_FILES) {
    assert.deepEqual(legacyRead(read(f)), [], `${f} still reads a legacy table`);
  }
  // the vendor QR resolution and scan lookup use the canonical deliveries too
  for (const f of ["lib/icms/actions/scan.ts", "app/api/icms/qr/validate/route.ts"]) {
    const src = read(f);
    assert.ok(!/\.from\(\s*["']vendor_transactions["']/.test(src), f);
    assert.match(src, /caterlink_vendor_deliveries/, f);
  }
});

test("the blocked checkpoint pages query no table and keep the scan permission untouched", () => {
  for (const slug of ["part-b", "part-c", "part-d", "part-hub", "part-redq", "skip-part-d", "incident"]) {
    const src = read(`app/(icms)/icms/transactions/[id]/${slug}/page.tsx`);
    assert.ok(!/\.from\(|\.rpc\(/.test(src), `${slug}: a blocked page must not query the database`);
    assert.match(src, /BLOCKED/, slug);
  }
});

test("every function the application calls for the CaterLink workflows exists in a versioned (non-legacy) migration", () => {
  const dir = path.join(REPO, "supabase/migrations");
  const sql = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("\n");
  const sources = CANONICAL_FILES.concat(["lib/icms/actions/transactions.ts"]).map(read).join("\n");
  const called = [...sources.matchAll(/callCaterlinkRpc\(\s*supabase,\s*"([a-z_]+)"/g)].map((m) => m[1]);
  assert.ok(called.length >= 6, `expected the new RPC call sites, found ${called.length}`);
  for (const fn of new Set(called)) {
    assert.match(sql, new RegExp(`create or replace function public\\.${fn}\\(`), `${fn} is not defined by any versioned migration`);
  }
});

test("no action supplies an identity: the database derives it from the session", () => {
  const vendor = read("lib/icms/actions/vendor-transactions.ts");
  const tx = read("lib/icms/actions/transactions.ts");
  for (const src of [vendor, tx]) {
    assert.ok(!/p_(user|profile|actor|vendor|pic|caller)_?(id|name|staff)/i.test(src.replace(/p_driver_/g, "")), "an RPC argument carries an identity");
  }
  const create = tx.slice(tx.indexOf("create_caterlink_driver_transaction_secure") - 200, tx.indexOf("create_caterlink_driver_transaction_secure") + 1400);
  assert.ok(!/profile\.(name|staff_id|id)/.test(create), "the Driver creation call must not send the signed-in profile's details");
  for (const t of ["create_caterlink_vendor_delivery_secure", "record_caterlink_vendor_security_check_secure", "complete_caterlink_vendor_delivery_secure"]) {
    assert.match(vendor, new RegExp(t));
  }
});

test("migration: additive, canonical, and fail-closed", () => {
  const sql = strip(read(MIGRATION));
  // never recreates a legacy table, never widens access
  for (const t of LEGACY_TABLES) {
    assert.ok(!new RegExp(`create table (if not exists )?public\\.${t}\\b`, "i").test(sql), `${t} must not be recreated`);
  }
  assert.ok(!/using\s*\(\s*true\s*\)/i.test(sql) && !/with\s+check\s*\(\s*true\s*\)/i.test(sql), "no blanket policy");
  assert.ok(!/create policy [^;]*\bfor (all|insert|update|delete)\b/i.test(sql), "clients get SELECT policies only");
  assert.ok(!/alter table public\.(transactions|vehicles|drivers|catering_companies|seals)\b/i.test(sql), "no existing workflow table is altered");
  // the one change to the capabilities table: a new, separate column; no scan/receipt/create value is written
  const capAlters = [...sql.matchAll(/alter table public\.caterlink_station_capabilities\s+([^;]*);/gi)].map((m) => m[1].replace(/\s+/g, " ").trim());
  assert.deepEqual(capAlters, ["add column if not exists can_check_vendor_delivery boolean not null default false"]);
  const capUpdate = sql.slice(sql.search(/update public\.caterlink_station_capabilities/i)).split(";")[0];
  assert.match(capUpdate, /set can_check_vendor_delivery = true/);
  assert.ok(!/can_scan|can_create|can_confirm|can_view|can_report|can_download|is_active\s*=/.test(capUpdate), "scan, receipt and create capability values are not written");
  assert.ok(!/insert into public\.caterlink_station_capabilities/i.test(sql));
  assert.ok(!/can_user_scan_caterlink|can_user_confirm_caterlink_receipt/.test(sql), "no database function is derived from the scan or receipt decisions");
  assert.ok(!/create or replace function public\.(can_user_scan_caterlink|can_user_confirm_caterlink_receipt|check_station_caterlink_capability|confirm_caterlink_destination_receipt_secure)/.test(sql), "scan and receipt decisions are not redefined");
  // every function: security definer + pinned search_path + anon denied + authenticated granted
  const fns = [...sql.matchAll(/create or replace function public\.(\w+)\(([\s\S]*?)\)\s*returns/g)].map((m) => m[1]);
  assert.ok(fns.length >= 9, `expected at least 9 functions, found ${fns.length}`);
  for (const fn of fns) {
    if (fn === "caterlink_vendor_guard") continue; // trigger function
    const def = sql.slice(sql.indexOf(`create or replace function public.${fn}(`));
    const head = def.slice(0, def.indexOf("$function$;") + 12);
    assert.match(head, /security definer/i, `${fn}: security definer`);
    assert.match(head, /set search_path to 'public'/i, `${fn}: pinned search_path`);
    assert.match(sql, new RegExp(`revoke execute on function public\\.${fn}\\([^)]*\\) from public, anon`), `${fn}: anon denied`);
    assert.match(sql, new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\) to authenticated`), `${fn}: authenticated granted`);
  }
  // idempotency markers
  assert.match(sql, /create table if not exists public\.caterlink_vendor_deliveries/);
  assert.match(sql, /create table if not exists public\.caterlink_vendor_checkpoints/);
  assert.equal([...sql.matchAll(/create policy (\w+)/g)].length, [...sql.matchAll(/drop policy if exists (\w+)/g)].length, "every policy is preceded by drop policy if exists");
});

test("a deployed-environment gap (function or table not deployed yet) renders as 'not activated'", () => {
  assert.equal(isModuleMissing({ code: "PGRST202", message: "Could not find the function public.list_caterlink_audit_secure in the schema cache" }), true);
  assert.equal(isModuleMissing({ code: "42883", message: "function public.x() does not exist" }), true);
  assert.equal(isModuleMissing({ code: "42501", message: "permission denied for function x" }), false, "a permission error is never a missing module");
  for (const f of [
    "app/(icms)/icms/vendor-transactions/page.tsx", "app/(icms)/icms/admin/audit/page.tsx", "app/(icms)/icms/transactions/new/page.tsx",
  ]) {
    assert.match(read(f), /isModuleMissing\(/, f);
    assert.match(read(f), /<ModuleNotActivated/, f);
  }
});

test("the vendor workflow no longer depends on a warehouse-PIC identity or legacy checkpoint roles", () => {
  const wf = read("lib/icms/workflow-vendor.ts");
  assert.ok(!/role:\s*"warehouse_pic"/.test(wf), "Part C belongs to the owning Vendor in the canonical model");
  assert.match(wf, /role:\s*"vendor"/);
  const partC = read("app/(icms)/icms/vendor-transactions/[id]/part-c/page.tsx");
  assert.match(partC, /requireRole\(\["vendor"\]\)/);
  assert.match(partC, /vendor_user_id !== profile\.id/, "an owner check precedes the form");
});

test("the gated staging runner verifies exactly what the migration adds", () => {
  const runner = read("scripts/staging/apply-external-workflows-migration.mjs");
  const sql = strip(read(MIGRATION));
  const created = [...sql.matchAll(/create or replace function public\.(\w+)\(/g)].map((m) => m[1]).sort();
  const listed = runner.slice(runner.indexOf("const NEW_FUNCTIONS = ["), runner.indexOf("];", runner.indexOf("const NEW_FUNCTIONS = [")));
  const inRunner = [...listed.matchAll(/"(\w+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(inRunner, created, "the runner's function list must equal the migration's");
  assert.match(runner, /const PRE_COUNT = 64;/);
  assert.match(runner, /LAST_PRE = "20261024000001"/);
  assert.match(runner, /ROLLBACK/);
  assert.match(runner, /--preflight-only/);
  assert.ok(!/postgres(ql)?:\/\/[^\[\s"']+:[^@\s"']+@/.test(runner), "no connection string with credentials in the runner");
});

test("Driver and Vendor are denied each other's pages (not only each other's rows)", () => {
  for (const f of ["app/(icms)/icms/vendor-transactions/page.tsx", "app/(icms)/icms/vendor-transactions/[id]/page.tsx"]) {
    assert.match(read(f), /role === "warehouse_pic"\) redirect\("\/icms\/dashboard\?error=forbidden"\)/, f);
  }
  assert.match(read("app/(icms)/icms/vendor-transactions/[id]/part-b/page.tsx"), /identity === "external"\) redirect\("\/icms\/dashboard\?error=forbidden"\)/);
  for (const f of ["app/(icms)/icms/transactions/page.tsx", "app/(icms)/icms/transactions/[id]/page.tsx"]) {
    assert.match(read(f), /role === "vendor"\) redirect\("\/icms\/dashboard\?error=forbidden"\)/, f);
  }
  assert.match(read("app/(icms)/icms/incidents/page.tsx"), /identity === "external"\) redirect\("\/icms\/dashboard\?error=forbidden"\)/);
});

test("the storage repairs are frozen migrations and the old proposal folder is gone", () => {
  const live = fs.readdirSync(path.join(REPO, "supabase/migrations"));
  assert.ok(live.includes("20261026000001_storage_upload_policy_repair.sql") && live.includes("20261026000002_signature_read_scoping.sql"));
  // only the still-unapproved profile-state repair may sit in the proposal folder, and it must not be a live migration
  const proposed = fs.existsSync(path.join(REPO, "supabase/proposed-migrations")) ? fs.readdirSync(path.join(REPO, "supabase/proposed-migrations")) : [];
  assert.deepEqual(proposed, ["20261027000001_station_visibility_requires_approved_profile.sql"]);
  assert.ok(!live.some((f) => /^20261027/.test(f)), "the profile-state repair was moved into supabase/migrations without approval");
  const prof = read("supabase/proposed-migrations/20261027000001_station_visibility_requires_approved_profile.sql");
  assert.match(prof, /p\.status = 'approved'/);
  assert.ok(!/create policy|drop policy/i.test(prof), "the profile-state repair edits no policy");
  const one = read("supabase/migrations/20261026000001_storage_upload_policy_repair.sql");
  const two = read("supabase/migrations/20261026000002_signature_read_scoping.sql");
  assert.match(one, /can_upload_report_attachment/);
  assert.ok(!/grant execute on function public\.get_report_submitter/i.test(one), "the repair must not re-grant get_report_submitter");
  assert.match(one, /set search_path to 'public'/);
  assert.match(one, /revoke execute on function public\.can_upload_report_attachment\(text\) from public, anon/);
  assert.ok(!/using\s*\(\s*true\s*\)/i.test(two) && !/auth\.role\(\)/.test(two.replace(/--.*$/gm, "")), "no blanket authenticated read");
  assert.match(two, /owner = auth\.uid\(\) or public\.caterlink_signature_visible\(name\)/);
  assert.match(two, /security invoker/);
});
