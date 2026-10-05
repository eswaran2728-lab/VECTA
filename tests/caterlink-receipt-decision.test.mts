import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildReceiptPlan, buildAccountPlan, RECEIPT_ACCOUNT_LABELS } from "../scripts/staging/lib/team-plan.mjs";
import { assertPreWriteBaseline } from "../scripts/staging/lib/run-gates.mjs";

const REPO = path.resolve(import.meta.dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");
const MIG = read("supabase/migrations/20261022000001_phase9_caterlink_kch_bki_final_receipt.sql");
const strip = (s: string) => s.replace(/--[^\n]*/g, "");

test("migration: KCH and BKI get final hub receipt only; scanning stays off; no other capability is granted", () => {
  const sql = strip(MIG);
  assert.match(sql, /s\.code in \('KCH', 'BKI'\)/);
  assert.match(sql, /false, false, false, false, true, false, false, false, true/, "insert: view/create/scan/station-receipt false, hub-receipt true, incident/history/pdf false");
  assert.match(sql, /can_confirm_hub_receipt = true,\s+can_scan = false/);
  assert.ok(!/can_scan = true/.test(sql), "no scan capability is ever enabled");
  assert.ok(!/update public\.caterlink_station_capabilities[\s\S]*\b(PEN|JHB)\b/.test(sql), "PEN/JHB configuration untouched");
  assert.ok(!/can_user_scan_caterlink/.test(sql), "the corrected scan function is not weakened or replaced");
});

test("migration: receipt decision derives identity from auth.uid(), strict roles, exact station, no bypass", () => {
  const sql = strip(MIG);
  const start = sql.indexOf("create or replace function public.can_user_confirm_caterlink_receipt(");
  const fn = sql.slice(start, sql.indexOf("revoke execute on function public.can_user_confirm_caterlink_receipt"));
  assert.match(fn, /v_uid uuid := auth\.uid\(\)/);
  assert.match(fn, /p\.status = 'approved'/);
  assert.match(fn, /rd\.code in \('sso', 'so', 'aso'\)/);
  assert.match(fn, /ura\.station_id = v_station_id/);
  assert.match(fn, /rd\.is_active/);
  assert.match(fn, /ura\.revoked_at is null/);
  assert.match(fn, /confirm_hub_receipt/);
  assert.ok(!/hub_se|operation_manager|main_enforcement|caterlink_management|super_admin|ops_group|current_role_name|'ADMIN'|p_profile_id/.test(fn), "no bypass and no caller-supplied identity");
  assert.ok(!/can_scan|'scan'/.test(fn), "receipt never consults the scan capability");
  assert.match(sql, /revoke execute on function public\.can_user_confirm_caterlink_receipt\(text, uuid\) from public, anon/);
  assert.match(sql, /grant execute on function public\.can_user_confirm_caterlink_receipt\(text, uuid\) to authenticated, service_role/);
});

test("migration: the receipt RPC authorizes before reading the transaction and updates only final receipt fields", () => {
  const sql = strip(MIG);
  const start = sql.indexOf("create or replace function public.confirm_caterlink_destination_receipt_secure(");
  const fn = sql.slice(start);
  assert.ok(fn.indexOf("can_user_confirm_caterlink_receipt(p_station_code)") < fn.indexOf("from public.transactions t where"), "authorization precedes the transaction lookup");
  assert.match(fn, /Transaction is not available for receipt confirmation at this station/);
  assert.match(fn, /already completed/);
  const upd = fn.slice(fn.indexOf("update public.transactions"), fn.indexOf("where id = p_transaction_id;"));
  assert.match(upd, /set status = 'COMPLETED',\s+completed_at = now\(\),\s+destination_station_id = v_station_id,\s+updated_at = now\(\)/);
  assert.match(fn, /phase8_write_audit\('caterlink_receipt_confirm'/);
  assert.match(sql, /revoke execute on function public\.confirm_caterlink_destination_receipt_secure\(uuid, text, text, text\) from public, anon/);
});

test("migration: only the two canonical ALPHA teams are created, idempotently", () => {
  const sql = strip(MIG);
  assert.match(sql, /insert into public\.org_teams \(station_id, name\)\s+select s\.id, 'ALPHA'[\s\S]*?s\.code in \('KCH', 'BKI'\)[\s\S]*?on conflict \(station_id, name\) do nothing/);
  assert.ok(!/create policy|enable row level security|alter table/.test(sql), "no new RLS policy or schema change");
});

test("the receipt plan has exactly the two approved accounts and does not enter the 36-account plan", () => {
  const plan = buildReceiptPlan();
  assert.deepEqual(plan.map((a) => a.label), ["aso-kch-receipt", "aso-bki-receipt"]);
  assert.deepEqual([...RECEIPT_ACCOUNT_LABELS], ["aso-kch-receipt", "aso-bki-receipt"]);
  const [kch, bki] = plan;
  assert.deepEqual([kch.roleCode, kch.scope.aoc, kch.scope.membership, kch.scope.department, kch.scope.hub, kch.scope.station, kch.scope.team], ["aso", "MY", "MAA", "operation", "sarawak", "KCH", "ALPHA"]);
  assert.deepEqual([bki.roleCode, bki.scope.aoc, bki.scope.membership, bki.scope.department, bki.scope.hub, bki.scope.station, bki.scope.team], ["aso", "MY", "MAA", "operation", "sabah", "BKI", "ALPHA"]);
  for (const a of plan) { assert.equal(a.accountStatus, "approved"); assert.match(a.caterlinkCapability, /scan denied/); assert.equal(a.icmsBridgeRowRequired, false); }
  assert.equal(buildAccountPlan().length, 36);
  assert.ok(!buildAccountPlan().some((a) => RECEIPT_ACCOUNT_LABELS.includes(a.label)));
});

test("the receipt run baseline is its own: 52 users, 18 teams, 62 migrations", () => {
  const ok = { migrations: 62, lastMigration: "20261022000001", finalMigrationCount: 1, prodInHistory: 0, authUsers: 52, profiles: 52, orgTeams: 18, buckets: 7, runAuthUsers: 0, runMetadataUsers: 0 };
  const expected = { migrations: 62, finalMigration: "20261022000001", authUsers: 52, profiles: 52, orgTeams: 18 };
  assert.doesNotThrow(() => assertPreWriteBaseline(ok, { allowExistingRun: false, expected }));
  for (const bad of [{ migrations: 61 }, { lastMigration: "20261021000001" }, { authUsers: 54 }, { orgTeams: 16 }, { runAuthUsers: 1 }]) {
    assert.throws(() => assertPreWriteBaseline({ ...ok, ...bad }, { allowExistingRun: false, expected }), /Baseline gate failed/);
  }
});

test("application code never derives scan from receipt or receipt from scan", () => {
  for (const f of ["lib/icms/auth.ts", "lib/icms/canonical.ts", "lib/icms/actions/scan.ts", "lib/avsec/auth.ts"]) {
    assert.ok(!/can_user_confirm_caterlink_receipt|confirm_hub_receipt|confirm_station_receipt/.test(read(f)), `${f} must not consult receipt capability`);
  }
});
