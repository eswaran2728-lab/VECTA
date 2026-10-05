#!/usr/bin/env node
// Applies ONLY supabase/migrations/20261020000001_canonical_operations_compatibility.sql to the approved
// staging project, in one isolated transaction, with verification inside the transaction before COMMIT.
//
// Safety: approved ref ddlctzbnqewubltcavkh only; forbidden production ref rejected anywhere in the
// environment; branch + clean tree required; both encrypted backups must authenticate in memory;
// verified TLS (never disabled); exactly 59 recorded migrations with 20261016000001 last; 16 Auth users,
// 16 profiles, 16 org_teams and the 7 canonical buckets; the migration version must be absent.
// Any failed check -> ROLLBACK. Prints names/counts only (never row data or credentials).
//
// Usage: node --env-file=.env.local scripts/staging/apply-canonical-compat-migration.mjs [--preflight-only]
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import child_process from "node:child_process";
import { createRequire } from "node:module";
import { decryptBackupPayload } from "./lib/backup-crypto.mjs";
import { buildVerifiedClientConfig, describeTlsError } from "./lib/db-tls.mjs";

const require = createRequire(import.meta.url);
const APPROVED_REF = "ddlctzbnqewubltcavkh";
const FORBIDDEN_REF = "zsxneokqulktgnccxgkz";
const EXPECTED_BRANCH = "dashboard/role-workspaces-adjustment";
const VERSION = "20261020000001";
const NAME = "canonical_operations_compatibility";
const FILE = "20261020000001_canonical_operations_compatibility.sql";
const PRE_COUNT = 59;
const LAST_PRE = "20261016000001";
const PREFLIGHT_ONLY = process.argv.includes("--preflight-only");
const BACKUP_1 = "C:\\Users\\eswaranp\\AppData\\Local\\Temp\\vecta-staging-backups\\ddlctzbnqewubltcavkh-2026-10-02T07-59-58-492Z.enc.json";
const BACKUP_2 = "C:\\Users\\eswaranp\\AppData\\Local\\Temp\\vecta-staging-backups\\ddlctzbnqewubltcavkh-schema-history-2026-10-02.enc.json";
const BUCKETS = ["report-attachments", "signatures", "incident-photos", "completed-forms", "sat-combined-reports", "caterlink-final-pdfs", "announcement-attachments"];
const EXPECTED_FUNCTIONS = [
  "canon_assignments", "canon_is_active", "canon_has_role", "canon_my_level", "canon_profile_level", "canon_station_visible",
  "canon_team_visible", "canon_same_team", "canon_has_role_at_station", "canon_can_admin_station", "canon_oversees",
  "canon_can_view_profile", "canonical_compat_role_for", "can_manage_roster_secure", "clear_roster_cell_secure",
  "list_roster_officers_secure", "list_roster_teams_secure", "list_eligible_supervising_officers_secure",
  "is_eligible_supervising_officer_secure", "can_acknowledge_report", "can_view_report", "can_file_report",
];

function loadPg() {
  try { return require("pg"); } catch { return require(path.resolve(import.meta.dirname, "../../supabase/tests/integration/node_modules/pg")); }
}

const logDir = path.join(os.tmpdir(), "vecta-staging-deployments");
fs.mkdirSync(logDir, { recursive: true });
const logPath = path.join(logDir, `canonical-compat-${Date.now()}.log`);
const log = (m) => { const l = `[${new Date().toISOString()}] ${m}`; console.log(l); fs.appendFileSync(logPath, l + "\n"); };
const fail = (m) => { throw new Error(m); };
const num = (r) => parseInt(r.rows[0].n ?? r.rows[0].count, 10);

async function snapshot(client) {
  const q = async (s) => (await client.query(s)).rows;
  return {
    authUsers: num(await client.query("select count(*)::int n from auth.users")),
    profiles: num(await client.query("select count(*)::int n from public.profiles")),
    orgTeams: num(await client.query("select count(*)::int n from public.org_teams")),
    buckets: (await q("select name from storage.buckets order by name")).map((r) => r.name),
    activeAssignmentsOnProfiles: num(await client.query(`
      select count(*)::int n from public.user_role_assignments ura join public.role_definitions rd on rd.id = ura.role_definition_id
      join public.profiles p on p.id = ura.profile_id
      where rd.is_active and ura.revoked_at is null and ura.starts_at <= now() and (ura.ends_at is null or ura.ends_at > now())`)),
    totalAssignments: num(await client.query("select count(*)::int n from public.user_role_assignments")),
    profileFp: (await q("select md5(string_agg(md5(p::text), ',' order by p.id::text)) fp from public.profiles p"))[0].fp,
    authFp: (await q("select md5(string_agg(u.id::text || coalesce(u.email,'') || coalesce(u.updated_at::text,''), ',' order by u.id::text)) fp from auth.users u"))[0].fp,
    assignmentsFp: (await q("select coalesce(md5(string_agg(md5(a::text), ',' order by a.id::text)), 'none') fp from public.user_role_assignments a"))[0].fp,
    policyCount: num(await client.query("select count(*)::int n from pg_policies where schemaname='public'")),
  };
}

async function main() {
  log("Canonical compatibility migration: preflight starting");
  const root = child_process.execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
  const branch = child_process.execSync("git branch --show-current", { encoding: "utf8" }).trim();
  const head = child_process.execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  log(`branch=${branch} head=${head}`);
  if (branch !== EXPECTED_BRANCH) fail(`Branch mismatch: ${branch}`);
  if (child_process.execSync("git status --porcelain", { encoding: "utf8" }).trim()) fail("Working tree is not clean");

  const dbUrl = process.env.STAGING_DATABASE_URL;
  if (!dbUrl) fail("STAGING_DATABASE_URL is not set");
  if (JSON.stringify(process.env).includes(FORBIDDEN_REF)) fail("Forbidden production reference present in the environment");
  const u = new URL(dbUrl);
  if (!u.hostname.includes(APPROVED_REF) && !u.username.includes(APPROVED_REF)) fail("Database URL does not identify the approved staging project");
  log(`target verified: host=${u.hostname}`);

  const pass = process.env.VECTA_BACKUP_PASSPHRASE;
  if (!pass) fail("VECTA_BACKUP_PASSPHRASE is not set");
  for (const f of [BACKUP_1, BACKUP_2]) if (!fs.existsSync(f)) fail(`Backup missing: ${path.basename(f)}`);
  const b1 = decryptBackupPayload(fs.readFileSync(BACKUP_1, "utf8"), pass);
  const b2 = decryptBackupPayload(fs.readFileSync(BACKUP_2, "utf8"), pass);
  log(`backup 1 authenticated (exportedAt=${b1.exportedAt}, authUsers=${b1.authUsers?.length}); backup 2 authenticated (exportedAt=${b2.exportedAt}, schemaSqlBytes=${b2.schemaSql?.length})`);

  const sql = fs.readFileSync(path.join(root, "supabase", "migrations", FILE), "utf8");
  const only = fs.readdirSync(path.join(root, "supabase", "migrations")).filter((f) => f.startsWith(VERSION));
  if (only.length !== 1 || only[0] !== FILE) fail("Migration file set unexpected");
  log(`migration file: ${FILE} (${sql.length} bytes)`);

  const { Client } = loadPg();
  const cfg = buildVerifiedClientConfig(dbUrl);
  const client = new Client({ connectionString: cfg.connectionString, ssl: cfg.ssl });
  try { await client.connect(); } catch (e) { fail(`Verified-TLS connection failed; no insecure fallback. ${describeTlsError(e)}`); }
  log(`connected with verified TLS (explicit CA: ${cfg.usedExplicitCa ? "yes" : "no"})`);

  let committed = false;
  try {
    const mig = (await client.query("select version, name from supabase_migrations.schema_migrations order by version")).rows;
    const last = mig[mig.length - 1]?.version;
    log(`recorded migrations=${mig.length} last=${last}`);
    if (mig.length !== PRE_COUNT) fail(`Expected exactly ${PRE_COUNT} migrations, found ${mig.length}`);
    if (last !== LAST_PRE) fail(`Expected last migration ${LAST_PRE}, found ${last}`);
    if (mig.some((m) => m.version === VERSION)) fail(`${VERSION} is already recorded`);
    if (mig.some((m) => String(m.name).includes(FORBIDDEN_REF))) fail("Production reference found in migration history");

    const pre = await snapshot(client);
    log(`pre-state: ${JSON.stringify({ ...pre, buckets: pre.buckets.length, profileFp: pre.profileFp.slice(0, 8), authFp: pre.authFp.slice(0, 8), assignmentsFp: pre.assignmentsFp.slice(0, 8) })}`);
    if (pre.authUsers !== 16 || pre.profiles !== 16) fail(`Expected 16 Auth users / 16 profiles, found ${pre.authUsers}/${pre.profiles}`);
    if (pre.orgTeams !== 16) fail(`Expected 16 org_teams, found ${pre.orgTeams}`);
    if (JSON.stringify(pre.buckets) !== JSON.stringify([...BUCKETS].sort())) fail("Canonical Storage bucket set differs from the expected seven");
    log(`active canonical assignments held by the 16 legacy profiles: ${pre.activeAssignmentsOnProfiles} (informational; expected 0 -- not a blocker)`);

    if (PREFLIGHT_ONLY) { log("PREFLIGHT ONLY: no change made."); return; }

    log("BEGIN isolated transaction");
    const t0 = Date.now();
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query(
        "insert into supabase_migrations.schema_migrations (version, name, statements) values ($1, $2, $3)",
        [VERSION, NAME, [sql]],
      );

      // ---- verification inside the transaction, before COMMIT ----
      const q = async (s, p) => (await client.query(s, p)).rows;
      const hist = await q("select version from supabase_migrations.schema_migrations where version = $1", [VERSION]);
      if (hist.length !== 1) fail("History entry is not exactly one");
      const total = num(await client.query("select count(*)::int n from supabase_migrations.schema_migrations"));
      if (total !== PRE_COUNT + 1) fail(`Expected ${PRE_COUNT + 1} history rows, found ${total}`);

      const fns = (await q("select distinct proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and proname = any($1)", [EXPECTED_FUNCTIONS])).map((r) => r.proname);
      const missing = EXPECTED_FUNCTIONS.filter((f) => !fns.includes(f));
      if (missing.length) fail(`Missing functions: ${missing.join(",")}`);

      const noRls = await q("select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname='public' and c.relkind in ('r','p') and not c.relrowsecurity");
      if (noRls.length) fail(`Tables without RLS: ${noRls.map((r) => r.relname).join(",")}`);
      const forAll = await q("select tablename, policyname from pg_policies where schemaname='public' and cmd='ALL'");
      if (forAll.length) fail(`FOR ALL policies remain: ${forAll.map((r) => r.tablename + "." + r.policyname).join(",")}`);
      const blanket = await q("select tablename, policyname from pg_policies where schemaname='public' and (coalesce(qual,'')='true' or coalesce(with_check,'')='true')");
      if (blanket.length) fail(`Blanket policies remain: ${blanket.map((r) => r.tablename + "." + r.policyname).join(",")}`);
      const publicPol = await q("select tablename, policyname from pg_policies where schemaname='public' and 'public' = any(roles)");
      if (publicPol.length) fail(`Policies granted to PUBLIC remain: ${publicPol.length}`);
      const updNoCheck = await q("select tablename, policyname from pg_policies where schemaname='public' and cmd='UPDATE' and (qual is null or with_check is null)");
      if (updNoCheck.length) fail(`UPDATE policies missing USING/WITH CHECK: ${updNoCheck.length}`);
      const hints = ["current_role_name", "current_role_rank", "is_monitor_or_above", "is_approved_management", "submitter_role_rank", "canonical_compat_role_for"];
      const compatPol = await q("select tablename, policyname from pg_policies where schemaname='public' and exists (select 1 from unnest($1::text[]) h where position(h in coalesce(qual,'') || coalesce(with_check,'')) > 0)", [hints]);
      if (compatPol.length) fail(`Policies still reference the compatibility rank: ${compatPol.map((r) => r.tablename + "." + r.policyname).join(",")}`);
      const profRole = await q("select tablename, policyname from pg_policies where schemaname='public' and (coalesce(qual,'') || coalesce(with_check,'')) ~ '(profiles|p)[.](role|ops_group|unified_role)'");
      if (profRole.length) fail(`Policies still read profiles.role/ops_group/unified_role: ${profRole.length}`);

      const anonTables = await q("select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p') and has_table_privilege('anon', c.oid, 'select,insert,update,delete,truncate,references,trigger')");
      if (anonTables.length) fail(`anon still holds table privileges on ${anonTables.length} tables`);
      const anonFns = await q("select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind='f' and has_function_privilege('anon', p.oid, 'execute') and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')");
      if (anonFns.length) fail(`anon can still execute ${anonFns.length} public functions: ${anonFns.slice(0, 8).map((r) => r.proname).join(",")}`);
      const colPriv = (await q("select has_column_privilege('authenticated','public.drivers','staff_ic_number','select') ic, has_column_privilege('authenticated','public.drivers','airport_pass_number','select') pass, has_column_privilege('authenticated','public.drivers','name','select') nm"))[0];
      if (colPriv.ic || colPriv.pass || !colPriv.nm) fail("drivers column grants are not as designed");
      const internal = await q("select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname = any($1) and has_function_privilege('authenticated', p.oid, 'execute')", [["get_report_submitter", "submitter_role_rank", "current_role_name", "canon_profile_level", "canonical_compat_role_for"]]);
      if (internal.length) fail(`Internal helpers still client-callable: ${internal.map((r) => r.proname).join(",")}`);
      const canonAnon = await q("select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'canon\\_%' and (has_function_privilege('anon', p.oid, 'execute') or exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type='EXECUTE'))");
      if (canonAnon.length) fail(`canon_* functions executable by anon/PUBLIC: ${canonAnon.map((r) => r.proname).join(",")}`);
      const noPath = await q("select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'canon\\_%' and p.prosecdef and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')");
      if (noPath.length) fail(`canon_* definers without a pinned search_path: ${noPath.map((r) => r.proname).join(",")}`);

      const post = await snapshot(client);
      if (post.authUsers !== 16 || post.profiles !== 16) fail("Auth user/profile count changed");
      if (post.profileFp !== pre.profileFp) fail("profiles content changed");
      if (post.authFp !== pre.authFp) fail("auth.users content changed");
      if (post.assignmentsFp !== pre.assignmentsFp) fail("user_role_assignments content changed");
      if (post.orgTeams !== 16) fail("org_teams count changed");
      if (JSON.stringify(post.buckets) !== JSON.stringify(pre.buckets)) fail("Storage buckets changed");
      log(`in-transaction verification PASSED (policies ${pre.policyCount} -> ${post.policyCount}; ${EXPECTED_FUNCTIONS.length} functions present; profiles/auth/assignments unchanged)`);

      await client.query("COMMIT");
      committed = true;
      log(`COMMIT done in ${Date.now() - t0} ms`);
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      log(`ROLLED BACK: ${String(e.message).replace(/postgres(ql)?:\/\/[^@\s]+@/g, "postgres://[REDACTED]@")}`);
      throw e;
    }

    // ---- post-commit confirmation ----
    const after = await snapshot(client);
    const m2 = (await client.query("select version from supabase_migrations.schema_migrations order by version")).rows;
    log(`post-commit: migrations=${m2.length} last=${m2[m2.length - 1].version}; authUsers=${after.authUsers} profiles=${after.profiles} orgTeams=${after.orgTeams} buckets=${after.buckets.length}; profilesUnchanged=${after.profileFp === pre.profileFp} authUnchanged=${after.authFp === pre.authFp}`);
    if (m2.length !== PRE_COUNT + 1 || m2.filter((r) => r.version === VERSION).length !== 1) fail("Post-commit history check failed");
  } finally {
    await client.end();
    log(`log file: ${logPath}`);
  }
  if (committed) log("RESULT: SUCCESS");
}

main().catch((e) => {
  console.error("FAILED:", String(e.message).replace(/postgres(ql)?:\/\/[^@\s]+@/g, "postgres://[REDACTED]@"));
  process.exit(1);
});
