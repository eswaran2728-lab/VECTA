#!/usr/bin/env node
// Read-only staging discovery of the organisational hierarchy and legacy
// teams. Runs inside a READ ONLY transaction over verified TLS. Prints
// codes and aggregate counts only -- never names, emails, ids of people,
// or any record content.
//
// Usage: node --env-file=.env.local scripts/staging/discover-org-hierarchy.mjs
import { createRequire } from "node:module";
import path from "node:path";
import { buildVerifiedClientConfig } from "./lib/db-tls.mjs";

const APPROVED_REF = "ddlctzbnqewubltcavkh";
const FORBIDDEN_REF = "zsxneokqulktgnccxgkz";

const require = createRequire(import.meta.url);
function loadPg() {
  try {
    return require("pg");
  } catch {
    return require(path.resolve(import.meta.dirname, "../../supabase/tests/integration/node_modules/pg"));
  }
}
const { Client } = loadPg();

async function main() {
  const dbUrl = process.env.STAGING_DATABASE_URL;
  if (!dbUrl) throw new Error("STAGING_DATABASE_URL is not set");
  if (JSON.stringify(process.env).includes(FORBIDDEN_REF)) throw new Error("Forbidden production reference present in environment");
  const u = new URL(dbUrl);
  if (!u.hostname.includes(APPROVED_REF) && !u.username.includes(APPROVED_REF)) throw new Error("Database URL does not identify the approved staging project");

  const cfg = buildVerifiedClientConfig(dbUrl);
  const client = new Client({ connectionString: cfg.connectionString, ssl: cfg.ssl });
  await client.connect();
  const out = {};
  try {
    await client.query("BEGIN READ ONLY");
    const q = async (sql) => (await client.query(sql)).rows;

    out.counts = {};
    for (const t of ["aocs", "operating_entities", "departments", "units", "hubs", "org_stations", "org_teams", "teams", "station_teams", "stations"]) {
      const exists = (await q(`select to_regclass('public.${t}') is not null as e`))[0].e;
      out.counts[t] = exists ? (await q(`select count(*)::int n from public.${t}`))[0].n : "table absent";
    }
    out.aocs = await q("select code, is_active from public.aocs order by code");
    out.operating_entities = await q("select code from public.operating_entities order by code");
    out.departments = await q("select a.code aoc, d.code from public.departments d join public.aocs a on a.id = d.aoc_id order by 1, 2");
    out.units = await q("select d.code department, u.code from public.units u join public.departments d on d.id = u.department_id order by 1, 2");
    out.hubs = await q("select code from public.hubs order by code");
    out.org_stations = await q("select s.code station, h.code hub from public.org_stations s join public.hubs h on h.id = s.hub_id order by 2, 1");
    out.legacy_teams = await q("select code from public.teams order by code");
    out.legacy_station_teams = await q("select station, team, active from public.station_teams order by station, team");
    out.profile_station_team_distribution = await q(
      "select coalesce(station,'(none)') station, coalesce(team,'(none)') team, count(*)::int n from public.profiles group by 1,2 order by 1,2"
    );
    out.caterlink_capable_stations = (await q(
      "select s.code from public.caterlink_station_capabilities c join public.org_stations s on s.id = c.station_id order by s.code"
    )).map((r) => r.code);
    out.stations_without_caterlink_capability = (await q(
      "select s.code from public.org_stations s where s.id not in (select station_id from public.caterlink_station_capabilities where station_id is not null) order by s.code"
    )).map((r) => r.code);
    out.org_team_references = (await q(
      "select count(*) filter (where org_team_id is not null)::int profiles_with_org_team, count(*) filter (where org_station_id is not null)::int profiles_with_org_station from public.profiles"
    ))[0];
    out.team_scoped_assignments = (await q("select count(*)::int n from public.user_role_assignments where team_id is not null"))[0].n;
    await client.query("ROLLBACK");
  } finally {
    await client.end();
  }
  console.log(JSON.stringify(out, null, 2));
  console.log("\nRead-only: no record was created, modified or deleted.");
}

main().catch((err) => {
  console.error("FATAL:", String(err.message).replace(/postgres(ql)?:\/\/[^@\s]+@/g, "postgres://[REDACTED]@"));
  process.exit(1);
});
