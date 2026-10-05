import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { assignmentsFromRpcRows, deriveCanonicalAccess, NO_CANONICAL_ACCESS } from "../lib/auth/canonical-access.ts";
import { decideCheckpointAccess } from "../lib/icms/canonical.ts";
import { ALL_ROLE_CODES } from "../scripts/staging/lib/role-matrix.mjs";
import { SCAN_ENABLED_STATIONS, buildAccountPlan } from "../scripts/staging/lib/team-plan.mjs";

const REPO = path.resolve(import.meta.dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");
const MIG = read("supabase/migrations/20261021000001_phase9_caterlink_scan_authorization_correction.sql");
const strip = (s: string) => s.replace(/--[^\n]*/g, "");

const SCAN_ROLES = ["sso", "so", "aso", "dse"];
const STATIONED = [...SCAN_ROLES, "hub_se", "sat_aso", "profiling_so", "profiling_aso"];
const STATIONS = ["PEN", "JHB", "KUL - MAA", "KCH", "BKI", "BTU"];
const row = (code: string, station: string | null) => ({
  role_code: code, role_category: "x", aoc_code: null, operating_entity_code: null, department_code: null, unit_code: null,
  hub_code: null, station_code: station, team_name: station ? "ALPHA" : null, starts_at: "2026-01-01T00:00:00Z", ends_at: null,
});
// The database answers the station capability: scanning is enabled at PEN and JHB only.
const stationCanScan = (st: string) => SCAN_ENABLED_STATIONS.includes(st);

test("decision table: every role x station -- only sso/so/aso/dse at PEN or JHB may scan", () => {
  assert.deepEqual([...SCAN_ENABLED_STATIONS].sort(), ["JHB", "PEN"]);
  for (const role of ALL_ROLE_CODES) {
    for (const st of STATIONS) {
      const access = deriveCanonicalAccess(assignmentsFromRpcRows([row(role, STATIONED.includes(role) ? st : null)]));
      const decision = decideCheckpointAccess(access, stationCanScan(st));
      const expected = SCAN_ROLES.includes(role) && SCAN_ENABLED_STATIONS.includes(st);
      assert.equal(decision.allowed, expected, `${role} @ ${st}`);
    }
  }
});

test("explicit denials: hub_se, operation_manager, main_enforcement, caterlink_management, compliance, investigation, SAT, profiling, entity/global/super, no assignment", () => {
  const denied = ["hub_se", "operation_manager", "main_enforcement", "caterlink_management", "compliance", "investigation_sso", "investigation_so", "investigation_aso",
    "sat_aso", "profiling_so", "profiling_aso", "maa_boss", "maa_admin", "aax_boss", "aax_admin", "airasia_management", "ghod", "global_reporting_controller", "super_admin"];
  for (const role of denied) {
    for (const st of ["PEN", "JHB"]) {
      const access = deriveCanonicalAccess(assignmentsFromRpcRows([row(role, st)]));
      assert.equal(decideCheckpointAccess(access, true).allowed, false, `${role} @ ${st}`);
    }
  }
  assert.equal(decideCheckpointAccess(NO_CANONICAL_ACCESS, true).allowed, false);
});

test("a station without the scan capability denies every operator, and an unknown capability fails closed", () => {
  for (const role of SCAN_ROLES) {
    const access = deriveCanonicalAccess(assignmentsFromRpcRows([row(role, "PEN")]));
    for (const cap of [false, null, undefined] as const) assert.equal(decideCheckpointAccess(access, cap).allowed, false, role);
  }
});

test("the 36-account plan documents scanning only for sso/so/aso at PEN and JHB", () => {
  for (const a of buildAccountPlan()) {
    const eligible = a.positiveOrNegative === "positive" && SCAN_ROLES.includes(a.roleCode) && SCAN_ENABLED_STATIONS.includes(a.scope.station);
    assert.equal(/^scan\/movement allowed/.test(a.caterlinkCapability), eligible, `${a.label}: ${a.caterlinkCapability}`);
  }
});

// ---------------- migration (static) ----------------
test("migration: identity from auth.uid(), approved profile, strict roles, exact station, no bypass", () => {
  const sql = strip(MIG);
  assert.match(sql, /v_uid uuid := auth\.uid\(\)/);
  assert.match(sql, /p\.status = 'approved'/);
  assert.match(sql, /rd\.code in \('sso', 'so', 'aso', 'dse'\)/);
  assert.match(sql, /ura\.station_id = v_station_id/);
  assert.match(sql, /rd\.is_active/);
  assert.match(sql, /ura\.revoked_at is null/);
  assert.match(sql, /p_station_code not in \('PEN', 'JHB'\)/);
  assert.match(sql, /check_station_caterlink_capability\(v_aoc_id, p_station_code, 'scan'\)/);
  const start = sql.indexOf("create or replace function public.can_user_scan_caterlink(");
  const fn = sql.slice(start, sql.indexOf("revoke execute on function public.can_user_scan_caterlink(text, uuid)"));
  assert.ok(!/hub_se|operation_manager|main_enforcement|caterlink_management|super_admin|ops_group|current_role_name|'ADMIN'/.test(fn), "no management / compat / legacy bypass inside the function");
  assert.ok(!/p_profile_id/.test(fn), "no caller-supplied identity");
  assert.match(sql, /drop function if exists public\.can_user_scan_caterlink\(uuid, uuid, text\)/);
  assert.match(sql, /drop function if exists public\.can_user_scan_caterlink\(uuid, text\)/);
  assert.match(sql, /revoke execute on function public\.can_user_scan_caterlink\(text, uuid\) from public, anon/);
});

test("migration: scan capability is switched off everywhere except PEN and JHB and receipt flags are not touched", () => {
  const sql = strip(MIG);
  assert.match(sql, /set can_scan = false/);
  assert.match(sql, /s\.code not in \('PEN', 'JHB'\)/);
  const cfg = sql.slice(sql.indexOf("update public.caterlink_station_capabilities"), sql.indexOf("create or replace function"));
  assert.ok(!/can_confirm_hub_receipt|can_confirm_station_receipt/.test(cfg), "receipt capabilities are separate and unchanged");
  assert.ok(!/create or replace function public\.check_station_caterlink_capability|create or replace function public\.confirm_caterlink/.test(sql), "receipt and capability-check functions are not modified");
});

// ---------------- application consistency ----------------
test("every scan gate in the application uses the single database decision and never supplies an identity", () => {
  const files = ["lib/avsec/auth.ts", "lib/icms/auth.ts", "lib/icms/actions/scan.ts", "app/api/icms/qr/validate/route.ts", "app/page.tsx", "app/(icms)/icms/transactions/[id]/page.tsx"];
  for (const f of files) {
    const src = read(f);
    assert.match(src, /can_user_scan_caterlink/, f);
    assert.ok(!/p_profile_id/.test(src), `${f}: must not pass a profile id`);
  }
  const canonical = read("lib/icms/canonical.ts");
  assert.match(canonical, /STATION_OPERATOR_CODES = \["aso", "so", "sso", "dse"\]/);
});

test("receipt confirmation does not imply scanning: scan decisions never consult receipt capabilities", () => {
  for (const f of ["lib/icms/auth.ts", "lib/icms/canonical.ts", "lib/icms/actions/scan.ts"]) {
    assert.ok(!/confirm_hub_receipt|confirm_station_receipt|can_confirm/.test(read(f)), f);
  }
});
