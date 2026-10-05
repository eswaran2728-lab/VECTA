#!/usr/bin/env node
// Idempotent seeding of the ESTABLISHED org_teams rows (lib/team-constants.mjs:
// ALPHA/BRAVO/CHARLIE/DELTA at 'KUL - MAA' -- sourced from the legacy teams
// seed, the Phase 2 migration and live station_teams). Never invents a team.
//
// Defaults to a dry run that makes no network call. --apply is required to
// write, and additionally requires --confirm=seed-established-teams and the
// shared staging guard (lib/env-guard.mjs). Existing rows are never modified.
//
// Usage:
//   node scripts/staging/seed-org-teams.mjs
//   node --env-file=.env.local scripts/staging/seed-org-teams.mjs --apply --confirm=seed-established-teams
import { resolveStagingAdminContext, printProjectIdentity } from "./lib/env-guard.mjs";
import { ESTABLISHED_TEAMS } from "./lib/team-constants.mjs";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const confirmed = args.includes("--confirm=seed-established-teams");

async function main() {
  console.log(`=== org_teams seed (${apply ? "APPLY" : "DRY RUN"}) ===`);
  console.log("Established rows to ensure (station / team):");
  for (const t of ESTABLISHED_TEAMS) console.log(`  - ${t.station} / ${t.name}`);

  if (!apply) {
    console.log("\nDry run: no network call made, nothing written.");
    return;
  }
  if (!confirmed) throw new Error("Refusing to apply without --confirm=seed-established-teams.");

  const ctx = resolveStagingAdminContext();
  printProjectIdentity(ctx);
  const { client } = ctx;

  let inserted = 0;
  let existing = 0;
  for (const t of ESTABLISHED_TEAMS) {
    const { data: station, error: stationError } = await client.from("org_stations").select("id").eq("code", t.station).maybeSingle();
    if (stationError || !station) throw new Error(`Station '${t.station}' not found; refusing to continue.`);
    const { data: found } = await client.from("org_teams").select("id").eq("station_id", station.id).eq("name", t.name).maybeSingle();
    if (found) {
      existing += 1;
      console.log(`  EXISTS   ${t.station} / ${t.name}`);
      continue;
    }
    const { error } = await client.from("org_teams").insert({ station_id: station.id, name: t.name });
    if (error) throw new Error(`Insert failed for ${t.station} / ${t.name}: ${error.message}`);
    inserted += 1;
    console.log(`  INSERTED ${t.station} / ${t.name}`);
  }
  console.log(`\nDone: ${inserted} inserted, ${existing} already existed.`);
}

main().catch((err) => {
  console.error("FATAL:", err.message);
  process.exit(1);
});
