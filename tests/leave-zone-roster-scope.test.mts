import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { accessHasAnyRoleCode, ROSTER_MANAGER_ROLE_CODES, ZONE_ADMIN_ROLE_CODES } from "../lib/auth/role-gates.ts";
import { deriveCanonicalAccess } from "../lib/auth/canonical-access.ts";
import { COMPAT_ROLE_BY_CANONICAL } from "../lib/auth/compat-role-map.mjs";
import {
  MIGRATIONS, PRE_COUNT, LAST_PRE, POST_COUNT, POST_LAST, LIVE_PHRASE, PRE_STATE, EXPECTED_PROBES,
  statementAudit, verifyFrozenMigrations, orderingGate, normalisedSha256, productionGate,
} from "../scripts/staging/apply-leave-zone-scope-migration.mjs";
import { EXPECTED_MIGRATION_COUNT, EXPECTED_LATEST_MIGRATION } from "../scripts/staging/lib/expected-baseline.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const MIG_DIR = path.join(ROOT, "supabase", "migrations");
const MIGRATION_FILE = `${MIGRATIONS[0].version}_${MIGRATIONS[0].name}.sql`;
const RUNNER = read("scripts/staging/apply-leave-zone-scope-migration.mjs");

const access = (...roles: string[]) =>
  deriveCanonicalAccess(roles.map((roleCode) => ({ roleCode, roleCategory: "operational", aocCode: "MY", operatingEntityCode: null, departmentCode: null, unitCode: null, hubCode: null, stationCode: null, teamName: null, startsAt: null, endsAt: null }) as never));

// ---------------------------------------------------------------------------------------------------------------------
// Canonical role gates (application layer)
// ---------------------------------------------------------------------------------------------------------------------

test("roster write gate: Operation Manager, Hub SE and DSE by canonical assignment; everyone else denied", () => {
  for (const r of ["operation_manager", "hub_se", "dse"]) assert.equal(accessHasAnyRoleCode(access(r), ROSTER_MANAGER_ROLE_CODES), true, r);
  for (const r of ["aso", "so", "sso", "main_enforcement", "maa_admin", "aax_admin", "compliance", "ghod", "caterlink_management", "profiling_aso", "sat_aso"]) {
    assert.equal(accessHasAnyRoleCode(access(r), ROSTER_MANAGER_ROLE_CODES), false, r);
  }
});

test("roster gate no longer rides on the compat rank: Hub SE is named explicitly (hub_se maps onto the DSE rank, so a rank list could not say it)", () => {
  assert.equal(COMPAT_ROLE_BY_CANONICAL.hub_se, "DSE", "the compat rank is a coincidence, not the authority");
  const actions = read("lib/avsec/duty/roster-actions.ts");
  assert.equal((actions.match(/await requireCanonicalRole\(ROSTER_MANAGER_ROLE_CODES\);/g) ?? []).length, 3, "cell write, cell clear and team schedule range");
  assert.doesNotMatch(actions, /requireRole\(\[\.\.\.ADMIN_ROLES, "DSE"\]\)/);
  // global schedule presets and team creation stay Operation-Manager-level
  assert.match(actions, /export async function createShift[\s\S]*?await requireRole\(ADMIN_ROLES\);/);
  assert.match(actions, /export async function deleteShift[\s\S]*?await requireRole\(ADMIN_ROLES\);/);
});

test("zone gate: Operation Manager only, by canonical assignment (page and both write actions)", () => {
  assert.deepEqual([...ZONE_ADMIN_ROLE_CODES], ["operation_manager"]);
  assert.equal(accessHasAnyRoleCode(access("operation_manager"), ZONE_ADMIN_ROLE_CODES), true);
  for (const r of ["dse", "hub_se", "so", "aso", "main_enforcement", "maa_admin"]) assert.equal(accessHasAnyRoleCode(access(r), ZONE_ADMIN_ROLE_CODES), false, r);
  const actions = read("lib/avsec/duty/zone-actions.ts");
  assert.equal((actions.match(/await requireCanonicalRole\(ZONE_ADMIN_ROLE_CODES\);/g) ?? []).length, 2, "upsert and activate/deactivate");
  assert.doesNotMatch(actions, /ADMIN_ROLES/);
  assert.match(read("app/(avsec)/avsec/admin/zones/page.tsx"), /await requireCanonicalRole\(ZONE_ADMIN_ROLE_CODES\);/);
});

test("a revoked-only, empty or super-admin identity never passes a canonical gate", () => {
  assert.equal(accessHasAnyRoleCode(access(), ROSTER_MANAGER_ROLE_CODES), false);
  assert.equal(accessHasAnyRoleCode(access("super_admin", "operation_manager"), ZONE_ADMIN_ROLE_CODES), false, "super admin never works operational routes");
});

test("zones stay readable for check-in: the read page and policy are untouched", () => {
  assert.match(read("app/(avsec)/avsec/duty/zones/page.tsx"), /requireAttendanceProfile\(\)/);
  const sql = read(`supabase/migrations/${MIGRATION_FILE}`).replace(/--.*$/gm, "");
  assert.doesNotMatch(sql, /duty_zones_scoped_read/);
  assert.doesNotMatch(sql, /canon_station_visible/);
});

test("the legacy leave-review fallback is station AND team scoped for a DSE (canonical accounts use the secure RPC)", () => {
  const a = read("lib/avsec/duty/absence-actions.ts");
  assert.match(a, /isDSE && !isOrgWide && \(!notice\.station \|\| !notice\.team \|\| notice\.station !== profile\.station \|\| notice\.team !== profile\.team\)/);
  assert.match(a, /review_leave_request_secure|reviewLeaveRequestSecure/);
});

test("handover summary: the station id is a server-side reference read (signed-in users cannot read org_stations)", () => {
  const src = read("lib/avsec/duty/handover-queries.ts");
  assert.match(src, /createAdminClient\(\)\.from\("org_stations"\)\.select\("id"\)\.eq\("code", station\)/);
  assert.match(src, /supabase\s*\.from\("transactions"\)/, "movements are still read with the caller's own session");
});

// ---------------------------------------------------------------------------------------------------------------------
// The migration and its guarded runner
// ---------------------------------------------------------------------------------------------------------------------

test("migration: DSE leave by station AND team, Operation Manager and Main Enforcement kept, zone writes Operation Manager only, nothing else touched", () => {
  const sql = read(`supabase/migrations/${MIGRATION_FILE}`).replace(/--.*$/gm, "");
  assert.match(sql, /create or replace function public\.canon_dse_of_team\(p_station text, p_team text\)/);
  assert.match(sql, /a\.role_code = 'dse'\s+and a\.station_code = p_station\s+and upper\(coalesce\(a\.team_name, ''\)\) = upper\(p_team\)/);
  assert.match(sql, /p_station is not null\s+and p_team is not null/, "a notice with no station or no team is never a DSE's");
  const select = sql.slice(sql.indexOf("create policy absence_notices_select_elevated"), sql.indexOf("drop policy absence_notices_dse_management_update"));
  assert.match(select, /canon_has_role\(array\['operation_manager', 'main_enforcement'\]\)/);
  assert.match(select, /canon_dse_of_team\(absence_notices\.station, absence_notices\.team\)/);
  const update = sql.slice(sql.indexOf("create policy absence_notices_dse_management_update"), sql.indexOf("drop policy duty_zones_admin_insert"));
  assert.doesNotMatch(update, /main_enforcement/, "Main Enforcement keeps its separate authority: read, not table updates");
  for (const op of ["insert", "update", "delete"]) {
    const p = sql.slice(sql.indexOf(`create policy duty_zones_admin_${op}`));
    const body = p.slice(0, p.indexOf(";"));
    assert.match(body, /canon_has_role\(array\['operation_manager'\]\)/, op);
    assert.doesNotMatch(body, /dse|hub_se|canon_can_admin_station/, op);
  }
  assert.doesNotMatch(sql, /\b(truncate|delete\s+from|alter\s+table|insert\s+into|update\s+public)\b/i);
  assert.doesNotMatch(sql, /can_manage_roster_secure|team_rosters/, "roster hub isolation already lives in the database and is not rewritten");
});

test("runner: frozen SHA, allow-list, ordering, baseline and live phrase", () => {
  const files = verifyFrozenMigrations((f) => fs.readFileSync(path.join(MIG_DIR, f)));
  assert.equal(files.length, 1);
  assert.equal(normalisedSha256(fs.readFileSync(path.join(MIG_DIR, MIGRATION_FILE))), MIGRATIONS[0].sha256);
  orderingGate(fs.readdirSync(MIG_DIR));
  assert.equal(PRE_COUNT, 101);
  assert.equal(LAST_PRE, "20261127000001");
  assert.equal(POST_COUNT, PRE_COUNT + 1);
  assert.equal(POST_LAST, "20261128000001");
  assert.equal(LIVE_PHRASE, "APPLY 20261128000001 TO STAGING ddlctzbnqewubltcavkh");
  assert.ok(Object.values(PRE_STATE).every((v) => typeof v === "string" && v.length === 32));
  assert.ok(EXPECTED_PROBES >= 0);
  // the certified staging baseline is the post-state once rolled out
  assert.ok(EXPECTED_MIGRATION_COUNT === PRE_COUNT || EXPECTED_MIGRATION_COUNT === POST_COUNT);
  assert.ok(EXPECTED_LATEST_MIGRATION === LAST_PRE || EXPECTED_LATEST_MIGRATION === POST_LAST);
});

test("runner: anything beyond the reviewed statements, or a weakened policy, is rejected before it can run", () => {
  const good = read(`supabase/migrations/${MIGRATION_FILE}`);
  assert.equal(statementAudit(good), null);
  assert.match(String(statementAudit(`${good}\ndelete from public.duty_zones;`)), /delete from/);
  assert.match(String(statementAudit(`${good}\ndrop table public.absence_notices;`)), /drop table/);
  assert.match(String(statementAudit(`${good}\ncreate policy duty_zones_scoped_read on public.duty_zones for select to authenticated using (true);`)), /create policy duty_zones_scoped_read/);
  // a zone write policy that lets a DSE back in
  assert.match(String(statementAudit(good.replace("with check (public.canon_has_role(array['operation_manager']));\n\ndrop policy duty_zones_admin_update", "with check (public.canon_has_role(array['operation_manager', 'dse']));\n\ndrop policy duty_zones_admin_update"))), /not Operation-Manager-only/);
  // a leave policy that falls back to station-only
  assert.match(String(statementAudit(good.replace(/public\.canon_dse_of_team\(absence_notices\.station, absence_notices\.team\)/g, "public.canon_has_role_at_station(array['dse'], absence_notices.station)"))), /team-scoped DSE function/);
  // Main Enforcement losing its read authority
  assert.match(String(statementAudit(good.replace("'operation_manager', 'main_enforcement'", "'operation_manager'"))), /Main Enforcement/);
});

test("runner: production refused, TLS verified, exact phrase, dry run first, backup gates, no secrets printed", () => {
  assert.throws(() => productionGate({ X: "zsxneokqulktgnccxgkz" }, []), /production reference/);
  assert.match(RUNNER, /connectVerified\(\)/);
  assert.match(RUNNER, /if \(LIVE && argVal\("confirm"\) !== LIVE_PHRASE\) fail\("the live phase needs the exact confirmation phrase"\)/);
  assert.match(RUNNER, /await pass\(false\);\n  log\("dry run rolled back"\);/);
  assert.match(RUNNER, /fresh backup is older than 6 hours/);
  assert.match(RUNNER, /fresh backup is inside the repository/);
  assert.doesNotMatch(RUNNER, /console\.log\([^)]*(PASSWORD|SECRET|TOKEN|STAGING_DATABASE_URL)/i);
});

test("runner probes: another team at the same station, another station, another hub, ordinary staff zone reads and check-in, Operation Manager oversight", () => {
  for (const needle of [
    "const N2 = await mkNotice(\"sso-kul\", \"KUL - MAA\", \"BRAVO\"); // another team at the same station",
    "const N3 = await mkNotice(\"aso\", \"PEN\", \"ALPHA\"); // another station (and hub)",
    "the leave defect was not reproduced on the pre-state",
    "the zone defect was not reproduced on the pre-state",
    "DSE reads only its own station AND team",
    "Operation Manager and Main Enforcement still read every notice",
    "only the Operation Manager succeeds; a DSE of the station, a Hub SE of the hub, ordinary staff and Main Enforcement are refused",
    "check-in still works: ASO and SO at KUL - MAA read the station's zones",
    "Hub SE is authorized for stations of its assigned hub (PEN) and refused JHB and KUL - MAA",
    "not BRAVO at the same station or another station",
    "the probe fixtures (five leave notices, one zone, no roster rows) were removed exactly",
  ]) assert.ok(RUNNER.includes(needle), needle);
});
