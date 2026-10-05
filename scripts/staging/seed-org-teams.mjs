#!/usr/bin/env node
// Idempotent, transactional seeding of the 16 approved org_teams rows:
// ALPHA / BRAVO / CHARLIE / DELTA separately within each of KUL - MAA, PEN,
// JHB and BTU (lib/team-constants.mjs). No QA team, no generic UAT team, no
// other station. Station ids are resolved from org_stations.code at run
// time -- never hardcoded.
//
// Modes (default is a dry run that makes NO network call):
//   node scripts/staging/seed-org-teams.mjs
//   node --env-file=.env.local scripts/staging/seed-org-teams.mjs --preflight
//        read-only hosted checks only (identity, backups, migrations, stations, org_teams)
//   node --env-file=.env.local scripts/staging/seed-org-teams.mjs --apply --confirm=seed-approved-teams
//        one transaction; verifies everything before COMMIT; any mismatch rolls back.
//
// A second --apply is a no-op (zero rows created) and still verifies the final state.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { APPROVED_TEAMS, SEEDED_STATIONS, OPERATIONAL_TEAM_NAMES } from "./lib/team-constants.mjs";
import { buildVerifiedClientConfig } from "./lib/db-tls.mjs";
import { decryptBackupPayload } from "./lib/backup-crypto.mjs";

export const APPROVED_STAGING_REF = "ddlctzbnqewubltcavkh";
export const FORBIDDEN_PROD_REF = "zsxneokqulktgnccxgkz";
const EXPECTED_MIGRATIONS = 59;
const LAST_MIGRATION = "20261016000001";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const preflight = args.includes("--preflight");
const confirmed = args.includes("--confirm=seed-approved-teams");

const BACKUP_FILES = [
  path.join(os.tmpdir(), "vecta-staging-backups", "ddlctzbnqewubltcavkh-2026-10-02T07-59-58-492Z.enc.json"),
  path.join(os.tmpdir(), "vecta-staging-backups", "ddlctzbnqewubltcavkh-schema-history-2026-10-02.enc.json"),
];

const require = createRequire(import.meta.url);
function loadPg() {
  try {
    return require("pg");
  } catch {
    return require(path.resolve(import.meta.dirname, "../../supabase/tests/integration/node_modules/pg"));
  }
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// Fingerprint of everything this seed must NOT change.
async function protectedFingerprint(client) {
  const q = async (sql) => (await client.query(sql)).rows[0];
  return {
    authUsers: (await q("select count(*)::int n from auth.users")).n,
    profiles: (await q("select count(*)::int n from public.profiles")).n,
    profilesHash: (await q("select md5(string_agg(p::text, '|' order by id)) h from public.profiles p")).h,
    legacyTeams: (await q("select count(*)::int n, md5(string_agg(code, ',' order by code)) h from public.teams")),
    assignments: (await q("select count(*)::int n from public.user_role_assignments")).n,
    stationTeams: (await q("select count(*)::int n from public.station_teams")).n,
  };
}

async function main() {
  console.log(`=== org_teams seed (${apply ? "APPLY" : preflight ? "PREFLIGHT (read-only)" : "DRY RUN"}) ===`);
  console.log(`Approved rows (${APPROVED_TEAMS.length}): ${SEEDED_STATIONS.length} stations x ${OPERATIONAL_TEAM_NAMES.length} teams`);
  for (const station of SEEDED_STATIONS) console.log(`  ${station.padEnd(10)} ${OPERATIONAL_TEAM_NAMES.join(", ")}`);

  if (!apply && !preflight) {
    console.log("\nDry run: no network call made, nothing written.");
    return;
  }
  if (apply && !confirmed) throw new Error("Refusing to apply without --confirm=seed-approved-teams.");

  // ---- identity gates ----
  if (APPROVED_TEAMS.length !== 16) throw new Error("Approved team list must contain exactly 16 rows.");
  const dbUrl = process.env.STAGING_DATABASE_URL;
  if (!dbUrl) throw new Error("STAGING_DATABASE_URL is not set");
  if (JSON.stringify(process.env).includes(FORBIDDEN_PROD_REF)) throw new Error("Forbidden production reference present in the environment");
  const u = new URL(dbUrl);
  if (!u.hostname.includes(APPROVED_STAGING_REF) && !u.username.includes(APPROVED_STAGING_REF)) {
    throw new Error("Database URL does not identify the approved staging project");
  }
  if (process.env.VECTA_APPROVED_STAGING_PROJECT_REF && process.env.VECTA_APPROVED_STAGING_PROJECT_REF !== APPROVED_STAGING_REF) {
    throw new Error("VECTA_APPROVED_STAGING_PROJECT_REF does not match the approved staging project");
  }
  log(`Target verified as approved staging project (user=${u.username}).`);

  // ---- backups authenticate (decrypted in memory only) ----
  const passphrase = process.env.VECTA_BACKUP_PASSPHRASE;
  if (!passphrase) throw new Error("VECTA_BACKUP_PASSPHRASE is not set");
  for (const [i, file] of BACKUP_FILES.entries()) {
    if (!fs.existsSync(file)) throw new Error(`Backup file ${i + 1} not found`);
    const b = decryptBackupPayload(fs.readFileSync(file, "utf8"), passphrase);
    log(`Backup ${i + 1} authenticated (exported ${b.exportedAt}).`);
  }

  const { Client } = loadPg();
  const cfg = buildVerifiedClientConfig(dbUrl);
  const client = new Client({ connectionString: cfg.connectionString, ssl: cfg.ssl });
  try {
    await client.connect();
  } catch (err) {
    throw new Error(`Verified-TLS connection failed; refusing insecure fallback (code=${err.code ?? "UNKNOWN"}).`);
  }
  log("Connected with verified TLS (certificate + hostname verification ON).");

  try {
    // ---- read-only gates ----
    const migs = (await client.query("select version, name from supabase_migrations.schema_migrations order by version")).rows;
    if (migs.length !== EXPECTED_MIGRATIONS) throw new Error(`Expected ${EXPECTED_MIGRATIONS} migrations, found ${migs.length}`);
    const last = migs[migs.length - 1];
    if (last.version !== LAST_MIGRATION || last.name !== "phase13_storage_and_admin_workflows") throw new Error(`Unexpected last migration ${last.version}`);
    log(`Migrations: ${migs.length}; last ${last.version} (${last.name}).`);

    const stationRows = (await client.query("select code, count(*)::int n from public.org_stations where code = any($1) group by code", [SEEDED_STATIONS])).rows;
    for (const code of SEEDED_STATIONS) {
      const n = stationRows.find((r) => r.code === code)?.n ?? 0;
      if (n !== 1) throw new Error(`Station '${code}' must resolve exactly once; found ${n}`);
    }
    log(`All ${SEEDED_STATIONS.length} target stations resolve exactly once.`);

    const teamCount = (await client.query("select count(*)::int n from public.org_teams")).rows[0].n;
    const existingApproved = (
      await client.query(
        "select count(*)::int n from public.org_teams t join public.org_stations s on s.id = t.station_id where (s.code, t.name) in (select * from unnest($1::text[], $2::text[]))",
        [APPROVED_TEAMS.map((t) => t.station), APPROVED_TEAMS.map((t) => t.name)]
      )
    ).rows[0].n;
    if (teamCount !== existingApproved) throw new Error(`org_teams contains ${teamCount - existingApproved} row(s) outside the approved list; refusing to proceed`);
    if (teamCount !== 0 && teamCount !== 16) throw new Error(`org_teams has ${teamCount} row(s); expected 0 (first run) or 16 (idempotent re-run)`);
    log(`org_teams currently has ${teamCount} row(s) (all within the approved list).`);

    const before = await protectedFingerprint(client);
    log(`Protected state: authUsers=${before.authUsers}, profiles=${before.profiles}, legacy teams=${before.legacyTeams.n}, assignments=${before.assignments}.`);
    if (before.authUsers !== 16 || before.profiles !== 16) throw new Error("Expected exactly 16 Auth users and 16 profiles");

    if (!apply) {
      log("PREFLIGHT ONLY: all gates passed. Nothing was written.");
      return;
    }

    // ---- one transaction ----
    const started = Date.now();
    await client.query("BEGIN");
    try {
      let inserted = 0;
      for (const t of APPROVED_TEAMS) {
        const res = await client.query(
          "insert into public.org_teams (station_id, name) select s.id, $2 from public.org_stations s where s.code = $1 on conflict (station_id, name) do nothing returning id",
          [t.station, t.name]
        );
        inserted += res.rowCount;
      }

      // ---- verify BEFORE commit ----
      const rows = (
        await client.query(
          "select s.code station, t.name, t.station_id, s.id sid from public.org_teams t join public.org_stations s on s.id = t.station_id order by s.code, t.name"
        )
      ).rows;
      const total = (await client.query("select count(*)::int n from public.org_teams")).rows[0].n;
      if (total !== 16 || rows.length !== 16) throw new Error(`Expected exactly 16 org_teams rows after seeding, found ${total}`);
      for (const t of APPROVED_TEAMS) {
        const match = rows.filter((r) => r.station === t.station && r.name === t.name);
        if (match.length !== 1) throw new Error(`Team ${t.station}/${t.name} must exist exactly once; found ${match.length}`);
        if (match[0].station_id !== match[0].sid) throw new Error(`Team ${t.station}/${t.name} is not linked to its own station`);
      }
      const perStation = Object.fromEntries(SEEDED_STATIONS.map((s) => [s, rows.filter((r) => r.station === s).length]));
      for (const s of SEEDED_STATIONS) if (perStation[s] !== 4) throw new Error(`Station ${s} must have exactly 4 teams; found ${perStation[s]}`);
      if (rows.some((r) => /^(QA|UAT)/i.test(r.name))) throw new Error("A QA/UAT team must never be created");
      const dupes = (await client.query("select count(*)::int n from (select station_id, name from public.org_teams group by 1,2 having count(*) > 1) d")).rows[0].n;
      if (dupes !== 0) throw new Error("Duplicate (station, team) rows detected");

      const after = await protectedFingerprint(client);
      for (const key of ["authUsers", "profiles", "profilesHash", "assignments", "stationTeams"]) {
        if (after[key] !== before[key]) throw new Error(`Protected state changed: ${key}`);
      }
      if (after.legacyTeams.n !== before.legacyTeams.n || after.legacyTeams.h !== before.legacyTeams.h) throw new Error("Legacy teams changed");

      await client.query("COMMIT");
      log(`COMMITTED: ${inserted} row(s) inserted (${total} total) in ${Date.now() - started} ms. Per station: ${JSON.stringify(perStation)}.`);
    } catch (err) {
      await client.query("ROLLBACK");
      throw new Error(`Seed rolled back completely: ${err.message}`);
    }

    // ---- post-commit confirmation ----
    const final = (await client.query("select count(*)::int n from public.org_teams")).rows[0].n;
    const post = await protectedFingerprint(client);
    log(`Post-commit: org_teams=${final}, authUsers=${post.authUsers}, profiles=${post.profiles}, profiles unchanged=${post.profilesHash === before.profilesHash}, legacy teams unchanged=${post.legacyTeams.h === before.legacyTeams.h}.`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("FATAL:", String(err.message).replace(/postgres(ql)?:\/\/[^@\s]+@/g, "postgres://[REDACTED]@"));
  process.exit(1);
});
