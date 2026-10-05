// Pre-write safety gates for the dashboard-review provisioning run. Every check throws on failure;
// nothing here prints a secret, a password or a connection string.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import child_process from "node:child_process";
import { createRequire } from "node:module";
import { decryptBackupPayload } from "./backup-crypto.mjs";
import { buildVerifiedClientConfig, describeTlsError } from "./db-tls.mjs";

export const APPROVED_REF = "ddlctzbnqewubltcavkh";
export const FORBIDDEN_REF = "zsxneokqulktgnccxgkz";
export const EXPECTED_BRANCH = "dashboard/role-workspaces-adjustment";
export const EXPECTED_REMOTE = "eswaran2728-lab/VECTA";
export const EXPECTED_MIGRATIONS = 61;
export const FINAL_MIGRATION = "20261021000001";
export const BASELINE = { authUsers: 16, profiles: 16, orgTeams: 16, buckets: 7 };
export const BACKUP_FILES = [
  "C:\\Users\\eswaranp\\AppData\\Local\\Temp\\vecta-staging-backups\\ddlctzbnqewubltcavkh-2026-10-02T07-59-58-492Z.enc.json",
  "C:\\Users\\eswaranp\\AppData\\Local\\Temp\\vecta-staging-backups\\ddlctzbnqewubltcavkh-schema-history-2026-10-02.enc.json",
];

const require = createRequire(import.meta.url);
export function loadPg() {
  try { return require("pg"); } catch { return require(path.resolve(import.meta.dirname, "../../../supabase/tests/integration/node_modules/pg")); }
}

export function emailFor(runId, label, domain) {
  return `vecta.uat.${runId}.${label}@${domain}`.toLowerCase();
}

export function defaultCredentialsDir(runId) {
  return path.join(os.tmpdir(), "vecta-staging-credentials", runId);
}

export function assertOutsideRepo(dir, repoRoot) {
  const rel = path.relative(path.resolve(repoRoot), path.resolve(dir));
  if (!rel.startsWith("..") && !path.isAbsolute(rel)) throw new Error("Credentials/manifest directory must be outside the repository.");
}

export function secureDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    if (process.platform === "win32") {
      const user = process.env.USERNAME;
      if (user) child_process.execFileSync("icacls", [dir, "/inheritance:r", "/grant:r", `${user}:(OI)(CI)F`], { stdio: "ignore" });
    } else {
      fs.chmodSync(dir, 0o700);
    }
  } catch { /* best effort; files are also created mode 0600 */ }
}

const TOOLING_PATHS = [/^scripts\/staging\//, /^tests\//, /^docs\//];

/**
 * expectedBase: the SHA the run was authorized against. HEAD must either equal it or descend from it with
 * ONLY provisioning-tooling / test / doc paths changed since (no app, migration or lib source).
 */
export function gitGates({ expectedBase, expectedRepoPath, extraAllowed = [] }) {
  const sh = (c) => child_process.execSync(c, { encoding: "utf8" }).trim();
  const root = sh("git rev-parse --show-toplevel");
  const resolved = path.resolve(root).toLowerCase();
  if (expectedRepoPath && resolved !== path.resolve(expectedRepoPath).toLowerCase()) throw new Error("Repository path is not the expected VECTA checkout.");
  const branch = sh("git branch --show-current");
  if (branch !== EXPECTED_BRANCH) throw new Error(`Branch mismatch: ${branch}`);
  const head = sh("git rev-parse HEAD");
  let toolingOnlySinceBase = true;
  if (expectedBase && head !== expectedBase) {
    try { sh(`git merge-base --is-ancestor ${expectedBase} HEAD`); } catch { throw new Error(`HEAD ${head} does not descend from the authorized base ${expectedBase}`); }
    const changed = sh(`git diff --name-only ${expectedBase} HEAD`).split(/\r?\n/).filter(Boolean);
    const outside = changed.filter((f) => ![...TOOLING_PATHS, ...extraAllowed].some((rx) => rx.test(f)));
    if (outside.length) throw new Error(`Files outside tooling/tests/docs changed since the authorized base: ${outside.slice(0, 5).join(",")}`);
    toolingOnlySinceBase = true;
  }
  if (sh("git status --porcelain")) throw new Error("Working tree is not clean.");
  const remote = sh("git remote get-url origin");
  if (!remote.includes(EXPECTED_REMOTE)) throw new Error("origin is not the expected VECTA repository.");
  return { root, branch, head, base: expectedBase ?? null, toolingOnlySinceBase, remote: EXPECTED_REMOTE };
}

export function environmentGates() {
  const env = process.env;
  if (JSON.stringify(env).includes(FORBIDDEN_REF)) throw new Error("Forbidden production reference present in the environment.");
  for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "STAGING_DATABASE_URL"]) {
    if (!env[k]) throw new Error(`${k} is not set.`);
  }
  const ref = new URL(env.NEXT_PUBLIC_SUPABASE_URL).hostname.split(".")[0];
  if (ref !== APPROVED_REF) throw new Error("Supabase URL does not resolve to the approved staging project.");
  if (env.VECTA_APPROVED_STAGING_PROJECT_REF !== APPROVED_REF) throw new Error("VECTA_APPROVED_STAGING_PROJECT_REF is not the approved staging ref.");
  const u = new URL(env.STAGING_DATABASE_URL);
  if (!u.hostname.includes(APPROVED_REF) && !u.username.includes(APPROVED_REF)) throw new Error("Database URL does not identify the approved staging project.");
  if (!(env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY)) throw new Error("Server-side Supabase secret is not available.");
  if (!env.VECTA_BACKUP_PASSPHRASE) throw new Error("VECTA_BACKUP_PASSPHRASE is not set.");
  return { projectRef: ref };
}

export function backupGates(repoRoot) {
  for (const f of BACKUP_FILES) {
    if (!fs.existsSync(f)) throw new Error(`Backup missing: ${path.basename(f)}`);
    const rel = path.relative(path.resolve(repoRoot), path.resolve(f));
    if (!rel.startsWith("..")) throw new Error("A backup lives inside the repository.");
  }
  const out = [];
  for (const f of BACKUP_FILES) {
    const b = decryptBackupPayload(fs.readFileSync(f, "utf8"), process.env.VECTA_BACKUP_PASSPHRASE);
    out.push({ file: path.basename(f), exportedAt: b.exportedAt });
  }
  return out;
}

export async function connectVerified() {
  const { Client } = loadPg();
  const cfg = buildVerifiedClientConfig(process.env.STAGING_DATABASE_URL);
  const client = new Client({ connectionString: cfg.connectionString, ssl: cfg.ssl });
  try { await client.connect(); } catch (e) { throw new Error(`Verified-TLS connection failed; no insecure fallback. ${describeTlsError(e)}`); }
  return { client, explicitCa: cfg.usedExplicitCa };
}

export async function baselineCounts(client, runId) {
  const n = async (sql, p) => parseInt((await client.query(sql, p)).rows[0].n, 10);
  const mig = (await client.query("select version, name from supabase_migrations.schema_migrations order by version")).rows;
  return {
    migrations: mig.length,
    lastMigration: mig[mig.length - 1]?.version,
    finalMigrationCount: mig.filter((m) => m.version === FINAL_MIGRATION).length,
    prodInHistory: mig.filter((m) => String(m.name).includes(FORBIDDEN_REF)).length,
    authUsers: await n("select count(*)::int n from auth.users"),
    profiles: await n("select count(*)::int n from public.profiles"),
    orgTeams: await n("select count(*)::int n from public.org_teams"),
    buckets: await n("select count(*)::int n from storage.buckets"),
    runAuthUsers: await n("select count(*)::int n from auth.users where email like $1", [`vecta.uat.${runId}.%`]),
    runMetadataUsers: await n("select count(*)::int n from auth.users where raw_user_meta_data->>'vecta_staging_run_id' = $1", [runId]),
  };
}

export function assertPreWriteBaseline(c, { allowExistingRun, expected = {} }) {
  const exp = { migrations: EXPECTED_MIGRATIONS, finalMigration: FINAL_MIGRATION, authUsers: BASELINE.authUsers, profiles: BASELINE.profiles, orgTeams: BASELINE.orgTeams, buckets: BASELINE.buckets, ...expected };
  const problems = [];
  if (c.migrations !== exp.migrations) problems.push(`migrations=${c.migrations} (expected ${exp.migrations})`);
  if (c.lastMigration !== exp.finalMigration || c.finalMigrationCount !== 1) problems.push(`final migration ${c.lastMigration} x${c.finalMigrationCount}`);
  if (c.prodInHistory) problems.push("production reference in migration history");
  if (!allowExistingRun) {
    if (c.authUsers !== exp.authUsers) problems.push(`authUsers=${c.authUsers}`);
    if (c.profiles !== exp.profiles) problems.push(`profiles=${c.profiles}`);
    if (c.runAuthUsers !== 0 || c.runMetadataUsers !== 0) problems.push(`run accounts already exist (${c.runAuthUsers}/${c.runMetadataUsers})`);
  }
  if (c.orgTeams !== exp.orgTeams) problems.push(`orgTeams=${c.orgTeams}`);
  if (c.buckets !== exp.buckets) problems.push(`buckets=${c.buckets}`);
  if (problems.length) throw new Error(`Baseline gate failed: ${problems.join("; ")}`);
}
