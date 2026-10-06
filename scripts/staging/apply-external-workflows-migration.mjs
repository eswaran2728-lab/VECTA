#!/usr/bin/env node
// Applies ONLY supabase/migrations/20261025000001_caterlink_external_workflows.sql to the approved staging
// project in one isolated transaction, with verification inside the transaction before COMMIT.
//
// NOT RUN. This runner exists so the hosted application is a reviewed, gated, reversible step; it must only be
// executed after the migration has been explicitly approved.
//
// Gates: exact repo/branch (HEAD must descend from the authorized base with only tooling/tests/docs/app/migration
// paths changed), clean tree, origin; approved staging ref only and production ref absent; verified TLS; the original
// encrypted backups AND a fresh pre-change backup authenticate; history is exactly 64 migrations ending at
// 20261024000001; 56 Auth users and 56 profiles; the 40 renamed review accounts exist. Snapshots the pre-change
// privileges, policies and capability rows into a new encrypted schema backup (used for recovery). Any failure ->
// ROLLBACK. Prints names/counts only.
//
// Usage: node --env-file=.env.local scripts/staging/apply-external-workflows-migration.mjs --expected-base=<sha> --run-id=<id> --backup=<path> [--preflight-only]
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
const VERSION = "20261025000001";
const NAME = "caterlink_external_workflows";
const FILE = `${VERSION}_${NAME}.sql`;
const PRE_COUNT = 64;
const LAST_PRE = "20261024000001";

const HARDENED_TABLES = [
  "transactions", "seals", "seal_verifications", "catering_companies", "vehicles", "drivers",
  "caterlink_checkpoint_part_a", "part_b_c", "caterlink_checkpoint_part_d", "caterlink_checkpoint_hub",
  "caterlink_checkpoint_redq", "caterlink_incidents", "caterlink_incident_notes", "caterlink_archives",
  "caterlink_transaction_pdfs", "caterlink_station_capabilities", "users",
];
const NEW_FUNCTIONS = [
  "caterlink_external_role", "create_caterlink_driver_transaction_secure", "list_caterlink_driver_options_secure",
  "caterlink_vendor_guard", "caterlink_can_check_vendor_station", "create_caterlink_vendor_delivery_secure",
  "record_caterlink_vendor_security_check_secure", "complete_caterlink_vendor_delivery_secure", "list_caterlink_audit_secure",
];
const LEGACY_TABLES = [
  "incidents", "part_a", "part_b", "part_c", "part_d", "part_hub", "part_redq", "audit_logs", "segment_timeouts",
  "incident_photos", "vendor_transactions", "vendor_part_a", "vendor_part_b", "vendor_part_c",
];

const logDir = path.join(os.tmpdir(), "vecta-staging-deployments");
fs.mkdirSync(logDir, { recursive: true });
const logPath = path.join(logDir, `external-workflows-migration-${Date.now()}.log`);
const log = (m) => { const l = `[${new Date().toISOString()}] ${m}`; console.log(l); fs.appendFileSync(logPath, l + "\n"); };
const fail = (m) => { throw new Error(m); };
const redact = (m) => String(m).replace(/postgres(ql)?:\/\/[^@\s]+@/g, "postgres://[REDACTED]@");

async function state(client) {
  const n = async (sql, p) => parseInt((await client.query(sql, p)).rows[0].n, 10);
  const caps = (await client.query("select s.code, c.can_scan, c.can_confirm_hub_receipt, c.can_confirm_station_receipt, c.can_view, c.can_create, c.can_report_incident, c.can_view_history, c.can_download_pdf, c.is_active from public.caterlink_station_capabilities c join public.org_stations s on s.id = c.station_id order by s.code")).rows;
  const rowCounts = {};
  for (const t of HARDENED_TABLES) rowCounts[t] = await n(`select count(*)::int n from public."${t}"`);
  return {
    authUsers: await n("select count(*)::int n from auth.users"),
    profiles: await n("select count(*)::int n from public.profiles"),
    orgTeams: await n("select count(*)::int n from public.org_teams"),
    buckets: await n("select count(*)::int n from storage.buckets"),
    assignments: await n("select count(*)::int n from public.user_role_assignments"),
    reviewAccounts: await n("select count(*)::int n from auth.users where raw_user_meta_data->>'vecta_staging_run_id' is not null"),
    profileFp: (await client.query("select md5(string_agg(md5(p::text), ',' order by p.id::text)) fp from public.profiles p")).rows[0].fp,
    authFp: (await client.query("select md5(string_agg(u.id::text || coalesce(u.email,'') || coalesce(u.encrypted_password,'') || coalesce(u.updated_at::text,''), ',' order by u.id::text)) fp from auth.users u")).rows[0].fp,
    assignmentsFp: (await client.query("select coalesce(md5(string_agg(md5(a::text), ',' order by a.id::text)), 'none') fp from public.user_role_assignments a")).rows[0].fp,
    usersFp: (await client.query("select coalesce(md5(string_agg(md5(u::text), ',' order by u.id::text)), 'none') fp from public.users u")).rows[0].fp,
    scanFnFp: (await client.query("select md5(pg_get_functiondef('public.can_user_scan_caterlink(text, uuid)'::regprocedure)) h")).rows[0].h,
    receiptFnFp: (await client.query("select md5(pg_get_functiondef('public.can_user_confirm_caterlink_receipt(text, uuid)'::regprocedure)) h")).rows[0].h,
    capabilities: caps,
    rowCounts,
  };
}

async function main() {
  if (!expectedBase || !runId || !freshBackup) fail("--expected-base, --run-id and --backup are required");
  log("CaterLink external-workflows migration: preflight starting");
  const git = gitGates({
    expectedBase,
    expectedRepoPath: path.resolve(import.meta.dirname, "../.."),
    extraAllowed: [/^supabase\//, /^lib\//, /^app\//, /^components\//, /^middleware\.ts$/],
  });
  const changed = child_process.execSync(`git diff --name-only ${expectedBase} HEAD`, { encoding: "utf8" }).split(/\r?\n/).filter(Boolean);
  log(`HEAD=${git.head} base=${expectedBase.slice(0, 12)} changedFiles=${changed.length}`);
  environmentGates();
  log("environment resolves only to the approved staging project; production reference absent");
  const backups = backupGates(git.root);
  const nb = decryptBackupPayload(fs.readFileSync(freshBackup, "utf8"), process.env.VECTA_BACKUP_PASSPHRASE);
  if (path.relative(git.root, path.resolve(freshBackup)).startsWith("..") === false) fail("Fresh backup is inside the repository");
  log(`backups authenticate: original x${backups.length}; fresh backup exportedAt=${nb.exportedAt} authUsers=${nb.authUsers?.length}`);
  if ((nb.authUsers?.length ?? 0) !== 56) fail(`Fresh backup lists ${nb.authUsers?.length} Auth users, expected 56`);

  const sql = fs.readFileSync(path.join(git.root, "supabase", "migrations", FILE), "utf8");
  if (fs.readdirSync(path.join(git.root, "supabase", "migrations")).filter((f) => f.startsWith(VERSION)).length !== 1) fail("Migration file set unexpected");
  log(`migration file ${FILE} (${sql.length} bytes)`);

  const { client, explicitCa } = await connectVerified();
  log(`verified TLS (explicit CA: ${explicitCa ? "yes" : "no"})`);
  let committed = false;
  try {
    const mig = (await client.query("select version, name from supabase_migrations.schema_migrations order by version")).rows;
    log(`recorded migrations=${mig.length} last=${mig[mig.length - 1]?.version}`);
    if (mig.length !== PRE_COUNT || mig[mig.length - 1].version !== LAST_PRE) fail(`Migration history is not exactly ${PRE_COUNT} ending at ${LAST_PRE}`);
    if (mig.some((m) => m.version === VERSION)) fail(`${VERSION} already recorded`);
    if (mig.some((m) => String(m.name).includes(FORBIDDEN_REF))) fail("Production reference in migration history");

    const pre = await state(client);
    log(`pre-state: authUsers=${pre.authUsers} profiles=${pre.profiles} orgTeams=${pre.orgTeams} buckets=${pre.buckets} assignments=${pre.assignments} reviewAccounts=${pre.reviewAccounts}`);
    if (pre.authUsers !== 56 || pre.profiles !== 56) fail("Expected 56 Auth users and 56 profiles");
    if (pre.reviewAccounts !== 40) fail(`Expected the 40 review accounts, found ${pre.reviewAccounts}`);
    if (pre.orgTeams !== 18 || pre.buckets !== 7) fail("org_teams/buckets baseline differs");
    if (pre.rowCounts.users !== 2) fail(`Expected 2 public.users rows, found ${pre.rowCounts.users}`);
    // public.users (2) and the station capability rows (9) are expected data; every workflow table must be empty
    if (pre.rowCounts.caterlink_station_capabilities !== 9) fail(`Expected 9 station capability rows, found ${pre.rowCounts.caterlink_station_capabilities}`);
    for (const t of HARDENED_TABLES.filter((x) => x !== "users" && x !== "caterlink_station_capabilities")) if (pre.rowCounts[t] !== 0) fail(`${t} is not empty (${pre.rowCounts[t]}); the reviewed data effects assumed an empty CaterLink workflow`);
    const scanEnabledPre = pre.capabilities.filter((c) => c.can_scan).map((c) => c.code).sort().join(",");
    if (scanEnabledPre !== "JHB,PEN") fail(`Pre-state scan-enabled stations are ${scanEnabledPre}, expected JHB,PEN`);
    const existing = (await client.query("select table_name from information_schema.tables where table_schema='public' and table_name = any($1)", [[...LEGACY_TABLES, "caterlink_vendor_deliveries", "caterlink_vendor_checkpoints"]])).rows;
    if (existing.length) fail(`Tables already present: ${existing.map((r) => r.table_name).join(",")}`);
    const colPre = (await client.query("select 1 from information_schema.columns where table_schema='public' and table_name='caterlink_station_capabilities' and column_name='can_check_vendor_delivery'")).rows;
    if (colPre.length) fail("can_check_vendor_delivery already exists");

    // pre-change snapshot (table privileges, policies, capability rows) = the recovery source for the revoked grants
    const acl = (await client.query("select c.relname, coalesce(c.relacl::text, '') acl from pg_class c where c.relnamespace='public'::regnamespace and c.relname = any($1) order by 1", [HARDENED_TABLES])).rows;
    const policies = (await client.query("select tablename, policyname, cmd, roles::text roles, qual, with_check from pg_policies where schemaname='public' and tablename = any($1) order by 1,2", [HARDENED_TABLES])).rows;
    const snapPath = path.join(path.dirname(freshBackup), `ddlctzbnqewubltcavkh-schema-prechange-${VERSION}-${Date.now()}.enc.json`);
    fs.writeFileSync(snapPath, JSON.stringify(encryptBackupPayload({ exportedAt: new Date().toISOString(), migrations: mig, acl, policies, capabilities: pre.capabilities }, process.env.VECTA_BACKUP_PASSPHRASE)), { mode: 0o600 });
    decryptBackupPayload(fs.readFileSync(snapPath, "utf8"), process.env.VECTA_BACKUP_PASSPHRASE);
    log(`pre-change privilege/policy/capability snapshot written and re-authenticated (${path.basename(snapPath)})`);

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

      const tables = (await q("select table_name from information_schema.tables where table_schema='public' and table_name like 'caterlink_vendor_%' order by 1")).map((r) => r.table_name);
      if (tables.join(",") !== "caterlink_vendor_checkpoints,caterlink_vendor_deliveries") fail(`Unexpected vendor tables: ${tables.join(",")}`);
      const legacy = await q("select table_name from information_schema.tables where table_schema='public' and table_name = any($1)", [LEGACY_TABLES]);
      if (legacy.length) fail(`Legacy ICMS tables were created: ${legacy.map((r) => r.table_name).join(",")}`);
      const rls = await q("select relname, relrowsecurity r from pg_class where relnamespace='public'::regnamespace and relname like 'caterlink_vendor_%' and relkind = 'r'");
      if (rls.length !== 2 || rls.some((r) => !r.r)) fail("Vendor tables must have RLS enabled");
      const vendorPriv = (await q("select has_table_privilege('anon','public.caterlink_vendor_deliveries','select') a, has_table_privilege('authenticated','public.caterlink_vendor_deliveries','insert') i, has_table_privilege('authenticated','public.caterlink_vendor_deliveries','update') u, has_table_privilege('authenticated','public.caterlink_vendor_deliveries','delete') d"))[0];
      if (vendorPriv.a || vendorPriv.i || vendorPriv.u || vendorPriv.d) fail("Vendor table client privileges are too wide");

      for (const fn of NEW_FUNCTIONS) {
        const row = (await q("select p.prosecdef d, coalesce(p.proconfig,'{}') c, has_function_privilege('anon', p.oid, 'execute') a from pg_proc p where p.pronamespace='public'::regnamespace and p.proname = $1", [fn]));
        if (row.length !== 1) fail(`${fn}: expected exactly one definition, found ${row.length}`);
        if (row[0].a) fail(`${fn}: anon can execute it`);
        if (fn !== "caterlink_vendor_guard" && (!row[0].d || !row[0].c.some((x) => x.startsWith("search_path=")))) fail(`${fn}: not SECURITY DEFINER with a pinned search_path`);
      }
      const refsScan = (await q("select count(*)::int n from pg_proc p where p.pronamespace='public'::regnamespace and p.prosrc ilike '%can_user_scan_caterlink%' and p.proname <> 'can_user_scan_caterlink'"))[0].n;
      if (refsScan !== 0) fail("A database function now derives permissions from the scan decision");

      const bad = await q(`select c.relname, r.rolname, p.priv from pg_class c cross join (values ('anon'),('authenticated')) r(rolname) cross join (values ('TRUNCATE'),('REFERENCES'),('TRIGGER')) p(priv)
        where c.relnamespace='public'::regnamespace and c.relkind='r' and c.relname = any($1) and has_table_privilege(r.rolname, c.oid, p.priv)`, [HARDENED_TABLES]);
      if (bad.length) fail(`TRUNCATE/REFERENCES/TRIGGER still granted: ${bad.map((b) => `${b.relname}:${b.rolname}`).join(",")}`);

      const post = await state(client);
      // the existing scan / receipt / create / view capability values are unchanged; only the new column differs
      if (JSON.stringify(post.capabilities) !== JSON.stringify(pre.capabilities)) fail("Existing station capability values changed");
      const vc = (await q("select s.code from public.caterlink_station_capabilities c join public.org_stations s on s.id = c.station_id where c.can_check_vendor_delivery order by 1")).map((r) => r.code).join(",");
      if (vc !== "JHB,PEN") fail(`can_check_vendor_delivery is enabled for ${vc}, expected JHB,PEN`);
      if (post.scanFnFp !== pre.scanFnFp || post.receiptFnFp !== pre.receiptFnFp) fail("The scan or receipt decision function changed");
      if (post.orgTeams !== 18) fail(`Expected 18 org_teams, found ${post.orgTeams}`);
      if (post.authUsers !== 56 || post.profiles !== 56 || post.buckets !== 7) fail("Counts changed");
      if (post.profileFp !== pre.profileFp) fail("profiles content changed");
      if (post.authFp !== pre.authFp) fail("auth.users content (including password hashes) changed");
      if (post.assignmentsFp !== pre.assignmentsFp) fail("user_role_assignments changed");
      if (post.usersFp !== pre.usersFp) fail("public.users content changed");
      if (JSON.stringify(post.rowCounts) !== JSON.stringify(pre.rowCounts)) fail("Existing CaterLink table row counts changed");
      const anonFns = await q("select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind='f' and has_function_privilege('anon', p.oid, 'execute') and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')");
      if (anonFns.length) fail(`anon can execute ${anonFns.length} public functions`);
      log("in-transaction verification PASSED (2 vendor tables with RLS; 9 functions definer/search_path/anon-denied; no legacy tables; no TRUNCATE/REFERENCES/TRIGGER for clients; capabilities unchanged except the new column = JHB,PEN; scan/receipt functions identical; auth/profiles/assignments/users unchanged)");

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
