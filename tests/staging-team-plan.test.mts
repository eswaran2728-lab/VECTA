import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ALL_ROLE_CODES, resolveRoleScope } from "../scripts/staging/lib/role-matrix.mjs";
import {
  ESTABLISHED_TEAMS, STATION_HUB, NO_CATERLINK_STATION, TeamNotEstablishedError,
  buildAccountPlan, summarizePlan, needsTeam, describeRoleScope,
} from "../scripts/staging/lib/team-plan.mjs";

const REPO = path.resolve(import.meta.dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");

test("account inventory: exact counts from current staging data", () => {
  const s = summarizePlan();
  assert.deepEqual(s, {
    base: 23, stationVariants: 7, negative: 7, totalPlanned: 37,
    readyNow: 16, needsKulTeamSeed: 11, blockedTeamNotEstablished: 9, impossibleNoSecondAoc: 1,
    creatableWithCurrentData: 36, needTeamId: 21,
  });
  assert.equal(ALL_ROLE_CODES.length, 23);
  assert.equal(new Set(buildAccountPlan().map((a) => a.label)).size, 37, "every account label is unique");
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
      assert.ok(ESTABLISHED_TEAMS.some((t) => t.station === s.station && t.name === s.team), `${a.label}: team must be an established team at ITS OWN station`);
    }
  }
});

test("teams are established only where the repository/legacy data establishes them -- nothing invented", () => {
  assert.deepEqual(ESTABLISHED_TEAMS, ["ALPHA", "BRAVO", "CHARLIE", "DELTA"].map((name) => ({ station: "KUL - MAA", name })));
  const legacySeed = read("supabase/migrations/avsec/0001_init_schema.sql");
  for (const t of ESTABLISHED_TEAMS) assert.match(legacySeed, new RegExp(`'${t.name}', '${t.name}'`), `${t.name} must be in the legacy teams seed`);
  assert.match(read("supabase/migrations/20260928000001_phase2_org_foundation.sql"), /"ALPHA" at PEN and "ALPHA" at\s*\n--\s*KUL are different rows/);
  assert.match(read("supabase/migrations/20260928000002_phase3_role_permission_foundation.sql"), /team_id does not belong to the assignment station_id/);
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

test("seed tool is idempotent-by-construction, dry-run by default, and gated", () => {
  const src = read("scripts/staging/seed-org-teams.mjs");
  assert.match(src, /const apply = args\.includes\("--apply"\)/);
  assert.match(src, /--confirm=seed-established-teams/);
  assert.match(src, /resolveStagingAdminContext\(\)/);
  assert.match(src, /\.eq\("station_id", station\.id\)\.eq\("name", t\.name\)\.maybeSingle\(\)/);
  assert.ok(!/\.delete\(|\.update\(|\.upsert\(/.test(src), "seed tool only inserts missing rows");
});

// ---- resolveRoleScope against a fake client: never creates a team ----
function fakeClient(opts: { teamRows: Array<{ station_id: string; name: string; id: string }> }) {
  const calls: string[] = [];
  const stations: Record<string, { id: string; code: string; hub_id: string; hubs: { code: string } }> = {
    "KUL - MAA": { id: "s-kul", code: "KUL - MAA", hub_id: "h-kul", hubs: { code: "kul" } },
    PEN: { id: "s-pen", code: "PEN", hub_id: "h-north", hubs: { code: "northern" } },
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

test("resolveRoleScope: a station with no established team is refused, not invented", async () => {
  const { client, calls } = fakeClient({ teamRows: [{ station_id: "s-pen", name: "ALPHA", id: "t-pen" }] });
  await assert.rejects(() => resolveRoleScope(client, "aso"), (e: Error) => e instanceof TeamNotEstablishedError && /No team is established/.test(e.message));
  assert.deepEqual(calls, []);
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
  assert.equal(describeRoleScope("so", { stationCode: "JHB" }).team, null);
});
