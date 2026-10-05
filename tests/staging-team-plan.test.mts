import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ALL_ROLE_CODES, resolveRoleScope } from "../scripts/staging/lib/role-matrix.mjs";
import {
  APPROVED_TEAMS, STATION_HUB, NO_CATERLINK_STATION, TeamNotEstablishedError,
  buildAccountPlan, summarizePlan, needsTeam, describeRoleScope, legacyProfileFor,
} from "../scripts/staging/lib/team-plan.mjs";
import { SEEDED_STATIONS, OPERATIONAL_TEAM_NAMES } from "../scripts/staging/lib/team-constants.mjs";

const REPO = path.resolve(import.meta.dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");

test("account inventory: exactly 36 accounts -- 23 base + 7 variants + 6 negatives, no foreign-AOC", () => {
  assert.deepEqual(summarizePlan(), { base: 23, stationVariants: 7, negative: 6, total: 36, readyNow: 16, needsTeamSeed: 20, needTeamId: 20 });
  const plan = buildAccountPlan();
  assert.equal(ALL_ROLE_CODES.length, 23);
  assert.equal(new Set(plan.map((a) => a.label)).size, 36, "every account label is unique");
  assert.ok(!plan.some((a) => /foreign/i.test(a.label) || a.accountStatus === "foreign_aoc"), "no foreign-AOC account");
  assert.ok(plan.every((a) => a.scope.aoc === "MY" || a.scope.aoc === null), "Malaysia AOC only");
});

test("account matrix: every account states membership, login state, workspace, allowed and denied features", () => {
  const protectedRoles = ["airasia_management", "ghod", "global_reporting_controller", "super_admin", "maa_boss", "maa_admin", "aax_boss", "aax_admin", "operation_manager", "main_enforcement", "compliance", "caterlink_management"];
  for (const a of buildAccountPlan()) {
    assert.equal(typeof a.membershipRequired, "boolean", a.label);
    assert.ok(a.loginState && a.workspace, a.label);
    assert.ok(Array.isArray(a.allowed) && Array.isArray(a.denied) && a.denied.length > 0, a.label);
    assert.equal(a.membershipRequired, !protectedRoles.includes(a.roleCode), a.label);
  }
  const negatives = buildAccountPlan().filter((a) => a.kind === "negative");
  assert.deepEqual(negatives.map((a) => a.accountStatus), ["pending", "rejected", "deactivated", "revoked", "expired", "future_dated"]);
  for (const n of negatives) assert.ok(/pending-approval/.test(n.workspace), `${n.label} must land on the status page, never a workspace`);
});

test("base and station-variant accounts never duplicate one another (distinct role+station+team)", () => {
  const seen = new Set<string>();
  for (const a of buildAccountPlan().filter((x) => x.kind !== "negative")) {
    const key = [a.roleCode, a.scope.station, a.scope.team].join("|");
    assert.ok(!seen.has(key), `duplicate account scope: ${key}`);
    seen.add(key);
  }
});

test("legacy compatibility fields follow the canonical mapping and scope (display only)", () => {
  assert.deepEqual(legacyProfileFor("operation_manager", describeRoleScope("operation_manager")), { role: "MANAGEMENT", station: null, team: null });
  assert.deepEqual(legacyProfileFor("aso", describeRoleScope("aso", { stationCode: "JHB" })), { role: "ASO", station: "JHB", team: "ALPHA" });
  assert.deepEqual(legacyProfileFor("ghod", describeRoleScope("ghod")), { role: "ASO", station: null, team: null });
});

test("account inventory: exactly the roles that need team_id are team-scoped", () => {
  const teamRoles = ALL_ROLE_CODES.filter(needsTeam).sort();
  assert.deepEqual(teamRoles, ["aso", "dse", "profiling_aso", "profiling_so", "sat_aso", "so", "sso"]);
  for (const a of buildAccountPlan()) {
    assert.equal(a.scope.team !== null || a.scope.station === null || !needsTeam(a.roleCode) || a.status === "blocked_team_not_established", true);
  }
});

test("team scope shapes match the Phase 3 scope-shape trigger for every planned account", () => {
  for (const a of buildAccountPlan()) {
    const s = a.scope;
    const r = a.roleCode;
    if (["airasia_management", "ghod", "global_reporting_controller", "super_admin"].includes(r)) {
      assert.deepEqual([s.aoc, s.entity, s.department, s.unit, s.hub, s.station, s.team], [null, null, null, null, null, null, null], r);
    } else if (r === "hub_se") {
      assert.ok(s.hub && !s.station && !s.team && !s.unit, "hub_se is hub-wide: no station/team");
    } else if (r.startsWith("investigation_")) {
      assert.ok(s.unit === "investigation" && !s.hub && !s.station && !s.team);
    } else if (needsTeam(r)) {
      assert.ok(s.station && s.hub, `${a.label} needs hub+station`);
      assert.equal(s.hub, STATION_HUB[s.station as string], `${a.label} station/hub must agree`);
    }
    if (r === "sat_aso" || r === "dse") assert.equal(s.hub, "kul", `${r} is KUL-hub only`);
    if (a.scope.team) {
      assert.ok(APPROVED_TEAMS.some((t) => t.station === s.station && t.name === s.team), `${a.label}: team must be an approved team at ITS OWN station`);
    }
  }
});

test("approved teams: exactly 16 rows -- the four operational names separately at each of four stations", () => {
  assert.equal(APPROVED_TEAMS.length, 16);
  assert.deepEqual(SEEDED_STATIONS, ["KUL - MAA", "PEN", "JHB", "BTU"]);
  assert.deepEqual(OPERATIONAL_TEAM_NAMES, ["ALPHA", "BRAVO", "CHARLIE", "DELTA"]);
  assert.equal(new Set(APPROVED_TEAMS.map((t) => `${t.station}|${t.name}`)).size, 16, "unique per station and team");
  for (const st of SEEDED_STATIONS) assert.deepEqual(APPROVED_TEAMS.filter((t) => t.station === st).map((t) => t.name), OPERATIONAL_TEAM_NAMES);
  assert.ok(!APPROVED_TEAMS.some((t) => /QA|UAT/i.test(t.name)), "no QA or generic UAT team");
  const legacySeed = read("supabase/migrations/avsec/0001_init_schema.sql");
  for (const name of OPERATIONAL_TEAM_NAMES) assert.ok(legacySeed.includes(`'${name}', '${name}'`), `${name} must be in the legacy teams seed`);
  assert.ok(read("supabase/migrations/20260928000001_phase2_org_foundation.sql").includes('"ALPHA" at PEN and "ALPHA" at'));
  assert.ok(read("supabase/migrations/20260928000002_phase3_role_permission_foundation.sql").includes("team_id does not belong to the assignment station_id"));
});

test("station/hub mapping used by the plan matches the Phase 2 station seed", () => {
  const phase2 = read("supabase/migrations/20260928000001_phase2_org_foundation.sql");
  for (const [station, hub] of Object.entries(STATION_HUB)) {
    assert.match(phase2, new RegExp(`\\('${hub}', '${station}',`), `${station} must seed under hub ${hub}`);
  }
  assert.equal(NO_CATERLINK_STATION, "BTU");
});

test("no staging script invents or auto-creates teams", () => {
  const dir = path.join(REPO, "scripts", "staging");
  for (const f of fs.readdirSync(dir, { recursive: true }) as string[]) {
    if (!f.endsWith(".mjs")) continue;
    const src = fs.readFileSync(path.join(dir, f), "utf8");
    assert.ok(!/UAT-\$\{|["']UAT-[a-z-]+["']/.test(src.replace(/user_metadata[^\n]*|`UAT \$\{label\}`[^\n]*|`UAT-\$\{label\}`[^\n]*/g, "")), `${f} must not create UAT-* teams`);
  }
  const rm = read("scripts/staging/lib/role-matrix.mjs");
  assert.ok(!/from\("org_teams"\)\s*\.upsert|\.upsert\(\{ station_id/.test(rm), "role-matrix must not upsert org_teams");
  const prov = read("scripts/staging/provision-test-accounts.mjs");
  assert.ok(!/from\("org_teams"\)/.test(prov), "provisioning must not touch org_teams");
});

test("seed tool: dry-run default, explicit flags, staging-only, transactional with verification before commit", () => {
  const src = read("scripts/staging/seed-org-teams.mjs");
  for (const needle of [
    'const apply = args.includes("--apply")',
    "--confirm=seed-approved-teams",
    'APPROVED_STAGING_REF = "ddlctzbnqewubltcavkh"',
    "Forbidden production reference",
    "buildVerifiedClientConfig(dbUrl)",
    "decryptBackupPayload",
    "EXPECTED_MIGRATIONS = 59",
    "must resolve exactly once",
    "on conflict (station_id, name) do nothing",
    "select s.id, $2 from public.org_stations s where s.code = $1",
    'await client.query("ROLLBACK")',
  ]) assert.ok(src.includes(needle), `seed tool must contain: ${needle}`);
  assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(src), "no hardcoded UUIDs");
  const begin = src.indexOf('"BEGIN"');
  const verify = src.indexOf("Expected exactly 16 org_teams rows after seeding");
  const commit = src.indexOf('"COMMIT"');
  assert.ok(begin > 0 && begin < verify && verify < commit, "verification must run inside the transaction before COMMIT");
  assert.equal((src.match(/insert into /gi) ?? []).length, 1, "the only write is the org_teams insert");
  assert.ok(!/\b(update|delete from|truncate|drop|alter)\b\s+(public\.)?(profiles|teams|station_teams|user_role_assignments|auth)/i.test(src));
});

// ---- resolveRoleScope against a fake client: never creates a team ----
function fakeClient(opts: { teamRows: Array<{ station_id: string; name: string; id: string }> }) {
  const calls: string[] = [];
  const stations: Record<string, { id: string; code: string; hub_id: string; hubs: { code: string } }> = {
    "KUL - MAA": { id: "s-kul", code: "KUL - MAA", hub_id: "h-kul", hubs: { code: "kul" } },
    PEN: { id: "s-pen", code: "PEN", hub_id: "h-north", hubs: { code: "northern" } },
    BKI: { id: "s-bki", code: "BKI", hub_id: "h-sabah", hubs: { code: "sabah" } },
  };
  const client = {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = (k: string, v: unknown) => { filters[k] = v; return q; };
      q.upsert = () => { calls.push(`upsert:${table}`); return q; };
      q.insert = () => { calls.push(`insert:${table}`); return q; };
      const resolve = () => {
        if (table === "aocs") return { data: { id: "aoc-my", code: "MY" }, error: null };
        if (table === "departments") return { data: { id: `d-${filters.code}` }, error: null };
        if (table === "units") return { data: { id: `u-${filters.code}` }, error: null };
        if (table === "org_stations") return { data: stations[filters.code as string] ?? null, error: null };
        if (table === "org_teams") return { data: opts.teamRows.find((t) => t.station_id === filters.station_id && t.name === filters.name) ?? null, error: null };
        return { data: null, error: null };
      };
      q.single = async () => resolve();
      q.maybeSingle = async () => resolve();
      return q;
    },
  };
  return { client, calls };
}

test("resolveRoleScope: missing team row throws TeamNotEstablishedError and writes nothing", async () => {
  const { client, calls } = fakeClient({ teamRows: [] });
  await assert.rejects(() => resolveRoleScope(client, "dse"), (e: Error) => e instanceof TeamNotEstablishedError && /seed-org-teams/.test(e.message));
  assert.deepEqual(calls, []);
});

test("resolveRoleScope: a station outside the approved four is refused, not invented", async () => {
  const { client, calls } = fakeClient({ teamRows: [] });
  await assert.rejects(() => resolveRoleScope(client, "aso", { stationCode: "BKI" }), (e: Error) => e instanceof TeamNotEstablishedError && /No team is approved/.test(e.message));
  assert.deepEqual(calls, []);
});

test("resolveRoleScope: PEN resolves its own approved ALPHA team once seeded", async () => {
  const { client } = fakeClient({ teamRows: [{ station_id: "s-pen", name: "ALPHA", id: "t-pen-alpha" }] });
  const scope = await resolveRoleScope(client, "aso");
  assert.deepEqual([scope.station_id, scope.team_id], ["s-pen", "t-pen-alpha"]);
});

test("resolveRoleScope: an existing established team resolves to its own station", async () => {
  const { client, calls } = fakeClient({ teamRows: [{ station_id: "s-kul", name: "ALPHA", id: "t-kul-alpha" }] });
  const scope = await resolveRoleScope(client, "dse");
  assert.equal(scope.team_id, "t-kul-alpha");
  assert.equal(scope.station_id, "s-kul");
  assert.equal(scope.hub_id, "h-kul");
  assert.deepEqual(calls, []);
});

test("describeRoleScope: station override is honoured and team follows the station", () => {
  assert.equal(describeRoleScope("so", { stationCode: "KUL - MAA" }).team, "ALPHA");
  assert.equal(describeRoleScope("so", { stationCode: "JHB" }).team, "ALPHA");
  assert.equal(describeRoleScope("so", { stationCode: "BKI" }).team, null, "an unapproved station has no team");
});
