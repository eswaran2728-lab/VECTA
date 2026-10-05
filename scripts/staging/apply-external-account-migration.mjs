#!/usr/bin/env node
// Applies ONLY supabase/migrations/20261023000001_caterlink_external_account_table.sql to the
// approved staging project in one isolated transaction, with verification inside the transaction before COMMIT.
//
// Gates: exact repo/branch (HEAD must descend from the authorized base with only tooling/tests/docs/migration
// paths changed), clean tree, origin; approved staging ref only and production ref absent; verified TLS; the two
// original encrypted backups AND the fresh pre-change backup authenticate; history is exactly 60 migrations ending
// at 20261020000001; 52 Auth users and 52 profiles; all 36 dashboard-review accounts exist. Also snapshots the
// pre-change function definition and capability rows into a new encrypted schema backup. Any failure -> ROLLBACK.
// Prints names/counts only.
//
// Usage: node --env-file=.env.local scripts/staging/apply-external-account-migration-migration.mjs --expected-base=<sha> --run-id=<id> --backup=<path> [--preflight-only]
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import child_process from "node:child_process";
import { decryptBackupPayload, encryptBackupPayload } from "./lib/backup-crypto.mjs";
import { gitGates, environmentGates, backupGates, connectVerified, FORBIDDEN_REF } from "./lib/run-gates.mjs";

const args = process.argv.slice(2);
const argVal = (k) => args.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=");
const PREFLIGHT_ONLY = args.includes("--preflight-only");
const expectedBase = argVal("expected-base");
const runId = argVal("run-id");
const freshBackup = argVal("backup");
const VERSION = "20261023000001";
const NAME = "caterlink_external_account_table";
const FILE = `${VERSION}_${NAME}.sql`;
const PRE_COUNT = 62;
const LAST_PRE = "20261022000001";

const logDir = path.join(os.tmpdir(), "vecta-staging-deployments");
fs.mkdirSync(logDir, { recursive: true });
const logPath = path.join(logDir, `external-account-migration-${Date.now()}.log`);
const log = (m) => { const l = `[${new Date().toISOString()}] ${m}`; console.log(l); fs.appendFileSync(logPath, l + "\n"); };
const fail = (m) => { throw new Error(m); };
const redact = (m) => String(m).replace(/postgres(ql)?:\/\/[^@\s]+@/g, "postgres://[REDACTED]@");

async function state(client) {
  const n = async (sql, p) => parseInt((await client.query(sql, p)).rows[0].n, 10);
  const rows = (await client.query("select s.code, c.can_scan, c.can_confirm_hub_receipt, c.can_confirm_station_receipt, c.can_view, c.can_create, c.can_report_incident, c.can_view_history, c.can_download_pdf, c.is_active from public.caterlink_station_capabilities c join public.org_stations s on s.id = c.station_id order by s.code")).rows;
  return {
    authUsers: await n("select count(*)::int n from auth.users"),
    profiles: await n("select count(*)::int n from public.profiles"),
    orgTeams: await n("select count(*)::int n from public.org_teams"),
    buckets: await n("select count(*)::int n from storage.buckets"),
    assignments: await n("select count(*)::int n from public.user_role_assignments"),
    profileFp: (await client.query("select md5(string_agg(md5(p::text), ',' order by p.id::text)) fp from public.profiles p")).rows[0].fp,
    authFp: (await client.query("select md5(string_agg(u.id::text || coalesce(u.email,'') || coalesce(u.encrypted_password,'') || coalesce(u.updated_at::text,''), ',' order by u.id::text)) fp from auth.users u")).rows[0].fp,
    assignmentsFp: (await client.query("select coalesce(md5(string_agg(md5(a::text), ',' order by a.id::text)), 'none') fp from public.user_role_assignments a")).rows[0].fp,
    capabilities: rows,
    runAccounts: await n("select count(*)::int n from auth.users where email like $1", [`vecta.uat.${runId}.%`]),
  };
}

async function main() {
  if (!expectedBase || !runId || !freshBackup) fail("--expected-base, --run-id and --backup are required");
  log("CaterLink external-account table migration: preflight starting");
  const git = gitGates({
    expectedBase,
    expectedRepoPath: path.resolve(import.meta.dirname, "../.."),
    // this run additionally allows exactly the receipt migration, the integration tests and application/test sources changed in the same commit range
    extraAllowed: [/^supabase\/migrations\/20261023000001_caterlink_external_account_table\.sql$/, /^supabase\/tests\/integration\//, /^lib\//, /^app\//, /^components\//, /^middleware\.ts$/],
  });
  const changed = child_process.execSync(`git diff --name-only ${expectedBase} HEAD`, { encoding: "utf8" }).split(/\r?\n/).filter(Boolean);
  log(`HEAD=${git.head} base=${expectedBase.slice(0, 12)} changedFiles=${changed.length}`);
  environmentGates();
  log("environment resolves only to the approved staging project; production reference absent");
  const backups = backupGates(git.root);
  const nb = decryptBackupPayload(fs.readFileSync(freshBackup, "utf8"), process.env.VECTA_BACKUP_PASSPHRASE);
  if (path.relative(git.root, path.resolve(freshBackup)).startsWith("..") === false) fail("Fresh backup is inside the repository");
  log(`backups authenticate: original x${backups.length}; fresh backup exportedAt=${nb.exportedAt} authUsers=${nb.authUsers?.length}`);
  if ((nb.authUsers?.length ?? 0) !== 54) fail(`Fresh backup lists ${nb.authUsers?.length} Auth users, expected 54`);

  const sql = fs.readFileSync(path.join(git.root, "supabase", "migrations", FILE), "utf8");
  if (fs.readdirSync(path.join(git.root, "supabase", "migrations")).filter((f) => f.startsWith(VERSION)).length !== 1) fail("Migration file set unexpected");
  log(`migration file ${FILE} (${sql.length} bytes)`);

  const { client, explicitCa } = await connectVerified();
  log(`verified TLS (explicit CA: ${explicitCa ? "yes" : "no"})`);
  let committed = false;
  try {
    const mig = (await client.query("select version, name from supabase_migrations.schema_migrations order by version")).rows;
    log(`recorded migrations=${mig.length} last=${mig[mig.length - 1]?.version}`);
    if (mig.length !== PRE_COUNT || mig[mig.length - 1].version !== LAST_PRE) fail("Migration history is not exactly 62 ending at 20261022000001");
    if (mig.some((m) => m.version === VERSION)) fail(`${VERSION} already recorded`);
    if (mig.some((m) => String(m.name).includes(FORBIDDEN_REF))) fail("Production reference in migration history");

    const pre = await state(client);
    log(`pre-state: authUsers=${pre.authUsers} profiles=${pre.profiles} orgTeams=${pre.orgTeams} buckets=${pre.buckets} assignments=${pre.assignments} runAccounts=${pre.runAccounts} scanEnabled=${pre.capabilities.filter((c) => c.can_scan).map((c) => c.code).join("|")}`);
    if (pre.authUsers !== 54 || pre.profiles !== 54) fail("Expected 54 Auth users and 54 profiles");
    if (pre.runAccounts !== 36) fail(`Expected all 36 base dashboard-review accounts, found ${pre.runAccounts}`);
    if (pre.orgTeams !== 18 || pre.buckets !== 7) fail("org_teams/buckets baseline differs");
    const usersBefore = (await client.query("select to_regclass('public.users') is not null as ok")).rows[0].ok;
    log(`public.users present before the migration: ${usersBefore}`);
    const scanEnabledPre = pre.capabilities.filter((c) => c.can_scan).map((c) => c.code).sort().join(",");
    if (scanEnabledPre !== "JHB,PEN") fail(`Pre-state scan-enabled stations are ${scanEnabledPre}, expected JHB,PEN`);

    // pre-change snapshot (function definitions + capability rows) as a new encrypted schema backup
    const defs = (await client.query("select p.oid::regprocedure::text sig, pg_get_functiondef(p.oid) def from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname='public' and p.proname in ('can_user_scan_caterlink','can_user_confirm_caterlink_receipt','get_my_active_role_assignments')")).rows;
    const snapPath = path.join(path.dirname(freshBackup), `ddlctzbnqewubltcavkh-schema-prechange-${VERSION}-${Date.now()}.enc.json`);
    fs.writeFileSync(snapPath, JSON.stringify(encryptBackupPayload({ exportedAt: new Date().toISOString(), migrations: mig, functions: defs, capabilities: pre.capabilities }, process.env.VECTA_BACKUP_PASSPHRASE)), { mode: 0o600 });
    decryptBackupPayload(fs.readFileSync(snapPath, "utf8"), process.env.VECTA_BACKUP_PASSPHRASE);
    log(`pre-change schema snapshot written and re-authenticated (${path.basename(snapPath)})`);

    if (PREFLIGHT_ONLY) { log("PREFLIGHT ONLY: no change made."); return; }

    log("BEGIN isolated transaction");
    const t0 = Date.now();
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("insert into supabase_migrations.schema_migrations (version, name, statements) values ($1, $2, $3)", [VERSION, NAME, [sql]]);

      // ---- verification inside the transaction, before COMMIT ----
      const q = async (s, p) => (await client.query(s, p)).rows;
      const total = parseInt((await q("select count(*)::int n from supabase_migrations.schema_migrations"))[0].n, 10);
      if (total !== PRE_COUNT + 1) fail(`Expected ${PRE_COUNT + 1} history rows`);
      if ((await q("select 1 from supabase_migrations.schema_migrations where version = $1", [VERSION])).length !== 1) fail("History entry is not exactly one");

      const usersRls = (await q("select c.relrowsecurity r from pg_class c where c.oid = 'public.users'::regclass"))[0].r;
      if (!usersRls) fail("public.users does not have RLS enabled");
      const pol = await q("select policyname, cmd, qual from pg_policies where schemaname='public' and tablename='users'");
      if (pol.length !== 1 || pol[0].cmd !== "SELECT" || !/auth\.uid\(\)/.test(pol[0].qual)) fail("public.users must carry exactly one own-row SELECT policy");
      const priv = (await q("select has_table_privilege('anon','public.users','select,insert,update,delete') a, has_table_privilege('authenticated','public.users','select') s, has_table_privilege('authenticated','public.users','insert,update,delete') w"))[0];
      if (priv.a || !priv.s || priv.w) fail("public.users grants are not anon-none / authenticated-select-only");
      const cols = (await q("select column_name from information_schema.columns where table_schema='public' and table_name='users'")).map((r) => r.column_name);
      if (cols.some((c) => /pass|secret|token/i.test(c))) fail("public.users has a credential-like column");
      if ((await q("select count(*)::int n from public.users"))[0].n !== 0) fail("public.users must start empty");
      const roleCheck = (await q("select pg_get_constraintdef(c.oid) d from pg_constraint c where c.conrelid = 'public.users'::regclass and c.contype = 'c' and pg_get_constraintdef(c.oid) ilike '%role%'"))[0]?.d ?? "";
      if (!/warehouse_pic/.test(roleCheck) || !/vendor/.test(roleCheck) || /supervisor|management/.test(roleCheck)) fail("public.users role check is not restricted to the external roles");
      const scanDef = (await q("select pg_get_functiondef('public.can_user_scan_caterlink(text, uuid)'::regprocedure) d"))[0].d;
      if (!/not in \('PEN', 'JHB'\)/.test(scanDef)) fail("The corrected scan function is no longer in place");
      const rcptSig = (await q("select count(*)::int n from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='can_user_confirm_caterlink_receipt'"))[0].n;
      if (rcptSig !== 1) fail("The receipt decision function changed unexpectedly");

      const post = await state(client);
      const enabled = post.capabilities.filter((c) => c.can_scan).map((c) => c.code).sort().join(",");
      if (enabled !== "JHB,PEN") fail(`Scan-enabled stations are ${enabled}, expected JHB,PEN`);
      if (JSON.stringify(post.capabilities) !== JSON.stringify(pre.capabilities)) fail("Station capabilities changed unexpectedly");
      if (post.orgTeams !== 18) fail(`Expected 18 org_teams, found ${post.orgTeams}`);
      if (post.authUsers !== 54 || post.profiles !== 54 || post.buckets !== 7) fail("Counts changed");
      if (post.profileFp !== pre.profileFp) fail("profiles content changed");
      if (post.authFp !== pre.authFp) fail("auth.users content (including password hashes) changed");
      if (post.assignmentsFp !== pre.assignmentsFp) fail("user_role_assignments changed");
      const anonFns = await q("select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind='f' and has_function_privilege('anon', p.oid, 'execute') and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')");
      if (anonFns.length) fail(`anon can execute ${anonFns.length} public functions`);
      log(`in-transaction verification PASSED (public.users created: RLS on, own-row select only, no client writes, external roles only; scan=${enabled}; auth/profiles/assignments/capabilities unchanged)`);

      await client.query("COMMIT");
      committed = true;
      log(`COMMIT done in ${Date.now() - t0} ms`);
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      log(`ROLLED BACK: ${redact(e.message)}`);
      throw e;
    }
    const m2 = (await client.query("select version from supabase_migrations.schema_migrations order by version")).rows;
    log(`post-commit: migrations=${m2.length} last=${m2[m2.length - 1].version} ${VERSION}x${m2.filter((r) => r.version === VERSION).length}`);
    if (m2.length !== PRE_COUNT + 1 || m2.filter((r) => r.version === VERSION).length !== 1) fail("Post-commit history check failed");
  } finally {
    await client.end();
    log(`log file: ${logPath}`);
  }
  if (committed) log("RESULT: SUCCESS");
}

main().catch((e) => { console.error("FAILED:", redact(e.message)); process.exit(1); });
